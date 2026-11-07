import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/asana-reconcile.ts — the at-most-once safety net.
 *
 * Invariants locked in:
 *  - HOUSE RULE: the shared step mock (src/test/inngest-step-mock.ts) fails the
 *    test if step.sendEvent is called from inside a step.run callback (silent
 *    production deadlock).
 *  - NO DEBOUNCE: continuations arrive on the same event name the cron fires, so
 *    a debounce would throttle the function's own self-chain.
 *  - The 6-HOUR gate: the cron fires this every 30 min, so most ticks must cost
 *    one read. A continuation is exempt — it is the middle of a walk that
 *    already passed the gate.
 *  - It scans only still-OPEN links, keyset-pages 50 at a time, caps 2 pages per
 *    run and self-chains the remainder from the top level.
 *  - Only the run that DRAINS the walk stamps last_reconcile_at (stamping per
 *    page would start the cooldown before the tail was ever looked at).
 *  - It applies the SAME shared helper as the webhook path — completing an
 *    action, marking a 404, and aborting cleanly on 401.
 */

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
  send: vi.fn(async () => ({ ids: ['e'] })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.config = config
      hoisted.handler = fn
      return { id: config.id }
    },
    send: hoisted.send,
  },
}))

let dbFake: AsanaRemoteFake = createAsanaRemoteFake()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => dbFake.client }))

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({
  loadAsanaReconcileState: vi.fn(),
  stampAsanaReconciledAt: vi.fn(),
}))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadAsanaReconcileState: hoistedConfig.loadAsanaReconcileState,
    stampAsanaReconciledAt: hoistedConfig.stampAsanaReconciledAt,
  }
})

const hoistedApi = vi.hoisted(() => ({ getTask: vi.fn() }))
class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'AsanaApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/asana-api', () => ({
  getTask: hoistedApi.getTask,
  AsanaUnauthorizedError: FakeUnauthorized,
  AsanaApiError: FakeApiError,
}))

await import('@/lib/inngest/asana-reconcile')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — a vi.fn per method plus the house-rule tripwire
 * (step tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = (data: Record<string, unknown> = {}) => ({
  data: { syncStateId: 'tss-1', ...data },
})

const STATES = { 'team-1': { completed: 'st-done', default: 'st-todo' } }

/** n open links with monotonic (created_at, id) so the keyset is deterministic. */
function openLinks(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const idx = offset + i
    return {
      id: `link-${String(idx).padStart(3, '0')}`,
      action_id: `act-${idx}`,
      external_id: `task-${idx}`,
      completed: false,
      created_at: `2026-07-${String((idx % 28) + 1).padStart(2, '0')}T00:00:0${idx % 10}.000Z`,
    }
  })
}

const ACTIVE_ACTION = (id: string) => ({
  id,
  status_id: 'st-doing',
  team_id: 'team-1',
  category: 'started',
})

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadAsanaReconcileState.mockResolvedValue({
    id: 'tss-1',
    workspaceId: 'ws-1',
    accountId: 'acct-1',
    userId: 'u-sync',
    lastReconcileAt: null,
  })
  hoistedConfig.stampAsanaReconciledAt.mockResolvedValue({ error: null })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.getTask.mockResolvedValue({ gid: 'task-0', completed: false })
  dbFake = createAsanaRemoteFake({})
})

// ---- Registration ----------------------------------------------------------

describe('asana-reconcile — registration', () => {
  it('serializes per sync state and is NOT debounced', () => {
    expect(hoisted.config.id).toBe('asana-reconcile')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/asana-reconcile' }])
    expect(hoisted.config.concurrency).toEqual([
      { limit: 1, key: 'event.data.syncStateId' },
    ])
  })

  it('REGRESSION: no debounce — it would throttle the function\'s OWN continuations', () => {
    // A multi-page walk self-chains through `tasks/asana-reconcile`, the very
    // event this function is debounced on, so any debounce delays each
    // continuation by its full period: a 150-link workspace would take
    // 2 × period to finish instead of running straight through. Cron bursts are
    // already handled by `concurrency: 1` plus the 6-hour gate, which makes a
    // redundant tick one cheap gated read.
    expect(hoisted.config.debounce).toBeUndefined()
  })
})

// ---- The 6-hour gate -------------------------------------------------------

describe('asana-reconcile — the 6-hour gate', () => {
  it('runs when last_reconcile_at is null (never swept)', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('skips a tick less than 6h after the last full walk', async () => {
    hoistedConfig.loadAsanaReconcileState.mockResolvedValue({
      id: 'tss-1',
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      lastReconcileAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'too_soon' })
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(hoistedApi.getTask).not.toHaveBeenCalled()
  })

  it('runs again once the last walk is older than 6h', async () => {
    hoistedConfig.loadAsanaReconcileState.mockResolvedValue({
      id: 'tss-1',
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      lastReconcileAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    })
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('EXEMPTS a continuation from the gate', async () => {
    // A self-chained page belongs to a walk that already passed the gate.
    hoistedConfig.loadAsanaReconcileState.mockResolvedValue({
      id: 'tss-1',
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      lastReconcileAt: new Date().toISOString(),
    })
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    const out = await hoisted.handler({
      event: EVENT({ cursorCreatedAt: '2026-06-01T00:00:00.000Z', cursorId: 'link-000' }),
      step: makeStep(),
    })
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('skips a missing sync state and a dead token', async () => {
    hoistedConfig.loadAsanaReconcileState.mockResolvedValue(null)
    expect(await hoisted.handler({ event: EVENT(), step: makeStep() })).toMatchObject({
      status: 'skipped',
      reason: 'no_sync_state',
    })

    hoistedConfig.loadAsanaReconcileState.mockResolvedValue({
      id: 'tss-1',
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      lastReconcileAt: null,
    })
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    expect(await hoisted.handler({ event: EVENT(), step: makeStep() })).toMatchObject({
      status: 'skipped',
      reason: 'no_token',
    })
  })
})

// ---- Scan set + paging -----------------------------------------------------

describe('asana-reconcile — paging', () => {
  it('scans only OPEN asana links for the workspace', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    await hoisted.handler({ event: EVENT(), step: makeStep() })

    const query = dbFake.linkQueries[0]
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'workspace_id', val: 'ws-1' },
        { op: 'eq', col: 'provider', val: 'asana' },
        { op: 'eq', col: 'completed', val: false },
      ]),
    )
    expect(query.limit).toBe(50)
  })

  it('drains in one run when the first page is short, and STAMPS the clock', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(3),
      actions: [ACTIVE_ACTION('act-0'), ACTIVE_ACTION('act-1'), ACTIVE_ACTION('act-2')],
      states: STATES,
    })
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(), step })

    expect(out).toMatchObject({ status: 'complete', applied: 3 })
    expect(hoistedApi.getTask).toHaveBeenCalledTimes(3)
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(hoistedConfig.stampAsanaReconciledAt).toHaveBeenCalledWith('tss-1')
  })

  it('caps at 2 pages (100 GETs) and SELF-CHAINS with a keyset cursor', async () => {
    const links = openLinks(150)
    dbFake = createAsanaRemoteFake({ links, states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(), step })

    expect(out).toMatchObject({ status: 'continued' })
    expect(hoistedApi.getTask).toHaveBeenCalledTimes(100)
    // NOT stamped — the walk is unfinished, and stamping now would start the
    // 6h cooldown with 50 links never looked at.
    expect(hoistedConfig.stampAsanaReconciledAt).not.toHaveBeenCalled()

    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    const [name, payload] = step.sendEvent.mock.calls[0] as unknown as [
      string,
      { name: string; data: { cursorCreatedAt: string; cursorId: string } },
    ]
    expect(name).toBe('continue-reconcile')
    expect(payload.name).toBe('tasks/asana-reconcile')
    expect(payload.data.cursorCreatedAt).toBeTruthy()
    expect(payload.data.cursorId).toBeTruthy()
  })

  it('the continuation resumes AFTER the cursor and finishes the walk', async () => {
    const links = openLinks(150)
    dbFake = createAsanaRemoteFake({ links, states: STATES })
    const step = makeStep()
    await hoisted.handler({ event: EVENT(), step })

    const [, payload] = step.sendEvent.mock.calls[0] as unknown as [
      string,
      { data: { cursorCreatedAt: string; cursorId: string } },
    ]

    hoistedApi.getTask.mockClear()
    const step2 = makeStep()
    const out = await hoisted.handler({
      event: EVENT({
        cursorCreatedAt: payload.data.cursorCreatedAt,
        cursorId: payload.data.cursorId,
      }),
      step: step2,
    })

    // The remaining 50, then drain + stamp.
    expect(hoistedApi.getTask).toHaveBeenCalledTimes(50)
    expect(out).toMatchObject({ status: 'complete' })
    expect(hoistedConfig.stampAsanaReconciledAt).toHaveBeenCalledWith('tss-1')
  })

  it('stamps even when there is nothing to sweep', async () => {
    dbFake = createAsanaRemoteFake({ links: [], states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete', applied: 0 })
    expect(hoistedConfig.stampAsanaReconciledAt).toHaveBeenCalled()
  })
})

// ---- Shared apply behaviour ------------------------------------------------

describe('asana-reconcile — applies the SAME rules as the webhook path', () => {
  it('completes an action whose task was completed while we were not listening', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue({ gid: 'task-0', completed: true })

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.statusUpdates).toEqual([
      { actionId: 'act-0', patch: { status_id: 'st-done' } },
    ])
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'flow/entity.status_changed' }),
    )
  })

  it('leaves a still-open task alone (the CAS matches nothing)', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue({ gid: 'task-0', completed: false })

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.casUpdates).toHaveLength(0)
    expect(dbFake.statusUpdates).toHaveLength(0)
  })

  it('marks a 404 task_deleted and keeps sweeping', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(2),
      actions: [ACTIVE_ACTION('act-0'), ACTIVE_ACTION('act-1')],
      states: STATES,
    })
    hoistedApi.getTask
      .mockRejectedValueOnce(new FakeApiError(404, 'gone'))
      .mockResolvedValueOnce({ gid: 'task-1', completed: true })

    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.markerUpdates).toHaveLength(1)
    expect(
      (dbFake.markerUpdates[0].patch.last_push_error as { code: string }).code,
    ).toBe('task_deleted')
    expect(dbFake.statusUpdates).toHaveLength(1)
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('aborts the run cleanly on 401 — no stamp, no chain', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(60), states: STATES })
    hoistedApi.getTask.mockRejectedValue(new FakeUnauthorized())

    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(), step })

    expect(out).toMatchObject({ status: 'aborted', reason: 'unauthorized' })
    expect(hoistedConfig.stampAsanaReconciledAt).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('rethrows a transient Asana failure so Inngest retries', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    hoistedApi.getTask.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    await expect(
      hoisted.handler({ event: EVENT(), step: makeStep() }),
    ).rejects.toThrow('unavailable')
  })
})
