import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/jira-reconcile.ts — the drift sweep.
 *
 * It matters MORE here than it does for Asana, for reasons that are structural
 * rather than defensive: a 3LO app cannot call `GET /webhook/failed` (Connect
 * apps only), a registration expires 30 days after its last refresh and goes
 * silent with nothing surfacing, and for a non-public app deliveries can stop
 * entirely on an app-owner mismatch after a 200 at registration time. Webhook
 * silence is indistinguishable from "nothing changed", so this poll is the only
 * mechanism that can ever notice.
 *
 * Invariants locked in:
 *  - HOUSE RULE: the shared step mock fails the test if step.sendEvent is called
 *    from inside a step.run callback (silent production deadlock).
 *  - NO DEBOUNCE: continuations arrive on the same event name the cron fires, so
 *    a debounce would throttle the function's own self-chain.
 *  - The 6-HOUR gate, exempt for continuations.
 *  - No SITE ⇒ nothing to address a read to ⇒ skip before minting a token.
 *  - Only still-OPEN links, keyset-paged 50 at a time, 2 pages per run, and only
 *    the run that DRAINS stamps the clock.
 *  - It applies the SAME shared helper as the webhook path, folding
 *    statusCategory rather than a status name, and refreshes the status label.
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
  loadJiraReconcileState: vi.fn(),
  stampJiraReconciledAt: vi.fn(),
}))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadJiraReconcileState: hoistedConfig.loadJiraReconcileState,
    stampJiraReconciledAt: hoistedConfig.stampJiraReconciledAt,
  }
})

const hoistedApi = vi.hoisted(() => ({ getIssue: vi.fn() }))
class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'JiraUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string> = {}
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'JiraApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: hoistedApi.getIssue,
    JiraUnauthorizedError: FakeUnauthorized,
    JiraApiError: FakeApiError,
  }
})

await import('@/lib/inngest/jira-reconcile')

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

const STATES = {
  'team-1': {
    completed: 'st-done',
    default: 'st-todo',
    started: 'st-doing',
    canceled: 'st-cancel',
  },
}

const RECONCILE_STATE = {
  id: 'tss-1',
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  userId: 'u-sync',
  cloudId: 'cafe0001',
  lastReconcileAt: null as string | null,
}

/** n open links with monotonic (created_at, id) so the keyset is deterministic. */
function openLinks(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const idx = offset + i
    return {
      id: `link-${String(idx).padStart(3, '0')}`,
      action_id: `act-${idx}`,
      external_id: `1000${idx}`,
      /** The site the issue lives on — ids are per-site (migration 216). */
      external_scope: 'cafe0001',
      completed: false,
      external_state_label: 'In Progress',
      last_push_error: null,
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

/** A Jira issue payload as `GET /issue?fields=status` returns it. */
function issue(name: string, category: string) {
  return { id: '10000', fields: { status: { id: 's1', name, statusCategory: { key: category } } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadJiraReconcileState.mockResolvedValue({ ...RECONCILE_STATE })
  hoistedConfig.stampJiraReconciledAt.mockResolvedValue({ error: null })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.getIssue.mockResolvedValue(issue('In Progress', 'indeterminate'))
  dbFake = createAsanaRemoteFake({})
})

// ---- Registration ----------------------------------------------------------

describe('jira-reconcile — registration', () => {
  it('serializes per sync state', () => {
    expect(hoisted.config.id).toBe('jira-reconcile')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/jira-reconcile' }])
    expect(hoisted.config.concurrency).toEqual([
      { limit: 1, key: 'event.data.syncStateId' },
    ])
  })

  it('REGRESSION: no debounce — it would throttle the function\'s OWN continuations', () => {
    // A multi-page walk self-chains through `tasks/jira-reconcile`, the very
    // event this function would be debounced on, so any debounce delays each
    // continuation by its full period. Cron bursts are already handled by
    // `concurrency: 1` plus the 6-hour gate.
    expect(hoisted.config.debounce).toBeUndefined()
  })
})

// ---- Gates -----------------------------------------------------------------

describe('jira-reconcile — the 6-hour gate', () => {
  it('runs when last_reconcile_at is null (never swept)', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('skips a tick less than 6h after the last full walk', async () => {
    hoistedConfig.loadJiraReconcileState.mockResolvedValue({
      ...RECONCILE_STATE,
      lastReconcileAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'too_soon' })
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('runs again once the last walk is older than 6h', async () => {
    hoistedConfig.loadJiraReconcileState.mockResolvedValue({
      ...RECONCILE_STATE,
      lastReconcileAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    })
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('EXEMPTS a continuation from the gate', async () => {
    hoistedConfig.loadJiraReconcileState.mockResolvedValue({
      ...RECONCILE_STATE,
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
    hoistedConfig.loadJiraReconcileState.mockResolvedValue(null)
    expect(await hoisted.handler({ event: EVENT(), step: makeStep() })).toMatchObject({
      status: 'skipped',
      reason: 'no_sync_state',
    })

    hoistedConfig.loadJiraReconcileState.mockResolvedValue({ ...RECONCILE_STATE })
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    expect(await hoisted.handler({ event: EVENT(), step: makeStep() })).toMatchObject({
      status: 'skipped',
      reason: 'no_token',
    })
  })

  it('skips a workspace with NO SITE before minting a token', async () => {
    // Unlike Asana, a cloudId is the API address — without one there is no URL
    // to read from, and no push can ever have landed either.
    hoistedConfig.loadJiraReconcileState.mockResolvedValue({
      ...RECONCILE_STATE,
      cloudId: null,
    })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'no_destination' })
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
  })
})

// ---- Scan set + paging -----------------------------------------------------

describe('jira-reconcile — paging', () => {
  it('scans only OPEN jira links for the workspace', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    await hoisted.handler({ event: EVENT(), step: makeStep() })

    const query = dbFake.linkQueries[0]
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'workspace_id', val: 'ws-1' },
        { op: 'eq', col: 'provider', val: 'jira' },
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
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(3)
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(hoistedConfig.stampJiraReconciledAt).toHaveBeenCalledWith('tss-1')
  })

  it('addresses every read to the workspace’s site', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0001', '10000', 'status')
  })

  it('caps at 2 pages (100 GETs) and SELF-CHAINS with a keyset cursor', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(150), states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(), step })

    expect(out).toMatchObject({ status: 'continued' })
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(100)
    // NOT stamped — the walk is unfinished, and stamping now would start the 6h
    // cooldown with 50 links never looked at.
    expect(hoistedConfig.stampJiraReconciledAt).not.toHaveBeenCalled()

    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    const [name, payload] = step.sendEvent.mock.calls[0] as unknown as [
      string,
      { name: string; data: { cursorCreatedAt: string; cursorId: string } },
    ]
    expect(name).toBe('continue-reconcile')
    expect(payload.name).toBe('tasks/jira-reconcile')
    expect(payload.data.cursorCreatedAt).toBeTruthy()
    expect(payload.data.cursorId).toBeTruthy()
  })

  it('REGRESSION: the continuation resumes AFTER the cursor and terminates', async () => {
    // A cursor that didn't advance would re-sweep page one forever, chaining
    // itself into an infinite loop at 100 Jira GETs a go.
    dbFake = createAsanaRemoteFake({ links: openLinks(150), states: STATES })
    const step = makeStep()
    await hoisted.handler({ event: EVENT(), step })

    const [, payload] = step.sendEvent.mock.calls[0] as unknown as [
      string,
      { data: { cursorCreatedAt: string; cursorId: string } },
    ]

    hoistedApi.getIssue.mockClear()
    const step2 = makeStep()
    const out = await hoisted.handler({
      event: EVENT({
        cursorCreatedAt: payload.data.cursorCreatedAt,
        cursorId: payload.data.cursorId,
      }),
      step: step2,
    })

    // The remaining 50, then drain + stamp — and no further chain.
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(50)
    expect(out).toMatchObject({ status: 'complete' })
    expect(step2.sendEvent).not.toHaveBeenCalled()
    expect(hoistedConfig.stampJiraReconciledAt).toHaveBeenCalledWith('tss-1')
  })

  it('stamps even when there is nothing to sweep', async () => {
    dbFake = createAsanaRemoteFake({ links: [], states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete', applied: 0 })
    expect(hoistedConfig.stampJiraReconciledAt).toHaveBeenCalled()
  })
})

// ---- Shared apply behaviour ------------------------------------------------

describe('jira-reconcile — applies the SAME rules as the webhook path', () => {
  it('completes an action whose issue moved to a done-category status', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Shipped', 'done'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.statusUpdates).toEqual([
      { actionId: 'act-0', patch: { status_id: 'st-done' } },
    ])
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'flow/entity.status_changed' }),
    )
    // …and the real status name is recorded alongside the boolean.
    expect(dbFake.linkUpdates).toEqual([
      { linkId: 'link-000', patch: { external_state_label: 'Shipped' } },
    ])
  })

  /**
   * REGRESSION (round-1 audit, echo group issue 2). The sweep is the path that
   * CATCHES a dropped delivery, so a cancellation the webhook lost would have
   * been repaired here as a completion — the same corruption, six hours later.
   * Both paths run the shared helper, and both now hand it the same refinement.
   */
  it('lands a cancel-named done status in the team’s CANCELED state', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue("Won't Do", 'done'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.statusUpdates).toEqual([
      { actionId: 'act-0', patch: { status_id: 'st-cancel' } },
    ])
  })

  it('leaves an issue still in an open category alone (the CAS matches nothing)', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('In Progress', 'indeterminate'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.casUpdates).toHaveLength(0)
    expect(dbFake.statusUpdates).toHaveLength(0)
    // The label was already 'In Progress' — a quiet sweep writes nothing at all.
    expect(dbFake.linkUpdates).toHaveLength(0)
  })

  it('records a status name that moved WITHIN the open categories', async () => {
    // Jira's whole advantage over Asana: "In Review" is real information even
    // though the completion boolean hasn't changed.
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('In Review', 'indeterminate'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.casUpdates).toHaveLength(0)
    expect(dbFake.linkUpdates).toEqual([
      { linkId: 'link-000', patch: { external_state_label: 'In Review' } },
    ])
  })

  it('marks a 404 task_missing and keeps sweeping', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(2),
      actions: [ACTIVE_ACTION('act-0'), ACTIVE_ACTION('act-1')],
      states: STATES,
    })
    hoistedApi.getIssue
      .mockRejectedValueOnce(new FakeApiError(404, 'Issue does not exist'))
      .mockResolvedValueOnce(issue('Done', 'done'))

    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.markerUpdates).toHaveLength(1)
    expect(
      (dbFake.markerUpdates[0].patch.last_push_error as { code: string }).code,
    ).toBe('task_missing')
    expect(dbFake.statusUpdates).toHaveLength(1)
    expect(out).toMatchObject({ status: 'complete' })
  })

  /**
   * REGRESSION (review finding: "Jira 404 means gone OR forbidden — code maps it
   * to a terminal task_deleted"). The sweep is the only thing that can notice
   * recovery, and it can only do so if the link stays in the scan set (it does:
   * the marker does not change `completed`) AND the marker is retired on the
   * first good read.
   */
  it('RE-READS a previously missing link and retires its marker', async () => {
    dbFake = createAsanaRemoteFake({
      links: [{ ...openLinks(1)[0], last_push_error: { code: 'task_missing', at: 'yesterday' } }],
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'done'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(1)
    expect(dbFake.markerUpdates).toEqual([
      { linkId: 'link-000', patch: { last_push_error: null } },
    ])
    expect(dbFake.statusUpdates).toHaveLength(1)
  })

  /**
   * REGRESSION (review finding: "links carry no site identity"). The sweep reads
   * every open link with the workspace's CURRENT cloudId; after a site switch
   * that resolved a different, unrelated issue on the new tenant for every one
   * of them — completing actions nobody touched, with no error anywhere.
   */
  it('sweeps each link against the site IT records', async () => {
    const [first] = openLinks(1)
    dbFake = createAsanaRemoteFake({
      links: [{ ...first, external_scope: 'cafe0002' }],
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('In Review', 'indeterminate'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    // context.cloudId is cafe0001 (see RECONCILE_STATE) — the link wins.
    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0002', '10000', 'status')
  })

  it('aborts the run cleanly on 401 — no stamp, no chain', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(60), states: STATES })
    hoistedApi.getIssue.mockRejectedValue(new FakeUnauthorized())

    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(), step })

    expect(out).toMatchObject({ status: 'aborted', reason: 'unauthorized' })
    expect(hoistedConfig.stampJiraReconciledAt).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('rethrows a transient Jira failure so Inngest retries', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    hoistedApi.getIssue.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    await expect(
      hoisted.handler({ event: EVENT(), step: makeStep() }),
    ).rejects.toThrow('unavailable')
  })
})
