/**
 * An agent's finish leaves the action in REVIEW, never Done; the person's
 * Reviewed marks it Done (decision 9, Liam 2026-10-14). One helper module
 * (src/lib/actions/agent-finish.ts) for every finish path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  completeActionOnReview,
  completeActionsForMergedPr,
  doneStateFor,
  moveActionToReview,
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
