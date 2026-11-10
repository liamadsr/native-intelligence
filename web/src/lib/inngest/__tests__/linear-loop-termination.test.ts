import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type FakeTeamStates } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * REGRESSION: the Linear↔Native Intelligence status cycle must terminate.
 *
 * Native Intelligence→Linear (linear-echo-status) and Linear→Native Intelligence (applyRemoteTaskState) form
 * a closed loop: a webhook moves the action, that fires
 * `flow/entity.status_changed`, which wakes the echo, which writes the issue's
 * state, which raises another webhook… Left unguarded this ping-pongs forever,
 * and each hop is a REAL state change in the customer's Linear with its own
 * notifications, triage rules and Slack noise.
 *
 * Three brakes, mirroring the Jira suite next door — with the differences that
 * come from Linear's typed states rather than from a different design:
 *
 *   BRAKE 1 (Native Intelligence→Linear). The echo READS THE ISSUE FIRST and stops when its
 *   current state already satisfies the bucket. ZERO writes. Unlike Jira there
 *   is no transition list involved at all — the comparison is a bucket fold of
 *   `WorkflowState.type` — but the ordering is load-bearing for exactly the same
 *   reason: without it a change a Linear user just made round-trips straight
 *   back out.
 *
 *   BRAKE 2 (Linear→Native Intelligence). The echo records the provider state on the link when
 *   it writes, so the webhook its own write raises finds the CAS already
 *   satisfied and stops before touching the action.
 *
 *   BRAKE 3 (the READ-BACK half of brake 1). A pre-check can only stop the loop
 *   while both sides AGREE about what a state means. A reopen (completed →
 *   started) must land the action in the team's STARTED state, and a
 *   cancellation must land it in the team's CANCELED state — otherwise the echo
 *   wakes with a bucket the issue contradicts and dutifully rewrites the
 *   customer's issue. Linear gets this right structurally where Jira needs a
 *   name heuristic: `canceled` and `duplicate` are real types.
 *
 *   BRAKE 3b. Where the team has no state to land in, the read-back DECLINES
 *   rather than approximating — approximating is what starts a bounce.
 *
 * All of them run the REAL functions against one shared, mutable link row — which
 * is the point: anything that decouples the link row from either direction (a
 * widened fast path, a skipped markSynced, a CAS that no longer guards) fails
 * here rather than in production.
 */

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  send: vi.fn(async () => ({ ids: ['e'] })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handler = fn
      return { id: config.id }
    },
    send: hoisted.send,
  },
}))

/**
 * The action row, held by REFERENCE so a trace can put it where its scenario
 * starts (a reopen begins from a completed action, a cancellation from a
 * started one) and the read-back then reads exactly that.
 */
const ACTIONS = [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }]

/** The team's board as a FULL five-category one, which is what migration 020 seeds. */
const FULL_BOARD: FakeTeamStates = {
  completed: 'st-done',
  default: 'st-todo',
  started: 'st-doing',
  canceled: 'st-cancel',
}

/** Held by REFERENCE, like ACTIONS, and restored in beforeEach. */
const TEAM_STATES: Record<string, FakeTeamStates> = { 'team-1': { ...FULL_BOARD } }

const db = createAsanaRemoteFake({
  links: [
    {
      id: 'link-1',
      action_id: 'act-1',
      external_id: 'iss-1',
      completed: false,
      external_state_label: 'In Progress',
      last_push_error: null,
    },
  ],
  actions: ACTIONS,
  states: TEAM_STATES,
})

/**
 * `workflow_state.id → category`, as the ECHO reads it.
 *
 * Deliberately keyed by id rather than hard-coded: the whole point of brake 3 is
 * that the bucket the echo wakes with is decided by WHICH state the read-back
 * chose, so a test that pinned the category independently would prove nothing
 * about the two sides agreeing.
 */
const STATE_CATEGORY: Record<string, string> = {
  'st-todo': 'unstarted',
  'st-doing': 'started',
  'st-done': 'completed',
  'st-cancel': 'canceled',
}

/** Link writes the echo makes, in order (markSynced / stampMarker). */
const echoLinkWrites: Array<Record<string, unknown>> = []

/**
 * The echo reads its links through `getServiceClient()` with a chain the shared
 * fake doesn't model (`select(...).eq().eq().eq()` awaited, plus workflow_state
 * by id). Layer just those two reads on top, mutating the SAME link rows the
 * apply helper sees — which is the entire point of the test.
 */
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'workflow_state') {
        let wanted: string | null = null
        return {
          select: () => ({
            eq: (_col: string, value: string) => {
              wanted = value
              return {
                maybeSingle: async () => ({
                  data: { category: STATE_CATEGORY[wanted ?? ''] ?? 'completed' },
                }),
              }
            },
          }),
        }
      }
      if (table === 'action_external_task') {
        let targetId: string | null = null
        const api: Record<string, unknown> = {
          select: () => api,
          eq: (col: string, val: unknown) => {
            if (col === 'id') targetId = val as string
            return api
          },
          update: (patch: Record<string, unknown>) => {
            echoLinkWrites.push(patch)
            // Apply it for real: the link row is the brake, so a test that
            // didn't mutate it would prove nothing about termination.
            const row = db.links.find((l) => l.id === (targetId ?? 'link-1'))
            if (row) Object.assign(row, patch)
            return api
          },
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: db.links, error: null }).then(resolve),
        }
        return api
      }
      return db.client.from(table)
    },
  }),
}))

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadLinearSyncState: vi.fn() }))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadLinearSyncState: hoistedConfig.loadLinearSyncState }
})

const hoistedApi = vi.hoisted(() => ({
  getIssue: vi.fn(),
  updateIssueState: vi.fn(),
  listTeamStates: vi.fn(),
}))
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: hoistedApi.getIssue,
    updateIssueState: hoistedApi.updateIssueState,
    listTeamStates: hoistedApi.listTeamStates,
  }
})

const { applyRemoteTaskState } = await import('@/lib/tasks/apply-remote-task-state')
const { linearRemoteState } = await import('@/lib/tasks/lifecycle')
await import('@/lib/inngest/linear-echo-status')

function makeStep(): StepMock {
  return createStepMock()
}

function issue(name: string, type: string) {
  return {
    id: 'iss-1',
    identifier: 'ENG-1',
    url: 'https://linear.app/acme/issue/ENG-1',
    trashed: false,
    archivedAt: null,
    state: { id: `ls-${type}`, name, type },
  }
}

/** The saved, derived state map for the destination team. */
const STATE_MAP = {
  not_started: { id: 'ls-unstarted', name: 'Todo' },
  in_progress: { id: 'ls-started', name: 'In Progress' },
  done: { id: 'ls-completed', name: 'Done' },
  canceled: { id: 'ls-canceled', name: 'Canceled' },
}

const DONE_ISSUE = issue('Done', 'completed')
const IN_PROGRESS_ISSUE = issue('In Progress', 'started')
const CANCELED_ISSUE = issue('Canceled', 'canceled')

beforeEach(() => {
  // Every trace starts from the same shared row, whatever the previous one did
  // to it — the row is deliberately mutable, so the reset has to be explicit.
  Object.assign(ACTIONS[0], { status_id: 'st-doing', team_id: 'team-1', category: 'started' })
  TEAM_STATES['team-1'] = { ...FULL_BOARD }
  Object.assign(db.links[0], {
    completed: false,
    external_state_label: 'In Progress',
    last_push_error: null,
  })
  db.statusUpdates.length = 0
  db.casUpdates.length = 0
  echoLinkWrites.length = 0

  hoisted.send.mockClear()
  hoistedApi.getIssue.mockReset().mockResolvedValue(DONE_ISSUE)
  hoistedApi.updateIssueState.mockReset().mockResolvedValue(DONE_ISSUE)
  hoistedApi.listTeamStates.mockReset().mockResolvedValue([])
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedConfig.loadLinearSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-sync',
    config: { team_id: 'team-1', organization_id: 'org-1', state_map: STATE_MAP },
  })
})

describe('Linear ↔ Native Intelligence loop termination', () => {
  it('BRAKE 1: a webhook-applied completion produces ZERO Linear writes from the echo', async () => {
    // The issue is already in a completed-type state (that's why the webhook
    // fired). An echo that wrote before looking would move it again.
    hoistedApi.getIssue.mockResolvedValue(DONE_ISSUE)

    // 1. Linear → Native Intelligence: the issue moved into a completed-type state.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'iss-1', completed: false },
      ...linearRemoteState('completed'),
    })
    expect(applied.outcome).toBe('completed')
    expect(db.links[0].completed).toBe(true)

    // 2. …which emitted flow/entity.status_changed. Feed that to the echo.
    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    expect(emitted[0].name).toBe('flow/entity.status_changed')

    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    // 3. THE ASSERTION: the echo wrote nothing at Linear.
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      status: 'ok',
      results: [{ linkId: 'link-1', outcome: 'already_synced' }],
    })
    // …and it did NOT mark the link broken, which is the failure mode the
    // current-state probe exists to prevent.
    expect(echoLinkWrites.filter((w) => w.last_push_error)).toHaveLength(0)
  })

  it('BRAKE 2: the echo’s own write cannot come back around', async () => {
    // Start from the other direction: an in-app status change the echo pushes to
    // Linear. Linear then raises a webhook for the write WE just made.
    hoistedApi.getIssue.mockResolvedValue(IN_PROGRESS_ISSUE)
    hoistedApi.updateIssueState.mockResolvedValue(DONE_ISSUE)

    // 1. Native Intelligence → Linear: the echo writes the state and records the result.
    await hoisted.handler({
      event: {
        data: {
          entity_type: 'action',
          entity_id: 'act-1',
          workspace_id: 'ws-1',
          to_status_id: 'st-done',
        },
      },
      step: makeStep(),
    })

    expect(hoistedApi.updateIssueState).toHaveBeenCalledTimes(1)
    // The brake is armed HERE: the link now carries the provider state.
    expect(db.links[0].completed).toBe(true)
    expect(db.links[0].external_state_label).toBe('Done')

    // 2. Linear → Native Intelligence: the webhook raised by our own write arrives.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'iss-1', completed: true },
      ...linearRemoteState('completed'),
    })

    // 3. THE ASSERTION: the CAS matched nothing, so the action was never
    // touched and no status change was emitted — the cycle ends in one hop.
    expect(applied.outcome).toBe('unchanged')
    expect(db.statusUpdates).toHaveLength(0)
    const emitted = hoisted.send.mock.calls as unknown as Array<[{ name?: string }]>
    expect(emitted.filter((c) => c[0]?.name === 'flow/entity.status_changed')).toHaveLength(0)
  })

  it('BRAKE 3: a Linear REOPEN into a started state produces ZERO Linear writes', async () => {
    // The full production trace. A Linear user drags a Done issue to In
    // Progress. If the read-back reopened the action into the team's DEFAULT
    // (unstarted) state, the echo would wake with bucket=not_started against a
    // `started` issue — a genuine disagreement — and drag the user's issue back
    // to Todo seconds later.
    Object.assign(ACTIONS[0], { status_id: 'st-done', category: 'completed' })
    db.links[0].completed = true
    db.links[0].external_state_label = 'Done'
    hoistedApi.getIssue.mockResolvedValue(IN_PROGRESS_ISSUE)

    // 1. Linear → Native Intelligence.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'iss-1', completed: true },
      ...linearRemoteState('started'),
    })
    expect(applied.outcome).toBe('reverted')
    // THE FIX: the started state, not the team default.
    expect(db.statusUpdates).toEqual([
      { actionId: 'act-1', patch: { status_id: 'st-doing' } },
    ])
    Object.assign(ACTIONS[0], { status_id: 'st-doing', category: 'started' })

    // 2. …which woke the echo.
    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    // 3. THE ASSERTION.
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ outcome: 'already_synced' }] })
  })

  it('BRAKE 3b: a started-less team DECLINES the reopen instead of bouncing it', async () => {
    // A Todo→Done board is one DELETE away in Native Intelligence. With no started state the
    // read-back must NOT approximate into the default — that is precisely the
    // disagreement that starts a bounce.
    Object.assign(ACTIONS[0], { status_id: 'st-done', category: 'completed' })
    db.links[0].completed = true
    TEAM_STATES['team-1'] = { completed: 'st-done', default: null, started: null, canceled: null }

    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'iss-1', completed: true },
      ...linearRemoteState('started'),
    })

    expect(applied.outcome).toBe('no_target_state')
    expect(db.statusUpdates).toHaveLength(0)
  })

  it('BRAKE 4: a Linear CANCELLATION lands canceled and produces ZERO Linear writes', async () => {
    // Where Jira needs isCanceledStatusName, Linear has a real `canceled` type —
    // so the two sides agree structurally rather than heuristically, and brake 1
    // can fire.
    hoistedApi.getIssue.mockResolvedValue(CANCELED_ISSUE)

    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'iss-1', completed: false },
      ...linearRemoteState('canceled'),
    })

    // `canceled`, not `completed`: the shared helper reports the distinction
    // Linear's own state type made, which is what keeps the echo agreeing.
    expect(applied.outcome).toBe('canceled')
    expect(db.statusUpdates).toEqual([
      { actionId: 'act-1', patch: { status_id: 'st-cancel' } },
    ])
    Object.assign(ACTIONS[0], { status_id: 'st-cancel', category: 'canceled' })

    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ outcome: 'already_synced' }] })
  })

  it('BRAKE 4b: a DUPLICATE closes the same way, and also stops in one hop', async () => {
    // The seventh state type. Folding it anywhere but `canceled` would either
    // leave the action open forever (no signal) or claim the work shipped.
    hoistedApi.getIssue.mockResolvedValue(issue('Duplicate', 'duplicate'))

    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'iss-1', completed: false },
      ...linearRemoteState('duplicate'),
    })

    // `canceled`, not `completed`: the shared helper reports the distinction
    // Linear's own state type made, which is what keeps the echo agreeing.
    expect(applied.outcome).toBe('canceled')
    expect(db.statusUpdates).toEqual([
      { actionId: 'act-1', patch: { status_id: 'st-cancel' } },
    ])
    Object.assign(ACTIONS[0], { status_id: 'st-cancel', category: 'canceled' })

    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
  })

  it('BRAKE 5: a Linear UN-CANCEL follows the issue back into progress, then stops', async () => {
    // The converse of brake 4: a CANCELED action must not be hoarded when the
    // provider says unambiguously that the issue is moving again. Linear always
    // supplies the hint (the type IS the signal), so `canceled_protected` — the
    // Asana carve-out — never applies here.
    Object.assign(ACTIONS[0], { status_id: 'st-cancel', category: 'canceled' })
    db.links[0].completed = true
    db.links[0].external_state_label = 'Canceled'
    hoistedApi.getIssue.mockResolvedValue(IN_PROGRESS_ISSUE)

    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'iss-1', completed: true },
      ...linearRemoteState('started'),
    })

    expect(applied.outcome).toBe('reverted')
    expect(db.statusUpdates).toEqual([
      { actionId: 'act-1', patch: { status_id: 'st-doing' } },
    ])
    Object.assign(ACTIONS[0], { status_id: 'st-doing', category: 'started' })

    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ outcome: 'already_synced' }] })
  })
})
