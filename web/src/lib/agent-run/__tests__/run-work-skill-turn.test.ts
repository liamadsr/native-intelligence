/**
 * A skill picked in a work run's chat (bots v4): the turn's token carries it
 * (`skillId`, with `chat`), and ceilingForWorkRunTurn adds the skill's tools
 * to that turn, the spec advertising and the tool route enforcing the same
 * set. Only tools the skill itself selects (its categories minus its disabled
 * tools, never the core set), only in the RUN'S OWN CLASSES (drafting for an
 * attempted run, read and internal-write for a person-started one: a skill
 * never gives a run more than the run itself may do, and a run's tool calls
 * have no approval step), never past the run's bot's ATTENDED chat ceiling
 * (the edition ∩ its persona, narrowed by its bounds), never past a
 * delegating chat's bound, never on a non-chat token, a run with no bot, or a
 * skill the person can't use here. A skill that selects no tools adds none.
 */
import { describe, it, expect } from 'vitest'
import {
  ceilingForWorkRun,
  ceilingForWorkRunTurn,
  computeDraftingCeiling,
  computeWorkRunCeiling,
  skillChatTurnTools,
  type WorkRunRow,
} from '../run-work-spec-rebuild'
import { computeToolCeiling } from '@/lib/ai/tool-ceiling-core'
import { getToolNamesForCategories, getToolSideEffect } from '@/lib/ai/tool-registry'
import { composeTeammateChatCeiling, type TeammateChatBounds } from '@/lib/chat/chat-ceiling'
import { computeEditionToolCeiling, resolveWorkspaceEdition } from '@/lib/editions'

interface Skill {
  id: string
  agent_config: unknown
  workspace_id: string | null
  is_system: boolean | null
}

/** A service client faking the reads the turn ceiling makes: the skill, the bot, the workspace, its loops. */
function client(opts: { skill: Skill | null; bot: Record<string, unknown> | null }) {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.in = () => c
    c.limit = () => c
    c.maybeSingle = async () => ({
      data: table === 'recipe' ? opts.skill : table === 'ai_team_member' ? opts.bot : null,
      error: null,
    })
    c.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
    return c
  }
  return { from: (t: string) => chain(t) } as never
}

const WS = 'ws-1'
/** A system bot whose bounds admit reads and internal writes (no persona selection). */
const BOT = {
  is_system: true,
  team_id: null,
  fronts_only: false,
  allowed_side_effects: ['read', 'internal-write'],
  tool_allowlist: null,
  agent: null,
  system_key: null,
  role: null,
}
const ACTIONS_SKILL: Skill = { id: 'skill-actions', agent_config: { enabled_tools: ['actions'] }, workspace_id: WS, is_system: false }
/** An attempted run: the drafting ceiling, narrowed to its bot. */
const RUN: WorkRunRow = {
  id: 'run-1',
  kind: 'workspace',
  origin: 'attempt',
  ai_team_member_id: 'bot-1',
  teammate: { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null },
}
const CHAT = { workspaceId: WS, userId: 'user-1', chat: true as const }

/** The bot's attended chat ceiling, as chat-ceiling.ts composes it for these bounds. */
async function botCeiling(allowed: string[] = BOT.allowed_side_effects): Promise<Set<string>> {
  const edition = computeEditionToolCeiling((await resolveWorkspaceEdition(client({ skill: null, bot: null }), WS)).edition)
  const bounds: TeammateChatBounds = { allowed_side_effects: allowed, tool_allowlist: null, agentConfig: null }
  return composeTeammateChatCeiling(edition, bounds)
}

/** Every class a bot can be allowed: its own chat may push, delete and automate. */
const EVERY_CLASS = ['read', 'internal-write', 'external-write', 'automation-write', 'delete']

describe('a skill picked in a work run’s chat', () => {
  it('on an ATTEMPTED run, a skill adds nothing beyond the drafting profile: no board write, whatever the bot may do', async () => {
    const supabase = client({ skill: ACTIONS_SKILL, bot: BOT })
    const runOwn = ceilingForWorkRun(RUN.origin, RUN.teammate, RUN.chat_ceiling)
    const drafting = computeDraftingCeiling()
    const turn = await ceilingForWorkRunTurn(supabase, RUN, { ...CHAT, skillId: ACTIONS_SKILL.id })
    // The bot's own chat may write to the board, and the skill selects those tools…
    const bot = await botCeiling()
    expect(bot.has('update_action')).toBe(true)
    expect(getToolNamesForCategories(['actions'])).toContain('update_action')
    // …but the run is reading and drafting, so the turn is too.
    for (const name of turn) {
      if (runOwn.has(name)) continue
      expect(drafting.has(name), name).toBe(true)
    }
    for (const name of ['create_action', 'update_action', 'complete_action', 'create_actions_batch', 'create_label', 'update_label', 'dismiss_proposal', 'dismiss_action', 'confirm_action', 'reorder_actions']) {
      expect(turn.has(name), name).toBe(false)
    }
    // The run's own ceiling stays (a superset of it), and never the native tools.
    for (const name of runOwn) expect(turn.has(name), name).toBe(true)
    expect(turn.has('search_tools')).toBe(false)
    expect(turn.has('ask_user')).toBe(false)
    // The same straight from the skill's tools.
    const tools = await skillChatTurnTools(supabase, { workspaceId: WS, userId: 'user-1', teammateId: 'bot-1', skillId: ACTIONS_SKILL.id, origin: 'attempt' })
    for (const name of tools) expect(drafting.has(name), name).toBe(true)
    expect(tools.has('update_action')).toBe(false)
  })

  it('on a run a person started, a skill stays within reads and internal writes, its own selection and the bot’s chat', async () => {
    const started: WorkRunRow = { ...RUN, origin: 'user', teammate: null }
    const supabase = client({ skill: ACTIONS_SKILL, bot: BOT })
    const tools = await skillChatTurnTools(supabase, { workspaceId: WS, userId: 'user-1', teammateId: 'bot-1', skillId: ACTIONS_SKILL.id, origin: 'user' })
    const bot = await botCeiling()
    const wanted = new Set(getToolNamesForCategories(['actions']))
    const classes = computeWorkRunCeiling()
    expect(tools.has('update_action')).toBe(true)
    for (const name of tools) {
      expect(wanted.has(name), name).toBe(true)
      expect(bot.has(name), name).toBe(true)
      expect(classes.has(name), name).toBe(true)
      expect(['read', 'internal-write']).toContain(getToolSideEffect(name))
    }
    // Never more than the run itself may do: the turn is the run's own ceiling.
    const turn = await ceilingForWorkRunTurn(supabase, started, { ...CHAT, skillId: ACTIONS_SKILL.id })
    const runOwn = ceilingForWorkRun(started.origin, started.teammate, started.chat_ceiling)
    expect([...turn].sort()).toEqual([...runOwn].sort())
  })

  it('a bot whose bounds only read gets no write from the skill', async () => {
    const readOnly = { ...BOT, allowed_side_effects: ['read'] }
    const tools = await skillChatTurnTools(client({ skill: ACTIONS_SKILL, bot: readOnly }), {
      workspaceId: WS,
      userId: 'user-1',
      teammateId: 'bot-1',
      skillId: ACTIONS_SKILL.id,
      origin: 'user',
    })
    for (const name of tools) expect(getToolSideEffect(name), name).toBe('read')
    expect(tools.has('update_action')).toBe(false)
  })

  it('adds nothing on a token without the chat claim, on a run with no bot, or for a bot that’s gone', async () => {
    const supabase = client({ skill: ACTIONS_SKILL, bot: BOT })
    const runOwn = ceilingForWorkRun(RUN.origin, RUN.teammate, RUN.chat_ceiling)
    const notChat = await ceilingForWorkRunTurn(supabase, RUN, { workspaceId: WS, userId: 'user-1', skillId: ACTIONS_SKILL.id })
    expect([...notChat].sort()).toEqual([...runOwn].sort())
    const noBot = await ceilingForWorkRunTurn(supabase, { ...RUN, ai_team_member_id: null }, { ...CHAT, skillId: ACTIONS_SKILL.id })
    expect(noBot.has('update_action')).toBe(false)
    const gone = await ceilingForWorkRunTurn(client({ skill: ACTIONS_SKILL, bot: null }), RUN, { ...CHAT, skillId: ACTIONS_SKILL.id })
    expect(gone.has('update_action')).toBe(false)
  })

  it('adds nothing for another workspace’s skill, a missing one, or one that selects no tools', async () => {
    const args = { workspaceId: WS, userId: 'user-1', teammateId: 'bot-1', skillId: 'skill-x', origin: 'user' }
    expect((await skillChatTurnTools(client({ skill: { ...ACTIONS_SKILL, workspace_id: 'ws-other' }, bot: BOT }), args)).size).toBe(0)
    expect((await skillChatTurnTools(client({ skill: null, bot: BOT }), args)).size).toBe(0)
    expect((await skillChatTurnTools(client({ skill: { ...ACTIONS_SKILL, agent_config: null }, bot: BOT }), args)).size).toBe(0)
    expect((await skillChatTurnTools(client({ skill: { ...ACTIONS_SKILL, agent_config: { enabled_tools: [] } }, bot: BOT }), args)).size).toBe(0)
    // A system skill is fine.
    expect((await skillChatTurnTools(client({ skill: { ...ACTIONS_SKILL, workspace_id: null, is_system: true }, bot: BOT }), args)).size).toBeGreaterThan(0)
  })

  it('a bot allowed external writes still gets only read and internal writes from a skill: never push, delete or automation', async () => {
    const everything = { ...BOT, allowed_side_effects: EVERY_CLASS }
    const bot = await botCeiling(EVERY_CLASS)
    // The bot's own chat may push to Linear and delete actions…
    expect(bot.has('push_action_to_linear')).toBe(true)
    expect(bot.has('delete_action')).toBe(true)
    const wide: Skill = { ...ACTIONS_SKILL, agent_config: { enabled_tools: ['actions', 'calendar', 'integrations', 'crm', 'email'] } }
    const tools = await skillChatTurnTools(client({ skill: wide, bot: everything }), {
      workspaceId: WS,
      userId: 'user-1',
      teammateId: 'bot-1',
      skillId: wide.id,
      origin: 'user',
    })
    // …but a skill on a run adds none of that: a run's tool calls have no approval step.
    expect(tools.size).toBeGreaterThan(0)
    for (const name of tools) expect(['read', 'internal-write'], name).toContain(getToolSideEffect(name))
    for (const name of ['push_action_to_linear', 'push_action_to_jira', 'push_action_to_asana', 'delete_action', 'accept_proposal', 'start_helper', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event']) {
      expect(tools.has(name), name).toBe(false)
    }
    expect(tools.has('update_action')).toBe(true)

    // The same through the turn's ceiling (what the spec advertises and the tool route enforces).
    const turn = await ceilingForWorkRunTurn(client({ skill: wide, bot: everything }), RUN, { ...CHAT, skillId: wide.id })
    const runOwn = ceilingForWorkRun(RUN.origin, RUN.teammate, RUN.chat_ceiling)
    for (const name of turn) {
      if (runOwn.has(name)) continue
      expect(['read', 'internal-write'], name).toContain(getToolSideEffect(name))
    }
    expect(turn.has('push_action_to_linear')).toBe(false)
    expect(turn.has('delete_action')).toBe(false)
  })

  it('a calendar-only skill that disables the core action tools adds none of them (no core tools ride along)', async () => {
    const calendar: Skill = {
      ...ACTIONS_SKILL,
      id: 'skill-calendar',
      agent_config: { enabled_tools: ['calendar'], disabled_tools: ['create_action', 'update_action', 'complete_action'] },
    }
    // What computeToolCeiling would have handed it: the core action tools, disabled or not.
    expect(computeToolCeiling(['calendar'], ['create_action', 'update_action', 'complete_action'])!.has('create_action')).toBe(true)

    const tools = await skillChatTurnTools(client({ skill: calendar, bot: { ...BOT, allowed_side_effects: EVERY_CLASS } }), {
      workspaceId: WS,
      userId: 'user-1',
      teammateId: 'bot-1',
      skillId: calendar.id,
      origin: 'user',
    })
    for (const name of ['create_action', 'update_action', 'complete_action', 'list_actions', 'find', 'get_dashboard_summary']) {
      expect(tools.has(name), name).toBe(false)
    }
    // Only the calendar's own tools, and of those only what a run may call (reads and its own offers' withdrawal:
    // no event writes, no working-hours change, no time offered or booked).
    const calendarTools = new Set(getToolNamesForCategories(['calendar']))
    for (const name of tools) expect(calendarTools.has(name), name).toBe(true)
    expect([...tools]).toEqual(['get_calendar_events', 'find_times', 'get_working_hours', 'list_time_offers', 'withdraw_time_offer', 'list_booking_links'])

    // A tool the skill disables stays out even when its category is selected.
    const actionsNoUpdate: Skill = { ...ACTIONS_SKILL, agent_config: { enabled_tools: ['actions'], disabled_tools: ['update_action'] } }
    const narrowed = await skillChatTurnTools(client({ skill: actionsNoUpdate, bot: BOT }), {
      workspaceId: WS,
      userId: 'user-1',
      teammateId: 'bot-1',
      skillId: actionsNoUpdate.id,
      origin: 'user',
    })
    expect(narrowed.has('update_action')).toBe(false)
    expect(narrowed.has('create_action')).toBe(true)
  })

  it('on work a chat handed over, stays within that chat’s bound', async () => {
    const handed: WorkRunRow = { ...RUN, origin: 'chat', chat_ceiling: ['list_actions', 'get_action'] }
    const turn = await ceilingForWorkRunTurn(client({ skill: ACTIONS_SKILL, bot: BOT }), handed, { ...CHAT, skillId: ACTIONS_SKILL.id })
    for (const name of turn) expect(['list_actions', 'get_action'], name).toContain(name)
    expect(turn.has('update_action')).toBe(false)
  })
})
