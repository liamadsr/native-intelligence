import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/linear-reconcile.ts — the drift sweep.
 *
 * Linear's webhooks are the best of the three providers' (signed, app-level, no
 * expiry to outrun), and this sweep still matters for three structural reasons:
 * Linear retries a failed delivery only THREE times and may then disable the
 * webhook outright with nothing surfacing; webhook silence is indistinguishable
 * from "nothing changed"; and the app console holds ONE webhook URL, so in dev
 * and preview this sweep is not the backstop, it is the only read-back path.
 *
 * Invariants locked in:
 *  - HOUSE RULE: the shared step mock fails the test if step.sendEvent is called
 *    from inside a step.run callback (silent production deadlock).
 *  - NO DEBOUNCE: continuations arrive on the same event name the cron fires, so
 *    a debounce would throttle the function's own self-chain.
 *  - The 6-HOUR gate, exempt for continuations.
 *  - Only still-OPEN links, keyset-paged 50 at a time, 2 pages per run, and only
 *    the run that DRAINS stamps the clock.
 *  - It applies the SAME shared helper as the webhook path, folding
 *    `WorkflowState.type` rather than a state name, and refreshes the label.
 *  - There is deliberately NO destination gate: a Linear read needs only the
 *    token (no site, no team), which is the structural difference from the Jira
 *    sibling's `no_destination` skip.
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
  loadLinearReconcileState: vi.fn(),
  stampLinearReconciledAt: vi.fn(),
}))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadLinearReconcileState: hoistedConfig.loadLinearReconcileState,
    stampLinearReconciledAt: hoistedConfig.stampLinearReconciledAt,
  }
})

const hoistedApi = vi.hoisted(() => ({ getIssue: vi.fn() }))
class FakeUnauthorized extends Error {
  readonly status = 401
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly graphQLErrors: unknown[] = []
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'LinearApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: hoistedApi.getIssue,
    LinearUnauthorizedError: FakeUnauthorized,
    LinearApiError: FakeApiError,
  }
})

await import('@/lib/inngest/linear-reconcile')

// ---- Helpers ---------------------------------------------------------------

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
  lastReconcileAt: null as string | null,
}

/** n open links with monotonic (created_at, id) so the keyset is deterministic. */
function openLinks(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const idx = offset + i
    return {
      id: `link-${String(idx).padStart(3, '0')}`,
      action_id: `act-${idx}`,
      external_id: `iss-${idx}`,
      completed: false,
      external_state_label: 'In Progress',
      // What the push stored; the sweep re-reads it and refreshes it only when
      // Linear rewrote the issue's URL (a team move).
      external_url: 'https://linear.app/acme/issue/ENG-1',
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

/** A Linear issue payload as `issue(id:)` returns it. */
function issue(name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'iss-0',
    identifier: 'ENG-1',
    url: 'https://linear.app/acme/issue/ENG-1',
    trashed: false,
    archivedAt: null,
    state: { id: 'ls-x', name, type },
    ...extra,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoistedConfig.loadLinearReconcileState.mockResolvedValue({ ...RECONCILE_STATE })
  hoistedConfig.stampLinearReconciledAt.mockResolvedValue({ error: null })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.getIssue.mockResolvedValue(issue('In Progress', 'started'))
  dbFake = createAsanaRemoteFake({})
})

// ---- Registration ----------------------------------------------------------

describe('linear-reconcile — registration', () => {
  it('serializes per sync state', () => {
    expect(hoisted.config.id).toBe('linear-reconcile')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/linear-reconcile' }])
    expect(hoisted.config.concurrency).toEqual([
      { limit: 1, key: 'event.data.syncStateId' },
    ])
  })

  it("no debounce — it would throttle the function's OWN continuations", () => {
    // A multi-page walk self-chains through `tasks/linear-reconcile`, the very
    // event this function would be debounced on, so any debounce delays each
    // continuation by its full period.
    expect(hoisted.config.debounce).toBeUndefined()
  })
})

// ---- Gates -----------------------------------------------------------------

describe('linear-reconcile — the 6-hour gate', () => {
  it('runs when last_reconcile_at is null (never swept)', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('skips a tick less than 6h after the last full walk', async () => {
    hoistedConfig.loadLinearReconcileState.mockResolvedValue({
      ...RECONCILE_STATE,
      lastReconcileAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'too_soon' })
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('runs again once the last walk is older than 6h', async () => {
    hoistedConfig.loadLinearReconcileState.mockResolvedValue({
      ...RECONCILE_STATE,
      lastReconcileAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    })
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('EXEMPTS a continuation from the gate', async () => {
    // A self-chained page is the middle of a walk that already passed the gate;
    // re-checking would truncate the walk the moment stamping moved earlier.
    hoistedConfig.loadLinearReconcileState.mockResolvedValue({
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
    hoistedConfig.loadLinearReconcileState.mockResolvedValue(null)
    expect(await hoisted.handler({ event: EVENT(), step: makeStep() })).toMatchObject({
      status: 'skipped',
      reason: 'no_sync_state',
    })

    hoistedConfig.loadLinearReconcileState.mockResolvedValue({ ...RECONCILE_STATE })
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    expect(await hoisted.handler({ event: EVENT(), step: makeStep() })).toMatchObject({
      status: 'skipped',
      reason: 'no_token',
    })
  })

  it('sweeps a workspace that has NOT picked a destination', async () => {
    // The structural difference from the Jira sibling, which skips on a missing
    // cloudId: a Linear read needs only the token. Such a workspace simply has
    // no links, so the first page comes back empty and the walk drains.
    dbFake = createAsanaRemoteFake({ links: [], states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'complete', applied: 0 })
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })
})

// ---- Scan set + paging -----------------------------------------------------

describe('linear-reconcile — paging', () => {
  it('scans only OPEN linear links for the workspace', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    await hoisted.handler({ event: EVENT(), step: makeStep() })

    const query = dbFake.linkQueries[0]
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'workspace_id', val: 'ws-1' },
        { op: 'eq', col: 'provider', val: 'linear' },
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
    expect(hoistedConfig.stampLinearReconciledAt).toHaveBeenCalledWith('tss-1')
  })

  it('addresses reads with the token alone — no site argument exists', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'iss-0')
  })

  it('caps at 2 pages (100 reads) and SELF-CHAINS with a keyset cursor', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(150), states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(), step })

    expect(out).toMatchObject({ status: 'continued' })
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(100)
    // NOT stamped — the walk is unfinished, and stamping now would start the 6h
    // cooldown with 50 links never looked at.
    expect(hoistedConfig.stampLinearReconciledAt).not.toHaveBeenCalled()

    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    const [name, payload] = step.sendEvent.mock.calls[0] as unknown as [
      string,
      { name: string; data: { cursorCreatedAt: string; cursorId: string } },
    ]
    expect(name).toBe('continue-reconcile')
    expect(payload.name).toBe('tasks/linear-reconcile')
    expect(payload.data.cursorCreatedAt).toBeTruthy()
    expect(payload.data.cursorId).toBeTruthy()
  })

  it('the continuation resumes AFTER the cursor and terminates', async () => {
    // A cursor that didn't advance would re-sweep page one forever, chaining
    // itself into an infinite loop at 100 Linear reads a go.
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

    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(50)
    expect(out).toMatchObject({ status: 'complete' })
    expect(step2.sendEvent).not.toHaveBeenCalled()
    expect(hoistedConfig.stampLinearReconciledAt).toHaveBeenCalledWith('tss-1')
  })

  it('stamps even when there is nothing to sweep', async () => {
    dbFake = createAsanaRemoteFake({ links: [], states: STATES })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })
    expect(out).toMatchObject({ status: 'complete', applied: 0 })
    expect(hoistedConfig.stampLinearReconciledAt).toHaveBeenCalled()
  })
})

// ---- Shared apply behaviour ------------------------------------------------

describe('linear-reconcile — applies the SAME rules as the webhook path', () => {
  it('completes an action whose issue moved to a `completed`-type state', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Shipped', 'completed'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.statusUpdates).toEqual([
      { actionId: 'act-0', patch: { status_id: 'st-done' } },
    ])
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'flow/entity.status_changed' }),
    )
    expect(dbFake.linkUpdates).toEqual([
      { linkId: 'link-000', patch: { external_state_label: 'Shipped' } },
    ])
  })

  it('lands a `canceled`-type state in the team’s CANCELED state', async () => {
    // The sweep is what CATCHES a dropped delivery, so a cancellation the
    // webhook lost must not be repaired here as a completion — the same
    // corruption, six hours later.
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue("Won't Do", 'canceled'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.statusUpdates).toEqual([
      { actionId: 'act-0', patch: { status_id: 'st-cancel' } },
    ])
  })

  it('lands a `duplicate`-type state in CANCELED too', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Duplicate', 'duplicate'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.statusUpdates).toEqual([
      { actionId: 'act-0', patch: { status_id: 'st-cancel' } },
    ])
  })

  it('leaves an issue still in an open type alone (the CAS matches nothing)', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('In Progress', 'started'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.casUpdates).toHaveLength(0)
    expect(dbFake.statusUpdates).toHaveLength(0)
    // The label was already 'In Progress' — a quiet sweep writes nothing at all.
    expect(dbFake.linkUpdates).toHaveLength(0)
  })

  it('records a state name that moved WITHIN the open types', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('In Review', 'started'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.casUpdates).toHaveLength(0)
    expect(dbFake.linkUpdates).toEqual([
      { linkId: 'link-000', patch: { external_state_label: 'In Review' } },
    ])
  })

  it('leaves the action alone for an UNRECOGNIZED type but still records the name', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Paused', 'hibernating'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.statusUpdates).toHaveLength(0)
    expect(dbFake.linkUpdates).toEqual([
      { linkId: 'link-000', patch: { external_state_label: 'Paused' } },
    ])
  })

  it('refreshes external_url after a team move rewrote the identifier', async () => {
    // The sweep is the backstop for a dropped delivery, so it has to absorb the
    // same drift the webhook path does — including the canonical URL, which
    // Linear rewrites along with the identifier when an issue changes team.
    dbFake = createAsanaRemoteFake({
      links: [
        {
          ...openLinks(1)[0],
          external_state_label: 'In Review',
          external_url: 'https://linear.app/acme/issue/ENG-1',
        },
      ],
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(
      issue('In Review', 'started', {
        identifier: 'OPS-45',
        url: 'https://linear.app/acme/issue/OPS-45',
      }),
    )

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.linkUpdates).toEqual([
      { linkId: 'link-000', patch: { external_url: 'https://linear.app/acme/issue/OPS-45' } },
    ])
  })

  it('marks a NULL issue task_missing and keeps sweeping', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(2),
      actions: [ACTIVE_ACTION('act-0'), ACTIVE_ACTION('act-1')],
      states: STATES,
    })
    hoistedApi.getIssue
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(issue('Done', 'completed'))

    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.markerUpdates).toHaveLength(1)
    expect(
      (dbFake.markerUpdates[0].patch.last_push_error as { code: string }).code,
    ).toBe('task_missing')
    expect(dbFake.statusUpdates).toHaveLength(1)
    expect(out).toMatchObject({ status: 'complete' })
  })

  it('marks a TRASHED issue task_missing without applying its state', async () => {
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed', { trashed: true }))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(
      (dbFake.markerUpdates[0].patch.last_push_error as { code: string }).code,
    ).toBe('task_missing')
    expect(dbFake.statusUpdates).toHaveLength(0)
  })

  it('applies an ARCHIVED but not trashed issue normally', async () => {
    // Linear auto-archives old completed issues — treating archived as gone
    // would stop read-back for exactly the issues most likely to be done.
    dbFake = createAsanaRemoteFake({
      links: openLinks(1),
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(
      issue('Done', 'completed', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    )

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(dbFake.markerUpdates).toHaveLength(0)
    expect(dbFake.statusUpdates).toEqual([
      { actionId: 'act-0', patch: { status_id: 'st-done' } },
    ])
  })

  it('RE-READS a previously missing link and retires its marker', async () => {
    // The marker does not change `completed`, so the link stays in the scan set
    // — which is what makes the retryable reading meaningful rather than
    // decorative.
    dbFake = createAsanaRemoteFake({
      links: [{ ...openLinks(1)[0], last_push_error: { code: 'task_missing', at: 'yesterday' } }],
      actions: [ACTIVE_ACTION('act-0')],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(1)
    expect(dbFake.markerUpdates).toEqual([
      { linkId: 'link-000', patch: { last_push_error: null } },
    ])
    expect(dbFake.statusUpdates).toHaveLength(1)
  })

  it('aborts the run cleanly on 401 — no stamp, no chain', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(60), states: STATES })
    hoistedApi.getIssue.mockRejectedValue(new FakeUnauthorized())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(), step })

    expect(out).toMatchObject({ status: 'aborted', reason: 'unauthorized' })
    expect(hoistedConfig.stampLinearReconciledAt).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rethrows a transient Linear failure so Inngest retries', async () => {
    dbFake = createAsanaRemoteFake({ links: openLinks(1), states: STATES })
    hoistedApi.getIssue.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    await expect(
      hoisted.handler({ event: EVENT(), step: makeStep() }),
    ).rejects.toThrow('unavailable')
  })
})
