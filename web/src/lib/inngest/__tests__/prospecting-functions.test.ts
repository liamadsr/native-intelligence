/**
 * The Inngest wrapper for the discovery run (spec §7, §15).
 *
 * The createFunction-capture pattern (canonical: hubspot-push-sweep.test.ts):
 * `inngest.createFunction` is mocked so the config and handler are captured,
 * and the handler is invoked directly with `createStepMock()`.
 *
 * `createStepMock()` IS MANDATORY here and this file is the reason. Its
 * AsyncLocalStorage tripwire is the only thing that catches a `step.*` call
 * made from inside a `step.run` callback — which does not throw in production,
 * it hangs for minutes having done nothing (the hubspot-push-sweep incident,
 * which swept thousands of contacts while emitting zero events, and whose
 * hand-rolled mock happily allowed it). Every test in this file goes through
 * that mock, so the tripwire is armed on every path.
 *
 * The wrapper's whole job is: claim the row, run the engine, and make sure a
 * throw does not leave the row spinning at `running` forever. The engine's own
 * behaviour is tested in `src/lib/prospecting/__tests__/run.test.ts`.
 *
 * The failure half of that job moved OUT of the handler. It used to be decided
 * by comparing `ctx.attempt` against the retry count, which was observed live
 * NOT to fire under the real Inngest dev server — a run whose only step threw
 * on every attempt sat at `running` forever. So the last-attempt inference is
 * gone and Inngest's own `onFailure` hook writes the status instead; the tests
 * below invoke that hook directly with a synthetic `inngest/function.failed`
 * payload, whose original event is nested at `event.data.event`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'
import { createStepMock, NESTED_STEP_ERROR } from '@/test/inngest-step-mock'

type Handler = (ctx: unknown) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  registrations: [] as Array<{ config: Record<string, unknown>; handler: Handler }>,
  executeDiscoveryRun: vi.fn(),
  executeAccountCardRun: vi.fn(),
  executePeopleRun: vi.fn(),
  guardBackgroundUsage: vi.fn(),
  guardBackgroundUsageOnPlan: vi.fn(async () => ({ chatgptPlan: true })),
  chatgptPlanFor: vi.fn(async (_userId: unknown, _opts?: unknown) => false),
  planDeepSearch: vi.fn(),
  chainProfileRun: vi.fn(),
  supabase: { from: vi.fn() },
  // Row 6: the run's Activity row. Mocked so the ledger never reaches this
  // suite's recording fake; the wiring is asserted below.
  mirror: { progress: vi.fn(), settle: vi.fn() },
  createProspectingRunMirror: vi.fn(),
  settleProspectingWorkByRun: vi.fn(async () => {}),
}))

vi.mock('@/lib/inngest/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/inngest/client')>(
    '@/lib/inngest/client',
  )
  return {
    ...actual,
    inngest: {
      createFunction: (config: Record<string, unknown>, handler: Handler) => {
        hoisted.registrations.push({ config, handler })
        return { id: config.id }
      },
    },
  }
})

vi.mock('@/lib/inngest/usage-guard', () => ({
  guardBackgroundUsage: hoisted.guardBackgroundUsage,
  guardBackgroundUsageOnPlan: hoisted.guardBackgroundUsageOnPlan,
}))

// The free tier: whether the run's person is on their own ChatGPT plan, and
// the plan's search.
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: hoisted.chatgptPlanFor }))
vi.mock('@/lib/web-research/plan-deep-search', () => ({ planDeepSearch: hoisted.planDeepSearch }))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => hoisted.supabase,
}))

// PARTIAL, not a stub. The wrapper now imports all three engines, and the two
// per-company ones reach `schemas.ts`, whose module-load property-cap
// assertions call `countSchemaProperties` from this very module. A full stub
// makes that assertion throw at import time — a failure that looks nothing
// like its cause.
vi.mock('@/lib/exa/deep-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exa/deep-search')>()),
  deepSearch: vi.fn(),
}))

vi.mock('@/lib/prospecting/run', () => ({
  executeDiscoveryRun: hoisted.executeDiscoveryRun,
}))

vi.mock('@/lib/prospecting/account-run', () => ({
  executeAccountCardRun: hoisted.executeAccountCardRun,
}))

vi.mock('@/lib/prospecting/people-run', () => ({
  executePeopleRun: hoisted.executePeopleRun,
}))
vi.mock('@/lib/prospecting/runs', () => ({
  chainProfileRun: hoisted.chainProfileRun,
}))
vi.mock('@/lib/work/prospecting-run-mirror', () => ({
  createProspectingRunMirror: (...args: unknown[]) => {
    hoisted.createProspectingRunMirror(...args)
    return hoisted.mirror
  },
  settleProspectingWorkByRun: hoisted.settleProspectingWorkByRun,
}))

const { PROSPECTING_INNGEST_RETRIES, CLAIMABLE_STATUSES, RUNNABLE_STATUSES, prospectingRunOnFailure } =
  await import('@/lib/inngest/prospecting-functions')
const { PROSPECTING_RUN_CANCEL, PROSPECTING_RUN_REQUESTED } = await import(
  '@/lib/inngest/client'
)

const registration = () => {
  const found = hoisted.registrations.find((r) => r.config.id === 'prospecting-run-execute')
  if (!found) throw new Error('prospecting-run-execute was never registered')
  return found
}

const EVENT = {
  data: { runId: 'run-1', workspaceId: 'ws-1', listId: 'list-1', userId: 'user-1' },
}

// ---------------------------------------------------------------------------
// A minimal Supabase fake that records the update chains the wrapper builds.
// ---------------------------------------------------------------------------

interface Recorded {
  table: string
  payload?: unknown
  filters: Array<[string, unknown]>
  in?: [string, string[]]
}

function fakeSupabase(claimResult: {
  rows: unknown[]
  error?: { message: string }
  /** What the claim's fallback read of a `canceling` row returns. */
  canceling?: unknown
}) {
  const recorded: Recorded[] = []
  hoisted.supabase.from = vi.fn((table: string) => {
    const entry: Recorded = { table, filters: [] }
    recorded.push(entry)
    const b: Record<string, unknown> = {}
    let selected = false
    Object.assign(b, {
      update: (payload: unknown) => {
        entry.payload = payload
        return b
      },
      eq: (col: string, val: unknown) => {
        entry.filters.push([col, val])
        return b
      },
      in: (col: string, vals: string[]) => {
        entry.in = [col, vals]
        return b
      },
      select: () => {
        selected = true
        return b
      },
      maybeSingle: async () => ({ data: claimResult.canceling ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) =>
        ok(selected ? { data: claimResult.rows, error: claimResult.error ?? null } : { data: null, error: null }),
    })
    return b
  }) as typeof hoisted.supabase.from
  return recorded
}

beforeEach(() => {
  hoisted.executeDiscoveryRun.mockReset()
  hoisted.executeAccountCardRun.mockReset()
  hoisted.executePeopleRun.mockReset()
  hoisted.guardBackgroundUsage.mockReset()
  hoisted.chainProfileRun.mockReset()
  hoisted.createProspectingRunMirror.mockClear()
  hoisted.settleProspectingWorkByRun.mockClear()
  hoisted.chainProfileRun.mockResolvedValue({ runId: null, targets: 0, skipped: 'nothing_to_score' })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers exactly one function, in its OWN lane at limit 1 per workspace', () => {
    const { config } = registration()
    expect(config.id).toBe('prospecting-run-execute')
    // §7: one paid run per workspace at a time. Two concurrent runs would race
    // the monthly-ceiling read in preflight, each seeing a total the other had
    // not yet written.
    expect(config.concurrency).toEqual([{ limit: 1, key: 'event.data.workspaceId' }])
    // Deliberately NOT the crm/enrich lane (limit 2): that lane is what a
    // user's own Enrich click uses.
    expect(config.retries).toBe(PROSPECTING_INNGEST_RETRIES)
  })

  it('triggers on run.requested and cancels on run.cancel, matched by runId', () => {
    const { config } = registration()
    expect(config.triggers).toEqual([{ event: PROSPECTING_RUN_REQUESTED }])
    expect(config.cancelOn).toEqual([{ event: PROSPECTING_RUN_CANCEL, match: 'data.runId' }])
    // The names are the cross-package contract; the route imports the same
    // constants, so a rename breaks the build rather than the feature.
    expect(PROSPECTING_RUN_REQUESTED).toBe('prospecting/run.requested')
    expect(PROSPECTING_RUN_CANCEL).toBe('prospecting/run.cancel')
  })
})

// ---------------------------------------------------------------------------
// The CAS claim
// ---------------------------------------------------------------------------

describe('the CAS claim', () => {
  it('claims → running with the status as the CONDITION, then runs', async () => {
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue({ status: 'completed', new_entries: 9 })
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    const claim = recorded[0]
    expect(claim.table).toBe('prospecting_run')
    expect(claim.payload).toMatchObject({ status: 'running' })
    // The compare-and-set: the status is a FILTER, not a read. A
    // read-then-write would let two attempts both see 'queued' and both run.
    expect(claim.in).toEqual(['status', ['queued', 'running']])
    expect(claim.filters).toContainEqual(['id', 'run-1'])
    expect(claim.filters).toContainEqual(['workspace_id', 'ws-1'])

    expect(hoisted.executeDiscoveryRun).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ status: 'completed' })
  })

  it('accepts a row already at `running` — a REDELIVERED attempt must claim its own row', async () => {
    // The bug this guards: attempt 1 threw a transient error and deliberately
    // left the row at `running` (marking it `failed` would trip the engine's
    // resume guard and disable the retry). So attempt 2 necessarily arrives to
    // find `running`. A claim filtered `.eq('status','queued')` refuses it and
    // returns without doing any work — `retries: 1` would buy exactly nothing.
    expect(RUNNABLE_STATUSES).toContain('running')
    expect(RUNNABLE_STATUSES).toContain('queued')
    // A cancel the engine has not yet converted is still claimable (as is),
    // and still a status the failure write may settle.
    expect(CLAIMABLE_STATUSES).toContain('canceling')
    // But the claim never flips it back to `running`.
    expect(RUNNABLE_STATUSES).not.toContain('canceling')
    // Terminal statuses are absent: those are the engine's word on the run.
    for (const terminal of ['completed', 'failed', 'canceled', 'budget_exhausted']) {
      expect(CLAIMABLE_STATUSES).not.toContain(terminal)
    }
  })

  it('runs the engine on the redelivered attempt when the row is still running', async () => {
    // The database side of the test above: the row matched the `.in` filter,
    // so PostgREST returns it and the engine gets to finish the run.
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue({ status: 'completed' })
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    expect(recorded[0].in).toEqual(['status', ['queued', 'running']])
    expect(hoisted.executeDiscoveryRun).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ status: 'completed' })
  })

  it('a `canceling` row is run as it stands, never flipped back to `running`', async () => {
    // A cancel pressed between a retry's attempts: the redelivered attempt must
    // not overwrite it with `running` (the engine would then never see it). It
    // still runs the engine, whose pre-call check settles it as `canceled`.
    const recorded = fakeSupabase({ rows: [], canceling: { id: 'run-1', kind: 'discover' } })
    hoisted.executeDiscoveryRun.mockResolvedValue({ status: 'canceled' })
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    // The flip matched nothing; the only write is that conditional update.
    expect(recorded.filter((r) => r.payload)).toHaveLength(1)
    expect(recorded[1].filters).toContainEqual(['status', 'canceling'])
    expect(recorded[1].payload).toBeUndefined()
    expect(hoisted.executeDiscoveryRun).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ status: 'canceled' })
  })

  it('exits IDEMPOTENTLY when the row reached a TERMINAL status — no engine, no bill', async () => {
    // Zero rows updated = the row is terminal (completed/failed/canceled/
    // budget_exhausted), so the run is over. Running it anyway re-bills every
    // angle against a run that already has a verdict.
    fakeSupabase({ rows: [] })
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    expect(out).toEqual({ skipped: 'not_claimable', runId: 'run-1' })
    expect(hoisted.executeDiscoveryRun).not.toHaveBeenCalled()
  })

  it('skips a malformed event rather than claiming anything', async () => {
    fakeSupabase({ rows: [{ id: 'run-1' }] })
    const step = createStepMock()
    for (const data of [null, {}, { runId: 'r' }, { runId: 'r', workspaceId: 'w' }]) {
      const out = await registration().handler({ event: { data }, step })
      expect(out).toEqual({ skipped: 'missing_ids' })
    }
    expect(hoisted.executeDiscoveryRun).not.toHaveBeenCalled()
  })

  it('lets a claim error propagate so Inngest retries it', async () => {
    fakeSupabase({ rows: [], error: { message: 'connection reset' } })
    const step = createStepMock()
    await expect(registration().handler({ event: EVENT, step })).rejects.toThrow(
      /connection reset/,
    )
  })
})

// ---------------------------------------------------------------------------
// Dispatch by kind
// ---------------------------------------------------------------------------

/**
 * ONE event, three engines.
 *
 * The kind lives on the ROW, not in the event, so these tests set it on what
 * the CLAIM returns — which is also the only place a redelivered attempt could
 * read it from. The wrapper's job is to hand the claimed row to exactly one
 * engine and never to more than one: a run that executed two engines would
 * bill twice and produce two contradictory terminal writes.
 */
describe('dispatch by kind', () => {
  const outcome = (status: string) => ({ status, new_entries: 0 })

  it('routes kind `discover` to the discovery engine', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'discover' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue(outcome('completed'))
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    expect(hoisted.executeDiscoveryRun).toHaveBeenCalledTimes(1)
    expect(hoisted.executeAccountCardRun).not.toHaveBeenCalled()
    expect(hoisted.executePeopleRun).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'completed' })
  })

  it('routes kind `account_card` to the account-card engine', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'account_card' }] })
    hoisted.executeAccountCardRun.mockResolvedValue(outcome('completed'))
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    expect(hoisted.executeAccountCardRun).toHaveBeenCalledTimes(1)
    expect(hoisted.executeDiscoveryRun).not.toHaveBeenCalled()
    expect(hoisted.executePeopleRun).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'completed' })
  })

  it('routes kind `people` to the people engine', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'people' }] })
    hoisted.executePeopleRun.mockResolvedValue(outcome('completed'))
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    expect(hoisted.executePeopleRun).toHaveBeenCalledTimes(1)
    expect(hoisted.executeDiscoveryRun).not.toHaveBeenCalled()
    expect(hoisted.executeAccountCardRun).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'completed' })
  })

  it('passes the SAME dependency bag and args to whichever engine it picks', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'people' }] })
    hoisted.executePeopleRun.mockResolvedValue(outcome('completed'))
    const step = createStepMock()

    await registration().handler({ event: EVENT, step })

    const [deps, args] = hoisted.executePeopleRun.mock.calls[0] as [
      { supabase: unknown; deepSearch: unknown; guardUsage: unknown; now: () => Date },
      Record<string, unknown>,
    ]
    // The real client, the real Exa call and the real usage guard — a stubbed
    // dependency here would make the engine tests prove nothing about
    // production.
    expect(deps.supabase).toBe(hoisted.supabase)
    expect(typeof deps.deepSearch).toBe('function')
    expect(deps.guardUsage).toBe(hoisted.guardBackgroundUsage)
    expect(deps.now()).toBeInstanceOf(Date)
    expect(args).toEqual({
      runId: 'run-1',
      workspaceId: 'ws-1',
      listId: 'list-1',
      userId: 'user-1',
    })
  })

  it("runs a person on their own ChatGPT plan on their plan's search, gated with the plan opt-in", async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'people' }] })
    hoisted.executePeopleRun.mockResolvedValue(outcome('completed'))
    hoisted.chatgptPlanFor.mockResolvedValueOnce(true)
    const step = createStepMock()

    await registration().handler({ event: EVENT, step })

    expect(hoisted.chatgptPlanFor).toHaveBeenCalledWith('user-1', { attempts: 2, failClosed: true })
    const [deps] = hoisted.executePeopleRun.mock.calls.at(-1) as [
      { deepSearch: (a: unknown) => Promise<unknown>; guardUsage: (u: string) => Promise<void> },
    ]
    await deps.deepSearch({ query: 'q', outputSchema: {} })
    expect(hoisted.planDeepSearch).toHaveBeenCalledWith({ query: 'q', outputSchema: {} }, { userId: 'user-1', workspaceId: 'ws-1' })
    await deps.guardUsage('user-1')
    expect(hoisted.guardBackgroundUsageOnPlan).toHaveBeenCalledWith('user-1')
    expect(hoisted.guardBackgroundUsage).not.toHaveBeenCalled()
  })

  it("fails a run whose person's plan can't be read, never running it on Exa", async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'people' }] })
    hoisted.chatgptPlanFor.mockRejectedValueOnce(new Error('ChatGPT plan check failed: boom'))
    const step = createStepMock()

    await expect(registration().handler({ event: EVENT, step })).rejects.toThrow(/plan check failed/)
    expect(hoisted.executePeopleRun).not.toHaveBeenCalled()
  })

  it('defaults a row with NO kind to discover rather than refusing it', async () => {
    // Migration 248 makes `kind` NOT NULL, so this is defence against a select
    // that lost the column — not a shape the database can produce. Discovery
    // is the safe default because it is the only kind that needs no selection.
    fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue(outcome('completed'))
    const step = createStepMock()

    await registration().handler({ event: EVENT, step })

    expect(hoisted.executeDiscoveryRun).toHaveBeenCalledTimes(1)
  })

  it('fails a run with an UNKNOWN kind instead of guessing an engine', async () => {
    // Firing a discovery search for someone who asked for people would spend
    // their budget on the wrong thing. And no engine can write the terminal
    // status here, because choosing one is the very thing that failed — so the
    // WRAPPER writes it, filtered to the non-terminal statuses.
    const recorded = fakeSupabase({ rows: [{ id: 'run-1', kind: 'nonsense' }] })
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'failed', error: 'unknown_kind', runId: 'run-1' })
    expect(hoisted.executeDiscoveryRun).not.toHaveBeenCalled()
    expect(hoisted.executeAccountCardRun).not.toHaveBeenCalled()
    expect(hoisted.executePeopleRun).not.toHaveBeenCalled()

    const write = recorded[1]
    expect(write.payload).toMatchObject({ status: 'failed' })
    expect(String((write.payload as { error: string }).error)).toContain('nonsense')
    // It can never clobber a terminal status the engine wrote.
    expect(write.in).toEqual(['status', ['queued', 'running', 'canceling']])
  })

  it('writes the unknown-kind failure through a TOP-LEVEL step', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'nonsense' }] })
    const step = createStepMock()

    await registration().handler({ event: EVENT, step })

    // The tripwire in createStepMock is what proves this: a step.run nested
    // inside another does not throw in production, it hangs.
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['claim-run', 'record-unknown-kind'])
  })
})

// ---------------------------------------------------------------------------
// Step discipline — the tripwire
// ---------------------------------------------------------------------------

describe('step discipline', () => {
  it('makes every step.run call from the TOP LEVEL of the handler', async () => {
    // The tripwire is armed by createStepMock: any step.* invoked while a
    // step.run callback is on the stack throws NESTED_STEP_ERROR. This test
    // passes only because the handler never nests — and it is the assertion
    // that hubspot-push-sweep's hand-rolled mock could not make.
    fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue({ status: 'completed' })
    const step = createStepMock()

    await registration().handler({ event: EVENT, step })

    // A row with no kind defaults to discover, and a completed discovery
    // hands off to the profile run — in its own top-level step.
    expect(step.run.mock.calls.map(([id]) => id)).toEqual([
      'claim-run',
      'chatgpt-plan',
      'execute-run',
      'chain-profile-run',
    ])
    for (const call of step.run.mock.results) {
      expect(call.type).toBe('return')
    }
  })

  it('the tripwire really is armed (a nested call would throw)', async () => {
    // A guard on the guard: if createStepMock ever stopped detecting nesting,
    // the test above would pass vacuously.
    const step = createStepMock()
    await expect(
      step.run('outer', async () => {
        await step.run('inner', async () => 1)
      }),
    ).rejects.toThrow(NESTED_STEP_ERROR)
  })

  it('passes the real engine dependencies through, unstubbed', async () => {
    fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue({ status: 'completed' })
    const step = createStepMock()

    await registration().handler({ event: EVENT, step })

    const [deps, args] = hoisted.executeDiscoveryRun.mock.calls[0]
    expect(args).toEqual({
      runId: 'run-1',
      workspaceId: 'ws-1',
      listId: 'list-1',
      userId: 'user-1',
    })
    // The usage gate is the REAL one — the engine calls it before anything
    // paid, and a wrapper that passed a no-op would silently disable the cap.
    expect(deps.guardUsage).toBe(hoisted.guardBackgroundUsage)
    expect(typeof deps.deepSearch).toBe('function')
    expect(deps.now()).toBeInstanceOf(Date)
    expect(deps.supabase).toBe(hoisted.supabase)
    // Row 6: the engine gets the run's ledger mirror, built for THIS run and kind.
    expect(deps.work).toBe(hoisted.mirror)
    expect(hoisted.createProspectingRunMirror).toHaveBeenCalledWith(hoisted.supabase, {
      id: 'run-1',
      workspaceId: 'ws-1',
      listId: 'list-1',
      kind: 'discover',
    })
  })

  it('tolerates a null userId', async () => {
    fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue({ status: 'completed' })
    const step = createStepMock()

    await registration().handler({
      event: { data: { ...EVENT.data, userId: undefined } },
      step,
    })
    expect(hoisted.executeDiscoveryRun.mock.calls[0][1].userId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Terminal writes vs transient rethrows
// ---------------------------------------------------------------------------

describe('failure handling', () => {
  it('does NOT write a status when the engine returns — the engine owns that', async () => {
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue({
      status: 'budget_exhausted',
      error: 'run_cap',
    })
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    // A run that RETURNS has already persisted its outcome. The wrapper
    // writing one too would race the engine's own terminal write and could
    // overwrite `budget_exhausted` with something less informative.
    expect(recorded.filter((r) => r.payload)).toHaveLength(1) // the claim only
    expect(out).toMatchObject({ status: 'budget_exhausted', error: 'run_cap' })
  })

  it('RETHROWS a transient error and writes NOTHING — the row stays claimable', async () => {
    // The highest-stakes assertion in the file, and the reason the wrapper no
    // longer tries to detect the last attempt. The engine's resume guard reads
    // `failed` as TERMINAL and returns without searching, so a wrapper that
    // marked the row failed while a retry was still pending would hand the
    // retry a row it had itself declared dead — `retries: 1` would buy nothing
    // and one transient Exa hiccup would permanently fail a run. Leaving the
    // row at `running` is what keeps the redelivered attempt able to claim it.
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })
    const boom = new Error('exa 503')
    hoisted.executeDiscoveryRun.mockRejectedValue(boom)
    const step = createStepMock()

    await expect(registration().handler({ event: EVENT, step })).rejects.toBe(boom)

    expect(
      recorded.find((r) => (r.payload as { status?: string } | undefined)?.status === 'failed'),
    ).toBeUndefined()
    // Only the claim ran. The status write is `onFailure`'s job, once.
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['claim-run', 'chatgpt-plan', 'execute-run'])
  })

  it('rethrows a transient error REGARDLESS of any attempt number it is handed', async () => {
    // The defect, stated as a test. The old wrapper decided whether to write
    // `failed` from `ctx.attempt >= PROSPECTING_INNGEST_RETRIES`, and that
    // inference did not fire under the real Inngest dev server — the run sat
    // at `running` forever. The handler now ignores `attempt` entirely, so no
    // value of it can produce a write.
    for (const attempt of [0, 1, PROSPECTING_INNGEST_RETRIES, 99, undefined, Number.NaN]) {
      const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })
      hoisted.executeDiscoveryRun.mockRejectedValue(new Error('exa 503'))
      const step = createStepMock()

      await expect(registration().handler({ event: EVENT, step, attempt })).rejects.toThrow(
        /exa 503/,
      )
      expect(
        recorded.find((r) => (r.payload as { status?: string } | undefined)?.status === 'failed'),
      ).toBeUndefined()
    }
  })

  it('does NOT rethrow a NonRetriableError — it is terminal on the first attempt', async () => {
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockRejectedValue(
      new NonRetriableError('Usage limit reached for user user-1'),
    )
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    // Inngest will not retry it and will not run `onFailure` for a path that
    // returned, so the row must be marked NOW or it stays 'running' forever.
    expect(out).toMatchObject({ status: 'failed', runId: 'run-1' })
    const failure = recorded.find(
      (r) => (r.payload as { status?: string } | undefined)?.status === 'failed',
    )
    expect(failure).toBeTruthy()
    expect(failure!.payload).toMatchObject({
      status: 'failed',
      error: 'Usage limit reached for user user-1',
    })
    expect(failure!.in).toEqual(['status', ['queued', 'running', 'canceling']])
  })

  it('writes the NonRetriable failure through a TOP-LEVEL step', async () => {
    fakeSupabase({ rows: [{ id: 'run-1' }] })
    hoisted.executeDiscoveryRun.mockRejectedValue(new NonRetriableError('capped'))
    const step = createStepMock()

    await registration().handler({ event: EVENT, step })

    // The tripwire would already have thrown NESTED_STEP_ERROR if the failure
    // write happened inside the failing step's own callback; this asserts the
    // step actually ran as its own named step.
    expect(step.run.mock.calls.map(([id]) => id)).toEqual([
      'claim-run',
      'chatgpt-plan',
      'execute-run',
      'record-failure',
    ])
  })
})

// ---------------------------------------------------------------------------
// onFailure — the ONLY thing that marks a retriable failure `failed`
// ---------------------------------------------------------------------------

/** A synthetic `inngest/function.failed` payload. The ORIGINAL event is nested
 *  at `event.data.event` — confirmed against `FailureEventPayload` in
 *  node_modules/inngest/types.d.ts (inngest 4.0.0). Reading the wrong level is
 *  the mistake this helper exists to make impossible to write by accident. */
function failureEvent(originalData: unknown) {
  return {
    event: {
      name: 'inngest/function.failed',
      data: {
        function_id: 'prospecting-run-execute',
        run_id: '01JX-run',
        error: { name: 'Error', message: 'ExaNotConfiguredError' },
        event: { name: 'prospecting/run.requested', data: originalData },
      },
    },
    error: new Error('ExaNotConfiguredError'),
  }
}

describe('onFailure', () => {
  it('is wired into the function config', () => {
    // Without this the hook never runs and the row spins forever — the exact
    // production symptom. `retries` is what onFailure fires after.
    expect(typeof registration().config.onFailure).toBe('function')
    expect(registration().config.retries).toBe(PROSPECTING_INNGEST_RETRIES)
  })

  it('writes failed, with the MESSAGE and a finished_at, after retries are exhausted', async () => {
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })

    const out = await prospectingRunOnFailure(failureEvent(EVENT.data))

    const failure = recorded.find(
      (r) => (r.payload as { status?: string } | undefined)?.status === 'failed',
    )
    expect(failure).toBeTruthy()
    expect(failure!.table).toBe('prospecting_run')
    expect(failure!.payload).toMatchObject({
      status: 'failed',
      error: 'ExaNotConfiguredError',
    })
    expect((failure!.payload as { finished_at?: string }).finished_at).toEqual(expect.any(String))
    expect(failure!.filters).toContainEqual(['id', 'run-1'])
    expect(failure!.filters).toContainEqual(['workspace_id', 'ws-1'])
    expect(out).toMatchObject({ runId: 'run-1', written: true })
    // Row 6: the run's Activity row fails with it.
    expect(hoisted.settleProspectingWorkByRun).toHaveBeenCalledWith(hoisted.supabase, 'run-1', {
      status: 'failed',
      error: 'ExaNotConfiguredError',
    })
  })

  it('filters on the non-terminal statuses so it can NEVER clobber the engine verdict', async () => {
    // A run that finished `completed` and then had a later step fail must
    // still read `completed`. The filter is what guarantees that, so it is
    // asserted exactly, not loosely.
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })

    await prospectingRunOnFailure(failureEvent(EVENT.data))

    const failure = recorded.find(
      (r) => (r.payload as { status?: string } | undefined)?.status === 'failed',
    )
    expect(failure!.in).toEqual(['status', ['queued', 'running', 'canceling']])
    expect(failure!.in![1]).toEqual([...CLAIMABLE_STATUSES])
  })

  it('reads the ids from the NESTED original event, not from the failure envelope', async () => {
    // `event.data` is the failure envelope (function_id, run_id, error); the
    // run's own ids are one level further down at `event.data.event.data`.
    // A hook that read the wrong level would write onto nothing.
    const recorded = fakeSupabase({ rows: [{ id: 'run-9' }] })

    await prospectingRunOnFailure(
      failureEvent({ runId: 'run-9', workspaceId: 'ws-9', listId: 'list-9', userId: null }),
    )

    const failure = recorded.find(
      (r) => (r.payload as { status?: string } | undefined)?.status === 'failed',
    )
    expect(failure!.filters).toContainEqual(['id', 'run-9'])
    expect(failure!.filters).toContainEqual(['workspace_id', 'ws-9'])
  })

  it('records the MESSAGE, never a stack, and caps its length', async () => {
    const recorded = fakeSupabase({ rows: [{ id: 'run-1' }] })
    const payload = failureEvent(EVENT.data)
    payload.error = new Error('x'.repeat(2000))

    await prospectingRunOnFailure(payload)

    const failure = recorded.find(
      (r) => (r.payload as { status?: string } | undefined)?.status === 'failed',
    )
    const message = (failure!.payload as { error: string }).error
    // This string is rendered to the user in the run history.
    expect(message).toHaveLength(500)
    expect(message).not.toContain('at ')
  })

  it('skips — without throwing — when the original event carries no ids', async () => {
    // Throwing out of a failure hook only produces a second failure.
    for (const data of [null, undefined, {}, { runId: 'r' }]) {
      const recorded = fakeSupabase({ rows: [] })
      const out = await prospectingRunOnFailure(failureEvent(data))
      expect(out).toEqual({ skipped: 'missing_ids' })
      expect(recorded).toHaveLength(0)
    }
  })

  it('reports a write error instead of throwing', async () => {
    // The caller is already on an error path; a throw here buys nothing.
    hoisted.supabase.from = vi.fn(() => {
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        update: () => b,
        eq: () => b,
        in: () => Promise.resolve({ error: { message: 'connection reset' } }),
      })
      return b
    }) as typeof hoisted.supabase.from

    await expect(prospectingRunOnFailure(failureEvent(EVENT.data))).resolves.toMatchObject({
      runId: 'run-1',
      written: false,
    })
  })
})

// ---------------------------------------------------------------------------
// The hand-off: discovery → profile
// ---------------------------------------------------------------------------

/**
 * "Find companies" means find AND score. The wrapper chains the profile run in
 * its own step AFTER discovery's terminal write — so the one-live-per-list lock
 * is free, and a retry of the chain step can never re-run discovery. Only a
 * discovery that actually finished (completed, or stopped early with results)
 * hands off; a cancelled or failed one, and the other two kinds, never do.
 */
describe('the hand-off to the profile run', () => {
  const outcome = (status: string) => ({ status, new_entries: 3 })

  it('chains the profile run after a COMPLETED discovery and reports its id', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'discover' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue(outcome('completed'))
    hoisted.chainProfileRun.mockResolvedValue({ runId: 'run-2', targets: 3, skipped: null, before: 'T0' })
    const step = createStepMock()

    const out = await registration().handler({ event: EVENT, step })

    expect(hoisted.chainProfileRun).toHaveBeenCalledTimes(1)
    // No marker on a discovery event: the first pass picks its own `before`.
    expect(hoisted.chainProfileRun.mock.calls[0][1]).toEqual({
      workspaceId: 'ws-1',
      listId: 'list-1',
      userId: 'user-1',
      before: undefined,
    })
    expect(out).toMatchObject({ status: 'completed', chained_run_id: 'run-2' })
    // Its own step, after execute-run — never inside it.
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['claim-run', 'chatgpt-plan', 'execute-run', 'chain-profile-run'])
  })

  it('chains after a discovery that stopped early WITH results', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'discover' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue(outcome('budget_exhausted'))
    const step = createStepMock()
    await registration().handler({ event: EVENT, step })
    expect(hoisted.chainProfileRun).toHaveBeenCalledTimes(1)
  })

  it('does NOT chain after a cancelled or failed discovery', async () => {
    for (const status of ['canceled', 'failed']) {
      hoisted.chainProfileRun.mockClear()
      fakeSupabase({ rows: [{ id: 'run-1', kind: 'discover' }] })
      hoisted.executeDiscoveryRun.mockResolvedValue(outcome(status))
      const out = await registration().handler({ event: EVENT, step: createStepMock() })
      expect(hoisted.chainProfileRun, status).not.toHaveBeenCalled()
      expect(out, status).not.toHaveProperty('chained_run_id')
    }
  })

  it('does NOT chain after a profile run a PERSON started, nor after a people run', async () => {
    for (const kind of ['account_card', 'people']) {
      hoisted.chainProfileRun.mockClear()
      fakeSupabase({ rows: [{ id: 'run-1', kind }] })
      hoisted.executeAccountCardRun.mockResolvedValue(outcome('completed'))
      hoisted.executePeopleRun.mockResolvedValue(outcome('completed'))
      await registration().handler({ event: EVENT, step: createStepMock() })
      expect(hoisted.chainProfileRun, kind).not.toHaveBeenCalled()
    }
  })

  it('chains the NEXT pass after a chained profile pass completes, carrying the hand-off marker', async () => {
    // One pass is capped at the targeted-run ceiling; a 75-company discovery
    // needs two. The marker is what keeps the passes finite: the next pass
    // only targets companies the earlier ones never carded.
    fakeSupabase({ rows: [{ id: 'run-2', kind: 'account_card' }] })
    hoisted.executeAccountCardRun.mockResolvedValue(outcome('completed'))
    hoisted.chainProfileRun.mockResolvedValue({ runId: 'run-3', targets: 19, skipped: null, before: 'T0' })
    const event = { data: { ...EVENT.data, runId: 'run-2', handoff: { before: 'T0' } } }

    const out = await registration().handler({ event, step: createStepMock() })

    expect(hoisted.chainProfileRun).toHaveBeenCalledTimes(1)
    expect(hoisted.chainProfileRun.mock.calls[0][1]).toEqual({
      workspaceId: 'ws-1',
      listId: 'list-1',
      userId: 'user-1',
      before: 'T0',
    })
    expect(out).toMatchObject({ status: 'completed', chained_run_id: 'run-3' })
  })

  it('stops chaining when a pass stops early — the user reads "stopped early" and decides', async () => {
    fakeSupabase({ rows: [{ id: 'run-2', kind: 'account_card' }] })
    hoisted.executeAccountCardRun.mockResolvedValue(outcome('budget_exhausted'))
    const event = { data: { ...EVENT.data, runId: 'run-2', handoff: { before: 'T0' } } }
    await registration().handler({ event, step: createStepMock() })
    expect(hoisted.chainProfileRun).not.toHaveBeenCalled()
  })

  it('a hand-off that could not start leaves the discovery verdict alone', async () => {
    fakeSupabase({ rows: [{ id: 'run-1', kind: 'discover' }] })
    hoisted.executeDiscoveryRun.mockResolvedValue(outcome('completed'))
    hoisted.chainProfileRun.mockResolvedValue({ runId: null, targets: 3, skipped: 'RUN_ALREADY_LIVE', before: 'T0' })
    const out = await registration().handler({ event: EVENT, step: createStepMock() })
    expect(out).toMatchObject({ status: 'completed', chained_run_id: null })
  })
})
