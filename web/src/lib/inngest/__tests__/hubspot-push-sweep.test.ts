import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, NESTED_STEP_ERROR, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/hubspot-push-sweep.ts via the createFunction-capture
 * pattern (canonical: hubspot-push-contact.test.ts / hubspot-functions.test.ts).
 *
 * The sweep is a retroactive backfill: it pages the workspace's eligible
 * contacts and fans out one crm/hubspot-push-contact event per contact. The
 * per-contact fn (NOT tested here) owns all real gating; the sweep only decides
 * WHICH rows to poke.
 *
 * Invariants locked in:
 *  - Guards: no-op when the push toggle is off, or when the workspace has no
 *    crm_sync_state row (HubSpot not connected). No query, no fan-out.
 *  - Eligibility query shape: workspace match, source_provider IS NULL (skips
 *    already-linked rows so re-sweeps are safe), merged_into_contact_id IS NULL,
 *    email NOT NULL, ordered by (created_at, id); scope filter — 'manual' →
 *    source='manual', 'all' → source != 'member'.
 *  - Permanent-failure marker: a routine sweep EXCLUDES contacts carrying
 *    metadata.hubspot_push_error (else a 401'd contact is re-emitted every cron
 *    tick forever); an includeFailed sweep re-admits them.
 *  - Fan-out: one crm/hubspot-push-contact event per eligible contact.
 *  - STEP STRUCTURE: one `step.run('sweep-page-N')` per page doing ONLY the
 *    query, with `step.sendEvent('push-batch-N')` at the FUNCTION level between
 *    steps. Nesting step tooling inside step.run is illegal in the Inngest SDK
 *    and hangs in production without emitting anything — it shipped once here.
 *    The shared step mock (src/test/inngest-step-mock.ts) now throws on nesting,
 *    so every test in this file is also a nesting regression test.
 *  - Paging + self-chain: a full page (PAGE_SIZE=100) that keeps yielding rows
 *    self-chains past the MAX_PAGES_PER_RUN cap, carrying a (created_at, id)
 *    keyset cursor AND the includeFailed mode; a short/empty page completes.
 *    The cursor threads page→page in memory, derived only from step.run output.
 *  - Registration: id, trigger, retries, debounce, keyed concurrency.
 */

// ---- Hoisted capture of the inngest function ------------------------------

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.config = config
      hoisted.handler = fn
      return { id: config.id }
    },
  },
}))

let dbFake: unknown = { from: vi.fn() }
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

vi.mock('@/lib/crm/hubspot-sync', () => ({
  HUBSPOT_SOURCE_PROVIDER: 'hubspot',
  HUBSPOT_PUSH_ERROR_KEY: 'hubspot_push_error',
}))

// PostgREST filter key for the permanent-failure marker.
const FAILED_FILTER = 'is:metadata->hubspot_push_error'
// …and for the unattended-create HOLD (Sequence step 2), applied on every fire.
const HOLD_FILTER = 'is:metadata->hubspot_push_hold'

// Evaluate the module so createFunction runs and the handler is captured.
await import('@/lib/inngest/hubspot-push-sweep')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — vi.fn per method PLUS the nesting tripwire that
 * would have caught the original `step.sendEvent`-inside-`step.run` bug.
 */
function makeStep(): StepMock {
  return createStepMock()
}

type Row = { id: string; created_at: string }

interface DbRows {
  workspaceSettings?: Record<string, unknown>
  syncState?: Record<string, unknown> | null
  /**
   * Contact pages returned in order, one per `.limit(...)` terminal await. When
   * exhausted, further reads return []. Tests queue their own paging shapes.
   */
  contactPages?: Row[][]
}

/**
 * Table-aware supabase fake. `.from('workspace')` and `.from('crm_sync_state')`
 * terminate at `.maybeSingle()`; `.from('contact')` is a chainable query whose
 * terminal await (`.limit()` returns a thenable) resolves `{ data, error }` from
 * the next queued page. Every chained filter is recorded so the query shape can
 * be asserted.
 */
function makeDb(rows: DbRows) {
  const contactCalls: Array<Record<string, unknown[]>> = []
  const pages = [...(rows.contactPages ?? [])]

  function contactBuilder() {
    const calls: Record<string, unknown[]> = {}
    const record = (m: string, args: unknown[]) => {
      calls[m] = args
    }
    const page = pages.shift() ?? []
    const result = { data: page, error: null }
    const api: Record<string, unknown> = {
      select: (...a: unknown[]) => {
        record('select', a)
        return api
      },
      eq: (...a: unknown[]) => {
        record(`eq:${String(a[0])}`, a)
        return api
      },
      neq: (...a: unknown[]) => {
        record(`neq:${String(a[0])}`, a)
        return api
      },
      is: (...a: unknown[]) => {
        record(`is:${String(a[0])}`, a)
        return api
      },
      not: (...a: unknown[]) => {
        record(`not:${String(a[0])}`, a)
        return api
      },
      or: (...a: unknown[]) => {
        record('or', a)
        return api
      },
      order: (...a: unknown[]) => {
        // Two .order calls — record both.
        const key = 'order' in calls ? 'order2' : 'order'
        record(key, a)
        return api
      },
      limit: (...a: unknown[]) => {
        record('limit', a)
        return api
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    }
    contactCalls.push(calls)
    return api
  }

  function readBuilder(table: 'workspace' | 'crm_sync_state') {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      limit: () => api,
      maybeSingle: async () => ({
        data:
          table === 'workspace'
            ? { settings: rows.workspaceSettings ?? {} }
            : rows.syncState ?? null,
        error: null,
      }),
    }
    return api
  }

  return {
    client: {
      from: (table: string) =>
        table === 'contact' ? contactBuilder() : readBuilder(table as 'workspace' | 'crm_sync_state'),
    } as never,
    contactCalls,
  }
}

const EVENT = { data: { workspaceId: 'ws-1' } }

const ON: Record<string, unknown> = { push_contacts_to_hubspot: true }

function rows(n: number, prefix = 'c'): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    created_at: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
  }))
}

/** Step ids of every `step.run` call, in order. */
function runIds(step: StepMock): string[] {
  return step.run.mock.calls.map(([id]) => id as string)
}

/** Step ids of every `step.sendEvent` call, in order. */
function sendIds(step: StepMock): string[] {
  return step.sendEvent.mock.calls.map(([id]) => id as string)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---- Registration ----------------------------------------------------------

describe('hubspot-push-sweep — registration', () => {
  it('registers with the right id, trigger, retries, debounce, and keyed concurrency', () => {
    expect(hoisted.config.id).toBe('hubspot-push-sweep')
    expect(hoisted.config.triggers).toEqual([{ event: 'crm/hubspot-push-sweep' }])
    expect(hoisted.config.retries).toBe(2)
    expect(hoisted.config.debounce).toEqual({ key: 'event.data.workspaceId', period: '60s' })
    expect(hoisted.config.concurrency).toEqual([{ limit: 1, key: 'event.data.workspaceId' }])
  })
})

// ---- Guards ----------------------------------------------------------------

describe('hubspot-push-sweep — guards', () => {
  it('no-ops when the push toggle is off (no query, no fan-out)', async () => {
    const db = makeDb({ workspaceSettings: {}, syncState: { account_id: 'acct-1' } })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'flag_off' })
    expect(db.contactCalls).toHaveLength(0)
    expect(step.sendEvent).not.toHaveBeenCalled()
    // Only the guard step ran — no page steps were even created.
    expect(runIds(step)).toEqual(['load-guard'])
  })

  it('no-ops when the workspace has no crm_sync_state row', async () => {
    const db = makeDb({ workspaceSettings: ON, syncState: null })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_hubspot_account' })
    expect(db.contactCalls).toHaveLength(0)
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(runIds(step)).toEqual(['load-guard'])
  })
})

// ---- Eligibility query shape -----------------------------------------------

describe('hubspot-push-sweep — eligibility query', () => {
  it("scope 'manual' (default): filters source='manual' + the invariant gates", async () => {
    const db = makeDb({
      workspaceSettings: ON, // scope absent → manual
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(2)],
    })
    dbFake = db.client
    const step = makeStep()
    await hoisted.handler({ event: EVENT, step })

    const q = db.contactCalls[0]
    expect(q['eq:workspace_id']).toEqual(['workspace_id', 'ws-1'])
    expect(q['is:source_provider']).toEqual(['source_provider', null])
    expect(q['is:merged_into_contact_id']).toEqual(['merged_into_contact_id', null])
    expect(q['not:email']).toEqual(['email', 'is', null])
    expect(q['eq:source']).toEqual(['source', 'manual'])
    expect(q['neq:source']).toBeUndefined()
    // Ordered by (created_at, id), one page of PAGE_SIZE.
    expect(q.order).toEqual(['created_at', { ascending: true }])
    expect(q.order2).toEqual(['id', { ascending: true }])
    expect(q.limit).toEqual([100])
  })

  it("scope 'all': filters source != 'member' instead of source='manual'", async () => {
    const db = makeDb({
      workspaceSettings: { ...ON, push_contacts_scope: 'all' },
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(1)],
    })
    dbFake = db.client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    const q = db.contactCalls[0]
    expect(q['neq:source']).toEqual(['source', 'member'])
    expect(q['eq:source']).toBeUndefined()
  })

  it('does not apply a keyset cursor on the first (cursorless) invocation', async () => {
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(2)],
    })
    dbFake = db.client
    await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(db.contactCalls[0].or).toBeUndefined()
  })

  it('excludes contacts carrying the permanent-failure marker by default', async () => {
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(2)],
    })
    dbFake = db.client
    await hoisted.handler({ event: EVENT, step: makeStep() })
    // metadata->hubspot_push_error IS NULL → unmarked rows only.
    expect(db.contactCalls[0][FAILED_FILTER]).toEqual(['metadata->hubspot_push_error', null])
    // …and held rows (an unattended run's create) are never swept.
    expect(db.contactCalls[0][HOLD_FILTER]).toEqual(['metadata->hubspot_push_hold', null])
  })

  it('excludes HELD contacts even on a retry sweep (includeFailed re-admits failures, never holds)', async () => {
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(2)],
    })
    dbFake = db.client
    await hoisted.handler({ event: { ...EVENT, data: { ...EVENT.data, includeFailed: true } }, step: makeStep() })
    expect(db.contactCalls[0][FAILED_FILTER]).toBeUndefined()
    expect(db.contactCalls[0][HOLD_FILTER]).toEqual(['metadata->hubspot_push_hold', null])
  })

  it('includes marked contacts when the event asks for a retry (includeFailed)', async () => {
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(2)],
    })
    dbFake = db.client
    await hoisted.handler({
      event: { data: { workspaceId: 'ws-1', includeFailed: true } },
      step: makeStep(),
    })
    expect(db.contactCalls[0][FAILED_FILTER]).toBeUndefined()
  })

  it('treats a non-true includeFailed as off (still excludes marked contacts)', async () => {
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(2)],
    })
    dbFake = db.client
    await hoisted.handler({
      event: { data: { workspaceId: 'ws-1', includeFailed: 'yes' } },
      step: makeStep(),
    })
    expect(db.contactCalls[0][FAILED_FILTER]).toEqual(['metadata->hubspot_push_error', null])
  })

  it('applies the keyset cursor from the event data on a continuation', async () => {
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(2)],
    })
    dbFake = db.client
    await hoisted.handler({
      event: {
        data: { workspaceId: 'ws-1', cursorCreatedAt: '2026-07-10T00:00:00.000Z', cursorId: 'c-9' },
      },
      step: makeStep(),
    })
    // Keyset: rows strictly after (created_at, id).
    expect(db.contactCalls[0].or).toEqual([
      'created_at.gt.2026-07-10T00:00:00.000Z,and(created_at.eq.2026-07-10T00:00:00.000Z,id.gt.c-9)',
    ])
  })
})

// ---- Step structure --------------------------------------------------------

describe('hubspot-push-sweep — step structure', () => {
  it('uses one step.run per page (query only) with the fan-out BETWEEN steps', async () => {
    // Page 0 full (100) → keep going; page 1 short (2) → drained.
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(100, 'p0'), rows(2, 'p1')],
    })
    dbFake = db.client
    const step = makeStep()
    await hoisted.handler({ event: EVENT, step })

    // Per-page step ids, not one monolithic 'sweep-page-batch'.
    expect(runIds(step)).toEqual(['load-guard', 'sweep-page-0', 'sweep-page-1'])
    expect(sendIds(step)).toEqual(['push-batch-0', 'push-batch-1'])

    // Interleaving proves the sendEvent happens at the FUNCTION level, between
    // step.run calls: page-0 query → push-batch-0 → page-1 query → push-batch-1.
    // (A nested sendEvent would have thrown outright — see the tripwire tests.)
    const runOrder = step.run.mock.invocationCallOrder
    const sendOrder = step.sendEvent.mock.invocationCallOrder
    expect(runOrder[1]).toBeLessThan(sendOrder[0]) // sweep-page-0 before push-batch-0
    expect(sendOrder[0]).toBeLessThan(runOrder[2]) // push-batch-0 before sweep-page-1
    expect(runOrder[2]).toBeLessThan(sendOrder[1]) // sweep-page-1 before push-batch-1
  })

  it('threads the keyset cursor from each page tail into the next page query', async () => {
    const page0 = rows(100, 'p0')
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [page0, rows(3, 'p1')],
    })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'complete', emitted: 103 })
    // Page 0 had no cursor; page 1 is keyed off page 0's LAST row.
    const tail = page0[99]
    expect(db.contactCalls[0].or).toBeUndefined()
    expect(db.contactCalls[1].or).toEqual([
      `created_at.gt.${tail.created_at},and(created_at.eq.${tail.created_at},id.gt.${tail.id})`,
    ])
  })
})

// ---- Fan-out ---------------------------------------------------------------

describe('hubspot-push-sweep — fan-out', () => {
  it('emits one crm/hubspot-push-contact event per eligible contact', async () => {
    const page = [
      { id: 'ct-a', created_at: '2026-07-01T00:00:00.000Z' },
      { id: 'ct-b', created_at: '2026-07-02T00:00:00.000Z' },
      { id: 'ct-c', created_at: '2026-07-03T00:00:00.000Z' },
    ]
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [page],
    })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'complete', emitted: 3 })
    // A single batched sendEvent carrying one push event per contact.
    const batchCalls = step.sendEvent.mock.calls.filter(
      ([id]) => typeof id === 'string' && id.startsWith('push-batch-'),
    )
    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0][0]).toBe('push-batch-0')
    const payload = batchCalls[0][1] as Array<{ name: string; data: unknown }>
    expect(payload).toEqual([
      { name: 'crm/hubspot-push-contact', data: { contactId: 'ct-a', workspaceId: 'ws-1' } },
      { name: 'crm/hubspot-push-contact', data: { contactId: 'ct-b', workspaceId: 'ws-1' } },
      { name: 'crm/hubspot-push-contact', data: { contactId: 'ct-c', workspaceId: 'ws-1' } },
    ])
  })

  it('completes with zero emitted on an empty eligible set (no fan-out at all)', async () => {
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [[]],
    })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'complete', emitted: 0 })
    // Exactly one page query, no sendEvent of ANY kind: an empty page must not
    // fire an empty batch, and a drained sweep must not self-chain.
    expect(runIds(step)).toEqual(['load-guard', 'sweep-page-0'])
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(db.contactCalls).toHaveLength(1)
  })

  it('stops paging as soon as a page comes back empty', async () => {
    // Page 0 full → page 1 empty (the table drained exactly on a page boundary).
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(100, 'p0'), []],
    })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'complete', emitted: 100 })
    expect(runIds(step)).toEqual(['load-guard', 'sweep-page-0', 'sweep-page-1'])
    // Only page 0 fanned out; the empty page 1 emitted nothing and ended the run.
    expect(sendIds(step)).toEqual(['push-batch-0'])
  })
})

// ---- Paging + self-chain ---------------------------------------------------

describe('hubspot-push-sweep — paging + self-chain', () => {
  it('completes (no self-chain) when a page is shorter than PAGE_SIZE', async () => {
    // A 50-row page (< 100) means the table drained → complete, no continuation.
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: [rows(50)],
    })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'complete', emitted: 50 })
    expect(db.contactCalls).toHaveLength(1)
    expect(sendIds(step)).toEqual(['push-batch-0'])
    expect(step.sendEvent).not.toHaveBeenCalledWith('continue-sweep', expect.anything())
  })

  it('self-chains past the per-run page cap, carrying a keyset cursor', async () => {
    // Every page is a FULL 100 rows → the loop never drains within the cap and
    // must self-chain. Queue enough full pages to exhaust MAX_PAGES_PER_RUN (20).
    const fullPages = Array.from({ length: 25 }, (_, p) => rows(100, `p${p}`))
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: fullPages,
    })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'continued' })
    // Read exactly the per-run cap of pages (20), not more.
    expect(db.contactCalls).toHaveLength(20)
    // 20 pages * 100 = 2000 emitted this invocation.
    expect(out).toMatchObject({ emitted: 2000 })
    // 20 page steps (+ the guard) and 20 batches (+ the continuation).
    expect(runIds(step)).toEqual([
      'load-guard',
      ...Array.from({ length: 20 }, (_, p) => `sweep-page-${p}`),
    ])
    expect(sendIds(step)).toEqual([
      ...Array.from({ length: 20 }, (_, p) => `push-batch-${p}`),
      'continue-sweep',
    ])

    // The continuation carries the keyset cursor = the last row of page 19.
    const cont = step.sendEvent.mock.calls.find(([id]) => id === 'continue-sweep')
    expect(cont).toBeTruthy()
    const lastRow = fullPages[19][99]
    expect(cont?.[1]).toEqual({
      name: 'crm/hubspot-push-sweep',
      data: {
        workspaceId: 'ws-1',
        cursorCreatedAt: lastRow.created_at,
        cursorId: lastRow.id,
        includeFailed: false,
      },
    })
  })

  it('carries includeFailed through the self-chain (a retry stays a retry)', async () => {
    // Without this, only page 1 of a retry sweep re-attempts the marked
    // contacts — every continuation silently reverts to the routine filter.
    const fullPages = Array.from({ length: 25 }, (_, p) => rows(100, `p${p}`))
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: fullPages,
    })
    dbFake = db.client
    const step = makeStep()
    const out = await hoisted.handler({
      event: { data: { workspaceId: 'ws-1', includeFailed: true } },
      step,
    })

    expect(out).toMatchObject({ status: 'continued' })
    // Every page of this run kept the retry mode (no marker filter anywhere).
    for (const call of db.contactCalls) {
      expect(call[FAILED_FILTER]).toBeUndefined()
    }
    const cont = step.sendEvent.mock.calls.find(([id]) => id === 'continue-sweep')
    expect((cont?.[1] as { data: Record<string, unknown> }).data).toMatchObject({
      includeFailed: true,
    })
  })

  it('resumes from the event cursor and keeps threading it across pages', async () => {
    const fullPages = Array.from({ length: 25 }, (_, p) => rows(100, `p${p}`))
    const db = makeDb({
      workspaceSettings: ON,
      syncState: { account_id: 'acct-1' },
      contactPages: fullPages,
    })
    dbFake = db.client
    const step = makeStep()
    await hoisted.handler({
      event: {
        data: { workspaceId: 'ws-1', cursorCreatedAt: '2026-07-10T00:00:00.000Z', cursorId: 'c-9' },
      },
      step,
    })

    // Page 0 uses the event cursor; every later page uses the previous tail.
    expect(db.contactCalls[0].or).toEqual([
      'created_at.gt.2026-07-10T00:00:00.000Z,and(created_at.eq.2026-07-10T00:00:00.000Z,id.gt.c-9)',
    ])
    for (let p = 1; p < 20; p++) {
      const tail = fullPages[p - 1][99]
      expect(db.contactCalls[p].or).toEqual([
        `created_at.gt.${tail.created_at},and(created_at.eq.${tail.created_at},id.gt.${tail.id})`,
      ])
    }
  })
})

// ---- Tripwire regression ---------------------------------------------------

/**
 * The bug this file's restructure fixes was invisible to tests because the old
 * hand-rolled step mock happily executed a nested `step.sendEvent`. These tests
 * assert the SHARED mock now refuses it, so the class of bug can't come back
 * silently — here or in any other Inngest function using the same mock.
 */
describe('inngest step mock — nesting tripwire', () => {
  it('throws when step.sendEvent is called inside a step.run callback', async () => {
    const step = createStepMock()
    await expect(
      step.run('outer', async () => {
        await step.sendEvent('nested', [{ name: 'x', data: {} }])
        return 'unreachable'
      }),
    ).rejects.toThrow(NESTED_STEP_ERROR)
  })

  it('throws for a nested step.run, including after an await inside the callback', async () => {
    const step = createStepMock()
    await expect(
      step.run('outer', async () => {
        await Promise.resolve()
        return step.run('nested', async () => 'nope')
      }),
    ).rejects.toThrow(NESTED_STEP_ERROR)
  })

  it('throws for nesting inside a helper called by the callback', async () => {
    const step = createStepMock()
    const helper = async () => {
      await step.sleep('nested-sleep', '1s')
    }
    await expect(step.run('outer', async () => helper())).rejects.toThrow(NESTED_STEP_ERROR)
  })

  it('allows sequential and parallel TOP-LEVEL step calls', async () => {
    const step = createStepMock()
    const [a, b] = await Promise.all([
      step.run('a', async () => 1),
      step.run('b', async () => 2),
    ])
    expect([a, b]).toEqual([1, 2])
    await expect(step.sendEvent('c', [{ name: 'x', data: {} }])).resolves.toBeTruthy()
  })
})
