/**
 * An agent's finish leaves the action in REVIEW, never Done; the person's
 * Reviewed marks it Done (decision 9, Liam 2026-10-14). One helper module
 * (src/lib/actions/agent-finish.ts) for every finish path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  beginStateFor,
  completeActionOnReview,
  completeActionsForMergedPr,
  doneStateFor,
  moveActionToReview,
  moveCardForRun,
  reviewStateFor,
  type TeamState,
} from '../agent-finish'
import { resolveWorkForAction, resolveWorkForDeliverable, settleWorkReview } from '@/lib/work/resolve'

const send = vi.hoisted(() => vi.fn(async (_p: unknown) => undefined))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send } }))
const notify = vi.hoisted(() => vi.fn(async (_p: Record<string, unknown>) => undefined))
vi.mock('@/lib/notifications', () => ({ createNotification: notify }))
const track = vi.hoisted(() => vi.fn())
vi.mock('@/lib/posthog', () => ({ trackServerEvent: track }))
// A linked pull request's present state on GitHub (pr-metadata.ts readPrState): never knowable unless a test says.
const prRead = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: false, why: 'unknowable' })))
vi.mock('@/lib/github/pr-metadata', () => ({ readPrState: prRead }))
// The person's agent's client (agent-writer.ts): each test hands back its fake.
const agentWriter = vi.hoisted(() => vi.fn((_userId: string): unknown => null))
vi.mock('../agent-writer', () => ({ agentWriterFor: agentWriter }))

const BASIC: TeamState[] = [
  { id: 'backlog', name: 'Backlog', category: 'backlog', sort_order: 0 },
  { id: 'todo', name: 'Todo', category: 'unstarted', sort_order: 1 },
  { id: 'doing', name: 'In Progress', category: 'started', sort_order: 2 },
  { id: 'done', name: 'Done', category: 'completed', sort_order: 3 },
  { id: 'canceled', name: 'Canceled', category: 'canceled', sort_order: 4 },
]
const WITH_REVIEW: TeamState[] = [...BASIC, { id: 'review', name: 'In Review', category: 'started', sort_order: 2.5 }]

describe('reviewStateFor', () => {
  it('never picks a completed state', () => {
    for (const current of ['backlog', 'todo', 'doing']) {
      expect(reviewStateFor(BASIC, current)).not.toBe('done')
      expect(reviewStateFor(WITH_REVIEW, current)).not.toBe('done')
    }
  })

  it('prefers the team’s review-named state when there is one', () => {
    expect(reviewStateFor(WITH_REVIEW, 'doing')).toBe('review')
    expect(reviewStateFor(WITH_REVIEW, 'todo')).toBe('review')
    expect(reviewStateFor(WITH_REVIEW, 'review')).toBeNull()
  })

  it('without one, a started action stays where it is', () => {
    expect(reviewStateFor(BASIC, 'doing')).toBeNull()
  })

  it('an action that never left Backlog / Todo moves to the first started state', () => {
    expect(reviewStateFor(BASIC, 'todo')).toBe('doing')
    expect(reviewStateFor(BASIC, 'backlog')).toBe('doing')
  })

  it('leaves an action a person already closed alone', () => {
    expect(reviewStateFor(WITH_REVIEW, 'done')).toBeNull()
    expect(reviewStateFor(WITH_REVIEW, 'canceled')).toBeNull()
  })

  it('ignores a review-named state that is not started (closed, or a backlog one)', () => {
    const states = [
      ...BASIC,
      { id: 'reviewed', name: 'Reviewed', category: 'completed', sort_order: 5 },
      { id: 'to-review', name: 'To review', category: 'backlog', sort_order: 0.5 },
    ]
    expect(reviewStateFor(states, 'todo')).toBe('doing')
  })

  it('never moves an action backwards: one already in a later started state stays put', () => {
    const states = [...WITH_REVIEW, { id: 'qa', name: 'QA', category: 'started', sort_order: 2.8 }]
    expect(reviewStateFor(states, 'qa')).toBeNull()
    expect(reviewStateFor(states, 'doing')).toBe('review')
  })

  it('doneStateFor is the first completed state', () => {
    expect(doneStateFor(BASIC)).toBe('done')
    expect(doneStateFor(BASIC.filter((s) => s.category !== 'completed'))).toBeNull()
  })
})

function world(status = 'todo', states: TeamState[] = BASIC, project = false): FakeSupabase {
  // `project`: a write's select returns the columns it names, as PostgREST does.
  const fake = makeFakeSupabase({ project })
  fake.seed('workflow_state', states.map((s) => ({ ...s, team_id: 'team-1' })))
  fake.seed('actions', [{ id: 'act-1', workspace_id: 'ws-1', team_id: 'team-1', status_id: status, agent_run_status: 'working' }])
  fake.seed('member', [{ id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' }])
  return fake
}

beforeEach(() => {
  send.mockClear()
  notify.mockClear()
  track.mockClear()
  agentWriter.mockReset()
  prRead.mockReset()
  prRead.mockResolvedValue({ ok: false, why: 'unknowable' })
})

describe('moveActionToReview', () => {
  it('the run’s settle: moves the action to review, sets the run status idle, and says who moved it to the flow dispatcher', async () => {
    const fake = world('todo')
    const out = await moveActionToReview(fake as never, {
      actionId: 'act-1',
      workspaceId: 'ws-1',
      resetRunStatus: true,
      actor: { userId: 'user-1', origin: { actor: 'agent', depth: 1, run_id: 'run-1' } },
    })
    expect(out).toEqual({ found: true, movedTo: 'doing' })
    expect(fake.rows('actions')[0]).toMatchObject({ status_id: 'doing', agent_run_status: 'idle' })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'flow/entity.status_changed',
        data: expect.objectContaining({ to_status_id: 'doing', origin: { actor: 'agent', depth: 1, run_id: 'run-1' } }),
      }),
    )
  })

  it('the settle on a started action: it stays put (no status write, no emit), its run status goes idle', async () => {
    const fake = world('doing')
    expect(await moveActionToReview(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', resetRunStatus: true })).toEqual({ found: true, movedTo: null })
    expect(fake.rows('actions')[0]).toMatchObject({ status_id: 'doing', agent_run_status: 'idle' })
    expect(send).not.toHaveBeenCalled()
  })

  it('an in-run move (complete_action mid-run) only moves the state: the run is still going', async () => {
    const fake = world('todo')
    await moveActionToReview(fake as never, { actionId: 'act-1', workspaceId: 'ws-1' })
    expect(fake.rows('actions')[0]).toMatchObject({ status_id: 'doing', agent_run_status: 'working' })
    const started = world('doing')
    await moveActionToReview(started as never, { actionId: 'act-1', workspaceId: 'ws-1' })
    expect(started.calls.filter((c) => c.table === 'actions' && c.op === 'update')).toHaveLength(0)
  })

  it('is fenced to the workspace', async () => {
    const fake = world('todo')
    expect(await moveActionToReview(fake as never, { actionId: 'act-1', workspaceId: 'ws-other' })).toEqual({ found: false, movedTo: null })
    expect(fake.rows('actions')[0].status_id).toBe('todo')
  })
})

describe('completeActionOnReview', () => {
  it('marks the action Done as the person’s act', async () => {
    const fake = world('doing')
    expect(await completeActionOnReview(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', actorUserId: 'user-1' })).toBe('done')
    expect(fake.rows('actions')[0].status_id).toBe('done')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ to_status_id: 'done', actor_user_id: 'user-1', origin: { actor: 'user', depth: 0 } }) }),
    )
  })

  it('leaves an action a person already canceled alone', async () => {
    const fake = world('canceled')
    expect(await completeActionOnReview(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', actorUserId: 'user-1' })).toBeNull()
    expect(fake.rows('actions')[0].status_id).toBe('canceled')
    expect(track).not.toHaveBeenCalled()
  })

  it('sends what the PATCH path sends on Done: the analytics event, and a notice to every other assignee', async () => {
    const fake = world('doing')
    fake.rows('actions')[0].identifier = 'ENG-1'
    fake.rows('actions')[0].title = 'Write the brief'
    fake.seed('member', [{ id: 'mem-2', user_id: 'user-2', workspace_id: 'ws-1' }])
    fake.rows('member')[0].display_name = 'Ada'
    fake.seed('action_assignee', [
      { action_id: 'act-1', member_id: 'mem-1' },
      { action_id: 'act-1', member_id: 'mem-2' },
    ])
    await completeActionOnReview(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', actorUserId: 'user-1' })
    expect(track).toHaveBeenCalledWith('action_completed', { userId: 'user-1', workspaceId: 'ws-1' }, { action_id: 'act-1' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({
      recipientId: 'mem-2',
      type: 'action_status_changed',
      title: 'Ada completed ENG-1',
      body: 'Write the brief',
      actorId: 'mem-1',
      targetType: 'action',
      targetId: 'act-1',
      metadata: { action_identifier: 'ENG-1', new_status: 'Done', new_category: 'completed' },
    })
  })
})

describe('a coding job waits for its merge', () => {
  function codingWorld(prResolved = false) {
    const fake = world('doing', BASIC, true)
    fake.seed('tracked_job', [
      {
        id: 'job-c',
        workspace_id: 'ws-1',
        member_id: 'mem-1',
        kind: 'coding_run',
        title: 'Fix the export',
        status: 'needs_review',
        deliverables: [{ type: 'pr', id: 'https://github.com/acme/core/pull/7', label: 'PR #7', ...(prResolved ? { resolved_at: 'x' } : {}) }],
        progress: {},
        source: { agent_run_id: 'run-c', action_id: 'act-1' },
      },
    ])
    fake.seed('agent_run', [
      { id: 'run-c', workspace_id: 'ws-1', kind: 'coding', action_id: 'act-1', triggered_by: 'user-1', pr_url: 'https://github.com/acme/core/pull/7' },
    ])
    return fake
  }

  it('Reviewed before the PR merges leaves the action open', async () => {
    const fake = codingWorld()
    await settleWorkReview(fake as never, fake.rows('tracked_job')[0] as never, 'reviewed')
    expect(fake.rows('tracked_job')[0].status).toBe('done')
    expect(fake.rows('actions')[0].status_id).toBe('doing')
  })

  it('the merge then marks it Done', async () => {
    const fake = codingWorld()
    await settleWorkReview(fake as never, fake.rows('tracked_job')[0] as never, 'reviewed')
    expect(await completeActionsForMergedPr(fake as never, 'https://github.com/acme/core/pull/7')).toBe(1)
    expect(fake.rows('actions')[0].status_id).toBe('done')
  })
})

describe('resolveWorkForAction: a person marking the action Done settles its review', () => {
  it('reviews every needs_review job that worked the action, and nothing else', async () => {
    const fake = world('done')
    fake.seed('tracked_job', [
      { id: 'job-1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'needs_review', progress: {}, source: { action_id: 'act-1' } },
      { id: 'job-2', workspace_id: 'ws-1', member_id: 'mem-1', status: 'needs_review', progress: {}, source: { action_id: 'act-other' } },
      { id: 'job-3', workspace_id: 'ws-1', member_id: 'mem-1', status: 'running', progress: {}, source: { action_id: 'act-1' } },
    ])
    expect(await resolveWorkForAction(fake as never, { actionId: 'act-1', workspaceId: 'ws-1' })).toEqual(['job-1'])
    expect(fake.rows('tracked_job').map((r) => r.status)).toEqual(['done', 'needs_review', 'running'])
    expect((fake.rows('tracked_job')[0].progress as { review?: string }).review).toBe('reviewed')
  })
})

describe('settleWorkReview → the action', () => {
  function withJob(fake: FakeSupabase) {
    fake.seed('tracked_job', [
      {
        id: 'job-1',
        workspace_id: 'ws-1',
        member_id: 'mem-1',
        kind: 'work_run',
        title: 'Write the brief',
        status: 'needs_review',
        needs: { kind: 'review', verb: 'review' },
        deliverables: [],
        progress: {},
        source: { agent_run_id: 'run-1', action_id: 'act-1' },
        created_at: '2026-10-14T00:00:00.000Z',
        reviewed_at: null,
      },
    ])
  }

  it('Reviewed marks the job’s action Done', async () => {
    const fake = world('doing')
    withJob(fake)
    const row = fake.rows('tracked_job')[0] as never
    const out = await settleWorkReview(fake as never, row, 'reviewed')
    expect(out.changed).toBe(true)
    expect(fake.rows('actions')[0].status_id).toBe('done')
  })

  it('accepting the work on its own surface (its last deliverable resolved) marks the action Done too', async () => {
    const fake = world('doing', BASIC, true)
    withJob(fake)
    fake.rows('tracked_job')[0].deliverables = [{ type: 'email_draft', id: 'd1', label: 'Reply' }]
    const out = await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'd1' })
    expect(out.completed).toEqual(['job-1'])
    expect(fake.rows('actions')[0].status_id).toBe('done')
  })

  it('Dismiss leaves the action where it is', async () => {
    const fake = world('doing')
    withJob(fake)
    const row = fake.rows('tracked_job')[0] as never
    await settleWorkReview(fake as never, row, 'dismissed')
    expect(fake.rows('actions')[0].status_id).toBe('doing')
  })
})

describe('beginStateFor: a job began on the card', () => {
  it('takes a card out of Backlog or Todo to the first started state, by category', () => {
    expect(beginStateFor(BASIC, 'backlog')).toBe('doing')
    expect(beginStateFor(BASIC, 'todo')).toBe('doing')
    expect(beginStateFor(BASIC, null)).toBe('doing')
  })

  it('reads the category, not the name: a renamed Todo still counts, a started state named "Todo" does not', () => {
    const renamed: TeamState[] = [
      { id: 'ideas', name: 'Ideas', category: 'backlog', sort_order: 0 },
      { id: 'todo-ish', name: 'Todo (started)', category: 'started', sort_order: 1 },
      { id: 'later', name: 'Building', category: 'started', sort_order: 2 },
    ]
    expect(beginStateFor(renamed, 'ideas')).toBe('todo-ish')
    expect(beginStateFor(renamed, 'todo-ish')).toBeNull()
  })

  it('leaves a started, closed or unknown card where it is', () => {
    expect(beginStateFor(BASIC, 'doing')).toBeNull()
    expect(beginStateFor(BASIC, 'done')).toBeNull()
    expect(beginStateFor(BASIC, 'canceled')).toBeNull()
    expect(beginStateFor(BASIC, 'another-team')).toBeNull()
    expect(beginStateFor(BASIC.filter((s) => s.category !== 'started'), 'todo')).toBeNull()
  })
})

describe('moveCardForRun: a person’s own agent run moves its card', () => {
  const RUN = { userId: 'user-1', id: 'sess-1', beganAt: '2026-11-14T10:00:00.000Z' }

  function cardWorld(status: string, states: TeamState[] = BASIC) {
    const fake = world(status, states)
    agentWriter.mockImplementation(() => fake)
    return fake
  }

  it('begin: Todo → the first started state, written as the person’s agent and told to the flows as the run', async () => {
    const fake = cardWorld('todo')
    expect(await moveCardForRun(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'begin', run: RUN })).toBe('doing')
    expect(fake.rows('actions')[0].status_id).toBe('doing')
    expect(agentWriter).toHaveBeenCalledWith('user-1')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ from_status_id: 'todo', to_status_id: 'doing', actor_user_id: 'user-1', origin: { actor: 'agent', depth: 1, run_id: 'sess-1' } }),
      }),
    )
  })

  it('the flow loop guard hears one hop past the start: a person’s Start is 1, a start at depth n is n + 1', async () => {
    const fake = cardWorld('todo')
    await moveCardForRun(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'begin', run: { ...RUN, startDepth: 2 } })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ origin: { actor: 'agent', depth: 3, run_id: 'sess-1' } }) }))
  })

  it('review: the pull request takes it to the team’s review state', async () => {
    const fake = cardWorld('doing', WITH_REVIEW)
    expect(await moveCardForRun(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'review', run: RUN })).toBe('review')
    expect(fake.rows('actions')[0].status_id).toBe('review')
  })

  it('done: the first done state, with the completion notices; never a closed card', async () => {
    const fake = cardWorld('review', WITH_REVIEW)
    expect(await moveCardForRun(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'done', run: RUN })).toBe('done')
    expect(track).toHaveBeenCalledWith('action_completed', { userId: 'user-1', workspaceId: 'ws-1' }, { action_id: 'act-1' })
    const canceled = cardWorld('canceled')
    expect(await moveCardForRun(canceled as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'done', run: RUN })).toBeNull()
    expect(canceled.rows('actions')[0].status_id).toBe('canceled')
  })

  it('is skipped once the person moved the card by hand since the run began (their moves only, and only since)', async () => {
    const fake = cardWorld('todo')
    fake.seed('entity_activity', [
      // Before the Start, and the run's own (an agent's): neither counts.
      { id: 'e1', entity_type: 'action', entity_id: 'act-1', action: 'status_changed', actor_kind: 'member', created_at: '2026-11-14T09:00:00.000Z' },
      { id: 'e2', entity_type: 'action', entity_id: 'act-1', action: 'status_changed', actor_kind: 'agent', created_at: '2026-11-14T10:05:00.000Z' },
    ])
    expect(await moveCardForRun(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'begin', run: RUN })).toBe('doing')

    send.mockClear()
    const moved = cardWorld('todo')
    moved.seed('entity_activity', [
      { id: 'e3', entity_type: 'action', entity_id: 'act-1', action: 'status_changed', actor_kind: 'member', created_at: '2026-11-14T10:01:00.000Z' },
    ])
    expect(await moveCardForRun(moved as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'begin', run: RUN })).toBeNull()
    expect(moved.rows('actions')[0].status_id).toBe('todo')
    expect(send).not.toHaveBeenCalled()
  })

  it('writes only while the card is where it was read: a hand move in between wins', async () => {
    const read = world('todo')
    // The person moved it to Done between the read and the write.
    const meanwhile = world('done')
    agentWriter.mockImplementation(() => meanwhile)
    expect(await moveCardForRun(read as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'begin', run: RUN })).toBeNull()
    expect(meanwhile.rows('actions')[0].status_id).toBe('done')
    expect(send).not.toHaveBeenCalled()
  })

  it('an ordinary status write: the person moves it back as they move any card', async () => {
    const fake = cardWorld('todo')
    await moveCardForRun(fake as never, { actionId: 'act-1', workspaceId: 'ws-1', move: 'begin', run: RUN })
    const write = fake.calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(write?.filters).toEqual(expect.arrayContaining([['id', 'act-1'], ['workspace_id', 'ws-1'], ['status_id', 'todo']]))
    expect(Object.keys(fake.rows('actions')[0]).sort()).toEqual(['agent_run_status', 'id', 'status_id', 'team_id', 'workspace_id'])
  })
})

describe('completeActionsForMergedPr: one path for cloud runs and Mac card jobs', () => {
  const PR = 'https://github.com/acme/core/pull/9'

  function macWorld(status = 'review', links: Array<{ pr_number: number; pr_state: string }> = [{ pr_number: 9, pr_state: 'merged' }]) {
    const fake = world(status, WITH_REVIEW, true)
    agentWriter.mockImplementation(() => fake)
    fake.seed('local_agent_session', [
      {
        id: 'sess-1',
        user_id: 'user-1',
        workspace_id: 'ws-1',
        idempotency_key: 'local-agent-action:0b7a4f7e-1d2c-4e5f-8a9b-0c1d2e3f4a5b:start:abc',
        created_at: '2026-11-14T10:00:00.000Z',
        pr_url: PR,
      },
    ])
    fake.rows('actions')[0].id = '0b7a4f7e-1d2c-4e5f-8a9b-0c1d2e3f4a5b'
    fake.seed('action_github_pr', links.map((l) => ({ workspace_id: 'ws-1', action_id: '0b7a4f7e-1d2c-4e5f-8a9b-0c1d2e3f4a5b', repo_full_name: 'acme/core', pr_url: `https://github.com/acme/core/pull/${l.pr_number}`, last_synced_at: '2026-11-14T09:00:00.000Z', ...l })))
    return fake
  }

  it('a Mac job’s merged pull request: the card is Done, as the person’s agent', async () => {
    const fake = macWorld()
    expect(await completeActionsForMergedPr(fake as never, PR)).toBe(1)
    expect(fake.rows('actions')[0].status_id).toBe('done')
    expect(agentWriter).toHaveBeenCalledWith('user-1')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ to_status_id: 'done', origin: { actor: 'agent', depth: 1, run_id: 'sess-1' } }) }))
  })

  it('waits while another pull request linked to the card is truly open (read again: a teammate’s that names the card holds it too)', async () => {
    prRead.mockResolvedValue({ ok: true, meta: { title: 'Teammate work', state: 'open', draft: false, headBranch: 'x' } })
    const fake = macWorld('review', [
      { pr_number: 9, pr_state: 'merged' },
      { pr_number: 10, pr_state: 'open' },
    ])
    expect(await completeActionsForMergedPr(fake as never, PR)).toBe(0)
    expect(fake.rows('actions')[0].status_id).toBe('review')
  })

  it('a linked pull request closed without merging was abandoned: it doesn’t hold the card', async () => {
    const fake = macWorld('review', [
      { pr_number: 9, pr_state: 'merged' },
      { pr_number: 8, pr_state: 'closed' },
    ])
    expect(await completeActionsForMergedPr(fake as never, PR)).toBe(1)
  })

  it('a card the person moved by hand since the job began stays where they put it', async () => {
    const fake = macWorld('doing')
    fake.seed('entity_activity', [
      { id: 'e1', entity_type: 'action', entity_id: '0b7a4f7e-1d2c-4e5f-8a9b-0c1d2e3f4a5b', action: 'status_changed', actor_kind: 'member', created_at: '2026-11-14T11:00:00.000Z' },
    ])
    expect(await completeActionsForMergedPr(fake as never, PR)).toBe(0)
    expect(fake.rows('actions')[0].status_id).toBe('doing')
  })

  it('a never-synced link made by hand (a repository that sends us no events) doesn’t hold the card', async () => {
    const fake = macWorld('review', [{ pr_number: 9, pr_state: 'merged' }])
    fake.seed('action_github_pr', [
      { workspace_id: 'ws-1', action_id: '0b7a4f7e-1d2c-4e5f-8a9b-0c1d2e3f4a5b', repo_full_name: 'elsewhere/tools', pr_number: 3, pr_url: 'https://github.com/elsewhere/tools/pull/3', pr_state: 'open', last_synced_at: null },
    ])
    expect(await completeActionsForMergedPr(fake as never, PR)).toBe(1)
    expect(fake.rows('actions')[0].status_id).toBe('done')
  })

  it('a never-synced link one of our own runs or Mac jobs opened still holds it (its webhook may not have spoken yet)', async () => {
    for (const ours of ['agent_run', 'local_agent_session'] as const) {
      const fake = macWorld('review', [{ pr_number: 9, pr_state: 'merged' }])
      fake.seed('action_github_pr', [
        { workspace_id: 'ws-1', action_id: '0b7a4f7e-1d2c-4e5f-8a9b-0c1d2e3f4a5b', repo_full_name: 'acme/core', pr_number: 12, pr_url: 'https://github.com/acme/core/pull/12', pr_state: 'open', last_synced_at: null },
      ])
      fake.seed(ours, [{ id: `${ours}-2`, workspace_id: 'ws-1', pr_url: 'https://github.com/acme/core/pull/12' }])
      expect(await completeActionsForMergedPr(fake as never, PR), ours).toBe(0)
      expect(fake.rows('actions')[0].status_id).toBe('review')
    }
  })

  it('a cloud run whose own pull request merges closes its card past a never-synced manual link, as before', async () => {
    const fake = world('doing', BASIC, true)
    fake.seed('agent_run', [{ id: 'run-c', workspace_id: 'ws-1', kind: 'coding', action_id: 'act-1', triggered_by: 'user-1', pr_url: 'https://github.com/acme/core/pull/7' }])
    fake.seed('action_github_pr', [
      { workspace_id: 'ws-1', action_id: 'act-1', repo_full_name: 'acme/core', pr_number: 7, pr_url: 'https://github.com/acme/core/pull/7', pr_state: 'merged', last_synced_at: '2026-11-14T09:00:00.000Z' },
      { workspace_id: 'ws-1', action_id: 'act-1', repo_full_name: 'elsewhere/tools', pr_number: 3, pr_url: 'https://github.com/elsewhere/tools/pull/3', pr_state: 'open', last_synced_at: null },
    ])
    expect(await completeActionsForMergedPr(fake as never, 'https://github.com/acme/core/pull/7')).toBe(1)
    expect(fake.rows('actions')[0].status_id).toBe('done')
  })

  describe('another link our table still shows open is read again at merge time', () => {
    const CARD = '0b7a4f7e-1d2c-4e5f-8a9b-0c1d2e3f4a5b'
    function withOtherLinks(n: number) {
      const fake = macWorld('review', [{ pr_number: 9, pr_state: 'merged' }])
      fake.seed(
        'action_github_pr',
        Array.from({ length: n }, (_, i) => ({
          id: `link-${i}`,
          workspace_id: 'ws-1',
          action_id: CARD,
          repo_full_name: 'elsewhere/tools',
          pr_number: 100 + i,
          pr_url: `https://github.com/elsewhere/tools/pull/${100 + i}`,
          pr_state: 'open',
          // Synced once at link time, or never: either way the row's memory isn't the answer.
          last_synced_at: i % 2 ? '2026-11-01T09:00:00.000Z' : null,
        })),
      )
      return fake
    }
    const linkRow = (fake: ReturnType<typeof withOtherLinks>, id: string) => fake.rows('action_github_pr').find((r) => r.id === id)!

    it('with the person’s sign-in, 4 s at most', async () => {
      const fake = withOtherLinks(1)
      await completeActionsForMergedPr(fake as never, PR)
      expect(prRead).toHaveBeenCalledWith(fake, 'elsewhere/tools', 100, 'user-1', { requireToken: true, timeoutMs: 4000 })
    })

    it('truly open: holds', async () => {
      prRead.mockResolvedValue({ ok: true, meta: { title: 'x', state: 'open', draft: false, headBranch: 'x' } })
      const fake = withOtherLinks(1)
      expect(await completeActionsForMergedPr(fake as never, PR)).toBe(0)
    })

    it('merged or closed: the row is brought up to date and it doesn’t hold', async () => {
      for (const state of ['merged', 'closed']) {
        prRead.mockResolvedValue({ ok: true, meta: { title: 'x', state, draft: false, headBranch: 'x' } })
        const fake = withOtherLinks(1)
        expect(await completeActionsForMergedPr(fake as never, PR), state).toBe(1)
        expect(linkRow(fake, 'link-0').pr_state).toBe(state)
        expect(linkRow(fake, 'link-0').last_synced_at).toBeTruthy()
      }
    })

    it('never knowable (no connection, no access, not found): doesn’t hold, as before; a passing failure holds', async () => {
      const unknowable = withOtherLinks(1)
      expect(await completeActionsForMergedPr(unknowable as never, PR)).toBe(1)
      prRead.mockResolvedValue({ ok: false, why: 'passing' })
      const passing = withOtherLinks(1)
      expect(await completeActionsForMergedPr(passing as never, PR)).toBe(0)
      expect(linkRow(passing, 'link-0').pr_state).toBe('open')
    })

    it('at most 5 reads, at once; past 5 such links the rest hold', async () => {
      prRead.mockResolvedValue({ ok: true, meta: { title: 'x', state: 'merged', draft: false, headBranch: 'x' } })
      let inFlight = 0
      let most = 0
      prRead.mockImplementation(async () => {
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return { ok: true, meta: { title: 'x', state: 'merged', draft: false, headBranch: 'x' } }
      })
      const five = withOtherLinks(5)
      expect(await completeActionsForMergedPr(five as never, PR)).toBe(1)
      expect(prRead).toHaveBeenCalledTimes(5)
      expect(most).toBe(5)
      prRead.mockClear()
      const six = withOtherLinks(6)
      expect(await completeActionsForMergedPr(six as never, PR)).toBe(0)
      expect(prRead).toHaveBeenCalledTimes(5)
    })

    it('ours are never read: they hold until their own webhook', async () => {
      const fake = withOtherLinks(1)
      fake.seed('agent_run', [{ id: 'run-2', workspace_id: 'ws-1', pr_url: 'https://github.com/elsewhere/tools/pull/100' }])
      expect(await completeActionsForMergedPr(fake as never, PR)).toBe(0)
      expect(prRead).not.toHaveBeenCalled()
    })
  })

  it('a cloud run’s card waits for every linked pull request too', async () => {
    const fake = world('doing', BASIC, true)
    fake.seed('agent_run', [{ id: 'run-c', workspace_id: 'ws-1', kind: 'coding', action_id: 'act-1', triggered_by: 'user-1', pr_url: 'https://github.com/acme/core/pull/7' }])
    fake.seed('action_github_pr', [
      { workspace_id: 'ws-1', action_id: 'act-1', repo_full_name: 'acme/core', pr_number: 7, pr_state: 'merged' },
      { workspace_id: 'ws-1', action_id: 'act-1', repo_full_name: 'acme/core', pr_number: 11, pr_state: 'draft', last_synced_at: '2026-11-14T09:00:00.000Z' },
    ])
    prRead.mockResolvedValue({ ok: true, meta: { title: 'Draft', state: 'open', draft: true, headBranch: 'x' } })
    expect(await completeActionsForMergedPr(fake as never, 'https://github.com/acme/core/pull/7')).toBe(0)
    fake.rows('action_github_pr')[1].pr_state = 'merged'
    expect(await completeActionsForMergedPr(fake as never, 'https://github.com/acme/core/pull/7')).toBe(1)
    expect(fake.rows('actions')[0].status_id).toBe('done')
  })
})
