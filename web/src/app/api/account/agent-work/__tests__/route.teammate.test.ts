/**
 * GET /api/account/agent-work?teammate=<id> — one teammate's work, for its bot
 * (docs/plans/bots-v4.md Phase 1a).
 *
 * What we lock in:
 *   - the teammate is checked before anything is read: an id that isn't one
 *     is a 400; a teammate hidden by RLS, in a workspace the caller isn't in,
 *     or on a private team they aren't on is a 404 (the same answer for each,
 *     and for no such teammate), and no work is read;
 *   - the answer is only that teammate's rows, read as the caller's member in
 *     its workspace, with each handoff tree it worked in whole, their chips,
 *     its roster entry with its role's breaker, whether the caller may Resume
 *     (an owner or admin of its workspace), and its last finished row;
 *   - `&last=1` (the bubble's "Last finished") is the last finished row
 *     alone: no rows, roster, breaker, chips or admin read;
 *   - a failed work read is a 500, never an empty answer;
 *   - what its page's About says and Customize opens (bots-v4.md Phase 1b):
 *     its shared skills in order, the custom agent it's built on (never a
 *     role persona, an anchor or another workspace's agent), the loops it
 *     fronts; a failed part is empty, never a failed answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  session: null as unknown,
  service: null as unknown,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => ({
    supabase: hoisted.session,
    user: { id: 'user-1' },
    workspaceId: 'w1',
    member: { id: 'm1' },
  })),
}))

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

const { GET } = await import('@/app/api/account/agent-work/route')

const MIN = 60_000
const DAY = 86_400_000
const RESEARCHER = '00000000-0000-4000-8000-0000000000a1'
const WRITER = '00000000-0000-4000-8000-0000000000a2'
const TRIAGE = '00000000-0000-4000-8000-0000000000a3'

function req(query: string) {
  return new Request(`http://localhost/api/account/agent-work${query}`)
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function job(over: Record<string, unknown>) {
  return {
    id: String(over.id),
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: String(over.id),
    status: 'done',
    origin: 'user',
    progress: {},
    created_at: ago(60 * MIN),
    ...over,
  }
}

function mate(over: Record<string, unknown>) {
  return {
    workspace_id: 'w1',
    team_id: 'team-public',
    name: String(over.id),
    avatar_url: null,
    role: null,
    autonomy: 'propose',
    is_system: false,
    system_key: null,
    bot_character: null,
    created_at: ago(10 * DAY),
    ...over,
  }
}

let session: FakeSupabase
let service: FakeSupabase

beforeEach(() => {
  session = makeFakeSupabase()
  service = makeFakeSupabase()
  hoisted.session = session
  hoisted.service = service
  // The caller, an owner of w1 and a plain member of w2.
  session.seed('member', [
    { id: 'm1', workspace_id: 'w1', user_id: 'user-1', role: 'owner' },
    { id: 'm2', workspace_id: 'w2', user_id: 'user-1', role: 'member' },
  ])
  session.seed('team', [
    { id: 'team-public', workspace_id: 'w1', is_private: false },
    { id: 'team-private', workspace_id: 'w1', is_private: true },
  ])
  session.seed('ai_team_member', [
    mate({ id: RESEARCHER, role: 'researcher', autonomy: 'attempt', bot_character: 'research' }),
    mate({ id: WRITER, role: 'writer' }),
    mate({ id: TRIAGE, team_id: null, is_system: true, system_key: 'triage' }),
  ])
})

const workReads = () => session.calls.filter((c) => c.table === 'tracked_job')

describe('GET /api/account/agent-work?teammate=: who may read it', () => {
  it('is a 400 for an id that isn’t a teammate id, with nothing read', async () => {
    const res = await GET(req('?teammate=writer'))
    expect(res.status).toBe(400)
    expect(session.calls).toEqual([])
  })

  it('is a 404 for a teammate hidden by RLS, and reads no work', async () => {
    // RLS on ai_team_member hides it: the caller's client returns no row.
    const res = await GET(req('?teammate=00000000-0000-4000-8000-0000000000ff'))
    expect(res.status).toBe(404)
    expect(workReads()).toEqual([])
  })

  it('is a 404 for a teammate in a workspace the caller isn’t a member of, and reads no work', async () => {
    session.seed('ai_team_member', [mate({ id: '00000000-0000-4000-8000-0000000000b1', workspace_id: 'w3' })])
    const res = await GET(req('?teammate=00000000-0000-4000-8000-0000000000b1'))
    expect(res.status).toBe(404)
    expect(workReads()).toEqual([])
  })

  it('is a 404 for a teammate on a private team the caller isn’t on (even an owner, whom RLS shows it), and reads no work', async () => {
    session.seed('ai_team_member', [mate({ id: '00000000-0000-4000-8000-0000000000c1', team_id: 'team-private' })])
    const res = await GET(req('?teammate=00000000-0000-4000-8000-0000000000c1'))
    expect(res.status).toBe(404)
    expect(workReads()).toEqual([])

    // A seat on the team opens it.
    session.seed('team_member', [{ team_id: 'team-private', member_id: 'm1' }])
    expect((await GET(req('?teammate=00000000-0000-4000-8000-0000000000c1'))).status).toBe(200)
  })

  it('is a 500 when the check itself fails, not a false "not found"', async () => {
    hoisted.session = {
      from: () => {
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in']) q[m] = () => q
        q.maybeSingle = async () => ({ data: null, error: { message: 'db down' } })
        return q
      },
    }
    expect((await GET(req(`?teammate=${WRITER}`))).status).toBe(500)
  })
})

describe('GET /api/account/agent-work?teammate=: the answer', () => {
  it('is only that teammate’s rows as the caller’s member in its workspace, its handoff trees whole, chips, its roster entry with its breaker, Resume, and its last finished row', async () => {
    session.seed('tracked_job', [
      job({ id: 'r-live', status: 'running', ai_team_member_id: RESEARCHER, created_at: ago(10 * MIN) }),
      job({ id: 'r-review', status: 'needs_review', ai_team_member_id: RESEARCHER, created_at: ago(40 * DAY) }),
      job({ id: 'r-done', status: 'done', ai_team_member_id: RESEARCHER, created_at: ago(2 * DAY), finished_at: ago(2 * DAY) }),
      job({ id: 'r-ancient', status: 'done', ai_team_member_id: RESEARCHER, created_at: ago(40 * DAY), finished_at: ago(40 * DAY) }),
      // Writer's run handed work to the researcher: the whole tree comes along.
      job({ id: 'w-root', status: 'waiting_on_child', ai_team_member_id: WRITER, created_at: ago(3 * 60 * MIN) }),
      job({ id: 'r-child', status: 'running', ai_team_member_id: RESEARCHER, parent_id: 'w-root', root_id: 'w-root', created_at: ago(2 * 60 * MIN) }),
      // Not the researcher's, and in no tree of its.
      job({ id: 'w-alone', status: 'running', ai_team_member_id: WRITER, created_at: ago(5 * MIN) }),
      job({ id: 'theirs', status: 'running', ai_team_member_id: RESEARCHER, member_id: 'm9', created_at: ago(5 * MIN) }),
    ])
    session.seed('work_touch', [{ work_item_id: 'r-live', entity_type: 'contact', entity_id: 'c1', verb: 'wrote', at: ago(MIN) }])
    session.seed('contact', [{ id: 'c1', workspace_id: 'w1', full_name: 'Dana Lee' }])
    // Its role's breaker: the gate's own count, on the service client.
    service.seed('ai_team_member', [mate({ id: RESEARCHER, role: 'researcher' })])
    service.seed('workspace', [{ id: 'w1', settings: { agent_autonomy: { mode: 'attempt', role_breaker_window: 2 } } }])
    service.seed('tracked_job', [
      job({ id: 'a1', ai_team_member_id: RESEARCHER, origin: 'attempt', progress: { review: 'dismissed' }, created_at: ago(MIN) }),
      job({ id: 'a2', ai_team_member_id: RESEARCHER, origin: 'attempt', progress: { review: 'dismissed' }, created_at: ago(2 * MIN) }),
    ])

    const res = await GET(req(`?teammate=${RESEARCHER}`))
    expect(res.status).toBe(200)
    const body = await readJson<{
      teammate_id: string
      workspace_id: string
      items: Array<{ id: string }>
      chips: Record<string, unknown[]>
      teammate: { id: string; bot_character: string | null; breaker: { paused: boolean; window: number } | null }
      may_resume: boolean
      last_finished: { id: string; title: string; finished_at: string } | null
      window_days: number
    }>(res)
    expect(body.teammate_id).toBe(RESEARCHER)
    expect(body.workspace_id).toBe('w1')
    expect(body.items.map((i) => i.id)).toEqual(['r-live', 'r-child', 'w-root', 'r-done', 'r-review'])
    expect(body.chips).toEqual({ 'r-live': [{ entity_type: 'contact', entity_id: 'c1', wrote: true, label: 'Dana Lee' }] })
    expect(body.teammate).toMatchObject({ id: RESEARCHER, bot_character: 'research', breaker: { paused: true, window: 2 } })
    expect(body.may_resume).toBe(true)
    // A whole row, for the bubble's card: its title and when it finished.
    expect(body.last_finished).toMatchObject({ id: 'r-done', title: 'r-done' })
    expect(body.window_days).toBe(14)

    // Its rows, read as the caller's member in its workspace.
    expect(workReads().length).toBeGreaterThan(0)
    for (const c of workReads()) {
      expect(c.filters).toContainEqual(['member_id', ['m1']])
      expect(c.filters).toContainEqual(['workspace_id', 'w1'])
    }
    // Its one roster entry, read on the caller's client.
    const rosterRead = session.calls.find((c) => c.table === 'ai_team_member' && c.filters.some(([col]) => col === 'workspace_id'))!
    expect(rosterRead.filters).toContainEqual(['id', [RESEARCHER]])
  })

  it('offers Resume only to an owner or admin of the teammate’s workspace', async () => {
    session.rows('member').splice(0, 1, { id: 'm1', workspace_id: 'w1', user_id: 'user-1', role: 'member' })
    const body = await readJson<{ may_resume: boolean }>(await GET(req(`?teammate=${WRITER}`)))
    expect(body.may_resume).toBe(false)
  })

  it('a system teammate needs no team, and has no breaker or rows to show yet', async () => {
    const body = await readJson<{ items: unknown[]; teammate: { id: string; breaker: unknown }; last_finished: unknown }>(
      await GET(req(`?teammate=${TRIAGE}`)),
    )
    expect(body.items).toEqual([])
    expect(body.teammate).toMatchObject({ id: TRIAGE, breaker: null })
    expect(body.last_finished).toBeNull()
  })

  it('&last=1: only its last finished row (the bubble’s), with no rows, roster, breaker, chips or admin read', async () => {
    session.seed('tracked_job', [
      job({ id: 'w-open', status: 'running', ai_team_member_id: WRITER, created_at: ago(5 * MIN) }),
      job({ id: 'w-older', status: 'done', ai_team_member_id: WRITER, created_at: ago(30 * DAY), finished_at: ago(30 * DAY) }),
      job({ id: 'w-newer', status: 'failed', ai_team_member_id: WRITER, created_at: ago(20 * DAY), finished_at: ago(20 * DAY) }),
    ])
    const res = await GET(req(`?teammate=${WRITER}&last=1`))
    expect(res.status).toBe(200)
    const body = await readJson<Record<string, unknown>>(res)
    expect(Object.keys(body).sort()).toEqual(['last_finished', 'teammate_id', 'workspace_id'])
    expect(body.last_finished).toMatchObject({ id: 'w-newer', status: 'failed' })
    expect(service.calls).toEqual([])
    expect(session.calls.some((c) => c.table === 'work_touch' || c.table === 'flow')).toBe(false)
    expect(session.calls.some((c) => c.table === 'member' && c.filters.some(([col]) => col === 'role'))).toBe(false)
  })

  it('wins over ?light=1', async () => {
    const body = await readJson<Record<string, unknown>>(await GET(req(`?light=1&teammate=${WRITER}&last=1`)))
    expect(body).toEqual({ teammate_id: WRITER, workspace_id: 'w1', last_finished: null })
  })

  it('is a 500 when its work can’t be read, never an empty answer', async () => {
    const real = session
    hoisted.session = {
      ...real,
      from: (table: string) => {
        if (table !== 'tracked_job') return real.from(table)
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'in', 'eq', 'gte', 'not', 'order']) q[m] = () => q
        q.limit = () => Promise.resolve({ data: null, error: { message: 'permission denied' } })
        return q
      },
    }
    const res = await GET(req(`?teammate=${WRITER}`))
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('Could not read the work feed')
    expect((await GET(req(`?teammate=${WRITER}&last=1`))).status).toBe(500)
  })
})

describe('GET /api/account/agent-work?teammate=: what its About says (Phase 1b)', () => {
  const COACH = '00000000-0000-4000-8000-0000000000d1'
  const agent = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    name: 'Sales Coach',
    slug: 'sales-coach',
    workspace_id: 'w1',
    category: 'agent',
    visibility: 'workspace',
    ...over,
  })
  type About = {
    skills: Array<{ id: string; name: string }>
    agent: { id: string; name: string } | null
    loops: Array<{ id: string; name: string }>
  }

  it('is its shared skills in order, the custom agent it’s built on, and the loops it fronts, oldest first', async () => {
    session.seed('ai_team_member', [mate({ id: COACH, agent: agent() })])
    session.seed('ai_team_member_skill', [
      { ai_team_member_id: COACH, sort_order: 1, skill: { id: 's2', name: 'Find emails', workspace_id: 'w1', visibility: 'workspace', is_system: false } },
      { ai_team_member_id: COACH, sort_order: 0, skill: { id: 's1', name: 'Research brief', workspace_id: null, visibility: 'public', is_system: true } },
      // A personal skill isn't one it checks (B1), and one the caller can't read embeds as nothing.
      { ai_team_member_id: COACH, sort_order: 2, skill: { id: 's3', name: 'My own', workspace_id: 'w1', visibility: 'personal', is_system: false } },
      { ai_team_member_id: COACH, sort_order: 3, skill: null },
      { ai_team_member_id: COACH, sort_order: 4, skill: { id: 's4', name: 'Elsewhere', workspace_id: 'w2', visibility: 'workspace', is_system: false } },
      { ai_team_member_id: WRITER, sort_order: 0, skill: { id: 's9', name: 'Not its', workspace_id: 'w1', visibility: 'workspace', is_system: false } },
    ])
    session.seed('flow', [
      { id: 'flow-2', workspace_id: 'w1', name: 'Digest', ai_team_member_id: COACH, created_at: ago(2 * DAY) },
      { id: 'flow-1', workspace_id: 'w1', name: 'Weekly brief', ai_team_member_id: COACH, created_at: ago(5 * DAY) },
      { id: 'flow-x', workspace_id: 'w1', name: 'Theirs', ai_team_member_id: WRITER, created_at: ago(DAY) },
    ])
    const body = await readJson<About>(await GET(req(`?teammate=${COACH}`)))
    expect(body.skills).toEqual([
      { id: 's1', name: 'Research brief' },
      { id: 's2', name: 'Find emails' },
    ])
    expect(body.agent).toEqual({ id: 'agent-1', name: 'Sales Coach' })
    expect(body.loops).toEqual([
      { id: 'flow-1', name: 'Weekly brief' },
      { id: 'flow-2', name: 'Digest' },
    ])
    // Read on the caller's own client.
    expect(service.calls.some((c) => c.table === 'ai_team_member_skill' || c.table === 'flow')).toBe(false)
  })

  it('names no agent for a role persona, the work-bot anchor, a personal or another workspace’s agent, or a skill', async () => {
    for (const persona of [
      agent({ slug: 'role-writer', name: 'Writer' }),
      agent({ slug: 'loop-work-bot', workspace_id: 'w1' }),
      agent({ visibility: 'personal' }),
      agent({ workspace_id: 'w2' }),
      agent({ category: 'skill' }),
      null,
    ]) {
      session.rows('ai_team_member').splice(0, session.rows('ai_team_member').length)
      session.seed('ai_team_member', [mate({ id: COACH, agent: persona })])
      const body = await readJson<About>(await GET(req(`?teammate=${COACH}`)))
      expect(body.agent).toBeNull()
    }
  })

  it('a part it couldn’t read is empty; the answer still comes', async () => {
    session.seed('ai_team_member', [mate({ id: COACH, agent: agent() })])
    session.seed('flow', [{ id: 'flow-1', workspace_id: 'w1', name: 'Weekly brief', ai_team_member_id: COACH, created_at: ago(DAY) }])
    const real = session
    hoisted.session = {
      ...real,
      from: (table: string) => {
        if (table !== 'ai_team_member_skill') return real.from(table)
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) q[m] = () => q
        q.order = () => Promise.resolve({ data: null, error: { message: 'permission denied' } })
        return q
      },
    }
    const res = await GET(req(`?teammate=${COACH}`))
    expect(res.status).toBe(200)
    const body = await readJson<About>(res)
    expect(body.skills).toEqual([])
    expect(body.agent).toEqual({ id: 'agent-1', name: 'Sales Coach' })
    expect(body.loops).toEqual([{ id: 'flow-1', name: 'Weekly brief' }])
  })
})
