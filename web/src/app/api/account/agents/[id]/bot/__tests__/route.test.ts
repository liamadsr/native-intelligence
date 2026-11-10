/**
 * POST /api/account/agents/[id]/bot (bots-v4 B1, "Give it a bot"): an agent
 * made before every shared agent got its bot can be given one, under the
 * agent's rule, made as a new agent's is (a work bot for a plain member, a
 * full teammate for an owner). A personal agent gets none; an agent that
 * already has one is a 409.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase, userId: 'user-plain', role: 'member' }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    supabase: h.db,
    user: { id: h.userId },
    workspaceId: 'ws-1',
    member: { id: `m-${h.userId}`, role: h.role },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.db }))

const { POST } = await import('../route')

beforeEach(() => {
  h.userId = 'user-plain'
  h.role = 'member'
  const db = makeFakeSupabase({ project: true })
  db.seed('recipe', [
    { id: 'anchor', slug: 'loop-work-bot', category: 'agent', workspace_id: null, is_system: false },
    { id: 'old', name: 'Sales Coach', category: 'agent', workspace_id: 'ws-1', is_system: false, created_by: 'user-plain', visibility: 'workspace' },
    { id: 'mine', name: 'Private', category: 'agent', workspace_id: 'ws-1', is_system: false, created_by: 'user-plain', visibility: 'personal' },
    { id: 'theirs', name: 'Theirs', category: 'agent', workspace_id: 'ws-1', is_system: false, created_by: 'user-other', visibility: 'workspace' },
  ])
  db.seed('member', [
    { id: 'm-user-plain', workspace_id: 'ws-1', user_id: 'user-plain', role: 'member' },
    { id: 'm-user-owner', workspace_id: 'ws-1', user_id: 'user-owner', role: 'owner' },
  ])
  db.seed('team', [{ id: 'team-1', workspace_id: 'ws-1', is_private: false, created_at: '2026-01-01T00:00:00Z' }])
  db.seed('team_member', [
    { team_id: 'team-1', member_id: 'm-user-plain', team_role: 'member' },
    { team_id: 'team-1', member_id: 'm-user-owner', team_role: 'member' },
  ])
  h.db = db
})

const give = (id: string, body: unknown = {}) =>
  POST(buildRequest({ url: `https://nativeintelligence.dev/api/account/agents/${id}/bot`, method: 'POST', body }) as unknown as NextRequest, {
    params: Promise.resolve({ id }),
  })

describe('POST /api/account/agents/[id]/bot', () => {
  it('gives its author’s agent a work bot on the first free face, built on the agent', async () => {
    const res = await give('old')
    expect(res.status).toBe(201)
    expect((await readJson<{ bot_kind: string }>(res)).bot_kind).toBe('work_bot')
    const [mate] = h.db.rows('ai_team_member')
    expect(mate).toMatchObject({ agent_recipe_id: 'old', fronts_only: true, name: 'Sales Coach', allowed_side_effects: ['read'] })
    expect(typeof mate.bot_character).toBe('string')
  })

  it('an owner’s is a full teammate, wearing the face picked', async () => {
    h.userId = 'user-owner'
    h.role = 'owner'
    const res = await give('theirs', { bot_character: 'ember' })
    expect(res.status).toBe(201)
    expect(h.db.rows('ai_team_member')[0]).toMatchObject({ agent_recipe_id: 'theirs', bot_character: 'ember' })
    expect(h.db.rows('ai_team_member')[0].fronts_only).not.toBe(true)
  })

  it('refuses a personal agent, someone else’s agent, and a second bot', async () => {
    expect((await give('mine')).status).toBe(400)
    expect((await give('theirs')).status).toBe(403)
    expect((await give('old')).status).toBe(201)
    const again = await give('old')
    expect(again.status).toBe(409)
    expect((await readJson<{ code: string }>(again)).code).toBe('AGENT_HAS_BOT')
    expect(h.db.rows('ai_team_member')).toHaveLength(1)
  })

  it('refuses a face that isn’t a bot', async () => {
    expect((await give('old', { bot_character: 'nope' })).status).toBe(400)
  })
})

describe('POST /api/account/agents/[id]/bot: its voice (bots-v4 B2)', () => {
  it('makes the bot in the voice picked, a work bot or a full teammate', async () => {
    expect((await give('old', { voice: 'lori' })).status).toBe(201)
    expect(h.db.rows('ai_team_member')[0]).toMatchObject({ agent_recipe_id: 'old', fronts_only: true, voice: 'lori' })
    h.userId = 'user-owner'
    h.role = 'owner'
    expect((await give('theirs', { bot_character: 'ember', voice: 'tana' })).status).toBe(201)
    expect(h.db.rows('ai_team_member').find((r) => r.agent_recipe_id === 'theirs')).toMatchObject({ bot_character: 'ember', voice: 'tana' })
  })

  it('with none picked, on Automatic', async () => {
    expect((await give('old', { bot_character: 'ember' })).status).toBe(201)
    expect(h.db.rows('ai_team_member')[0].voice ?? null).toBeNull()
  })

  it.each([['Lori'], [''], [7], [['lori']]])('refuses %j with a 400 naming the field, and makes nothing', async (bad) => {
    const res = await give('old', { voice: bad })
    expect(res.status).toBe(400)
    expect(await readJson<{ details: unknown }>(res)).toMatchObject({ details: { field: 'voice' } })
    expect(h.db.rows('ai_team_member')).toHaveLength(0)
  })
})
