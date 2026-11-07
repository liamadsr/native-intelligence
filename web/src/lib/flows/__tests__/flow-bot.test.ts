/**
 * Every loop has a bot (bots-v3 Phase 3): what a flow write asks for, the
 * default's order, the work-bot insert and the back-fill, against the
 * in-memory database double.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { FREE_BOT_CHARACTER_ORDER } from '@/lib/bots/teammate-faces'
import { characterName, builtBotId } from '@/lib/bots/bot-faces'
import {
  WORK_BOT_ANCHOR_SLUG,
  backfillFlowBot,
  cleanBotName,
  createWorkBot,
  defaultFlowBot,
  flowBotRefusal,
  listFlowBotOptions,
  mayFrontLoop,
  parseFlowBotInput,
  othersTalkTo,
  resolveFlowBotChoice,
  retireWorkBotIfUnused,
  spareLoopBot,
  suggestFlowBot,
  workBotTeamFor,
} from '../flow-bot'

const WS = 'ws-1'
const USER = 'user-1'

function world(): FakeSupabase {
  const db = makeFakeSupabase({
    rpc: { seed_system_teammates: () => ({ data: 0, error: null }) },
  })
  db.seed('recipe', [
    { id: 'anchor', slug: WORK_BOT_ANCHOR_SLUG, category: 'agent', workspace_id: null, is_system: false },
    { id: 'skill-verdict', category: 'skill', workspace_id: WS, is_system: false, agent_config: { output_contract: 'verdict' } },
    { id: 'skill-prose', category: 'skill', workspace_id: WS, is_system: false, agent_config: { output_contract: 'prose' } },
    { id: 'skill-held', category: 'skill', workspace_id: WS, is_system: false, agent_config: null },
  ])
  db.seed('member', [
    { id: 'm-1', workspace_id: WS, user_id: USER, role: 'member' },
    { id: 'm-owner', workspace_id: WS, user_id: 'owner-1', role: 'owner' },
  ])
  db.seed('team', [
    { id: 'team-general', workspace_id: WS, is_private: false, created_at: '2026-01-01T00:00:00Z' },
    { id: 'team-private', workspace_id: WS, is_private: true, created_at: '2026-01-02T00:00:00Z' },
    { id: 'team-mine', workspace_id: WS, is_private: true, created_at: '2026-01-03T00:00:00Z' },
  ])
  db.seed('team_member', [
    { team_id: 'team-general', member_id: 'm-1' },
    { team_id: 'team-mine', member_id: 'm-1' },
  ])
  db.seed('ai_team_member', [
    { id: 'tm-captures', workspace_id: WS, team_id: 'team-general', name: 'Captures', is_system: true, system_key: 'captures', fronts_only: false, bot_character: 'triage', created_at: '2026-01-01T00:00:00Z' },
    { id: 'tm-mail', workspace_id: WS, team_id: 'team-general', name: 'Mail', is_system: true, system_key: 'mail', fronts_only: false, bot_character: 'mail', created_at: '2026-01-01T00:00:01Z' },
    { id: 'tm-prospecting', workspace_id: WS, team_id: 'team-general', name: 'Prospecting', is_system: true, system_key: 'prospecting', fronts_only: false, bot_character: 'scout', created_at: '2026-01-01T00:00:02Z' },
    { id: 'tm-writer', workspace_id: WS, team_id: 'team-general', name: 'Writer', is_system: false, system_key: null, fronts_only: false, bot_character: 'writer', created_at: '2026-01-05T00:00:00Z' },
    { id: 'tm-secret', workspace_id: WS, team_id: 'team-private', name: 'Secret', is_system: false, system_key: null, fronts_only: false, bot_character: 'nova', created_at: '2026-01-04T00:00:00Z' },
    { id: 'tm-other-ws', workspace_id: 'ws-2', team_id: 'team-x', name: 'Elsewhere', is_system: false, system_key: null, fronts_only: false, bot_character: 'ember', created_at: '2026-01-01T00:00:00Z' },
  ])
  return db
}

const client = (db: FakeSupabase) => db as unknown as SupabaseClient

/** A skill held, with its teammate embedded as skillHolderFor's `ai_team_member!inner(...)` read returns it. */
const hold = (db: FakeSupabase, mateId: string, skillId: string) => ({
  ai_team_member_id: mateId,
  skill_recipe_id: skillId,
  ai_team_member: db.rows('ai_team_member').find((m) => m.id === mateId) ?? null,
})
const skill = (id: string) => ({ type: 'run_skill', enabled: true, config: { skill_id: id } })

describe('parseFlowBotInput', () => {
  it('says nothing when the body names no bot', () => {
    expect(parseFlowBotInput({ name: 'x' })).toBeUndefined()
  })
  it('reads a teammate and a character', () => {
    expect(parseFlowBotInput({ ai_team_member_id: 'tm-1' })).toEqual({ kind: 'teammate', teammateId: 'tm-1' })
    expect(parseFlowBotInput({ bot_character: 'ember', bot_name: '  Brief   bot ' })).toEqual({
      kind: 'character',
      character: 'ember',
      name: 'Brief bot',
    })
  })
  it('refuses a clear: a loop always has a bot', () => {
    expect(parseFlowBotInput({ ai_team_member_id: null })).toBeInstanceOf(Error)
    expect(parseFlowBotInput({ ai_team_member_id: '' })).toBeInstanceOf(Error)
  })
  it('refuses a face that is not a character', () => {
    expect(parseFlowBotInput({ bot_character: 'not-a-bot' })).toBeInstanceOf(Error)
    // Shaped like a built bot's id, but no recipe (a body past the list's end).
    expect(parseFlowBotInput({ bot_character: 'xzzaaaaa' })).toBeInstanceOf(Error)
  })
  it('reads a built bot (Phase 6: Build one… in Its bot)', () => {
    const built = builtBotId({ body: 'dew', eyes: 'googly', worn: 'party' })!
    expect(parseFlowBotInput({ bot_character: built })).toEqual({ kind: 'character', character: built, name: null })
  })
  it('reads bot_new: always a new agent, with its name; refuses a bad value or a teammate too', () => {
    expect(parseFlowBotInput({ bot_new: true })).toEqual({ kind: 'new', name: null })
    expect(parseFlowBotInput({ bot_new: true, bot_name: '  Weekly   briefer ' })).toEqual({ kind: 'new', name: 'Weekly briefer' })
    // bot_new wins over a face sent with it: the face could name a teammate already wearing it.
    expect(parseFlowBotInput({ bot_new: true, bot_character: 'writer' })).toEqual({ kind: 'new', name: null })
    // false (or absent) is the old behaviour.
    expect(parseFlowBotInput({ bot_new: false, bot_character: 'ember' })).toEqual({ kind: 'character', character: 'ember', name: null })
    expect(parseFlowBotInput({ bot_new: 'yes' })).toBeInstanceOf(Error)
    expect(parseFlowBotInput({ bot_new: true, bot_name: 7 })).toBeInstanceOf(Error)
    expect(parseFlowBotInput({ bot_new: true, ai_team_member_id: 'tm-1' })).toBeInstanceOf(Error)
  })
  it('bounds a name', () => {
    expect(cleanBotName('a'.repeat(200))?.length).toBe(60)
    expect(cleanBotName('   ')).toBeNull()
  })
})

describe('mayFrontLoop (the trigger job rule)', () => {
  it('lets Captures front loops (Triage and Reconciler folded in, migration 318), never another area face or the Assistant', () => {
    expect(mayFrontLoop({ is_system: true, system_key: 'captures' })).toBe(true)
    for (const key of ['mail', 'prospecting', 'evals', 'crm', 'assistant', 'triage', 'reconciler']) {
      expect(mayFrontLoop({ is_system: true, system_key: key })).toBe(false)
    }
    expect(mayFrontLoop({ is_system: false, system_key: null })).toBe(true)
  })
  it('keeps a seeded loop on its own system teammate', () => {
    expect(mayFrontLoop({ is_system: true, system_key: 'mail' }, 'seed:triage')).toBe(false)
    expect(mayFrontLoop({ is_system: true, system_key: 'captures' }, 'seed:triage')).toBe(true)
    expect(mayFrontLoop({ is_system: true, system_key: 'captures' }, 'seed:reconcile')).toBe(true)
  })
})

describe('createWorkBot', () => {
  it('makes a fronts_only teammate on the anchor persona with propose-only limits', async () => {
    const db = world()
    const made = await createWorkBot(client(db), { workspaceId: WS, teamId: 'team-mine', name: null, character: 'ember', createdBy: USER })
    expect('teammate' in made).toBe(true)
    const row = db.rows('ai_team_member').find((r) => r.bot_character === 'ember' && r.workspace_id === WS)!
    expect(row).toMatchObject({
      fronts_only: true,
      role: null,
      agent_recipe_id: 'anchor',
      autonomy: 'propose',
      allowed_side_effects: ['read'],
      team_id: 'team-mine',
      created_by: USER,
      // No name given: the catalogue's name for the face, never a hard-coded one.
      name: characterName('ember'),
    })
  })

  it('fails closed without the anchor (migration 302 missing)', async () => {
    const db = makeFakeSupabase()
    const made = await createWorkBot(client(db), { workspaceId: WS, teamId: 't', name: 'x', character: 'ember', createdBy: USER })
    expect(made).toMatchObject({ status: 500 })
    expect(db.rows('ai_team_member')).toEqual([])
  })
})

describe('workBotTeamFor', () => {
  it('uses the flow team when the person is on it, else their first team', async () => {
    const db = world()
    expect(await workBotTeamFor(client(db), { workspaceId: WS, userId: USER, flowTeamId: 'team-mine' })).toBe('team-mine')
    expect(await workBotTeamFor(client(db), { workspaceId: WS, userId: USER, flowTeamId: 'team-private' })).toBe('team-general')
    expect(await workBotTeamFor(client(db), { workspaceId: WS, userId: USER })).toBe('team-general')
  })

  it('skips the editor’s private teams the run-as member is not on', async () => {
    const db = world()
    db.seed('member', [{ id: 'm-alice', workspace_id: WS, user_id: 'alice', role: 'member' }])
    // The editor's only team is private, and Alice isn't on it: an open team instead.
    db.seed('team_member', [{ team_id: 'team-private', member_id: 'm-owner' }])
    expect(
      await workBotTeamFor(client(db), { workspaceId: WS, userId: 'owner-1', flowTeamId: 'team-private', runAsUserId: 'alice' }),
    ).toBe('team-general')
    // Alice on the private team too: the flow's team is fine.
    db.seed('team_member', [{ team_id: 'team-private', member_id: 'm-alice' }])
    expect(
      await workBotTeamFor(client(db), { workspaceId: WS, userId: 'owner-1', flowTeamId: 'team-private', runAsUserId: 'alice' }),
    ).toBe('team-private')
  })
})

describe('defaultFlowBot: skill holder, then Captures for verdict, then a new work bot', () => {
  it('names the teammate that holds the loop skill', async () => {
    const db = world()
    db.seed('ai_team_member_skill', [hold(db, 'tm-writer', 'skill-held')])
    const r = await defaultFlowBot(client(db), { workspaceId: WS, userId: USER, actions: [skill('skill-held')] })
    expect(r).toEqual({ teammateId: 'tm-writer', created: false })
  })

  it('skips a skill holder on a private team the person is not on', async () => {
    const db = world()
    db.seed('ai_team_member_skill', [hold(db, 'tm-secret', 'skill-verdict')])
    const r = await defaultFlowBot(client(db), { workspaceId: WS, userId: USER, actions: [skill('skill-verdict')] })
    expect(r).toEqual({ teammateId: 'tm-captures', created: false })
  })

  it('gives a verdict loop with no holder to Captures', async () => {
    const db = world()
    const r = await defaultFlowBot(client(db), { workspaceId: WS, userId: USER, actions: [skill('skill-verdict')] })
    expect(r).toEqual({ teammateId: 'tm-captures', created: false })
  })

  it('makes a work bot for any other loop, on the first free face, named after that face', async () => {
    const db = world()
    const r = await defaultFlowBot(client(db), {
      workspaceId: WS,
      userId: USER,
      flowTeamId: null,
      actions: [skill('skill-prose')],
    })
    expect(r).toMatchObject({ created: true })
    const made = db.rows('ai_team_member').find((m) => m.id === (r as { teammateId: string }).teammateId)!
    // The faces this workspace wears (another workspace's Ember doesn't count).
    const worn = new Set(['triage', 'mail', 'scout', 'writer', 'nova'])
    const face = FREE_BOT_CHARACTER_ORDER.find((c) => !worn.has(c))!
    expect(made.bot_character).toBe(face)
    // Pick Ember, meet Ember: the catalogue's name, never the loop's.
    expect(made).toMatchObject({ name: characterName(face), fronts_only: true, team_id: 'team-general' })
  })

  it('keeps a seeded loop on its system teammate', async () => {
    const db = world()
    const r = await defaultFlowBot(client(db), { workspaceId: WS, userId: USER, seedKey: 'seed:reconcile', actions: [] })
    expect(r).toEqual({ teammateId: 'tm-captures', created: false })
  })
})

describe('resolveFlowBotChoice', () => {
  const base = { workspaceId: WS, userId: USER }

  it('points at a teammate the editor can reach', async () => {
    const r = await resolveFlowBotChoice(client(world()), { ...base, choice: { kind: 'teammate', teammateId: 'tm-writer' } })
    expect(r).toEqual({ teammateId: 'tm-writer', created: false })
  })

  it('refuses another workspace, an area face that fronts no loops, and an unreachable private team', async () => {
    const db = world()
    for (const id of ['tm-other-ws', 'tm-prospecting', 'tm-secret']) {
      const r = await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'teammate', teammateId: id } })
      expect(r).toMatchObject({ status: 400 })
    }
  })

  it('points a worn face at its wearer, and makes a work bot for a free one', async () => {
    const db = world()
    expect(await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'character', character: 'writer', name: null } })).toEqual({
      teammateId: 'tm-writer',
      created: false,
    })
    // Nova is worn only on a private team the editor isn't on: a new bot, not the hidden one.
    const r = await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'character', character: 'nova', name: 'Nova brief' } })
    expect(r).toMatchObject({ created: true })
    const made = db.rows('ai_team_member').find((m) => m.id === (r as { teammateId: string }).teammateId)!
    expect(made).toMatchObject({ name: 'Nova brief', bot_character: 'nova', fronts_only: true })
  })

  it('a new agent (bot_new) is always made, on a free face, with the name typed: it never reuses a teammate', async () => {
    const db = world()
    const before = db.rows('ai_team_member').length
    const r = await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'new', name: 'Weekly briefer' } })
    expect(r).toMatchObject({ created: true })
    expect(db.rows('ai_team_member')).toHaveLength(before + 1)
    const made = db.rows('ai_team_member').find((m) => m.id === (r as { teammateId: string }).teammateId)!
    const worn = new Set(['triage', 'mail', 'scout', 'writer', 'nova'])
    expect(made).toMatchObject({ name: 'Weekly briefer', fronts_only: true, bot_character: FREE_BOT_CHARACTER_ORDER.find((c) => !worn.has(c)) })
  })

  it('a new agent is still made when every free face is worn: it shares a face, never a teammate', async () => {
    const db = world()
    const worn = db.rows('ai_team_member').filter((m) => m.workspace_id === WS).length
    db.seed(
      'ai_team_member',
      FREE_BOT_CHARACTER_ORDER.map((face, i) => ({
        id: `tm-fill-${i}`,
        workspace_id: WS,
        team_id: 'team-general',
        name: `Fill ${i}`,
        is_system: false,
        system_key: null,
        fronts_only: false,
        bot_character: face,
        agent_recipe_id: null,
        created_at: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
      })),
    )
    expect(db.rows('ai_team_member').filter((m) => m.workspace_id === WS).length).toBeGreaterThan(worn)
    const r = await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'new', name: 'Briefer' } })
    expect(r).toMatchObject({ created: true })
    const made = db.rows('ai_team_member').find((m) => m.id === (r as { teammateId: string }).teammateId)!
    expect(made.id).not.toMatch(/^tm-fill-/)
    expect(made).toMatchObject({ name: 'Briefer', fronts_only: true, bot_character: FREE_BOT_CHARACTER_ORDER[0] })
  })

  it('names an unnamed work bot after its character, not the loop', async () => {
    const db = world()
    const r = await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'character', character: 'ember', name: null } })
    expect(r).toMatchObject({ created: true })
    const made = db.rows('ai_team_member').find((m) => m.id === (r as { teammateId: string }).teammateId)!
    expect(made).toMatchObject({ name: characterName('ember'), bot_character: 'ember' })
  })

  it('puts a work bot made by an editor in a team the loop’s run-as member can reach', async () => {
    const db = world()
    // Alice runs the loop and sits only on team-general; the editor's oldest
    // team the run-as member can reach is team-general, never private team-mine.
    db.seed('member', [{ id: 'm-alice', workspace_id: WS, user_id: 'alice', role: 'member' }])
    db.seed('team_member', [{ team_id: 'team-general', member_id: 'm-alice' }])
    const r = await resolveFlowBotChoice(client(db), {
      ...base,
      flowTeamId: 'team-mine',
      runAsUserId: 'alice',
      choice: { kind: 'character', character: 'ember', name: null },
    })
    const made = db.rows('ai_team_member').find((m) => m.id === (r as { teammateId: string }).teammateId)!
    expect(made.team_id).toBe('team-general')
  })
})

describe('flowBotRefusal', () => {
  it('turns the trigger refusal into a message, and nothing else', () => {
    expect(flowBotRefusal({ code: '23514', message: 'that bot is on a private team you are not on' })).toBe(
      'that bot is on a private team you are not on',
    )
    expect(flowBotRefusal({ code: '42501', message: 'rls' })).toBeNull()
    expect(flowBotRefusal(null)).toBeNull()
  })
})

describe('retireWorkBotIfUnused (a re-pick or a loop delete never strands a face)', () => {
  const workBot = { id: 'wb-1', workspace_id: WS, team_id: 'team-general', name: 'Ember', is_system: false, system_key: null, fronts_only: true, bot_character: 'ember' }

  it('deletes a work bot nothing needs any more', async () => {
    const db = world()
    db.seed('ai_team_member', [workBot])
    expect(await retireWorkBotIfUnused(client(db), { workspaceId: WS, teammateId: 'wb-1' })).toBe(true)
    expect(db.rows('ai_team_member').some((m) => m.id === 'wb-1')).toBe(false)
  })

  it('keeps one that still fronts a loop, has a chat, a memory or a run', async () => {
    for (const [table, row] of [
      ['flow', { id: 'f1', workspace_id: WS, ai_team_member_id: 'wb-1' }],
      ['chat_conversations', { id: 'c1', user_id: 'someone', ai_team_member_id: 'wb-1' }],
      ['agent_memory', { id: 'am1', workspace_id: WS, ai_team_member_id: 'wb-1' }],
      ['tracked_job', { id: 'j1', workspace_id: WS, ai_team_member_id: 'wb-1' }],
    ] as const) {
      const db = world()
      db.seed('ai_team_member', [workBot])
      db.seed(table, [row])
      expect(await retireWorkBotIfUnused(client(db), { workspaceId: WS, teammateId: 'wb-1' })).toBe(false)
      expect(db.rows('ai_team_member').some((m) => m.id === 'wb-1')).toBe(true)
    }
  })

  it('keeps a custom agent’s work bot (Phase 6), but retires a loop’s on the anchor', async () => {
    let db = world()
    db.seed('recipe', [{ id: 'agent-x', slug: null, category: 'agent', workspace_id: WS, is_system: false }])
    db.seed('ai_team_member', [{ ...workBot, agent_recipe_id: 'agent-x' }])
    expect(await retireWorkBotIfUnused(client(db), { workspaceId: WS, teammateId: 'wb-1' })).toBe(false)
    expect(db.rows('ai_team_member').some((m) => m.id === 'wb-1')).toBe(true)
    db = world()
    db.seed('ai_team_member', [{ ...workBot, agent_recipe_id: 'anchor' }])
    expect(await retireWorkBotIfUnused(client(db), { workspaceId: WS, teammateId: 'wb-1' })).toBe(true)
  })

  it('never touches a full teammate', async () => {
    const db = world()
    expect(await retireWorkBotIfUnused(client(db), { workspaceId: WS, teammateId: 'tm-writer' })).toBe(false)
    expect(db.rows('ai_team_member').some((m) => m.id === 'tm-writer')).toBe(true)
  })
})

describe('othersTalkTo', () => {
  it('counts only other people’s threads with the bot', async () => {
    const db = world()
    db.seed('chat_conversations', [{ id: 'c1', user_id: USER, ai_team_member_id: 'wb-1' }])
    expect(await othersTalkTo(client(db), { teammateId: 'wb-1', userId: USER })).toBe(false)
    db.seed('chat_conversations', [{ id: 'c2', user_id: 'someone-else', ai_team_member_id: 'wb-1' }])
    expect(await othersTalkTo(client(db), { teammateId: 'wb-1', userId: USER })).toBe(true)
  })
})

describe('backfillFlowBot: skill holder, then Captures for verdict, then a new work bot', () => {
  const flow = (id: string, actions: unknown[], over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: WS,
    team_id: null,
    name: id,
    created_by: USER,
    seed_key: null,
    actions: actions as never,
    ...over,
  })

  function withFlows(db: FakeSupabase, flows: Array<Record<string, unknown>>) {
    db.seed('flow', flows.map((f) => ({ ...f, ai_team_member_id: f.ai_team_member_id ?? null })))
    return db
  }

  it('writes each loop in the plan order', async () => {
    const db = world()
    db.seed('ai_team_member_skill', [hold(db, 'tm-writer', 'skill-held')])
    const flows = [flow('held', [skill('skill-held')]), flow('verdict', [skill('skill-verdict')]), flow('prose', [skill('skill-prose')])]
    withFlows(db, flows)
    const out = []
    for (const f of flows) out.push(await backfillFlowBot(client(db), f, { execute: true }))
    expect(out[0]).toMatchObject({ kind: 'set', teammateId: 'tm-writer', created: false })
    expect(out[1]).toMatchObject({ kind: 'set', teammateId: 'tm-captures', created: false })
    expect(out[2]).toMatchObject({ kind: 'set', created: true })
    const byId = new Map(db.rows('flow').map((f) => [f.id, f.ai_team_member_id]))
    expect(byId.get('held')).toBe('tm-writer')
    expect(byId.get('verdict')).toBe('tm-captures')
    const bot = db.rows('ai_team_member').find((m) => m.id === byId.get('prose'))!
    expect(bot).toMatchObject({ name: characterName(bot.bot_character as never), fronts_only: true })
  })

  it('never overrides a loop that already has a bot, and drops the bot it made', async () => {
    const db = world()
    const f = flow('chosen', [skill('skill-prose')], { ai_team_member_id: 'tm-writer' })
    withFlows(db, [f])
    const before = db.rows('ai_team_member').length
    const out = await backfillFlowBot(client(db), { ...f, ai_team_member_id: undefined } as never, { execute: true })
    expect(out).toMatchObject({ kind: 'skipped' })
    expect(db.rows('flow')[0].ai_team_member_id).toBe('tm-writer')
    expect(db.rows('ai_team_member').length).toBe(before)
  })

  it('makes nothing on a dry run', async () => {
    const db = world()
    const f = flow('prose', [skill('skill-prose')])
    withFlows(db, [f])
    const before = db.rows('ai_team_member').length
    expect(await backfillFlowBot(client(db), f, { execute: false })).toMatchObject({ kind: 'would-set', plan: 'a new work bot' })
    expect(db.rows('ai_team_member').length).toBe(before)
    expect(db.rows('flow')[0].ai_team_member_id).toBeNull()
  })

  it('reaches as the run-as member: their private-team holder counts, another person’s does not', async () => {
    const db = world()
    db.seed('ai_team_member_skill', [hold(db, 'tm-secret', 'skill-held')])
    const f = flow('held', [skill('skill-held')])
    withFlows(db, [f])
    expect(await backfillFlowBot(client(db), f, { execute: false })).toMatchObject({ plan: 'a new work bot' })
    db.seed('team_member', [{ team_id: 'team-private', member_id: 'm-1' }])
    expect(await backfillFlowBot(client(db), f, { execute: false })).toMatchObject({ plan: 'skill holder', teammateId: 'tm-secret' })
  })
})

describe('suggestFlowBot (the editor’s preselection): the default, without making anything', () => {
  it('suggests the holder, Captures, else a free face, and makes no row', async () => {
    const db = world()
    db.seed('ai_team_member_skill', [hold(db, 'tm-writer', 'skill-held')])
    const before = db.rows('ai_team_member').length
    expect(await suggestFlowBot(client(db), { workspaceId: WS, userId: USER, actions: [skill('skill-held')] })).toEqual({
      kind: 'teammate',
      teammateId: 'tm-writer',
    })
    expect(await suggestFlowBot(client(db), { workspaceId: WS, userId: USER, actions: [skill('skill-verdict')] })).toEqual({
      kind: 'teammate',
      teammateId: 'tm-captures',
    })
    const free = await suggestFlowBot(client(db), { workspaceId: WS, userId: USER, actions: [] })
    expect(free.kind).toBe('character')
    expect(db.rows('ai_team_member').length).toBe(before)
  })
})

describe('listFlowBotOptions (what "Its bot" offers)', () => {
  it('lists the bots the person can reach that may front loops, with their loops, and the free faces', async () => {
    const db = world()
    db.seed('flow', [
      { id: 'f1', workspace_id: WS, name: 'Weekly brief', ai_team_member_id: 'tm-writer', created_at: '1' },
      { id: 'f2', workspace_id: WS, name: 'My triage', ai_team_member_id: 'tm-captures', created_at: '2' },
      { id: 'f3', workspace_id: 'ws-2', name: 'Not here', ai_team_member_id: 'tm-other-ws', created_at: '3' },
    ])
    const out = await listFlowBotOptions(client(db), client(db), { workspaceId: WS, userId: USER })
    // Mail and Prospecting can't front loops; Secret is on a private team the person isn't on; another workspace's never shows.
    expect(out.teammates.map((t) => [t.id, t.fronts])).toEqual([
      ['tm-captures', ['My triage']],
      ['tm-writer', ['Weekly brief']],
    ])
    const worn = new Set(['triage', 'mail', 'scout', 'writer', 'nova'])
    expect(out.free_characters).toEqual(FREE_BOT_CHARACTER_ORDER.filter((c) => !worn.has(c)))
    expect(out.free_characters).not.toContain('chat')
  })
})


describe('a rebuilt loop takes its spare agent back, never a duplicate (GEN-1168)', () => {
  /** A loop's agent no loop points at: its loop was deleted, but it has a chat, so it wasn't retired. */
  const spare = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: WS,
    team_id: 'team-general',
    name: 'Weekly briefer',
    is_system: false,
    system_key: null,
    fronts_only: true,
    bot_character: 'sprout',
    agent_recipe_id: 'anchor',
    created_at: '2026-01-06T00:00:00Z',
    ...over,
  })
  const base = { workspaceId: WS, userId: USER }

  it('a new agent named like a spare takes the oldest one back, whatever its face', async () => {
    const db = world()
    db.seed('ai_team_member', [spare('weekly-new', { created_at: '2026-01-08T00:00:00Z' }), spare('weekly-old', { created_at: '2026-01-07T00:00:00Z' })])
    const before = db.rows('ai_team_member').length
    expect(await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'new', name: ' weekly  BRIEFER ' } })).toEqual({
      teammateId: 'weekly-old',
      created: false,
    })
    expect(db.rows('ai_team_member')).toHaveLength(before)
  })

  it('another name, or none, is a new agent; so is the default: an unrelated loop never inherits a spare', async () => {
    const db = world()
    db.seed('ai_team_member', [spare('weekly')])
    expect(await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'new', name: 'Daily briefer' } })).toMatchObject({ created: true })
    expect(await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'new', name: null } })).toMatchObject({ created: true })
    expect(await defaultFlowBot(client(db), { ...base, actions: [skill('skill-prose')] })).toMatchObject({ created: true })
    expect((await suggestFlowBot(client(db), { ...base, actions: [] })).kind).toBe('character')
  })

  it('never takes one that still fronts a loop, one out of reach, or a custom agent’s work agent', async () => {
    const db = world()
    db.seed('recipe', [{ id: 'custom-agent', slug: 'scout', category: 'agent', workspace_id: WS, is_system: false }])
    db.seed('ai_team_member', [
      spare('busy'),
      spare('hidden', { team_id: 'team-private' }),
      spare('custom', { agent_recipe_id: 'custom-agent' }),
    ])
    db.seed('flow', [{ id: 'loop-1', workspace_id: WS, name: 'Daily', ai_team_member_id: 'busy' }])
    expect(await spareLoopBot(client(db), { ...base, name: 'Weekly briefer' })).toBeNull()
  })

  it('a spare must suit the run-as member too', async () => {
    const db = world()
    db.seed('member', [{ id: 'm-runner', workspace_id: WS, user_id: 'runner', role: 'member' }])
    db.seed('ai_team_member', [spare('mine-only', { team_id: 'team-mine' })])
    expect(await spareLoopBot(client(db), { ...base, name: 'Weekly briefer' })).toMatchObject({ id: 'mine-only' })
    expect(await spareLoopBot(client(db), { ...base, name: 'Weekly briefer', runAsUserId: 'runner' })).toBeNull()
  })

  it('picking its face takes it back too (as before: a teammate already wearing a face fronts the loop)', async () => {
    const db = world()
    db.seed('ai_team_member', [spare('weekly')])
    expect(await resolveFlowBotChoice(client(db), { ...base, choice: { kind: 'character', character: 'sprout', name: null } })).toEqual({
      teammateId: 'weekly',
      created: false,
    })
  })
})
