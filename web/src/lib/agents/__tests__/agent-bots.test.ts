/**
 * The bots on an agent and the skills they always check (bots-v4 B1,
 * decision 11), on the database double: which teammates count as the agent's
 * bots, which skills may be pinned, and how a list is written to each bot.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, replaceAiMemberSkillsRpc, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  agentSkillIds,
  checkPinnableSkills,
  isInvalidSkill,
  isTooManySkills,
  listAgentBots,
  manageableTeams,
  pinnableOnly,
  replaceBotSkills,
  skillIdsByBot,
  skillsOnJoining,
  writeBotSkills,
} from '../agent-bots'

let db: FakeSupabase
const failing = new Set<string>()
const sb = () => db as unknown as SupabaseClient

beforeEach(() => {
  failing.clear()
  // Selects return only the columns they name (PostgREST), and a bot's skills
  // are written by the database's one call (migration 305), as in production.
  db = makeFakeSupabase({
    project: true,
    rpc: { replace_ai_member_skills: replaceAiMemberSkillsRpc(() => db, { fail: (id) => failing.has(id) }) },
  })
  db.seed('ai_team_member', [
    { id: 'riley', workspace_id: 'ws-1', agent_recipe_id: 'coach', is_system: false, fronts_only: false, created_at: '2026-01-01' },
    { id: 'coach-bot', workspace_id: 'ws-1', agent_recipe_id: 'coach', is_system: false, fronts_only: true, created_at: '2026-01-02' },
    { id: 'loop-bot', workspace_id: 'ws-1', agent_recipe_id: 'anchor', is_system: false, fronts_only: true, created_at: '2026-01-03' },
    { id: 'triage', workspace_id: 'ws-1', agent_recipe_id: 'loop-triage', is_system: true, fronts_only: false, created_at: '2026-01-04' },
    { id: 'elsewhere', workspace_id: 'ws-2', agent_recipe_id: 'coach', is_system: false, fronts_only: false, created_at: '2026-01-05' },
  ])
  db.seed('recipe', [
    { id: 's-own', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
    { id: 's-sys', category: 'skill', workspace_id: null, is_system: true, visibility: 'workspace' },
    { id: 's-mine', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'personal' },
    { id: 's-foreign', category: 'skill', workspace_id: 'ws-2', is_system: false, visibility: 'public' },
    { id: 'a-agent', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
    ...['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => ({ id, category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' })),
  ])
})

describe('listAgentBots', () => {
  it('is every bot built on the agent in this workspace: its full teammates and its work bot, oldest first', async () => {
    expect((await listAgentBots(sb(), { workspaceId: 'ws-1', agentId: 'coach' })).map((b) => b.id)).toEqual(['riley', 'coach-bot'])
  })

  it('never a loop’s work bot or a system teammate (their personas are anchors)', async () => {
    expect((await listAgentBots(sb(), { workspaceId: 'ws-1', agentId: 'anchor' })).map((b) => b.id)).toEqual(['loop-bot'])
    // A system teammate is its own agent: never listed as an agent's bot.
    expect(await listAgentBots(sb(), { workspaceId: 'ws-1', agentId: 'loop-triage' })).toEqual([])
  })
})

describe('checkPinnableSkills', () => {
  it('takes up to five of this workspace’s or system skills, unique, in order', async () => {
    expect(await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: ['s-sys', 's-own', 's-sys'] })).toEqual({ ok: true, ids: ['s-sys', 's-own'] })
    expect(await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: [] })).toEqual({ ok: true, ids: [] })
  })

  it('refuses a sixth skill', async () => {
    const out = await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: ['s1', 's2', 's3', 's4', 's5', 's6'] })
    expect(out).toMatchObject({ ok: false, code: 'TOO_MANY_SKILLS' })
  })

  it('refuses a personal skill, another workspace’s, an agent, and a missing one', async () => {
    expect(await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: ['s-mine'] })).toMatchObject({ ok: false, code: 'PERSONAL_SKILL' })
    expect(await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: ['s-foreign'] })).toMatchObject({ ok: false, code: 'INVALID_SKILLS' })
    expect(await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: ['a-agent'] })).toMatchObject({ ok: false, code: 'INVALID_SKILLS' })
    expect(await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: ['gone'] })).toMatchObject({ ok: false, code: 'INVALID_SKILLS' })
    expect(await checkPinnableSkills(sb(), { workspaceId: 'ws-1', ids: 'not-a-list' })).toMatchObject({ ok: false, code: 'INVALID_SKILLS' })
  })

  it('pinnableOnly keeps what may be pinned, in order', async () => {
    expect(await pinnableOnly(sb(), { workspaceId: 'ws-1', ids: ['s-mine', 's-own', 's-foreign', 's-sys'] })).toEqual(['s-own', 's-sys'])
  })
})

describe('writeBotSkills', () => {
  const skills = (botId: string) =>
    db
      .rows('ai_team_member_skill')
      .filter((r) => r.ai_team_member_id === botId)
      .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
      .map((r) => r.skill_recipe_id)

  it('gives each bot exactly the list, in order, in one database call per bot', async () => {
    db.seed('ai_team_member_skill', [
      { ai_team_member_id: 'riley', skill_recipe_id: 's1', sort_order: 0 },
      { ai_team_member_id: 'riley', skill_recipe_id: 's2', sort_order: 1 },
      { ai_team_member_id: 'coach-bot', skill_recipe_id: 's3', sort_order: 0 },
    ])
    const out = await writeBotSkills(sb(), { botIds: ['riley', 'coach-bot'], skillIds: ['s2', 's4'] })
    expect(out).toEqual({ changed: ['riley', 'coach-bot'], failed: [] })
    expect(skills('riley')).toEqual(['s2', 's4'])
    expect(skills('coach-bot')).toEqual(['s2', 's4'])
    // Whole lists, replaced by the locking call: no row-by-row writes two saves could interleave.
    expect(db.rpcCalls).toEqual([
      { fn: 'replace_ai_member_skills', args: { p_member_id: 'riley', p_skill_ids: ['s2', 's4'] } },
      { fn: 'replace_ai_member_skills', args: { p_member_id: 'coach-bot', p_skill_ids: ['s2', 's4'] } },
    ])
    expect(db.calls.filter((c) => c.table === 'ai_team_member_skill' && c.op !== 'select')).toEqual([])
  })

  it('a bot whose write fails is named and keeps what it had; the others still change', async () => {
    db.seed('ai_team_member_skill', [{ ai_team_member_id: 'riley', skill_recipe_id: 's1', sort_order: 0 }])
    failing.add('riley')
    const out = await writeBotSkills(sb(), { botIds: ['riley', 'coach-bot'], skillIds: ['s2'] })
    expect(out.changed).toEqual(['coach-bot'])
    expect(out.failed).toEqual([{ id: 'riley', error: 'skills write failed for riley' }])
    expect(skills('riley')).toEqual(['s1'])
    expect(skills('coach-bot')).toEqual(['s2'])
  })

  it('the database refuses a sixth skill, whatever the route checked first', async () => {
    const error = await replaceBotSkills(sb(), { botId: 'riley', skillIds: ['s1', 's2', 's3', 's4', 's5', 's6'] })
    expect(isTooManySkills(error)).toBe(true)
    expect(skills('riley')).toEqual([])
    expect(isTooManySkills(await replaceBotSkills(sb(), { botId: 'riley', skillIds: ['s1'] }))).toBe(false)
  })

  it('the database refuses another workspace’s skill and anything that isn’t a skill; a system skill is fine', async () => {
    expect(isInvalidSkill(await replaceBotSkills(sb(), { botId: 'riley', skillIds: ['s1', 's-foreign'] }))).toBe(true)
    expect(isInvalidSkill(await replaceBotSkills(sb(), { botId: 'riley', skillIds: ['a-agent'] }))).toBe(true)
    expect(skills('riley')).toEqual([])
    expect(await replaceBotSkills(sb(), { botId: 'riley', skillIds: ['s-sys', 's-own'] })).toBeNull()
    expect(skills('riley')).toEqual(['s-sys', 's-own'])
  })

  it('an empty list clears them', async () => {
    db.seed('ai_team_member_skill', [{ ai_team_member_id: 'riley', skill_recipe_id: 's1', sort_order: 0 }])
    expect(await writeBotSkills(sb(), { botIds: ['riley'], skillIds: [] })).toEqual({ changed: ['riley'], failed: [] })
    expect(skills('riley')).toEqual([])
  })
})

describe('a new bot starts with the agent’s skills', () => {
  it('reads its oldest other bot’s list', async () => {
    db.seed('ai_team_member_skill', [
      { ai_team_member_id: 'riley', skill_recipe_id: 's2', sort_order: 1 },
      { ai_team_member_id: 'riley', skill_recipe_id: 's1', sort_order: 0 },
      { ai_team_member_id: 'coach-bot', skill_recipe_id: 's9', sort_order: 0 },
    ])
    expect(await agentSkillIds(sb(), { workspaceId: 'ws-1', agentId: 'coach' })).toEqual(['s1', 's2'])
    // Leaving out the new bot itself (here the oldest), the next one's.
    expect(await agentSkillIds(sb(), { workspaceId: 'ws-1', agentId: 'coach', excludeId: 'riley' })).toEqual(['s9'])
    expect(await agentSkillIds(sb(), { workspaceId: 'ws-1', agentId: 'nobody' })).toEqual([])
    expect((await skillIdsByBot(sb(), ['riley', 'coach-bot'])).get('riley')).toEqual(['s1', 's2'])
  })
})

describe('a bot moving onto an agent', () => {
  beforeEach(() => {
    db.seed('ai_team_member', [{ id: 'mover', workspace_id: 'ws-1', agent_recipe_id: 'quill', is_system: false, fronts_only: false, created_at: '2026-02-01' }])
    db.seed('ai_team_member_skill', [
      { ai_team_member_id: 'riley', skill_recipe_id: 's-own', sort_order: 0 },
      { ai_team_member_id: 'riley', skill_recipe_id: 's-mine', sort_order: 1 },
      { ai_team_member_id: 'riley', skill_recipe_id: 's-sys', sort_order: 2 },
      { ai_team_member_id: 'mover', skill_recipe_id: 's5', sort_order: 0 },
    ])
  })

  it('takes the list the agent’s other bots share, pinnable ones only', async () => {
    expect(await skillsOnJoining(sb(), { workspaceId: 'ws-1', agentId: 'coach', botId: 'mover' })).toEqual(['s-own', 's-sys'])
  })

  it('keeps its own when the agent has no other bot (a copy made for it)', async () => {
    expect(await skillsOnJoining(sb(), { workspaceId: 'ws-1', agentId: 'fresh-copy', botId: 'mover' })).toBeNull()
    // Itself already on it counts for nothing.
    expect(await skillsOnJoining(sb(), { workspaceId: 'ws-1', agentId: 'quill', botId: 'mover' })).toBeNull()
  })
})

describe('manageableTeams', () => {
  beforeEach(() => {
    db.seed('team', [
      { id: 't-open', workspace_id: 'ws-1', name: 'Open', is_private: false },
      { id: 't-mine', workspace_id: 'ws-1', name: 'Mine', is_private: true },
      { id: 't-locked', workspace_id: 'ws-1', name: 'Locked', is_private: true },
      { id: 't-other', workspace_id: 'ws-2', name: 'Other', is_private: false },
    ])
    db.seed('team_member', [
      { team_id: 't-mine', member_id: 'm-owner', team_role: 'member' },
      { team_id: 't-open', member_id: 'm-lead', team_role: 'lead' },
      { team_id: 't-mine', member_id: 'm-lead', team_role: 'member' },
    ])
  })

  it('an owner: every team they can see, by name', async () => {
    const teams = await manageableTeams(sb(), { workspaceId: 'ws-1', memberId: 'm-owner', role: 'owner' })
    expect(teams.map((t) => t.id)).toEqual(['t-mine', 't-open'])
  })

  it('a lead: the teams they lead; a plain member: none', async () => {
    expect((await manageableTeams(sb(), { workspaceId: 'ws-1', memberId: 'm-lead', role: 'member' })).map((t) => t.id)).toEqual(['t-open'])
    expect(await manageableTeams(sb(), { workspaceId: 'ws-1', memberId: 'm-plain', role: 'member' })).toEqual([])
  })
})
