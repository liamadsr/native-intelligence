/**
 * "Give it a bot" (bots-v3 Phase 6): creating a custom agent with a face also
 * makes the agent's teammate, built on the agent, wearing that face:
 *
 *   - a FULL teammate (assignable, not fronts_only) when the creator is an
 *     owner or admin (on their own team) or a team lead (on the team they lead);
 *   - a WORK BOT (fronts_only, propose-only limits) on their team for a plain
 *     member;
 *   - a face that isn't a character or a built bot is a 400, before the agent
 *     is written; a built bot's id is saved as it is.
 *
 * The route's writes run on the database double for both the session and the
 * service client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, replaceAiMemberSkillsRpc, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { builtBotId } from '@/lib/bots/bot-faces'
import { makeAgentTeammate } from '@/lib/library/agent-bot'

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase, userId: 'user-plain', role: 'member', memberId: 'm-plain', failSkills: false }))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspaceMember: async () => ({
    supabase: h.db,
    user: { id: h.userId, email: 'x@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: h.memberId, role: h.role },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

const { POST } = await import('../route')
const { DELETE } = await import('../[id]/route')

function as(who: 'owner' | 'lead' | 'plain') {
  h.userId = `user-${who}`
  h.memberId = `m-${who}`
  h.role = who === 'owner' ? 'owner' : 'member'
}

beforeEach(() => {
  h.failSkills = false
  const db: FakeSupabase = makeFakeSupabase({
    rpc: { replace_ai_member_skills: replaceAiMemberSkillsRpc(() => db, { fail: () => h.failSkills }) },
  })
  db.seed('recipe', [{ id: 'anchor', slug: 'loop-work-bot', category: 'agent', workspace_id: null, is_system: false }])
  db.seed('member', [
    { id: 'm-owner', workspace_id: 'ws-1', user_id: 'user-owner', role: 'owner' },
    { id: 'm-lead', workspace_id: 'ws-1', user_id: 'user-lead', role: 'member' },
    { id: 'm-plain', workspace_id: 'ws-1', user_id: 'user-plain', role: 'member' },
  ])
  db.seed('team', [
    { id: 'team-general', workspace_id: 'ws-1', is_private: false, created_at: '2026-01-01T00:00:00Z' },
    { id: 'team-design', workspace_id: 'ws-1', is_private: false, created_at: '2026-01-02T00:00:00Z' },
    { id: 'team-sales', workspace_id: 'ws-1', is_private: true, created_at: '2026-01-03T00:00:00Z' },
  ])
  db.seed('team_member', [
    { team_id: 'team-sales', member_id: 'm-owner', team_role: 'member' },
    { team_id: 'team-general', member_id: 'm-lead', team_role: 'member' },
    { team_id: 'team-design', member_id: 'm-lead', team_role: 'lead' },
    { team_id: 'team-design', member_id: 'm-plain', team_role: 'member' },
  ])
  h.db = db
})

const create = (body: Record<string, unknown>) =>
  POST(buildRequest({ url: 'https://dial8.ai/api/account/agents', method: 'POST', body }) as unknown as NextRequest)

type Created = { agent: { id: string }; ai_team_member?: { id: string; fronts_only: boolean }; bot_kind?: string; bot_error?: string }

describe('POST /api/account/agents: Give it a bot', () => {
  it('makes an owner’s agent a full teammate on their own team, built on the agent', async () => {
    as('owner')
    const res = await create({ name: 'Sales Coach', system_prompt: 'Coach', bot_character: 'coach' })
    expect(res.status).toBe(200)
    const body = await readJson<Created>(res)
    expect(body.bot_kind).toBe('full')
    const mate = h.db.rows('ai_team_member').find((r) => r.id === body.ai_team_member!.id)!
    expect(mate).toMatchObject({
      name: 'Sales Coach',
      agent_recipe_id: body.agent.id,
      team_id: 'team-sales',
      bot_character: 'coach',
      created_by: 'user-owner',
    })
    expect(mate.fronts_only).not.toBe(true)
  })

  it('makes a team lead’s agent a full teammate on the team they lead', async () => {
    as('lead')
    const body = await readJson<Created>(await create({ name: 'Designer', bot_character: 'ember' }))
    expect(body.bot_kind).toBe('full')
    expect(h.db.rows('ai_team_member').find((r) => r.id === body.ai_team_member!.id)).toMatchObject({ team_id: 'team-design', bot_character: 'ember' })
  })

  it('makes a plain member’s agent a work bot that speaks for it and takes no assignments', async () => {
    as('plain')
    const body = await readJson<Created>(await create({ name: 'Notes helper', bot_character: 'notes' }))
    expect(body.bot_kind).toBe('work_bot')
    expect(body.ai_team_member!.fronts_only).toBe(true)
    expect(h.db.rows('ai_team_member').find((r) => r.id === body.ai_team_member!.id)).toMatchObject({
      name: 'Notes helper',
      fronts_only: true,
      role: null,
      agent_recipe_id: body.agent.id,
      team_id: 'team-design',
      autonomy: 'propose',
      allowed_side_effects: ['read'],
      bot_character: 'notes',
    })
  })

  it('saves a built bot as it is', async () => {
    as('plain')
    const built = builtBotId({ body: 'heart', color: '#5B7BFF', glasses: 'shades', worn: 'crown' })!
    const body = await readJson<Created>(await create({ name: 'Built', bot_character: built }))
    expect(h.db.rows('ai_team_member').find((r) => r.id === body.ai_team_member!.id)?.bot_character).toBe(built)
  })

  it.each([['dragon'], ['xzzaaaaa'], [42], [null]])('refuses %j with a 400 and writes nothing', async (bad) => {
    as('owner')
    const res = await create({ name: 'Nope', bot_character: bad })
    expect(res.status).toBe(400)
    expect(h.db.rows('recipe').filter((r) => r.category === 'agent' && r.workspace_id === 'ws-1')).toHaveLength(0)
    expect(h.db.rows('ai_team_member')).toHaveLength(0)
  })

  // bots-v4 B1: making an agent makes its bot, every time.
  it('gives every shared agent its bot, on the first free face when none is picked', async () => {
    as('owner')
    h.db.seed('ai_team_member', [{ id: 'worn', workspace_id: 'ws-1', bot_character: 'chat', name: 'Assistant' }])
    const body = await readJson<Created>(await create({ name: 'Bare' }))
    expect(body.bot_kind).toBe('full')
    const mate = h.db.rows('ai_team_member').find((r) => r.id === body.ai_team_member!.id)!
    expect(mate).toMatchObject({ agent_recipe_id: body.agent.id, name: 'Bare' })
    // The first face nobody wears: never the one already worn.
    expect(typeof mate.bot_character).toBe('string')
    expect(mate.bot_character).not.toBe('chat')
  })

  it('a personal agent made with no face gets no bot', async () => {
    as('owner')
    const body = await readJson<Created>(await create({ name: 'Mine', visibility: 'personal' }))
    expect(body.ai_team_member).toBeUndefined()
    expect(h.db.rows('ai_team_member')).toHaveLength(0)
  })

  it('keeps the agent when its bot can’t be made, and says why', async () => {
    as('plain')
    // A member on no team, in a workspace whose every team is private: nowhere for a bot.
    for (const t of h.db.rows('team')) t.is_private = true
    for (const s of h.db.rows('team_member')) s.member_id = s.member_id === 'm-plain' ? 'm-gone' : s.member_id
    const res = await create({ name: 'Orphan', bot_character: 'dew' })
    expect(res.status).toBe(200)
    const body = await readJson<Created>(res)
    expect(body.agent.id).toBeTruthy()
    expect(body.bot_error).toMatch(/team/i)
  })
})

describe('POST /api/account/agents: a personal agent has no bot', () => {
  it('refuses a bot for a personal agent with a 400 and writes nothing', async () => {
    as('plain')
    const res = await create({ name: 'Mine', visibility: 'personal', bot_character: 'notes' })
    expect(res.status).toBe(400)
    expect(h.db.rows('recipe').filter((r) => r.workspace_id === 'ws-1')).toHaveLength(0)
    expect(h.db.rows('ai_team_member')).toHaveLength(0)
  })
})

describe('DELETE /api/account/agents/[id]: an agent with a bot can be deleted', () => {
  const remove = (id: string) =>
    DELETE(buildRequest({ url: `https://dial8.ai/api/account/agents/${id}`, method: 'DELETE' }) as unknown as NextRequest, {
      params: Promise.resolve({ id }),
    })
  /** The database's RESTRICT on ai_team_member.agent_recipe_id (migration 144), which the double doesn't enforce. */
  const stillBuiltOn = (agentId: string) => h.db.rows('ai_team_member').filter((r) => r.agent_recipe_id === agentId)

  it('a plain member deletes their agent, and its bot goes with it', async () => {
    as('plain')
    const made = await readJson<Created>(await create({ name: 'Notes helper', bot_character: 'notes' }))
    expect(made.bot_kind).toBe('work_bot')
    const res = await remove(made.agent.id)
    expect(res.status).toBe(200)
    expect(stillBuiltOn(made.agent.id)).toHaveLength(0)
    expect(h.db.rows('recipe').find((r) => r.id === made.agent.id)).toBeUndefined()
  })

  it('refuses, by name, while a full teammate is built on it, and changes nothing', async () => {
    as('owner')
    const made = await readJson<Created>(await create({ name: 'Sales Coach', bot_character: 'coach' }))
    expect(made.bot_kind).toBe('full')
    const res = await remove(made.agent.id)
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body.code).toBe('AGENT_FIELDED')
    expect(body.error).toContain('Sales Coach')
    expect(body.error).toMatch(/Teams/)
    expect(stillBuiltOn(made.agent.id)).toHaveLength(1)
    expect(h.db.rows('recipe').find((r) => r.id === made.agent.id)).toBeDefined()
  })

  it('names only the teammates the caller can reach: one on a private team they’re not on is counted', async () => {
    as('owner')
    const made = await readJson<Created>(await create({ name: 'Sales Coach', bot_character: 'coach' }))
    h.db.seed('team', [{ id: 'team-quiet', workspace_id: 'ws-1', is_private: true, created_at: '2026-01-04T00:00:00Z' }])
    h.db.seed('ai_team_member', [
      { id: 'quiet-mate', workspace_id: 'ws-1', team_id: 'team-quiet', name: 'Quiet mate', agent_recipe_id: made.agent.id, is_system: false, fronts_only: false },
    ])
    const res = await remove(made.agent.id)
    expect(res.status).toBe(409)
    const { error } = await readJson<{ error: string }>(res)
    expect(error).toContain('Sales Coach and 1 on a private team are agents built on this persona')
    expect(error).toMatch(/The one on a private team is for an owner, an admin or the team’s lead to remove/)
    expect(error).not.toContain('Quiet mate')
  })

  it('a bot others chat with, on a private team the caller isn’t on, isn’t named either', async () => {
    as('plain')
    const made = await readJson<Created>(await create({ name: 'Notes helper', bot_character: 'notes' }))
    h.db.seed('team', [{ id: 'team-quiet', workspace_id: 'ws-1', is_private: true, created_at: '2026-01-04T00:00:00Z' }])
    h.db.rows('ai_team_member').find((r) => r.id === made.ai_team_member!.id)!.team_id = 'team-quiet'
    h.db.seed('chat_conversations', [{ id: 'c1', user_id: 'user-lead', ai_team_member_id: made.ai_team_member!.id }])
    const res = await remove(made.agent.id)
    expect(res.status).toBe(409)
    const { error } = await readJson<{ error: string }>(res)
    expect(error).toContain('this persona’s agent (on a private team)')
    expect(error).not.toContain('Notes helper')
  })

  it('a plain member may not delete an agent whose bot other people chat with (their chats would go)', async () => {
    as('plain')
    const made = await readJson<Created>(await create({ name: 'Notes helper', bot_character: 'notes' }))
    h.db.seed('chat_conversations', [{ id: 'c1', user_id: 'user-lead', ai_team_member_id: made.ai_team_member!.id }])
    const res = await remove(made.agent.id)
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('AGENT_BOT_IN_USE')
    expect(stillBuiltOn(made.agent.id)).toHaveLength(1)
    expect(h.db.rows('recipe').find((r) => r.id === made.agent.id)).toBeDefined()
  })

  it('only its author, or an owner or admin, may delete it', async () => {
    as('plain')
    const made = await readJson<Created>(await create({ name: 'Notes helper', bot_character: 'notes' }))
    as('lead')
    const res = await remove(made.agent.id)
    expect(res.status).toBe(403)
    expect(stillBuiltOn(made.agent.id)).toHaveLength(1)
    as('owner')
    expect((await remove(made.agent.id)).status).toBe(200)
    expect(stillBuiltOn(made.agent.id)).toHaveLength(0)
  })
})


describe('makeAgentTeammate: a bot made beside its agent’s other bots (decision 11)', () => {
  beforeEach(() => {
    h.db.seed('recipe', [
      { id: 'coach', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
      { id: 's-1', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
    ])
    h.db.seed('ai_team_member', [
      { id: 'riley', workspace_id: 'ws-1', team_id: 'team-design', agent_recipe_id: 'coach', is_system: false, fronts_only: false, created_at: '1' },
    ])
    h.db.seed('ai_team_member_skill', [{ ai_team_member_id: 'riley', skill_recipe_id: 's-1', sort_order: 0 }])
  })
  const make = () =>
    makeAgentTeammate(h.db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      userId: 'user-owner',
      agent: { id: 'coach', name: 'Coach' },
      character: 'ember',
    })
  const skillsOf = (id: string) => h.db.rows('ai_team_member_skill').filter((r) => r.ai_team_member_id === id).map((r) => r.skill_recipe_id)

  it('starts with the skills they always check', async () => {
    const made = await make()
    if ('error' in made) throw new Error(made.error)
    expect(made.skillsError).toBeNull()
    expect(skillsOf(made.teammate.id)).toEqual(['s-1'])
  })

  it('is made anyway when they can’t be copied, and says why instead of only logging it', async () => {
    h.failSkills = true
    const made = await make()
    if ('error' in made) throw new Error(made.error)
    expect(made.skillsError).toMatch(/skills write failed/)
    expect(h.db.rows('ai_team_member').some((r) => r.id === made.teammate.id)).toBe(true)
    expect(skillsOf(made.teammate.id)).toEqual([])
  })
})

describe('POST /api/account/agents: its bot’s voice (bots-v4 B2)', () => {
  const mateOf = (body: Created) => h.db.rows('ai_team_member').find((r) => r.id === body.ai_team_member!.id)!

  it('makes a full teammate or a work bot in the voice picked', async () => {
    as('owner')
    const full = await readJson<Created>(await create({ name: 'Sales Coach', bot_character: 'coach', voice: 'lori' }))
    expect(full.bot_kind).toBe('full')
    expect(mateOf(full).voice).toBe('lori')
    as('plain')
    const work = await readJson<Created>(await create({ name: 'Notes helper', bot_character: 'notes', voice: 'chichi' }))
    expect(work.bot_kind).toBe('work_bot')
    expect(mateOf(work)).toMatchObject({ fronts_only: true, voice: 'chichi' })
  })

  it('with none picked, or null, its bot is on Automatic', async () => {
    as('owner')
    expect(mateOf(await readJson<Created>(await create({ name: 'Plain', bot_character: 'coach' }))).voice ?? null).toBeNull()
    expect(mateOf(await readJson<Created>(await create({ name: 'Null', bot_character: 'ember', voice: null }))).voice ?? null).toBeNull()
  })

  it.each([['Lori'], [''], ['lori bot'], [42], [{ id: 'lori' }]])('refuses %j with a 400 naming the field, and writes nothing', async (bad) => {
    as('owner')
    const res = await create({ name: 'Nope', bot_character: 'coach', voice: bad })
    expect(res.status).toBe(400)
    expect(await readJson<{ details: unknown }>(res)).toMatchObject({ details: { field: 'voice' } })
    expect(h.db.rows('recipe').filter((r) => r.category === 'agent' && r.workspace_id === 'ws-1')).toHaveLength(0)
    expect(h.db.rows('ai_team_member')).toHaveLength(0)
  })

  it('a personal agent has no bot to give a voice: a 400, nothing written', async () => {
    as('plain')
    const res = await create({ name: 'Mine', visibility: 'personal', voice: 'lori' })
    expect(res.status).toBe(400)
    expect(h.db.rows('recipe').filter((r) => r.workspace_id === 'ws-1')).toHaveLength(0)
  })
})

describe('makeAgentTeammate: a new bot’s voice is its own (decision 11)', () => {
  beforeEach(() => {
    h.db.seed('recipe', [{ id: 'coach', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' }])
    h.db.seed('ai_team_member', [
      { id: 'riley', workspace_id: 'ws-1', team_id: 'team-design', agent_recipe_id: 'coach', is_system: false, fronts_only: false, voice: 'lori', created_at: '1' },
    ])
  })
  const make = (voice?: string | null) =>
    makeAgentTeammate(h.db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      userId: 'user-owner',
      agent: { id: 'coach', name: 'Coach' },
      character: 'ember',
      ...(voice !== undefined ? { voice } : {}),
    })

  it('never takes the agent’s other bots’ voice: Automatic unless one is picked', async () => {
    const made = await make()
    if ('error' in made) throw new Error(made.error)
    expect(h.db.rows('ai_team_member').find((r) => r.id === made.teammate.id)?.voice ?? null).toBeNull()
    const picked = await make('tana')
    if ('error' in picked) throw new Error(picked.error)
    expect(h.db.rows('ai_team_member').find((r) => r.id === picked.teammate.id)?.voice).toBe('tana')
    expect(h.db.rows('ai_team_member').find((r) => r.id === 'riley')?.voice).toBe('lori')
  })
})
