/**
 * POST /api/account/actions/[id]/start-agent — the delegate's Start
 * (decision 9) and its one-live-run rule (Sequence row 5).
 *
 * Start runs the right worker: the coding agent only for a `developer` agent
 * on a project with a repo; a work run on the EXISTING action for every other
 * agent (launchWorkItem with existingActionId). A second Start while a run of
 * ANY kind is live on the action returns THAT run and starts nothing: no
 * second agent_run, no second Activity row, no second dispatch. The lookup is
 * pinned to the workspace, the action and exactly the live statuses — a
 * finished run (`pr_open` included) never blocks a new one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AGENT_RUN_LIVE_STATUSES } from '@/lib/agent-run/types'

interface Query {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: unknown
  filters: Array<{ method: string; args: unknown[] }>
}
type Result = { data: unknown; error: unknown }

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ['evt-1'] })),
  ensureWork: vi.fn(async () => ({})),
  launch: vi.fn(async (..._args: unknown[]) => ({ ok: true, reused: false, agentRunId: 'work-run-1', actionId: 'action-1', identifier: 'ENG-42' }) as Record<string, unknown>),
  service: { tag: 'service-client' },
  envFor: vi.fn(async (..._args: unknown[]) => 'env-1' as string | null),
  queries: [] as Query[],
  respond: (_q: Query): Result => ({ data: null, error: null }),
  // Whether the caller is on their own ChatGPT plan (the free tier).
  chatgptPlanFor: vi.fn(async (_userId: unknown) => false),
}))

function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from(table: string) {
      const q: Query = { table, op: 'select', filters: [] }
      hoisted.queries.push(q)
      const b: Record<string, unknown> = {}
      const rec =
        (method: string) =>
        (...args: unknown[]) => {
          q.filters.push({ method, args })
          return b
        }
      const settle = async () => hoisted.respond(q)
      Object.assign(b, {
        select: rec('select'),
        insert: (p: unknown) => ((q.op = 'insert'), (q.payload = p), b),
        update: (p: unknown) => ((q.op = 'update'), (q.payload = p), b),
        eq: rec('eq'),
        in: rec('in'),
        order: rec('order'),
        limit: rec('limit'),
        single: settle,
        maybeSingle: settle,
        then: (ok: (v: Result) => unknown, err?: (e: unknown) => unknown) => settle().then(ok, err),
      })
      return b
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client() }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ ensureWorkForAgentRun: hoisted.ensureWork }))
vi.mock('@/lib/environments/resolve', () => ({ runEnvironmentIdFor: hoisted.envFor }))
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: hoisted.chatgptPlanFor }))
vi.mock('@/lib/work/start-work-item', () => ({
  launchWorkItem: hoisted.launch,
  snapshotResources: async (_s: unknown, raw: unknown) => raw,
}))

import { POST } from '../route'

const ACTION = {
  id: 'action-1',
  identifier: 'ENG-42',
  title: 'Fix the flaky export',
  description: null,
  status_id: 's1',
  team_id: 'team-1',
  project_id: 'p1',
  assignee_ai_member_id: 'ai-1',
  agent_run_status: null,
  project: { github_repo: 'acme/core' },
}

function world(
  opts: {
    live?: { id: string; kind?: string } | null
    liveError?: { message: string }
    role?: string | null
    repo?: string | null
    /** The agent's team is private, and the caller isn't on it. */
    privateTeam?: boolean
  } = {},
) {
  const action = { ...ACTION, project: { github_repo: opts.repo === undefined ? 'acme/core' : opts.repo } }
  hoisted.respond = (q) => {
    if (q.table === 'actions' && q.op === 'select') return { data: action, error: null }
    if (q.table === 'ai_team_member') {
      return {
        data: {
          id: 'ai-1',
          name: 'Dev',
          role: opts.role === undefined ? 'developer' : opts.role,
          team_id: 'team-1',
          is_system: false,
          fronts_only: false,
        },
        error: null,
      }
    }
    if (q.table === 'team') return { data: { is_private: opts.privateTeam === true }, error: null }
    if (q.table === 'team_member') return { data: null, error: null }
    if (q.table === 'member') return { data: { id: 'member-1' }, error: null }
    if (q.table === 'agent_run' && q.op === 'select') {
      return { data: opts.live ?? null, error: opts.liveError ?? null }
    }
    if (q.table === 'agent_run' && q.op === 'insert') return { data: { id: 'run-new' }, error: null }
    return { data: null, error: null }
  }
}

const start = () =>
  POST(
    new Request('http://localhost/api/account/actions/action-1/start-agent', { method: 'POST' }),
    { params: Promise.resolve({ id: 'action-1' }) },
  )

const ops = (table: string, op: Query['op']) => hoisted.queries.filter((q) => q.table === table && q.op === op)

beforeEach(() => {
  hoisted.queries.length = 0
  hoisted.send.mockClear()
  hoisted.ensureWork.mockClear()
  hoisted.launch.mockClear()
  hoisted.envFor.mockClear()
})

describe('POST start-agent — one live run per action', () => {
  it('starts a run when none is live, after looking for one on this action', async () => {
    world()
    const res = await start()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'server', worker: 'coding_run', agentRunId: 'run-new' })

    const [lookup] = ops('agent_run', 'select')
    expect(lookup.filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['workspace_id', 'ws-1'] },
        { method: 'eq', args: ['action_id', 'action-1'] },
        { method: 'in', args: ['status', [...AGENT_RUN_LIVE_STATUSES]] },
      ]),
    )
    // Any kind: a live work run blocks a coding run and the other way round.
    expect(lookup.filters.some((f) => f.method === 'eq' && f.args[0] === 'kind')).toBe(false)
    // Exactly the live set: a finished run — pr_open included — never blocks.
    expect(AGENT_RUN_LIVE_STATUSES).not.toContain('pr_open')

    expect(ops('agent_run', 'insert')).toHaveLength(1)
    // The run records the environment it starts in (migration 420): the project's, else the workspace default.
    expect(hoisted.envFor).toHaveBeenCalledWith(hoisted.service, { projectId: 'p1', workspaceId: 'ws-1', userId: 'user-1' })
    expect(ops('agent_run', 'insert')[0].payload).toMatchObject({ action_id: 'action-1', environment_id: 'env-1' })
    expect(hoisted.ensureWork).toHaveBeenCalledTimes(1)
    expect(ops('actions', 'update')[0].payload).toEqual({ agent_run_status: 'working' })
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'agent/run.requested',
      data: { agent_run_id: 'run-new', workspace_id: 'ws-1' },
    })
  })

  it('returns the live run and starts nothing when one is already going', async () => {
    world({ live: { id: 'run-live' } })
    const res = await start()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'server', agentRunId: 'run-live', worker: 'coding_run', reused: true })
    expect(ops('agent_run', 'insert')).toHaveLength(0)
    expect(hoisted.ensureWork).not.toHaveBeenCalled()
    expect(ops('actions', 'update')).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('refuses to start blind when the lookup fails', async () => {
    world({ liveError: { message: 'db down' } })
    const res = await start()
    expect(res.status).toBe(500)
    expect(ops('agent_run', 'insert')).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})

describe('POST start-agent — the right worker for the delegate (decision 9)', () => {
  it('a non-developer agent gets a work run on the EXISTING action, not the coding agent', async () => {
    world({ role: 'writer' })
    const res = await start()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'server', kind: 'work', worker: 'work_run', reason: 'not_a_developer', agentRunId: 'work-run-1' })
    expect(ops('agent_run', 'insert')).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
    expect(hoisted.launch).toHaveBeenCalledTimes(1)
    const input = hoisted.launch.mock.calls[0][2] as Record<string, unknown>
    expect(input).toMatchObject({
      workspaceId: 'ws-1',
      userId: 'user-1',
      memberId: 'member-1',
      existingActionId: 'action-1',
      aiTeamMemberId: 'ai-1',
      title: 'Fix the flaky export',
      plan: { teamId: 'team-1', statusId: 's1' },
    })
    expect(String(input.task)).toContain('ENG-42')
    expect(String(input.task)).toContain('the person marks it Done')
  })

  it('a developer on a project with no repo gets a work run too, and the response says why', async () => {
    world({ repo: null })
    const res = await start()
    expect(await res.json()).toMatchObject({ kind: 'work', worker: 'work_run', reason: 'no_repo' })
    expect(hoisted.launch).toHaveBeenCalledTimes(1)
    expect(ops('agent_run', 'insert')).toHaveLength(0)
  })

  it('an agent with no role (every agent made before roles) on a repo project keeps coding', async () => {
    world({ role: null })
    const res = await start()
    expect(await res.json()).toEqual({ mode: 'server', worker: 'coding_run', agentRunId: 'run-new' })
    expect(hoisted.launch).not.toHaveBeenCalled()
    expect(ops('agent_run', 'insert')).toHaveLength(1)
  })

  it('a private team’s agent the caller is not on can’t be started', async () => {
    world({ privateTeam: true })
    const res = await start()
    expect(res.status).toBe(403)
    expect(ops('agent_run', 'insert')).toHaveLength(0)
    expect(hoisted.launch).not.toHaveBeenCalled()
  })

  it('a live work run blocks a second Start and is returned', async () => {
    world({ role: 'writer', live: { id: 'run-live', kind: 'workspace' } })
    const res = await start()
    expect(await res.json()).toEqual({ mode: 'server', agentRunId: 'run-live', kind: 'work', worker: 'work_run', reused: true })
    expect(hoisted.launch).not.toHaveBeenCalled()
  })

  it('a live work run also blocks a coding Start', async () => {
    world({ live: { id: 'run-live', kind: 'workspace' } })
    const res = await start()
    expect((await res.json()).reused).toBe(true)
    expect(ops('agent_run', 'insert')).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('a failed work start reports the stage', async () => {
    world({ role: 'writer' })
    hoisted.launch.mockResolvedValueOnce({ ok: false, stage: 'dispatch', error: 'inngest down' })
    const res = await start()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('inngest down')
  })
})

describe('POST start-agent — a person on their own ChatGPT plan (the free tier)', () => {
  it('a coding Start is refused, with why, before any run is made: a coding run is NI-paid', async () => {
    world()
    hoisted.chatgptPlanFor.mockResolvedValueOnce(true)
    const res = await start()
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'CHATGPT_PLAN_NO_CODING', error: expect.stringContaining('ChatGPT plan') })
    expect(hoisted.chatgptPlanFor).toHaveBeenCalledWith('user-1')
    expect(ops('agent_run', 'insert')).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('a non-coding Start still gets its work run (which runs on the plan)', async () => {
    world({ role: 'writer' })
    hoisted.chatgptPlanFor.mockResolvedValue(true)
    try {
      const res = await start()
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ kind: 'work', worker: 'work_run' })
      expect(hoisted.launch).toHaveBeenCalledTimes(1)
    } finally {
      hoisted.chatgptPlanFor.mockResolvedValue(false)
    }
  })
})

