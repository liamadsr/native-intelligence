import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/hubspot-functions.ts via the createFunction-capture
 * pattern (canonical: capture-ingest.test.ts). Both functions are captured off
 * the mocked inngest.createFunction so their handlers run directly.
 *
 * Invariants locked in:
 *  - Initial import: companies-then-contacts ordering, cursor persisted per
 *    page, sync_watermark snapshotted BEFORE listing, status transitions,
 *    self-chain when pages exceed the bound, already-complete short-circuit.
 *  - Incremental: no-ops without a watermark / incomplete import; advances the
 *    watermark monotonically (never regresses).
 */

// ---- Hoisted capture of BOTH inngest functions ----------------------------

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  configs: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handlers[config.id as string] = fn
      hoisted.configs[config.id as string] = config
      return { id: config.id }
    },
  },
}))

// getServiceClient returns a per-test fake, swapped in beforeEach.
let dbFake: unknown = { from: vi.fn() }
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

// Token resolver — default returns a token; tests override to null.
const hoistedToken = vi.hoisted(() => ({
  getValidTokenForAccount: vi.fn(async (_id: string) => ({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  }) as { token: string; email: null; accountId: string } | null),
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

// HubSpot API — list/search stubs. Tests set the queued pages.
const hoistedApi = vi.hoisted(() => ({
  listObjects: vi.fn(),
  advanceSearchWatermark: vi.fn(),
}))
vi.mock('@/lib/integrations/hubspot-api', () => ({
  listObjects: hoistedApi.listObjects,
  advanceSearchWatermark: hoistedApi.advanceSearchWatermark,
  CONTACT_PROPERTIES: ['email'],
  COMPANY_PROPERTIES: ['name'],
}))

// Upsert engine — spied so we assert routing without real DB writes.
const hoistedSync = vi.hoisted(() => ({
  upsertHubspotCompany: vi.fn(async () => ({ action: 'inserted', id: 'x', companyId: 'x' })),
  upsertHubspotContact: vi.fn(async () => ({ action: 'inserted', id: 'x' })),
}))
vi.mock('@/lib/crm/hubspot-sync', () => ({
  upsertHubspotCompany: hoistedSync.upsertHubspotCompany,
  upsertHubspotContact: hoistedSync.upsertHubspotContact,
}))

// The importer (roadmap track G3): the initial backfill stages its pages into
// one import batch; spied so we assert what was staged, in order.
const hoistedImport = vi.hoisted(() => ({
  stagingBatchForAccount: vi.fn(async () => null as { id: string } | null),
  createImportBatch: vi.fn(async () => ({ ok: true, batch: { id: 'batch-1' } })),
  loadImportBatch: vi.fn(async () => ({ id: 'batch-1' })),
  stageRecords: vi.fn(async (_db: unknown, _batch: unknown, records: unknown[]) => ({ staged: records.length, skipped: 0 })),
}))
vi.mock('@/lib/crm/import/batch', () => hoistedImport)
vi.mock('@/lib/crm/import/run', () => ({ CONTACT_IMPORT_APPLY: 'crm/import.apply' }))

/** The kinds of records each stageRecords call staged, in order. */
const stagedKinds = () => hoistedImport.stageRecords.mock.calls.map((c) => (c[2] as Array<{ kind: string }>).map((r) => r.kind))

// The import's Activity row (src/lib/work/import-mirror.ts) — spied so we
// assert the run is opened, stepped and settled with the right run identity.
const hoistedLedger = vi.hoisted(() => ({
  openHubspotImport: vi.fn(async () => {}),
  stepHubspotImport: vi.fn(async () => {}),
  finishHubspotImport: vi.fn(async () => {}),
  failHubspotImport: vi.fn(async () => {}),
}))
vi.mock('@/lib/work/import-mirror', () => hoistedLedger)

// Evaluate the module so both createFunction calls run.
await import('@/lib/inngest/hubspot-functions')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — vi.fn per method plus the nesting tripwire
 * (step tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = { data: { userId: 'u-1', workspaceId: 'ws-1', accountId: 'acct-1' } }

/**
 * A crm_sync_state fake supporting the query shapes the functions issue:
 *   .from('crm_sync_state').select(..).eq('account_id', id).maybeSingle()  → read
 *   .from('crm_sync_state').update(patch).eq('account_id', id)             → write
 * Reads return the CURRENT (mutable) state; writes merge into it and are
 * recorded so tests can assert the transition sequence.
 */
function makeStateDb(initial: Record<string, unknown> | null) {
  let state = initial ? { ...initial } : null
  const updates: Array<Record<string, unknown>> = []

  function builder() {
    let mode: 'select' | 'update' | 'upsert' = 'select'
    let patch: Record<string, unknown> | null = null
    // Conditional-write guards accumulated via `.lt(col, val)` before the
    // terminal `.eq('account_id', id)` applies the update.
    const ltGuards: Array<{ col: string; val: unknown }> = []
    let applied = false

    // Apply a pending update once its terminal `.eq` lands, honoring any `.lt`
    // guards (mirrors PostgREST: the UPDATE only touches rows matching them; a
    // NULL column never satisfies `.lt`).
    function apply() {
      if (mode !== 'update' || !patch || applied) return
      const guardsPass = ltGuards.every(({ col, val }) => {
        const cur = state?.[col]
        if (cur === null || cur === undefined) return false
        return (cur as string) < (val as string)
      })
      if (guardsPass) {
        updates.push(patch)
        state = { ...(state ?? {}), ...patch }
      }
      patch = null
      applied = true
    }

    const api: Record<string, unknown> = {
      select: () => api,
      update: (p: Record<string, unknown>) => {
        mode = 'update'
        patch = p
        return api
      },
      upsert: (row: Record<string, unknown>) => {
        mode = 'upsert'
        if (!state) state = { ...row }
        return api
      },
      lt: (col: string, val: unknown) => {
        ltGuards.push({ col, val })
        return api
      },
      eq: () => {
        // Filters are collected, NOT applied here — PostgREST applies all
        // filters (`.eq`, `.lt`, …) atomically at execution regardless of call
        // order, so committing on `.eq` would ignore a `.lt` guard chained after
        // it (as the conditional watermark write does). Commit happens on await.
        return api
      },
      maybeSingle: async () => ({ data: state, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        // Awaiting the builder executes the query — this is where an update
        // (with any accumulated filters) commits.
        apply()
        return Promise.resolve({ data: state, error: null }).then(resolve)
      },
    }
    return api
  }

  return {
    client: { from: () => builder() } as never,
    updates,
    getState: () => state,
  }
}

function page(results: unknown[], after?: string) {
  return { results, paging: after ? { next: { after } } : undefined }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
})

// ---- Config wiring ---------------------------------------------------------

describe('hubspot-functions — registration', () => {
  it('registers both functions with the right ids + triggers', () => {
    expect(hoisted.configs['hubspot-initial-import'].triggers).toEqual([
      { event: 'crm/hubspot-initial-import' },
    ])
    expect(hoisted.configs['hubspot-incremental-sync'].triggers).toEqual([
      { event: 'crm/hubspot-incremental-sync' },
    ])
    expect(hoisted.configs['hubspot-incremental-sync'].debounce).toMatchObject({
      key: 'event.data.accountId',
    })
  })

  // FINDING 4: both functions must serialize per-account so overlapping runs
  // can't race crm_sync_state read-modify-writes. Different accounts stay
  // parallel (the key scopes the limit).
  it('keys concurrency on the account so runs for one account serialize', () => {
    expect(hoisted.configs['hubspot-initial-import'].concurrency).toEqual([
      { limit: 1, key: 'event.data.accountId' },
    ])
    expect(hoisted.configs['hubspot-incremental-sync'].concurrency).toEqual([
      { limit: 1, key: 'event.data.accountId' },
    ])
  })
})

// ---- Initial import --------------------------------------------------------

describe('hubspotInitialImport', () => {
  it('happy path: companies then contacts, watermark snapshotted before listing, completes', async () => {
    const db = makeStateDb({ initial_import_status: 'pending' })
    dbFake = db.client
    // 1 page of companies (no cursor), then 1 page of contacts (no cursor).
    hoistedApi.listObjects
      .mockResolvedValueOnce(page([{ id: 'co1', properties: {} }])) // companies
      .mockResolvedValueOnce(page([{ id: 'p1', properties: {} }])) // contacts
    const step = makeStep()

    const result = await hoistedInitial()({ event: EVENT, step })

    expect(result).toMatchObject({ status: 'complete' })
    // Watermark set in the first step, before any listObjects call.
    const firstPatch = db.updates[0]
    expect(firstPatch.initial_import_status).toBe('importing_companies')
    expect(firstPatch.sync_watermark).toBeTruthy()
    expect(firstPatch.initial_import_started_at).toBeTruthy()
    // Companies staged before contacts, into one import batch, never upserted directly.
    expect(stagedKinds()).toEqual([['company'], ['contact']])
    expect(hoistedImport.createImportBatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'hubspot', accountId: 'acct-1', workspaceId: 'ws-1', userId: 'u-1', notify: true }))
    expect(hoistedSync.upsertHubspotCompany).not.toHaveBeenCalled()
    expect(hoistedSync.upsertHubspotContact).not.toHaveBeenCalled()
    // Final state: complete, and the importer is asked to apply the batch.
    expect(db.getState()?.initial_import_status).toBe('complete')
    expect(db.getState()?.initial_import_completed_at).toBeTruthy()
    expect(step.sendEvent).toHaveBeenCalledWith('apply-import', { name: 'crm/import.apply', data: { batchId: 'batch-1', workspaceId: 'ws-1' } })
  })

  it('a self-chained continuation stages into the batch still staging (no second batch)', async () => {
    const db = makeStateDb({ initial_import_status: 'importing_contacts', initial_import_started_at: '2026-10-31T00:00:00Z', sync_watermark: '2026-10-31T00:00:00Z' })
    dbFake = db.client
    hoistedImport.stagingBatchForAccount.mockResolvedValueOnce({ id: 'batch-0' })
    hoistedApi.listObjects.mockResolvedValueOnce(page([{ id: 'p1', properties: { email: 'a@b.com' } }]))
    const step = makeStep()

    await hoistedInitial()({ event: EVENT, step })

    expect(hoistedImport.createImportBatch).not.toHaveBeenCalled()
    expect(stagedKinds()).toEqual([['contact']])
    expect(step.sendEvent).toHaveBeenCalledWith('apply-import', { name: 'crm/import.apply', data: { batchId: 'batch-0', workspaceId: 'ws-1' } })
  })

  it('persists the cursor + running total after every page', async () => {
    const db = makeStateDb({ initial_import_status: 'pending' })
    dbFake = db.client
    // Companies: 2 pages (cursor c2 then done), contacts: 1 page.
    hoistedApi.listObjects
      .mockResolvedValueOnce(page([{ id: 'co1', properties: {} }], 'c2'))
      .mockResolvedValueOnce(page([{ id: 'co2', properties: {} }]))
      .mockResolvedValueOnce(page([{ id: 'p1', properties: {} }]))
    const step = makeStep()

    await hoistedInitial()({ event: EVENT, step })

    // A per-page update carried the cursor c2 then null.
    const cursorPatches = db.updates.filter((u) => 'companies_cursor' in u)
    expect(cursorPatches[0].companies_cursor).toBe('c2')
    expect(cursorPatches[0].total_companies_synced).toBe(1)
    // A later company patch cleared the cursor to null with total 2.
    const cleared = cursorPatches.find((u) => u.companies_cursor === null && u.total_companies_synced === 2)
    expect(cleared).toBeTruthy()
  })

  it('self-chains when companies exceed the per-run page bound', async () => {
    const db = makeStateDb({ initial_import_status: 'pending' })
    dbFake = db.client
    // Every listObjects returns a fresh cursor → never terminates within bound.
    hoistedApi.listObjects.mockResolvedValue(page([{ id: 'co', properties: {} }], 'more'))
    const step = makeStep()

    const result = await hoistedInitial()({ event: EVENT, step })

    expect(result).toMatchObject({ status: 'continued', phase: 'companies' })
    expect(step.sendEvent).toHaveBeenCalledWith('continue-import-companies', {
      name: 'crm/hubspot-initial-import',
      data: { userId: 'u-1', workspaceId: 'ws-1', accountId: 'acct-1' },
    })
    // Bounded at 50 pages/run.
    expect(hoistedApi.listObjects).toHaveBeenCalledTimes(50)
    // Contacts were never touched this invocation, and nothing is applied yet.
    expect(stagedKinds().flat().every((k) => k === 'company')).toBe(true)
    expect(step.sendEvent).not.toHaveBeenCalledWith('apply-import', expect.anything())
  })

  it('short-circuits when the import is already complete', async () => {
    const db = makeStateDb({ initial_import_status: 'complete' })
    dbFake = db.client
    const step = makeStep()

    const result = await hoistedInitial()({ event: EVENT, step })

    expect(result).toMatchObject({ status: 'already_complete' })
    expect(hoistedApi.listObjects).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('does not re-snapshot the watermark on a self-chained continuation', async () => {
    // Resuming mid-import: watermark + started_at already set.
    const db = makeStateDb({
      initial_import_status: 'importing_companies',
      initial_import_started_at: '2026-07-24T00:00:00Z',
      sync_watermark: '2026-07-24T00:00:00Z',
      companies_cursor: 'resume-cursor',
      total_companies_synced: 100,
    })
    dbFake = db.client
    hoistedApi.listObjects
      .mockResolvedValueOnce(page([{ id: 'co', properties: {} }])) // companies done
      .mockResolvedValueOnce(page([{ id: 'p', properties: {} }])) // contacts done
    const step = makeStep()

    await hoistedInitial()({ event: EVENT, step })

    // The first status patch must NOT overwrite the existing watermark/start.
    const firstPatch = db.updates[0]
    expect(firstPatch.sync_watermark).toBeUndefined()
    expect(firstPatch.initial_import_started_at).toBeUndefined()
    // Resumed from the stored cursor.
    expect(hoistedApi.listObjects.mock.calls[0][2].after).toBe('resume-cursor')
  })

  it('a contacts-phase continuation keeps the importing_contacts status (no restart loop)', async () => {
    const db = makeStateDb({
      initial_import_status: 'importing_contacts',
      initial_import_started_at: '2026-07-24T00:00:00Z',
      sync_watermark: '2026-07-24T00:00:00Z',
      contacts_cursor: 'contacts-resume',
      total_companies_synced: 40,
      total_contacts_synced: 5000,
    })
    dbFake = db.client
    hoistedApi.listObjects.mockResolvedValueOnce(page([{ id: 'p', properties: {} }]))
    const step = makeStep()

    await hoistedInitial()({ event: EVENT, step })

    // The start patch must not push the stored status back to the companies phase.
    expect(db.updates[0].initial_import_status).toBe('importing_contacts')
    expect(hoistedApi.listObjects.mock.calls[0][2].after).toBe('contacts-resume')
  })

  it('marks failed (does not throw) when no token is available', async () => {
    const db = makeStateDb({ initial_import_status: 'pending' })
    dbFake = db.client
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const step = makeStep()

    const result = await hoistedInitial()({ event: EVENT, step })

    expect(result).toMatchObject({ status: 'failed', reason: 'no_token' })
    expect(db.getState()?.initial_import_status).toBe('failed')
    expect(db.getState()?.last_sync_error).toContain('token')
  })
})

describe('hubspotInitialImport — the Activity row', () => {
  const REF = { accountId: 'acct-1', workspaceId: 'ws-1', userId: 'u-1' }

  it('opens a fresh run keyed on the start it stamps, steps per phase, finishes with the totals', async () => {
    const db = makeStateDb({ initial_import_status: 'pending' })
    dbFake = db.client
    hoistedApi.listObjects
      .mockResolvedValueOnce(page([{ id: 'co1', properties: {} }]))
      .mockResolvedValueOnce(page([{ id: 'p1', properties: {} }]))

    await hoistedInitial()({ event: EVENT, step: makeStep() })

    const startedAt = db.updates[0].initial_import_started_at
    expect(startedAt).toBeTruthy()
    const ref = { ...REF, startedAt }
    expect(hoistedLedger.openHubspotImport).toHaveBeenCalledWith(db.client, ref, true)
    expect(hoistedLedger.stepHubspotImport.mock.calls.map((c) => c.slice(1))).toEqual([
      [ref, 1, null],
      [ref, 1, 1],
    ])
    expect(hoistedLedger.finishHubspotImport).toHaveBeenCalledWith(db.client, ref, 1, 1)
    expect(hoistedLedger.failHubspotImport).not.toHaveBeenCalled()
  })

  it('a self-chained continuation finds the same run by its stored start', async () => {
    const db = makeStateDb({
      initial_import_status: 'importing_contacts',
      initial_import_started_at: '2026-07-24T00:00:00Z',
      sync_watermark: '2026-07-24T00:00:00Z',
      total_companies_synced: 40,
      total_contacts_synced: 7,
    })
    dbFake = db.client
    hoistedApi.listObjects.mockResolvedValueOnce(page([{ id: 'p', properties: {} }]))

    await hoistedInitial()({ event: EVENT, step: makeStep() })

    const ref = { ...REF, startedAt: '2026-07-24T00:00:00Z' }
    expect(hoistedLedger.openHubspotImport).toHaveBeenCalledWith(db.client, ref, false)
    expect(hoistedLedger.finishHubspotImport).toHaveBeenCalledWith(db.client, ref, 40, 8)
  })

  it('a re-kick after a failure re-stamps the start, so it is a new run rather than the failed one reopened', async () => {
    const db = makeStateDb({
      initial_import_status: 'failed',
      initial_import_started_at: '2026-07-24T00:00:00Z',
      sync_watermark: '2026-07-24T00:00:00Z',
    })
    dbFake = db.client
    hoistedApi.listObjects
      .mockResolvedValueOnce(page([{ id: 'co1', properties: {} }]))
      .mockResolvedValueOnce(page([{ id: 'p1', properties: {} }]))

    await hoistedInitial()({ event: EVENT, step: makeStep() })

    const restamped = db.updates[0].initial_import_started_at as string
    expect(restamped).toBeTruthy()
    expect(restamped).not.toBe('2026-07-24T00:00:00Z')
    // The watermark is not re-snapshotted: incremental sync still covers the gap.
    expect(db.updates[0].sync_watermark).toBeUndefined()
    expect(hoistedLedger.openHubspotImport).toHaveBeenCalledWith(db.client, { ...REF, startedAt: restamped }, true)
  })

  it('fails the run with a reason the user can act on when no token is available', async () => {
    const db = makeStateDb({ initial_import_status: 'pending' })
    dbFake = db.client
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)

    await hoistedInitial()({ event: EVENT, step: makeStep() })

    expect(hoistedLedger.failHubspotImport).toHaveBeenCalledWith(
      db.client,
      expect.objectContaining(REF),
      'No valid HubSpot token for this account — reconnect HubSpot',
    )
    expect(hoistedLedger.finishHubspotImport).not.toHaveBeenCalled()
  })

  it('opens nothing when the import is already complete', async () => {
    dbFake = makeStateDb({ initial_import_status: 'complete' }).client
    await hoistedInitial()({ event: EVENT, step: makeStep() })
    expect(hoistedLedger.openHubspotImport).not.toHaveBeenCalled()
  })
})

// ---- Incremental sync ------------------------------------------------------

describe('hubspotIncrementalSync', () => {
  it('no-ops without any sync state', async () => {
    dbFake = makeStateDb(null).client
    const step = makeStep()
    const result = await hoistedIncremental()({ event: EVENT, step })
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_state' })
    expect(hoistedApi.advanceSearchWatermark).not.toHaveBeenCalled()
  })

  it('no-ops when the initial import is not complete', async () => {
    dbFake = makeStateDb({ initial_import_status: 'importing_contacts', sync_watermark: 'x' }).client
    const step = makeStep()
    const result = await hoistedIncremental()({ event: EVENT, step })
    expect(result).toMatchObject({ status: 'skipped', reason: 'import_incomplete' })
  })

  it('no-ops when complete but the watermark is missing', async () => {
    dbFake = makeStateDb({ initial_import_status: 'complete', sync_watermark: null }).client
    const step = makeStep()
    const result = await hoistedIncremental()({ event: EVENT, step })
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_watermark' })
  })

  it('advances the watermark monotonically to the max seen', async () => {
    const past = '2026-07-24T00:00:00.000Z'
    const db = makeStateDb({ initial_import_status: 'complete', sync_watermark: past })
    dbFake = db.client
    const newerMs = Date.parse('2026-07-25T00:00:00.000Z')
    hoistedApi.advanceSearchWatermark
      .mockResolvedValueOnce({ watermark: newerMs, totalSeen: 3, pagesFetched: 1 }) // companies
      .mockResolvedValueOnce({ watermark: Date.parse(past), totalSeen: 0, pagesFetched: 1 }) // contacts
    const step = makeStep()

    const result = await hoistedIncremental()({ event: EVENT, step })

    expect(result).toMatchObject({ status: 'synced' })
    // Persisted watermark advanced to the newer company timestamp.
    expect(db.getState()?.sync_watermark).toBe(new Date(newerMs).toISOString())
  })

  it('never regresses the watermark when nothing newer is seen', async () => {
    const current = '2026-07-24T00:00:00.000Z'
    const db = makeStateDb({ initial_import_status: 'complete', sync_watermark: current })
    dbFake = db.client
    // Both passes return an OLDER watermark than what's stored.
    const olderMs = Date.parse('2026-07-20T00:00:00.000Z')
    hoistedApi.advanceSearchWatermark
      .mockResolvedValueOnce({ watermark: olderMs, totalSeen: 0, pagesFetched: 1 })
      .mockResolvedValueOnce({ watermark: olderMs, totalSeen: 0, pagesFetched: 1 })
    const step = makeStep()

    await hoistedIncremental()({ event: EVENT, step })

    // Watermark stays at the (newer) stored value.
    expect(db.getState()?.sync_watermark).toBe(current)
  })

  // FINDING 4: the watermark persist is a CONDITIONAL (.lt-guarded) update, so a
  // lower value is a row-level no-op even if a concurrent writer stored a newer
  // watermark between our read and write — the DB invariant holds regardless of
  // the scheduler. Counters/last_sync_at still update (they're written
  // unconditionally in a separate statement).
  it('watermark persist with a lower value is a no-op (conditional update)', async () => {
    const stored = '2026-07-24T00:00:00.000Z'
    const db = makeStateDb({
      initial_import_status: 'complete',
      sync_watermark: stored,
      total_companies_synced: 10,
      total_contacts_synced: 20,
    })
    dbFake = db.client
    // Search yields OLDER results but non-zero counts.
    const olderMs = Date.parse('2026-07-20T00:00:00.000Z')
    hoistedApi.advanceSearchWatermark
      .mockResolvedValueOnce({ watermark: olderMs, totalSeen: 2, pagesFetched: 1 })
      .mockResolvedValueOnce({ watermark: olderMs, totalSeen: 3, pagesFetched: 1 })
    const step = makeStep()

    await hoistedIncremental()({ event: EVENT, step })

    // The .lt guard rejected the regressive watermark write → unchanged.
    expect(db.getState()?.sync_watermark).toBe(stored)
    // But the unconditional counters/last_sync_at update still landed.
    expect(db.getState()?.total_companies_synced).toBe(12)
    expect(db.getState()?.total_contacts_synced).toBe(23)
    expect(db.getState()?.last_sync_at).toBeTruthy()
    // No `sync_watermark` key appeared in any COMMITTED update patch.
    expect(db.updates.some((u) => 'sync_watermark' in u)).toBe(false)
  })

  it('advances the watermark when the stored one is strictly older (guard passes)', async () => {
    const older = '1970-01-01T00:00:00.000Z'
    const db = makeStateDb({ initial_import_status: 'complete', sync_watermark: older })
    dbFake = db.client
    const newerMs = Date.parse('2026-07-25T00:00:00.000Z')
    hoistedApi.advanceSearchWatermark
      .mockResolvedValueOnce({ watermark: newerMs, totalSeen: 1, pagesFetched: 1 })
      .mockResolvedValueOnce({ watermark: 0, totalSeen: 0, pagesFetched: 1 })
    const step = makeStep()

    await hoistedIncremental()({ event: EVENT, step })

    // stored (epoch) < next → the .lt guard admits the advance.
    expect(db.getState()?.sync_watermark).toBe(new Date(newerMs).toISOString())
  })

  it('skips (does not throw) when no token is available', async () => {
    const db = makeStateDb({ initial_import_status: 'complete', sync_watermark: '2026-07-24T00:00:00Z' })
    dbFake = db.client
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const step = makeStep()

    const result = await hoistedIncremental()({ event: EVENT, step })
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_token' })
    expect(hoistedApi.advanceSearchWatermark).not.toHaveBeenCalled()
  })
})

// ---- Handler accessors (evaluated after module import) ---------------------

function hoistedInitial(): Handler {
  return hoisted.handlers['hubspot-initial-import']
}
function hoistedIncremental(): Handler {
  return hoisted.handlers['hubspot-incremental-sync']
}
