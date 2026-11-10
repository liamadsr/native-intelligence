/**
 * GET /api/account/agent-editor (bots-v4 B1): what the one agent editor reads,
 * opened on an agent or on a bot. Every bot built on the agent the caller can
 * reach, its work bot included; the ones on private teams counted, never
 * named; a system teammate or a loop's work bot alone, with no agent, saying
 * what it speaks from.
 *
 * Two doubles, both returning only the columns a select names (PostgREST's
 * projection: a read that leaves out `workspace_id` makes every agent look
 * like an anchor). The session one holds what the caller's RLS lets them read:
 * no anchor, and no other member's personal agent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase, type Row } from '@/lib/work/__tests__/fake-supabase'
import type { AgentEditorData } from '@/lib/agents/editor-model'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  session: null as unknown as FakeSupabase,
  userId: 'user-lead',
  role: 'member',
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    supabase: h.session,
    user: { id: h.userId },
    workspaceId: 'ws-1',
    member: { id: `m-${h.userId}`, role: h.role },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.db }))

const { GET } = await import('../route')

const SEED: Record<string, Row[]> = {
  recipe: [
    { id: 'coach', name: 'Sales Coach', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace', created_by: 'user-author', system_prompt: 'Coach the sales team.' },
    { id: 'meeting', name: 'Meeting', category: 'agent', workspace_id: null, is_system: true, visibility: 'workspace', created_by: null },
    { id: 'anchor', name: 'Work bot', slug: 'loop-work-bot', category: 'agent', workspace_id: null, is_system: false, visibility: 'personal', created_by: null },
    { id: 'loop-triage', name: 'Triage', category: 'agent', workspace_id: null, is_system: false, visibility: 'personal', created_by: null },
    // Another member's personal agent, with bots from before a personal agent had none.
    { id: 'private-coach', name: 'My coach', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'personal', created_by: 'user-other', system_prompt: 'Only mine.' },
  ],
  team: [
    { id: 'sales', name: 'Sales', workspace_id: 'ws-1', is_private: false },
    { id: 'ops', name: 'Ops', workspace_id: 'ws-1', is_private: false },
    { id: 'secret', name: 'Secret', workspace_id: 'ws-1', is_private: true },
  ],
  team_member: [{ team_id: 'sales', member_id: 'm-user-lead', team_role: 'lead' }],
  ai_team_member: [
    { id: 'riley', name: 'Riley', workspace_id: 'ws-1', team_id: 'sales', agent_recipe_id: 'coach', is_system: false, fronts_only: false, role: null, bot_character: 'scout', allowed_side_effects: ['read'], created_at: '1' },
    { id: 'coach-bot', name: 'Coach', workspace_id: 'ws-1', team_id: 'ops', agent_recipe_id: 'coach', is_system: false, fronts_only: true, role: null, bot_character: 'ember', allowed_side_effects: ['read'], created_at: '2' },
    { id: 'hidden', name: 'Hidden', workspace_id: 'ws-1', team_id: 'secret', agent_recipe_id: 'coach', is_system: false, fronts_only: false, role: null, bot_character: 'dew', allowed_side_effects: ['read'], created_at: '3' },
    { id: 'ember', name: 'Ember', workspace_id: 'ws-1', team_id: 'ops', agent_recipe_id: 'anchor', is_system: false, fronts_only: true, role: null, bot_character: 'nova', allowed_side_effects: ['read'], created_at: '4' },
    { id: 'triage', name: 'Triage', workspace_id: 'ws-1', team_id: 'sales', agent_recipe_id: 'loop-triage', is_system: true, system_key: 'captures', fronts_only: false, role: null, bot_character: 'triage', allowed_side_effects: ['read'], created_at: '5' },
    { id: 'old-mate', name: 'Old mate', workspace_id: 'ws-1', team_id: 'sales', agent_recipe_id: 'private-coach', is_system: false, fronts_only: false, role: null, bot_character: 'sage', allowed_side_effects: ['read'], created_at: '6' },
    { id: 'old-bot', name: 'Old bot', workspace_id: 'ws-1', team_id: 'sales', agent_recipe_id: 'private-coach', is_system: false, fronts_only: true, role: null, bot_character: 'pip', allowed_side_effects: ['read'], created_at: '7' },
  ],
  ai_team_member_skill: [
    { ai_team_member_id: 'riley', skill_recipe_id: 's2', sort_order: 1 },
    { ai_team_member_id: 'riley', skill_recipe_id: 's1', sort_order: 0 },
  ],
  flow: [{ id: 'f1', workspace_id: 'ws-1', ai_team_member_id: 'ember', name: 'Weekly brief', created_at: '1' }],
}

/** What the caller's own client reads: RLS hides the anchors and another member's personal recipe. */
const readable = (table: string, row: Row) => table !== 'recipe' || row.visibility !== 'personal' || (row.created_by != null && row.created_by === h.userId)

function as(userId: string, role = 'member') {
  h.userId = userId
  h.role = role
  h.db = makeFakeSupabase({ project: true })
  h.session = makeFakeSupabase({ project: true })
  for (const [table, rows] of Object.entries(SEED)) {
    h.db.seed(table, rows.map((r) => ({ ...r })))
    h.session.seed(
      table,
      rows.filter((r) => readable(table, r)).map((r) => ({ ...r })),
    )
  }
}

beforeEach(() => as('user-lead'))

const read = async (query: string) => {
  const res = await GET(buildRequest({ url: `https://nativeintelligence.dev/api/account/agent-editor?${query}`, method: 'GET' }) as unknown as NextRequest)
  return { status: res.status, body: res.status === 200 ? await readJson<AgentEditorData>(res) : null }
}

describe('GET /api/account/agent-editor', () => {
  it('on an agent: its bots the caller can reach, its work bot included, the private one counted and never named', async () => {
    const { status, body } = await read('agent=coach')
    expect(status).toBe(200)
    expect(body!.agent).toMatchObject({ id: 'coach', name: 'Sales Coach', kind: 'workspace', created_by: 'user-author', system_prompt: 'Coach the sales team.' })
    expect(body!.bots.map((b) => [b.id, b.kind, b.team_name])).toEqual([
      ['riley', 'agent_teammate', 'Sales'],
      ['coach-bot', 'agent_work_bot', 'Ops'],
    ])
    // (The workspace's faces carry names through the session client, which RLS fences; this double has no RLS.)
    expect(JSON.stringify(body!.bots)).not.toContain('Hidden')
    expect(body!.hidden_bots).toBe(1)
    expect(body!.focus).toBe('riley')
    expect(body!.bots[0].skill_ids).toEqual(['s1', 's2'])
    // What the editor needs to apply the same rules as the routes.
    expect(body!.caller).toEqual({ user_id: 'user-lead', role: 'member', lead_team_ids: ['sales'] })
    expect(body!.teams.map((t) => t.id)).toEqual(['sales'])
  })

  it('its author opens their own agent, as a workspace agent', async () => {
    as('user-author')
    const { status, body } = await read('agent=coach')
    expect(status).toBe(200)
    expect(body!.agent).toMatchObject({ id: 'coach', kind: 'workspace', created_by: 'user-author' })
  })

  it('on a full teammate: opens on it, with its agent and the other bots on it', async () => {
    const { body } = await read('teammate=riley')
    expect(body!.focus).toBe('riley')
    expect(body!.agent).toMatchObject({ id: 'coach', kind: 'workspace' })
    expect(body!.bots.map((b) => [b.id, b.kind])).toEqual([
      ['riley', 'agent_teammate'],
      ['coach-bot', 'agent_work_bot'],
    ])
  })

  it('each bot carries its own voice (bots-v4 B2), and the workspace’s faces the voices their bots chose', async () => {
    for (const db of [h.db, h.session]) {
      const rows = db.rows('ai_team_member')
      rows.find((r) => r.id === 'riley')!.voice = 'lori'
      rows.find((r) => r.id === 'hidden')!.voice = 'lori'
      rows.find((r) => r.id === 'ember')!.voice = 'tana'
      // A value that isn't a voice id reads as Automatic.
      rows.find((r) => r.id === 'coach-bot')!.voice = 'Not A Voice'
    }
    const { body } = await read('agent=coach')
    expect(body!.bots.map((b) => [b.id, b.voice])).toEqual([
      ['riley', 'lori'],
      ['coach-bot', null],
    ])
    // Every teammate wearing a face, the private team's too (counted for "Also used by", never named).
    expect(body!.workspace_faces.filter((f) => f.voice).map((f) => [f.id, f.voice])).toEqual([
      ['riley', 'lori'],
      ['hidden', 'lori'],
      ['ember', 'tana'],
    ])
    expect(body!.workspace_faces.find((f) => f.id === 'coach-bot')).not.toHaveProperty('voice')
  })

  it('on an agent’s work bot: the agent’s bot, never a loop’s', async () => {
    const { body } = await read('teammate=coach-bot')
    expect(body!.focus).toBe('coach-bot')
    expect(body!.agent?.id).toBe('coach')
    expect(body!.bots.map((b) => [b.id, b.kind])).toEqual([
      ['riley', 'agent_teammate'],
      ['coach-bot', 'agent_work_bot'],
    ])
  })

  it('a bot on another member’s personal agent is still that agent’s bot, its words hidden', async () => {
    let { status, body } = await read('teammate=old-bot')
    expect(status).toBe(200)
    expect(body!.agent).toBeNull()
    expect(body!.bots.map((b) => [b.id, b.kind])).toEqual([['old-bot', 'agent_work_bot']])
    expect(JSON.stringify(body)).not.toContain('Only mine')
    ;({ status, body } = await read('teammate=old-mate'))
    expect(status).toBe(200)
    expect(body!.agent).toBeNull()
    expect(body!.bots.map((b) => [b.id, b.kind])).toEqual([['old-mate', 'agent_teammate']])
    // The agent itself reads as missing.
    expect((await read('agent=private-coach')).status).toBe(404)
  })

  it('its author reads it, with both its bots', async () => {
    as('user-other')
    const { body } = await read('teammate=old-bot')
    expect(body!.agent).toMatchObject({ id: 'private-coach', kind: 'workspace', system_prompt: 'Only mine.' })
    expect(body!.bots.map((b) => [b.id, b.kind])).toEqual([
      ['old-mate', 'agent_teammate'],
      ['old-bot', 'agent_work_bot'],
    ])
  })

  it('a system teammate comes alone, with no agent, saying what its job is', async () => {
    const { body } = await read('teammate=triage')
    expect(body!.agent).toBeNull()
    expect(body!.bots).toHaveLength(1)
    expect(body!.bots[0]).toMatchObject({ id: 'triage', kind: 'system_teammate' })
    expect(body!.bots[0].about).toMatch(/proposals/)
  })

  it('a loop’s work bot comes alone, with no agent, naming its loops', async () => {
    const { body } = await read('teammate=ember')
    expect(body!.agent).toBeNull()
    expect(body!.bots.map((b) => [b.id, b.kind])).toEqual([['ember', 'loop_work_bot']])
    expect(body!.bots[0].about).toBe('Speaks for Weekly brief.')
  })

  it('a built-in agent opens read-only by kind', async () => {
    const { body } = await read('agent=meeting')
    expect(body!.agent).toMatchObject({ id: 'meeting', kind: 'builtin' })
    expect(body!.bots).toEqual([])
  })

  it('refuses an anchor as an agent, a bot the caller can’t reach, and an unclear ask', async () => {
    expect((await read('agent=anchor')).status).toBe(404)
    expect((await read('teammate=hidden')).status).toBe(404)
    expect((await read('teammate=nobody')).status).toBe(404)
    expect((await read('')).status).toBe(400)
    expect((await read('agent=coach&teammate=riley')).status).toBe(400)
  })
})
