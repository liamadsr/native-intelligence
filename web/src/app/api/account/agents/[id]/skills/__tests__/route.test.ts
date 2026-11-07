/**
 * PUT /api/account/agents/[id]/skills (bots-v4 B1, decision 11): the skills
 * an agent always checks are saved to every bot built on it in the
 * workspace, its work bot included, and to no loop work bot, under the
 * agent's rule (its author, or an owner or admin). Up to five, never a
 * personal one. The answer names only the bots the caller can reach. The
 * double stands in for both clients; selects return only what they name, and
 * each bot's list is written by the database's one call (migration 305).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, replaceAiMemberSkillsRpc, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase, userId: 'user-author', role: 'member', failing: new Set<string>() }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    supabase: h.db,
    user: { id: h.userId },
    workspaceId: 'ws-1',
    member: { id: `m-${h.userId}`, role: h.role },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.db }))

const { PUT } = await import('../route')

function seed() {
  const db: FakeSupabase = makeFakeSupabase({
    project: true,
    rpc: { replace_ai_member_skills: replaceAiMemberSkillsRpc(() => db, { fail: (id) => h.failing.has(id) }) },
  })
  db.seed('recipe', [
    { id: 'coach', category: 'agent', workspace_id: 'ws-1', is_system: false, created_by: 'user-author', visibility: 'workspace' },
    { id: 'meeting', category: 'agent', workspace_id: null, is_system: true, created_by: null, visibility: 'workspace' },
    { id: 'anchor', category: 'agent', workspace_id: null, is_system: false, created_by: null, visibility: 'personal', slug: 'loop-work-bot' },
    { id: 'lonely', category: 'agent', workspace_id: 'ws-1', is_system: false, created_by: 'user-author', visibility: 'workspace' },
    ...['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => ({ id, category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' })),
    { id: 's-mine', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'personal' },
  ])
  db.seed('team', [
    { id: 'sales', workspace_id: 'ws-1', is_private: false },
    { id: 'ops', workspace_id: 'ws-1', is_private: false },
    { id: 'gen', workspace_id: 'ws-1', is_private: false },
    { id: 'secret', workspace_id: 'ws-1', is_private: true },
  ])
  db.seed('ai_team_member', [
    // Two bots on the agent: a full teammate on one team, its work bot on another.
    { id: 'riley', name: 'Riley', workspace_id: 'ws-1', team_id: 'sales', agent_recipe_id: 'coach', is_system: false, fronts_only: false, created_at: '1' },
    { id: 'coach-bot', name: 'Coach', workspace_id: 'ws-1', team_id: 'ops', agent_recipe_id: 'coach', is_system: false, fronts_only: true, created_at: '2' },
    // A third, on a private team the caller isn't on: it changes too, counted and never named.
    { id: 'quiet', name: 'Quiet', workspace_id: 'ws-1', team_id: 'secret', agent_recipe_id: 'coach', is_system: false, fronts_only: false, created_at: '2b' },
    // Not the agent's: a loop's work bot, a system teammate, another workspace's bot on the same agent id.
    { id: 'loop-bot', name: 'Ember', workspace_id: 'ws-1', team_id: 'ops', agent_recipe_id: 'anchor', is_system: false, fronts_only: true, created_at: '3' },
    { id: 'triage', name: 'Triage', workspace_id: 'ws-1', team_id: 'gen', agent_recipe_id: 'loop-triage', is_system: true, fronts_only: false, created_at: '4' },
    { id: 'far', name: 'Far', workspace_id: 'ws-2', team_id: 'x', agent_recipe_id: 'coach', is_system: false, fronts_only: false, created_at: '5' },
  ])
  db.seed('ai_team_member_skill', [
    { ai_team_member_id: 'riley', skill_recipe_id: 's1', sort_order: 0 },
    { ai_team_member_id: 'coach-bot', skill_recipe_id: 's1', sort_order: 0 },
    { ai_team_member_id: 'loop-bot', skill_recipe_id: 's5', sort_order: 0 },
    { ai_team_member_id: 'far', skill_recipe_id: 's6', sort_order: 0 },
  ])
  return db
}

const put = (agentId: string, body: unknown) =>
  PUT(buildRequest({ url: `https://dial8.ai/api/account/agents/${agentId}/skills`, method: 'PUT', body }) as unknown as NextRequest, {
    params: Promise.resolve({ id: agentId }),
  })

const skillsOf = (botId: string) =>
  h.db
    .rows('ai_team_member_skill')
    .filter((r) => r.ai_team_member_id === botId)
    .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
    .map((r) => r.skill_recipe_id)

beforeEach(() => {
  h.failing.clear()
  h.db = seed()
  h.userId = 'user-author'
  h.role = 'member'
})

describe('PUT /api/account/agents/[id]/skills', () => {
  it('saves the list to every bot on the agent in the workspace, its work bot included, and to no loop bot', async () => {
    const res = await put('coach', { skill_recipe_ids: ['s2', 's1'] })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body).toEqual({ skill_recipe_ids: ['s2', 's1'], bots: ['riley', 'coach-bot'], hidden_bots: 1 })
    expect(JSON.stringify(body)).not.toContain('quiet')
    expect(skillsOf('riley')).toEqual(['s2', 's1'])
    expect(skillsOf('coach-bot')).toEqual(['s2', 's1'])
    expect(skillsOf('quiet')).toEqual(['s2', 's1'])
    expect(skillsOf('loop-bot')).toEqual(['s5'])
    expect(skillsOf('triage')).toEqual([])
    expect(skillsOf('far')).toEqual(['s6'])
  })

  it('an owner may, as the agent’s author may', async () => {
    h.userId = 'user-owner'
    h.role = 'owner'
    expect((await put('coach', { skill_recipe_ids: ['s3'] })).status).toBe(200)
    expect(skillsOf('riley')).toEqual(['s3'])
  })

  it('someone who can’t edit the agent can’t change its skills, a team lead included', async () => {
    h.userId = 'user-lead'
    h.role = 'member'
    const res = await put('coach', { skill_recipe_ids: ['s3'] })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/author, or a workspace owner or admin/)
    expect(skillsOf('riley')).toEqual(['s1'])
  })

  it('a built-in agent’s are nobody’s: make a copy first', async () => {
    h.userId = 'user-owner'
    h.role = 'owner'
    const res = await put('meeting', { skill_recipe_ids: ['s3'] })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/Make a copy/)
  })

  it('a loop anchor is no agent here', async () => {
    h.userId = 'user-owner'
    h.role = 'owner'
    expect((await put('anchor', { skill_recipe_ids: ['s3'] })).status).toBe(404)
  })

  it('refuses a sixth skill and a personal one, before writing anything', async () => {
    let res = await put('coach', { skill_recipe_ids: ['s1', 's2', 's3', 's4', 's5', 's6'] })
    expect(res.status).toBe(400)
    expect((await readJson<{ code: string }>(res)).code).toBe('TOO_MANY_SKILLS')
    res = await put('coach', { skill_recipe_ids: ['s-mine'] })
    expect(res.status).toBe(400)
    expect((await readJson<{ code: string }>(res)).code).toBe('PERSONAL_SKILL')
    expect(skillsOf('riley')).toEqual(['s1'])
  })

  it('an agent with no bot yet has nowhere to keep them', async () => {
    const res = await put('lonely', { skill_recipe_ids: ['s1'] })
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('AGENT_HAS_NO_BOT')
  })

  type Partial = {
    error: string
    code: string
    details: { changed: Array<{ name: string }>; hidden_changed: number; failed: Array<{ name: string }>; hidden_failed: number }
  }

  it('names the bots whose skills didn’t change when a write fails, and counts the private ones', async () => {
    h.failing.add('riley')
    const res = await put('coach', { skill_recipe_ids: ['s2'] })
    expect(res.status).toBe(500)
    const body = await readJson<Partial>(res)
    expect(body.code).toBe('AGENT_SKILLS_PARTIAL')
    expect(body.error).toBe('Its skills didn’t change for Riley.')
    expect(body.details.changed.map((b) => b.name)).toEqual(['Coach'])
    expect(body.details.hidden_changed).toBe(1)
    expect(body.details.failed.map((b) => b.name)).toEqual(['Riley'])
    expect(body.details.hidden_failed).toBe(0)
    // Riley kept what it had: its list changes whole or not at all.
    expect(skillsOf('riley')).toEqual(['s1'])
  })

  it('a failed bot on a private team the caller isn’t on is counted, never named', async () => {
    h.failing.add('quiet')
    const res = await put('coach', { skill_recipe_ids: ['s2'] })
    expect(res.status).toBe(500)
    const body = await readJson<Partial>(res)
    expect(body.error).toBe('Its skills didn’t change for 1 on a private team.')
    expect(body.details.failed).toEqual([])
    expect(body.details.hidden_failed).toBe(1)
    expect(JSON.stringify(body)).not.toMatch(/quiet/i)
  })

  it('names a private team’s bot to someone on that team', async () => {
    h.db.seed('team_member', [{ team_id: 'secret', member_id: 'm-user-author', team_role: 'member' }])
    const res = await put('coach', { skill_recipe_ids: ['s3'] })
    expect(await readJson(res)).toEqual({ skill_recipe_ids: ['s3'], bots: ['riley', 'coach-bot', 'quiet'], hidden_bots: 0 })
  })
})
