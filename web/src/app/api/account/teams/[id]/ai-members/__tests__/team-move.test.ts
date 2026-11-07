/**
 * A bot's team, from the one agent editor (bots-v4 B1): a full teammate moves
 * to another team of the workspace through PATCH ai-members (`team_id`; RLS
 * judges both teams); a system teammate and a work bot stay where they are;
 * a bot that speaks for loops never moves onto a private team, where the
 * people its loops run as might not reach it. The double has no RLS: the
 * route's own checks are what's under test. Its selects return only what they
 * name, as PostgREST's do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }))

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...h.db, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.db }))

const { PATCH } = await import('../[aiMemberId]/route')

beforeEach(() => {
  const db = makeFakeSupabase({ project: true })
  db.seed('team', [
    { id: 'team-1', workspace_id: 'ws-1', is_private: false },
    { id: 'team-2', workspace_id: 'ws-1', is_private: false },
    { id: 'team-secret', workspace_id: 'ws-1', is_private: true },
    { id: 'team-far', workspace_id: 'ws-2', is_private: false },
  ])
  db.seed('recipe', [
    // The caller wrote the agent, so its work bot is theirs to change (botRule).
    { id: 'coach', category: 'agent', workspace_id: 'ws-1', is_system: false, created_by: 'user-1' },
    { id: 'anchor', category: 'agent', workspace_id: null, is_system: false },
  ])
  db.seed('ai_team_member', [
    { id: 'riley', workspace_id: 'ws-1', team_id: 'team-1', agent_recipe_id: 'coach', is_system: false, fronts_only: false, role: null },
    { id: 'triage', workspace_id: 'ws-1', team_id: 'team-1', agent_recipe_id: 'anchor', is_system: true, fronts_only: false, role: null },
    { id: 'coach-bot', workspace_id: 'ws-1', team_id: 'team-1', agent_recipe_id: 'coach', is_system: false, fronts_only: true, role: null },
  ])
  db.seed('member', [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'user-1', role: 'member' }])
  h.db = db
})

const move = (id: string, teamId: unknown) =>
  PATCH(buildRequest({ method: 'PATCH', body: { team_id: teamId } }) as unknown as NextRequest, {
    params: Promise.resolve({ id: 'team-1', aiMemberId: id }),
  })
const teamOf = (id: string) => h.db.rows('ai_team_member').find((r) => r.id === id)?.team_id

describe('PATCH ai-members: a bot’s team', () => {
  it('moves a full teammate to another team of the workspace', async () => {
    const res = await move('riley', 'team-2')
    expect(res.status).toBe(200)
    expect(teamOf('riley')).toBe('team-2')
  })

  it('a system teammate stays on the team it was set up on', async () => {
    const res = await move('triage', 'team-2')
    expect(res.status).toBe(409)
    expect(await readJson(res)).toMatchObject({ code: 'TEAM_FIXED', error: 'A built-in teammate stays on the team it was set up on.' })
    expect(teamOf('triage')).toBe('team-1')
  })

  it('a work bot stays on the team it was made on', async () => {
    const res = await move('coach-bot', 'team-2')
    expect(res.status).toBe(409)
    expect(await readJson(res)).toMatchObject({ code: 'TEAM_FIXED', error: 'A work agent stays on the team it was made on.' })
    expect(teamOf('coach-bot')).toBe('team-1')
  })

  it('a bot that speaks for loops never moves onto a private team; onto an open one it may', async () => {
    h.db.seed('flow', [{ id: 'f1', workspace_id: 'ws-1', ai_team_member_id: 'riley' }])
    const res = await move('riley', 'team-secret')
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('BOT_FRONTS_LOOPS')
    expect(teamOf('riley')).toBe('team-1')
    expect((await move('riley', 'team-2')).status).toBe(200)
  })

  it('one that speaks for none may move onto a private team', async () => {
    expect((await move('riley', 'team-secret')).status).toBe(200)
    expect(teamOf('riley')).toBe('team-secret')
  })

  it('refuses another workspace’s team, and a team id that isn’t one', async () => {
    expect((await move('riley', 'team-far')).status).toBe(400)
    expect((await move('riley', 42)).status).toBe(400)
    expect(teamOf('riley')).toBe('team-1')
  })
})
