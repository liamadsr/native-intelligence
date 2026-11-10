/**
 * The work-bot routes (bots-v3 Phase 3): a plain member (no teammate-manage
 * policy: not an owner, admin or team lead) can make, rename, re-face and
 * delete a work bot, and only a work bot. The writes run on the service client
 * after the route's checks, so the database double stands in for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { builtBotId } from '@/lib/bots/bot-faces'
import { makeFakeSupabase, replaceAiMemberSkillsRpc, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase, userId: 'user-plain' }))

vi.mock('@/lib/api-auth', () => ({
  // As the real helper does: the caller's member row, read from the database,
  // carrying only the columns the route asks for (`id` unless it says more).
  // So a route that checks `member.role` without asking for it sees none.
  requireWorkspaceMember: async (options?: { select?: string }) => {
    const row = h.db.rows('member').find((m) => m.user_id === h.userId && m.workspace_id === 'ws-1')
    const columns = (options?.select ?? 'id').split(',').map((c) => c.trim())
    return {
      supabase: h.db,
      user: { id: h.userId },
      workspaceId: 'ws-1',
      member: Object.fromEntries(columns.map((c) => [c, row?.[c]])),
    }
  },
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.db }))

const { POST } = await import('../route')
const { PATCH, DELETE } = await import('../[id]/route')

function seed() {
  // Selects return only what they name (PostgREST); a bot's skills are written
  // by the database's one call (migration 305).
  const db: FakeSupabase = makeFakeSupabase({
    project: true,
    rpc: { replace_ai_member_skills: replaceAiMemberSkillsRpc(() => db) },
  })
  db.seed('recipe', [{ id: 'anchor', slug: 'loop-work-bot', category: 'agent', workspace_id: null }])
  db.seed('member', [
    // A plain member: the ai_team_member manage policy would refuse them.
    { id: 'm-plain', workspace_id: 'ws-1', user_id: 'user-plain', role: 'member' },
    { id: 'm-owner', workspace_id: 'ws-1', user_id: 'user-owner', role: 'owner' },
  ])
  db.seed('team', [
    { id: 'team-mine', workspace_id: 'ws-1', is_private: false, created_at: '2026-01-01T00:00:00Z' },
    { id: 'team-locked', workspace_id: 'ws-1', is_private: true, created_at: '2026-01-02T00:00:00Z' },
  ])
  db.seed('team_member', [{ team_id: 'team-mine', member_id: 'm-plain' }])
  db.seed('ai_team_member', [
    { id: 'full-writer', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Writer', is_system: false, fronts_only: false, bot_character: 'writer' },
    { id: 'locked-bot', workspace_id: 'ws-1', team_id: 'team-locked', name: 'Locked', is_system: false, fronts_only: true, bot_character: 'nova' },
  ])
  return db
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  h.db = seed()
  h.userId = 'user-plain'
})

describe('POST /api/account/work-bots', () => {
  it('lets a plain member make a work bot in their team, with propose-only limits', async () => {
    const res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots', method: 'POST', body: { name: 'Brief bot', bot_character: 'ember' } }) as NextRequest)
    expect(res.status).toBe(201)
    const made = h.db.rows('ai_team_member').find((r) => r.name === 'Brief bot')!
    expect(made).toMatchObject({
      fronts_only: true,
      role: null,
      team_id: 'team-mine',
      agent_recipe_id: 'anchor',
      autonomy: 'propose',
      allowed_side_effects: ['read'],
      bot_character: 'ember',
      created_by: 'user-plain',
    })
  })

  it('refuses a team the member is not on, and a face that is not a character', async () => {
    let res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots', method: 'POST', body: { team_id: 'team-locked' } }) as NextRequest)
    expect(res.status).toBe(400)
    res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots', method: 'POST', body: { bot_character: 'nope' } }) as NextRequest)
    expect(res.status).toBe(400)
    expect(h.db.rows('ai_team_member')).toHaveLength(2)
  })
})

describe('PATCH / DELETE /api/account/work-bots/[id]', () => {
  async function makeOne(): Promise<string> {
    const res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots', method: 'POST', body: { name: 'Brief bot', bot_character: 'ember' } }) as NextRequest)
    return (await readJson<{ ai_team_member: { id: string } }>(res)).ai_team_member.id
  }

  it('renames and re-faces it', async () => {
    const id = await makeOne()
    const res = await PATCH(
      buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'PATCH', body: { name: '  Ember  ', bot_character: 'scout' } }) as NextRequest,
      params(id),
    )
    expect(res.status).toBe(200)
    expect(h.db.rows('ai_team_member').find((r) => r.id === id)).toMatchObject({ name: 'Ember', bot_character: 'scout' })
  })

  it('deletes it', async () => {
    const id = await makeOne()
    const res = await DELETE(buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'DELETE' }) as NextRequest, params(id))
    expect(res.status).toBe(200)
    expect(h.db.rows('ai_team_member').some((r) => r.id === id)).toBe(false)
  })

  it('refuses a plain member’s delete while other people chat with it, and keeps their threads', async () => {
    const id = await makeOne()
    h.db.seed('chat_conversations', [
      { id: 'c-mine', user_id: 'user-plain', ai_team_member_id: id },
      { id: 'c-theirs', user_id: 'user-other', ai_team_member_id: id },
    ])
    const res = await DELETE(buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'DELETE' }) as NextRequest, params(id))
    expect(res.status).toBe(409)
    expect(h.db.rows('ai_team_member').some((r) => r.id === id)).toBe(true)
    expect(h.db.rows('chat_conversations').map((c) => c.id)).toEqual(['c-mine', 'c-theirs'])
  })

  it('lets an owner delete one other people chat with, where a plain member gets the 409', async () => {
    const id = await makeOne()
    h.db.seed('chat_conversations', [
      { id: 'c-plain', user_id: 'user-plain', ai_team_member_id: id },
      { id: 'c-other', user_id: 'user-other', ai_team_member_id: id },
    ])
    const url = `https://nativeintelligence.dev/api/account/work-bots/${id}`

    // The plain member who made it: others chat with it, so no.
    let res = await DELETE(buildRequest({ url, method: 'DELETE' }) as NextRequest, params(id))
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('WORK_BOT_IN_USE')
    expect(h.db.rows('ai_team_member').some((r) => r.id === id)).toBe(true)

    // The owner (role read from their member row): yes.
    h.userId = 'user-owner'
    res = await DELETE(buildRequest({ url, method: 'DELETE' }) as NextRequest, params(id))
    expect(res.status).toBe(200)
    expect(h.db.rows('ai_team_member').some((r) => r.id === id)).toBe(false)
  })

  it('lets a plain member delete one only they chat with', async () => {
    const id = await makeOne()
    h.db.seed('chat_conversations', [{ id: 'c-mine', user_id: 'user-plain', ai_team_member_id: id }])
    const res = await DELETE(buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'DELETE' }) as NextRequest, params(id))
    expect(res.status).toBe(200)
  })

  it('never touches a full teammate (403) or a bot on a private team they are not on (404)', async () => {
    let res = await PATCH(
      buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots/full-writer', method: 'PATCH', body: { name: 'Mine now' } }) as NextRequest,
      params('full-writer'),
    )
    expect(res.status).toBe(403)
    res = await DELETE(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots/full-writer', method: 'DELETE' }) as NextRequest, params('full-writer'))
    expect(res.status).toBe(403)
    res = await DELETE(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots/locked-bot', method: 'DELETE' }) as NextRequest, params('locked-bot'))
    expect(res.status).toBe(404)
    expect(h.db.rows('ai_team_member').map((r) => [r.id, r.name])).toEqual([
      ['full-writer', 'Writer'],
      ['locked-bot', 'Locked'],
    ])
  })
})

describe('built bots through the work-bot routes (bots-v3 Phase 6: the builder saves here)', () => {
  const BUILT = builtBotId({ body: 'scout', eyes: 'happy', worn: 'beret' })!

  it('makes a work bot wearing a built bot, and re-faces one to a built bot', async () => {
    let res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots', method: 'POST', body: { name: 'Built', bot_character: BUILT } }) as NextRequest)
    expect(res.status).toBe(201)
    const id = (await readJson<{ ai_team_member: { id: string } }>(res)).ai_team_member.id
    expect(h.db.rows('ai_team_member').find((r) => r.id === id)).toMatchObject({ bot_character: BUILT, fronts_only: true })
    const other = builtBotId({ body: 'round', glasses: 'monocle' })!
    res = await PATCH(
      buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'PATCH', body: { bot_character: other } }) as NextRequest,
      params(id),
    )
    expect(res.status).toBe(200)
    expect(h.db.rows('ai_team_member').find((r) => r.id === id)).toMatchObject({ bot_character: other })
  })

  it('refuses an id that is not a built bot (a 400), and makes or changes nothing', async () => {
    let res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots', method: 'POST', body: { bot_character: 'xzzaaaaa' } }) as NextRequest)
    expect(res.status).toBe(400)
    expect(h.db.rows('ai_team_member')).toHaveLength(2)
    res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots', method: 'POST', body: { name: 'Built', bot_character: BUILT } }) as NextRequest)
    const id = (await readJson<{ ai_team_member: { id: string } }>(res)).ai_team_member.id
    res = await PATCH(
      buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'PATCH', body: { bot_character: 'xaaaaaab' } }) as NextRequest,
      params(id),
    )
    expect(res.status).toBe(400)
    expect(h.db.rows('ai_team_member').find((r) => r.id === id)).toMatchObject({ bot_character: BUILT })
  })
})

describe('"Make a copy for this bot" through the work-bot route (bots-v4 B1, decision 11)', () => {
  beforeEach(() => {
    h.db.seed('recipe', [
      // A plain member's agent: its work bot is its author's to change.
      { id: 'coach', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace', forked_from: null, created_by: 'user-plain' },
      { id: 'coach-copy', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace', forked_from: 'coach' },
      { id: 'other', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace', forked_from: null },
      { id: 'private-copy', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'personal', forked_from: 'coach' },
    ])
    h.db.seed('ai_team_member', [
      { id: 'coach-bot', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Coach', is_system: false, fronts_only: true, agent_recipe_id: 'coach', bot_character: 'ember' },
      { id: 'loop-bot', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Ember', is_system: false, fronts_only: true, agent_recipe_id: 'anchor', bot_character: 'scout' },
    ])
  })
  const repoint = (id: string, agentRecipeId: string) =>
    PATCH(
      buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'PATCH', body: { agent_recipe_id: agentRecipeId } }) as NextRequest,
      params(id),
    )
  const agentOf = (id: string) => h.db.rows('ai_team_member').find((r) => r.id === id)?.agent_recipe_id

  it('points an agent’s work bot at a copy of its own agent', async () => {
    const res = await repoint('coach-bot', 'coach-copy')
    expect(res.status).toBe(200)
    expect(agentOf('coach-bot')).toBe('coach-copy')
  })

  it('and at nothing else: another agent, or a personal copy', async () => {
    expect((await repoint('coach-bot', 'other')).status).toBe(400)
    expect((await repoint('coach-bot', 'private-copy')).status).toBe(400)
    expect((await repoint('coach-bot', 'missing')).status).toBe(400)
    expect(agentOf('coach-bot')).toBe('coach')
  })

  it('the bot keeps its skills, and the other bots on the agent stay on the original (decision 11)', async () => {
    h.db.seed('ai_team_member', [
      { id: 'riley', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Riley', is_system: false, fronts_only: false, agent_recipe_id: 'coach', bot_character: 'dew' },
    ])
    h.db.seed('ai_team_member_skill', [
      { ai_team_member_id: 'coach-bot', skill_recipe_id: 's-1', sort_order: 0 },
      { ai_team_member_id: 'riley', skill_recipe_id: 's-1', sort_order: 0 },
    ])
    expect((await repoint('coach-bot', 'coach-copy')).status).toBe(200)
    expect(agentOf('coach-bot')).toBe('coach-copy')
    expect(agentOf('riley')).toBe('coach')
    expect(h.db.rows('ai_team_member_skill').filter((r) => r.ai_team_member_id === 'coach-bot').map((r) => r.skill_recipe_id)).toEqual(['s-1'])
  })

  it('a name or face edit reaches only that bot', async () => {
    h.db.seed('ai_team_member', [
      { id: 'riley', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Riley', is_system: false, fronts_only: false, agent_recipe_id: 'coach', bot_character: 'dew' },
    ])
    const res = await PATCH(
      buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots/coach-bot', method: 'PATCH', body: { name: 'Closer', bot_character: 'nova' } }) as NextRequest,
      params('coach-bot'),
    )
    expect(res.status).toBe(200)
    expect(h.db.rows('ai_team_member').find((r) => r.id === 'coach-bot')).toMatchObject({ name: 'Closer', bot_character: 'nova' })
    expect(h.db.rows('ai_team_member').find((r) => r.id === 'riley')).toMatchObject({ name: 'Riley', bot_character: 'dew' })
  })

  it('another member who reaches the bot can’t point it elsewhere, rename it or re-face it: it fronts someone else’s agent', async () => {
    h.db.seed('member', [{ id: 'm-other', workspace_id: 'ws-1', user_id: 'user-other', role: 'member' }])
    h.db.seed('team_member', [{ team_id: 'team-mine', member_id: 'm-other' }])
    h.userId = 'user-other'
    let res = await repoint('coach-bot', 'coach-copy')
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/only the persona’s author, or a workspace owner or admin/)
    res = await PATCH(
      buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots/coach-bot', method: 'PATCH', body: { name: 'Mine now' } }) as NextRequest,
      params('coach-bot'),
    )
    expect(res.status).toBe(403)
    expect(agentOf('coach-bot')).toBe('coach')
    // An owner may.
    h.userId = 'user-owner'
    expect((await repoint('coach-bot', 'coach-copy')).status).toBe(200)
  })

  it('a loop’s bot speaks from its loops: its persona never changes (409)', async () => {
    const res = await repoint('loop-bot', 'coach-copy')
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('WORK_BOT')
    expect(agentOf('loop-bot')).toBe('anchor')
  })

  it('onto a copy that already has bots, it takes the skills they share (one list per agent)', async () => {
    h.db.seed('recipe', [
      { id: 's-1', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
      { id: 's-2', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
    ])
    h.db.seed('ai_team_member', [
      { id: 'copy-mate', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Mate', is_system: false, fronts_only: false, agent_recipe_id: 'coach-copy', bot_character: 'dew', created_at: '1' },
    ])
    h.db.seed('ai_team_member_skill', [
      { ai_team_member_id: 'coach-bot', skill_recipe_id: 's-1', sort_order: 0 },
      { ai_team_member_id: 'copy-mate', skill_recipe_id: 's-2', sort_order: 0 },
    ])
    expect((await repoint('coach-bot', 'coach-copy')).status).toBe(200)
    expect(h.db.rows('ai_team_member_skill').filter((r) => r.ai_team_member_id === 'coach-bot').map((r) => r.skill_recipe_id)).toEqual(['s-2'])
  })

  it('deleting an agent’s work bot is its author’s, or an owner’s, never another member’s who reaches it', async () => {
    const remove = () =>
      DELETE(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots/coach-bot', method: 'DELETE' }) as NextRequest, params('coach-bot'))
    h.db.seed('member', [{ id: 'm-other', workspace_id: 'ws-1', user_id: 'user-other', role: 'member' }])
    h.db.seed('team_member', [{ team_id: 'team-mine', member_id: 'm-other' }])
    h.userId = 'user-other'
    const res = await remove()
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/only the persona’s author, or a workspace owner or admin/)
    expect(agentOf('coach-bot')).toBe('coach')
    h.userId = 'user-plain'
    expect((await remove()).status).toBe(200)
    expect(agentOf('coach-bot')).toBeUndefined()
  })

  it('an owner may delete an agent’s work bot', async () => {
    h.userId = 'user-owner'
    expect((await DELETE(buildRequest({ url: 'https://nativeintelligence.dev/api/account/work-bots/coach-bot', method: 'DELETE' }) as NextRequest, params('coach-bot'))).status).toBe(200)
  })
})

describe('a work bot’s voice (bots-v4 B2, migration 308)', () => {
  beforeEach(() => {
    h.db.seed('recipe', [
      // A plain member's agent: its work bot is its author's to change.
      { id: 'coach', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace', forked_from: null, created_by: 'user-plain' },
    ])
    h.db.seed('ai_team_member', [
      { id: 'coach-bot', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Coach', is_system: false, fronts_only: true, agent_recipe_id: 'coach', bot_character: 'ember', voice: null },
      { id: 'loop-bot', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Ember', is_system: false, fronts_only: true, agent_recipe_id: 'anchor', bot_character: 'scout', voice: 'cha' },
      { id: 'riley', workspace_id: 'ws-1', team_id: 'team-mine', name: 'Riley', is_system: false, fronts_only: false, agent_recipe_id: 'coach', bot_character: 'dew', voice: 'aba' },
    ])
  })
  const revoice = (id: string, voice: unknown) =>
    PATCH(buildRequest({ url: `https://nativeintelligence.dev/api/account/work-bots/${id}`, method: 'PATCH', body: { voice } }) as NextRequest, params(id))
  const voiceOf = (id: string) => h.db.rows('ai_team_member').find((r) => r.id === id)?.voice

  it('takes one voice id, and null for Automatic', async () => {
    let res = await revoice('loop-bot', 'lori')
    expect(res.status).toBe(200)
    expect(voiceOf('loop-bot')).toBe('lori')
    // The update reads the voice back with the bot (PostgREST returns only what's named).
    expect(h.db.selects.filter((s) => s.table === 'ai_team_member').every((s) => /\bvoice\b/.test(s.columns))).toBe(true)
    res = await revoice('loop-bot', null)
    expect(res.status).toBe(200)
    expect(voiceOf('loop-bot')).toBeNull()
  })

  it.each([['Lori'], [''], ['lori bot'], ['-lori'], ['x'.repeat(33)], [42], [true], [{ id: 'lori' }], [['lori']]])(
    'refuses %j with a 400 naming the field, and changes nothing',
    async (bad) => {
      const res = await revoice('loop-bot', bad)
      expect(res.status).toBe(400)
      expect(await readJson<{ details: unknown }>(res)).toMatchObject({ details: { field: 'voice' } })
      expect(voiceOf('loop-bot')).toBe('cha')
    },
  )

  it('a voice another bot chose is allowed, and the edit reaches only this bot (decision 11)', async () => {
    expect((await revoice('coach-bot', 'aba')).status).toBe(200)
    expect(voiceOf('coach-bot')).toBe('aba')
    // The agent's other bot keeps its own; the loop's bot too.
    expect(voiceOf('riley')).toBe('aba')
    expect(voiceOf('loop-bot')).toBe('cha')
    expect((await revoice('coach-bot', 'milton')).status).toBe(200)
    expect(voiceOf('riley')).toBe('aba')
  })

  it('a loop’s bot: any member who reaches it; an agent’s work bot: its agent’s rule, as its name and face', async () => {
    h.db.seed('member', [{ id: 'm-other', workspace_id: 'ws-1', user_id: 'user-other', role: 'member' }])
    h.db.seed('team_member', [{ team_id: 'team-mine', member_id: 'm-other' }])
    h.userId = 'user-other'
    expect((await revoice('loop-bot', 'lori')).status).toBe(200)
    const res = await revoice('coach-bot', 'lori')
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/only the persona’s author, or a workspace owner or admin/)
    expect(voiceOf('coach-bot')).toBeNull()
    // Its author may, and an owner may.
    h.userId = 'user-plain'
    expect((await revoice('coach-bot', 'lori')).status).toBe(200)
    h.userId = 'user-owner'
    expect((await revoice('coach-bot', 'tana')).status).toBe(200)
    expect(voiceOf('coach-bot')).toBe('tana')
  })

  it('never a full teammate’s (403), nor a bot on a private team the caller isn’t on (404)', async () => {
    expect((await revoice('riley', 'lori')).status).toBe(403)
    expect((await revoice('locked-bot', 'lori')).status).toBe(404)
    expect(voiceOf('riley')).toBe('aba')
  })
})
