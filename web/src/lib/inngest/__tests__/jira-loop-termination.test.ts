import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type FakeTeamStates } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * REGRESSION: the Jira↔Native Intelligence status cycle must terminate.
 *
 * Native Intelligence→Jira (jira-echo-status) and Jira→Native Intelligence (applyRemoteTaskState) form a
 * closed loop: a webhook moves the action, that fires
 * `flow/entity.status_changed`, which wakes the echo, which transitions the
 * issue, which raises another webhook… Left unguarded this ping-pongs forever,
 * and each hop is a REAL status change in the customer's Jira with its own
 * notifications and automation triggers.
 *
 * Jira has TWO brakes, and they are not the same one Asana uses. Asana's echo
 * can answer "already in sync?" from the link row alone (its lifecycle is a
 * boolean), so it short-circuits before any API call. Jira's cannot — which
 * transitions exist depends on the issue's current status — so:
 *
 *   BRAKE 1 (Native Intelligence→Jira, tested first). The echo ASKS JIRA FIRST: it reads the
 *   issue's current status before selecting anything, and when that status
 *   already satisfies the bucket it stops there. ZERO writes. The transition
 *   list cannot answer this on its own — a workflow offers no self-loop, so
 *   "nothing reaches the target" and "we are already on the target" look
 *   identical from it, and the version of this test that only supplied a
 *   candidate-less list was passing for the wrong reason.
 *
 *   BRAKE 2 (Jira→Native Intelligence, tested second). The echo records the provider state on
 *   the link when it transitions, so the webhook its own write raises finds the
 *   CAS already satisfied and stops before touching the action.
 *
 *   BRAKE 3 / BRAKE 4 (the READ-BACK half of brake 1). A pre-check can only stop
 *   the loop when the two sides AGREE about what the issue's status means, and
 *   for two Jira shapes they used not to: a reopen (Done → In Progress) landed
 *   the action in the team's DEFAULT state, and a cancellation (→ "Won't Do")
 *   landed it in the team's COMPLETED state. Both then woke the echo with a
 *   bucket the issue genuinely contradicted, so it dutifully transitioned the
 *   issue back and overwrote the choice a human had just made. Fixed in the
 *   read-back (category- and cancel-aware landing), which is what makes brake 1
 *   fire for these two traces instead of being structurally unable to.
 *
 *   BRAKE 3b / BRAKE 5 (the two EDGES of that fix, added in round 2). Landing
 *   the action somewhere the issue contradicts is what starts a bounce, so the
 *   read-back declines rather than approximating when the team has no state to
 *   land in (3b) — and, conversely, does NOT hoard a cancellation when the
 *   provider says unambiguously that the issue is moving again (5). 5b pins the
 *   Asana half of that same rule, which is unchanged.
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

/**
 * Held by REFERENCE, like ACTIONS, and restored in beforeEach: two traces delete
 * a column to prove the board shapes a user can actually reach (a Todo→Done
 * board is one DELETE away — the workflow-states route only refuses a state
 * actions still reference) are handled without overwriting the human.
 */
const TEAM_STATES: Record<string, FakeTeamStates> = { 'team-1': { ...FULL_BOARD } }

const db = createAsanaRemoteFake({
  links: [
    {
      id: 'link-1',
      action_id: 'act-1',
      external_id: '10001',
      external_scope: 'cafe0001',
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
 * Deliberately keyed by id rather than hard-coded: the whole point of brakes 3
 * and 4 is that the bucket the echo wakes with is decided by WHICH state the
 * read-back chose, so a test that pinned the category independently would prove
 * nothing about the two sides agreeing.
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
        // The echo resolves the TARGET status's category by id.
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

const hoistedConfig = vi.hoisted(() => ({ loadJiraSyncState: vi.fn() }))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadJiraSyncState: hoistedConfig.loadJiraSyncState }
})

const hoistedApi = vi.hoisted(() => ({
  getTransitions: vi.fn(),
  transitionIssue: vi.fn(),
  getIssue: vi.fn(),
}))
vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getTransitions: hoistedApi.getTransitions,
    transitionIssue: hoistedApi.transitionIssue,
    getIssue: hoistedApi.getIssue,
  }
})

const { applyRemoteTaskState } = await import('@/lib/tasks/apply-remote-task-state')
await import('@/lib/inngest/jira-echo-status')

/**
 * Shared Inngest step mock — a vi.fn per method plus the nesting tripwire (step
 * tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

/** The issue as Jira reports it once it has landed in a done-category status. */
const DONE_ISSUE = {
  id: '10001',
  fields: { status: { id: 's-done', name: 'Done', statusCategory: { key: 'done' } } },
}

/** …and while it is still open, which is where BRAKE 2's cycle starts. */
const IN_PROGRESS_ISSUE = {
  id: '10001',
  fields: {
    status: { id: 's-doing', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  },
}

/** …and once a Jira user has abandoned it. */
const WONT_DO_ISSUE = {
  id: '10001',
  fields: { status: { id: 's-wont', name: "Won't Do", statusCategory: { key: 'done' } } },
}

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
  hoistedApi.getTransitions.mockReset()
  hoistedApi.transitionIssue.mockReset().mockResolvedValue(undefined)
  hoistedApi.getIssue.mockReset().mockResolvedValue(DONE_ISSUE)
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedConfig.loadJiraSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-sync',
    // No status map: the echo falls back to statusCategory, the common case.
    config: { cloud_id: 'cafe0001', project_id: '10000', issue_type_id: '1' },
  })
})

describe('Jira ↔ Native Intelligence loop termination', () => {
  it('BRAKE 1: a webhook-applied completion produces ZERO Jira writes from the echo', async () => {
    // The issue is already Done (that's why the webhook fired). The workflow
    // offers a reopen AND a "Won't Do" — both real transitions — so an echo that
    // selected before looking would fire one of them at an issue the user just
    // finished. Recognising "already there" is the only correct answer.
    hoistedApi.getTransitions.mockResolvedValue([
      { id: '41', name: "Won't Do", to: { id: 's-wont', name: "Won't Do", statusCategory: { key: 'done' } } },
      { id: '11', name: 'Reopen', to: { id: 's-todo', name: 'To Do', statusCategory: { key: 'new' } } },
    ])

    // 1. Jira → Native Intelligence: the issue moved into a done-category status.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: false },
      remoteCompleted: true,
    })
    expect(applied.outcome).toBe('completed')
    expect(db.links[0].completed).toBe(true)

    // 2. …which emitted flow/entity.status_changed. Feed that to the echo.
    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    expect(emitted[0].name).toBe('flow/entity.status_changed')

    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    // 3. THE ASSERTION: the echo transitioned nothing — and did not even need
    // the transition list to work that out.
    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(hoistedApi.getTransitions).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      status: 'ok',
      results: [{ linkId: 'link-1', outcome: 'already_synced' }],
    })
    // …and it did NOT mark the link broken, which is the failure mode the
    // current-status probe exists to prevent.
    const marks = echoLinkWrites.filter((w) => w.last_push_error)
    expect(marks).toHaveLength(0)
  })

  it('BRAKE 2: the echo’s own transition cannot come back around', async () => {
    // Start from the other direction: an in-app status change the echo pushes to
    // Jira. Jira then raises a webhook for the transition WE just made.
    db.links[0].completed = false
    db.links[0].external_state_label = 'In Progress'
    // The fake accumulates across the file — clear what BRAKE 1 recorded so the
    // assertions below are about THIS cycle only.
    db.statusUpdates.length = 0
    db.casUpdates.length = 0
    echoLinkWrites.length = 0
    hoisted.send.mockClear()
    // This cycle starts from an issue that is genuinely still open — the action
    // moving to Done in Native Intelligence is the change being pushed out.
    hoistedApi.getIssue.mockResolvedValue(IN_PROGRESS_ISSUE)
    hoistedApi.getTransitions.mockResolvedValue([
      {
        id: '31',
        name: 'Done',
        to: { id: 's-done', name: 'Done', statusCategory: { key: 'done' } },
      },
    ])

    // 1. Native Intelligence → Jira: the echo fires the transition and records the result.
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

    expect(hoistedApi.transitionIssue).toHaveBeenCalledTimes(1)
    // The brake is armed HERE: the link now carries the provider state.
    expect(db.links[0].completed).toBe(true)
    expect(db.links[0].external_state_label).toBe('Done')

    // 2. Jira → Native Intelligence: the webhook raised by our own transition arrives.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: true },
      remoteCompleted: true,
    })

    // 3. THE ASSERTION: the CAS matched nothing, so the action was never
    // touched and no status change was emitted — the cycle ends in one hop.
    expect(applied.outcome).toBe('unchanged')
    expect(db.statusUpdates).toHaveLength(0)
    const emitted = hoisted.send.mock.calls as unknown as Array<[{ name?: string }]>
    expect(emitted.filter((c) => c[0]?.name === 'flow/entity.status_changed')).toHaveLength(0)
  })

  /**
   * REGRESSION (review finding 17, re-confirmed by the round-1 audit: "echo
   * transitions an issue that already satisfies the bucket, bouncing a Jira
   * reopen back to To Do").
   *
   * The full production trace, end to end. A Jira user drags a Done issue to "In
   * Progress"; the read-back folded that to `remoteCompleted:false` and reopened
   * the action into the team's DEFAULT state (unstarted), so the echo woke with
   * bucket=not_started against an `indeterminate` issue. The two sides genuinely
   * disagreed, brake 1 could not fire by construction, and the echo moved the
   * user's "In Progress" back to "To Do" seconds later.
   *
   * The fix is in the READ-BACK, not the echo: a reopen whose remote status is
   * `indeterminate` lands in the team's own started state, and brake 1 then does
   * the rest by itself.
   */
  it('BRAKE 3: a Jira REOPEN into In Progress produces ZERO Jira writes', async () => {
    // The action is Done in Native Intelligence and the issue is Done in Jira; the user then
    // drags the issue to In Progress.
    Object.assign(ACTIONS[0], { status_id: 'st-done', category: 'completed' })
    db.links[0].completed = true
    db.links[0].external_state_label = 'Done'
    hoistedApi.getIssue.mockResolvedValue(IN_PROGRESS_ISSUE)
    // From In Progress the workflow offers a way back to To Do and on to Done —
    // both real transitions, either of which would overwrite the user's choice.
    hoistedApi.getTransitions.mockResolvedValue([
      { id: '11', name: 'To Do', to: { id: 's-todo', name: 'To Do', statusCategory: { key: 'new' } } },
      { id: '31', name: 'Done', to: { id: 's-done', name: 'Done', statusCategory: { key: 'done' } } },
    ])

    // 1. Jira → Native Intelligence.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: true },
      remoteCompleted: false,
      remoteHint: { category: 'indeterminate' },
    })

    // THE READ-BACK ASSERTION: the action follows the issue into a STARTED
    // state, not into the team's default one.
    expect(applied).toMatchObject({ outcome: 'reverted', toStatusId: 'st-doing' })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-doing' } }])

    // 2. …which emitted flow/entity.status_changed. Feed that to the echo.
    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    expect(emitted[0].name).toBe('flow/entity.status_changed')

    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    // 3. THE ECHO ASSERTION: bucket=in_progress now matches the issue's own
    // `indeterminate` status, so nothing is fired at the customer's Jira.
    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(hoistedApi.getTransitions).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      status: 'ok',
      bucket: 'in_progress',
      results: [{ linkId: 'link-1', outcome: 'already_synced' }],
    })
    expect(echoLinkWrites.filter((w) => w.last_push_error)).toHaveLength(0)
  })

  /**
   * REGRESSION (round-2 audit, echo issue 2: "the exact finding-17 bounce
   * survives for a team with no `started`-category state").
   *
   * BRAKE 3 with the in-progress column deleted — a reachable board, not a
   * theoretical one. The first fix reopened into the team's `started` state and
   * FELL BACK to the ordinary reopen target (is_default, an unstarted state)
   * when there was none, which re-created the very bounce it existed to remove:
   * the read-back put the action in To Do, the echo woke with
   * bucket=not_started against an `indeterminate` issue, and dragged the user's
   * "In Progress" back to "To Do".
   *
   * The honest answer is to write NOTHING to the action: `no_target_state`. The
   * link still records the provider's state (so a re-delivery is a no-op and the
   * label is still refreshed by the caller), Native Intelligence and Jira visibly disagree,
   * and neither system overwrites the other.
   */
  it('BRAKE 3b: a started-less team DECLINES the reopen instead of bouncing it', async () => {
    delete TEAM_STATES['team-1'].started
    Object.assign(ACTIONS[0], { status_id: 'st-done', category: 'completed' })
    db.links[0].completed = true
    db.links[0].external_state_label = 'Done'
    hoistedApi.getIssue.mockResolvedValue(IN_PROGRESS_ISSUE)
    // The transition that USED to be fired at the customer's Jira.
    hoistedApi.getTransitions.mockResolvedValue([
      { id: '11', name: 'To Do', to: { id: 's-todo', name: 'To Do', statusCategory: { key: 'new' } } },
    ])

    // 1. Jira → Native Intelligence.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: true },
      remoteCompleted: false,
      remoteHint: { category: 'indeterminate' },
    })

    // THE READ-BACK ASSERTION: no state to land in, so nothing lands.
    expect(applied).toMatchObject({ linkId: 'link-1', outcome: 'no_target_state' })
    expect(applied.toStatusId).toBeUndefined()
    expect(db.statusUpdates).toHaveLength(0)
    expect(ACTIONS[0].status_id).toBe('st-done')

    // …but the link DID move, so the re-delivery Jira may send is a no-op.
    expect(db.casUpdates).toHaveLength(1)
    expect(db.links[0].completed).toBe(false)

    // 2. THE ECHO ASSERTION: no status change was emitted, so the echo is never
    // woken and nothing at all is fired at the customer's Jira.
    const emitted = hoisted.send.mock.calls as unknown as Array<[{ name?: string }]>
    expect(emitted.filter((c) => c[0]?.name === 'flow/entity.status_changed')).toHaveLength(0)
    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
  })

  /**
   * REGRESSION (round-1 audit, echo group issue 2 — the verifier's HEADLINE
   * instance of the same root cause: "a Jira-side cancellation round-trips back
   * out as a completion").
   *
   * A Jira user moves a started issue to "Won't Do". The read-back folded that
   * to `remoteCompleted:true` (Jira has no cancel CATEGORY — canceled and done
   * share `done`) and moved the action into the team's COMPLETED state: the
   * user's cancellation was recorded in Native Intelligence as a completion, and the echo then
   * woke with bucket=done and transitioned the issue from "Won't Do" back to
   * "Done", stamping a `resolution: Done` on the way.
   */
  it('BRAKE 4: a Jira CANCELLATION lands canceled and produces ZERO Jira writes', async () => {
    hoistedApi.getIssue.mockResolvedValue(WONT_DO_ISSUE)
    // "Done" is reachable from "Won't Do" — the transition the old code fired.
    hoistedApi.getTransitions.mockResolvedValue([
      { id: '31', name: 'Done', to: { id: 's-done', name: 'Done', statusCategory: { key: 'done' } } },
    ])

    // 1. Jira → Native Intelligence.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: false },
      remoteCompleted: true,
      remoteCanceled: true,
    })

    // THE READ-BACK ASSERTION: cancelled work is recorded as cancelled.
    expect(applied).toMatchObject({ outcome: 'canceled', toStatusId: 'st-cancel' })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-cancel' } }])

    // 2. The status change wakes the echo.
    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    // 3. THE ECHO ASSERTION: bucket=canceled is satisfied by the issue's own
    // done-category status, so the user's "Won't Do" is left exactly alone.
    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      status: 'ok',
      bucket: 'canceled',
      results: [{ linkId: 'link-1', outcome: 'already_synced' }],
    })
  })

  /**
   * REGRESSION (round-2 audit, echo issue 3: "canceled_protected is newly
   * reachable for JIRA-ORIGINATED cancellations, and refuses the reopen
   * forever").
   *
   * BRAKE 4 followed by the user changing their mind. `canceled_protected`
   * exists because ASANA's un-complete is ambiguous — Asana cannot represent
   * cancellation, so a canceled action's task is completed:true exactly like a
   * done one and "un-completed" could mean either "not done" or "not
   * cancelled". Jira's is not ambiguous: the caller hands us the issue's actual
   * statusCategory, and `indeterminate` says "in progress" and nothing else.
   * Refusing that reopen left the action Cancelled forever, with the 6-hourly
   * reconcile re-refusing it on every sweep.
   *
   * So: hint present → follow the issue; hint absent (every Asana caller) →
   * canceled_protected, exactly as before.
   */
  it('BRAKE 5: a Jira UN-CANCEL follows the issue back into progress, then stops', async () => {
    // 1. Jira → Native Intelligence: the user abandons the issue (BRAKE 4's first half).
    hoistedApi.getIssue.mockResolvedValue(WONT_DO_ISSUE)
    const canceled = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: false },
      remoteCompleted: true,
      remoteCanceled: true,
    })
    expect(canceled).toMatchObject({ outcome: 'canceled', toStatusId: 'st-cancel' })
    // The status write the fake records against the shared action row.
    Object.assign(ACTIONS[0], { status_id: 'st-cancel', category: 'canceled' })
    db.statusUpdates.length = 0
    hoisted.send.mockClear()

    // 2. …and changes their mind: the issue goes back to In Progress.
    hoistedApi.getIssue.mockResolvedValue(IN_PROGRESS_ISSUE)
    hoistedApi.getTransitions.mockResolvedValue([
      { id: '11', name: 'To Do', to: { id: 's-todo', name: 'To Do', statusCategory: { key: 'new' } } },
      { id: '31', name: 'Done', to: { id: 's-done', name: 'Done', statusCategory: { key: 'done' } } },
    ])

    const reopened = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: true },
      remoteCompleted: false,
      remoteHint: { category: 'indeterminate' },
    })

    // THE READ-BACK ASSERTION: the cancellation is NOT sticky against an
    // unambiguous provider signal — the action follows the issue.
    expect(reopened).toMatchObject({ outcome: 'reverted', toStatusId: 'st-doing' })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-doing' } }])
    Object.assign(ACTIONS[0], { status_id: 'st-doing', category: 'started' })

    // 3. THE ECHO ASSERTION: and the round trip still terminates in one hop —
    // bucket=in_progress matches the issue's own `indeterminate` status.
    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    expect(emitted[0].name).toBe('flow/entity.status_changed')
    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(hoistedApi.getTransitions).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      status: 'ok',
      bucket: 'in_progress',
      results: [{ linkId: 'link-1', outcome: 'already_synced' }],
    })
  })

  /**
   * The other half of BRAKE 5's rule, and the reason it is safe: an ASANA
   * caller passes no hint, so the un-complete of a canceled action stays
   * ambiguous and stays refused. Asana's own suites pin this too; it is
   * repeated here because this file is where the two providers' shared helper
   * is exercised against a live link row.
   */
  it('BRAKE 5b: an un-complete with NO hint (Asana) is still canceled_protected', async () => {
    Object.assign(ACTIONS[0], { status_id: 'st-cancel', category: 'canceled' })
    db.links[0].completed = true

    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: '10001', completed: true },
      remoteCompleted: false,
    })

    expect(applied).toMatchObject({ outcome: 'canceled_protected' })
    expect(db.statusUpdates).toHaveLength(0)
    // Not even the link row moves — a committed completed:false would strand it.
    expect(db.casUpdates).toHaveLength(0)
    expect(db.links[0].completed).toBe(true)
  })
})
