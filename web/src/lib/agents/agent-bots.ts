/**
 * The bots on an agent, and the skills they always check (docs/plans/bots-v4.md,
 * Phase B1, decision 11). Server-only: every helper takes the SERVICE client,
 * after the route has checked who may do what (editable-fields.ts).
 *
 * The bots on an agent are the workspace's teammates built on its persona
 * (`ai_team_member.agent_recipe_id`): its full teammates and its work bot.
 * Never a system teammate (it is its own agent) and never a loop's work bot
 * (it is built on the work-bot anchor, which no route edits as an agent).
 *
 * The skills an agent always checks stay stored per bot
 * (`ai_team_member_skill`), because every reader looks there: the prompt
 * (loadAgentPersona) and loop routing (skillHolderFor). The editor saves the
 * agent's list to every bot on it, and a new bot on the agent starts with it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_PINNED_SKILLS, isOwnerOrAdmin, isPinnableSkill, type SkillRecipeFacts } from './editable-fields'

/** A bot on an agent, with the columns the editor and its routes read. */
export interface AgentBotRow {
  id: string
  workspace_id: string
  name: string
  team_id: string | null
  bot_character: string | null
  /** The voice it chose (migration 308), or null for Automatic: its own, never the agent's. */
  voice?: string | null
  is_system: boolean
  system_key: string | null
  fronts_only: boolean
  role: string | null
  autonomy: string | null
  allowed_side_effects: string[] | null
  agent_recipe_id: string
  created_at: string | null
}

export const AGENT_BOT_COLUMNS =
  'id, workspace_id, name, team_id, bot_character, voice, is_system, system_key, fronts_only, role, autonomy, allowed_side_effects, agent_recipe_id, created_at'

/** Every bot built on `agentId` in the workspace, oldest first (private teams included). Throws on a failed read. */
export async function listAgentBots(service: SupabaseClient, args: { workspaceId: string; agentId: string }): Promise<AgentBotRow[]> {
  const { data, error } = await service
    .from('ai_team_member')
    .select(AGENT_BOT_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('agent_recipe_id', args.agentId)
    // NOT NULL DEFAULT false (migration 280): the same rows as `= false`.
    .neq('is_system', true)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`agent teammates read failed: ${error.message}`)
  return (data ?? []) as AgentBotRow[]
}

/** Whether any bot is built on the agent in the workspace. Throws on a failed read. */
export async function agentHasBots(service: SupabaseClient, args: { workspaceId: string; agentId: string }): Promise<boolean> {
  return (await listAgentBots(service, args)).length > 0
}

/** Each bot's skills, in order. Throws on a failed read. */
export async function skillIdsByBot(service: SupabaseClient, botIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (botIds.length === 0) return out
  const { data, error } = await service
    .from('ai_team_member_skill')
    .select('ai_team_member_id, skill_recipe_id, sort_order')
    .in('ai_team_member_id', [...botIds])
  if (error) throw new Error(`teammate skills read failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ ai_team_member_id: string; skill_recipe_id: string; sort_order: number | null }>
  for (const id of botIds) {
    out.set(
      id,
      rows
        .filter((r) => r.ai_team_member_id === id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((r) => r.skill_recipe_id),
    )
  }
  return out
}

/**
 * The skills a new bot on the agent starts with: its oldest bot's (the editor
 * keeps them the same on every bot), leaving out `excludeId` (the new bot
 * itself). None for an agent with no other bot.
 */
export async function agentSkillIds(
  service: SupabaseClient,
  args: { workspaceId: string; agentId: string; excludeId?: string },
): Promise<string[]> {
  const oldest = (await listAgentBots(service, args)).find((b) => b.id !== args.excludeId)
  if (!oldest) return []
  return (await skillIdsByBot(service, [oldest.id])).get(oldest.id) ?? []
}

export type PinnableSkillsCheck =
  | { ok: true; ids: string[] }
  | { ok: false; code: 'INVALID_SKILLS' | 'TOO_MANY_SKILLS' | 'PERSONAL_SKILL'; error: string }

/**
 * A list of skills a bot may always check: unique, at most five, each a skill
 * of this workspace or a system one, and never a personal one
 * (isPinnableSkill). Throws on a failed read.
 */
export async function checkPinnableSkills(
  client: SupabaseClient,
  args: { workspaceId: string; ids: unknown },
): Promise<PinnableSkillsCheck> {
  if (!Array.isArray(args.ids) || !args.ids.every((id) => typeof id === 'string' && id.length > 0)) {
    return { ok: false, code: 'INVALID_SKILLS', error: 'skill_recipe_ids must be a list of skill ids' }
  }
  const ids = [...new Set(args.ids as string[])]
  if (ids.length > MAX_PINNED_SKILLS) {
    return { ok: false, code: 'TOO_MANY_SKILLS', error: `An agent can always check up to ${MAX_PINNED_SKILLS} skills` }
  }
  if (ids.length === 0) return { ok: true, ids }
  const { data, error } = await client
    .from('recipe')
    .select('id, category, is_system, workspace_id, visibility')
    .in('id', ids)
  if (error) throw new Error(`skills read failed: ${error.message}`)
  const found = new Map(((data ?? []) as Array<SkillRecipeFacts & { id: string }>).map((r) => [r.id, r]))
  for (const id of ids) {
    const skill = found.get(id)
    if (skill?.category === 'skill' && skill.visibility === 'personal') {
      return { ok: false, code: 'PERSONAL_SKILL', error: 'A personal skill can’t be one an agent always checks: share it with the workspace first' }
    }
    if (!isPinnableSkill(skill, args.workspaceId)) {
      return { ok: false, code: 'INVALID_SKILLS', error: 'One or more skills are invalid' }
    }
  }
  return { ok: true, ids }
}

/**
 * `ids` less any skill a bot may not always check (another workspace's, a
 * personal one, one gone), in order: what a new bot copies from the agent's
 * other bots. Throws on a failed read.
 */
export async function pinnableOnly(service: SupabaseClient, args: { workspaceId: string; ids: readonly string[] }): Promise<string[]> {
  if (args.ids.length === 0) return []
  const { data, error } = await service
    .from('recipe')
    .select('id, category, is_system, workspace_id, visibility')
    .in('id', [...args.ids])
  if (error) throw new Error(`skills read failed: ${error.message}`)
  const ok = new Set(
    ((data ?? []) as Array<SkillRecipeFacts & { id: string }>).filter((r) => isPinnableSkill(r, args.workspaceId)).map((r) => r.id),
  )
  return args.ids.filter((id) => ok.has(id)).slice(0, MAX_PINNED_SKILLS)
}

/**
 * What a bot moving onto `agentId` takes for its skills (decision 11): the
 * list the agent's other bots share (its oldest other bot's, pinnable ones
 * only) when it has any, or null when it has none, and the bot keeps its own
 * (a fresh copy made for it, or an agent with no bot yet). Throws on a failed
 * read.
 */
export async function skillsOnJoining(
  service: SupabaseClient,
  args: { workspaceId: string; agentId: string; botId: string },
): Promise<string[] | null> {
  const other = (await listAgentBots(service, { workspaceId: args.workspaceId, agentId: args.agentId })).find((b) => b.id !== args.botId)
  if (!other) return null
  const ids = (await skillIdsByBot(service, [other.id])).get(other.id) ?? []
  return pinnableOnly(service, { workspaceId: args.workspaceId, ids })
}

/** A database refusal, with its SQLSTATE when it has one. */
export type SkillsWriteError = { code?: string; message: string }

/**
 * Replace one bot's skills with `skillIds`, in that order: the database's one
 * write of them (replace_ai_member_skills, migration 305), whole and at once
 * under a lock on the bot's row, so two saves at once can't leave a bot more
 * than five skills or half of each list. It refuses a sixth (23514) and an id
 * that isn't a skill of the bot's workspace or a system one (23503). Service
 * client only; the caller has checked the rule (editable-fields.ts).
 */
export async function replaceBotSkills(
  service: SupabaseClient,
  args: { botId: string; skillIds: readonly string[] },
): Promise<SkillsWriteError | null> {
  const { error } = await service.rpc('replace_ai_member_skills', { p_member_id: args.botId, p_skill_ids: [...args.skillIds] })
  if (!error) return null
  return { code: (error as { code?: string }).code, message: error.message }
}

/** True when the database refused a bot's skills for being more than five. */
export function isTooManySkills(error: SkillsWriteError | null): boolean {
  return error?.code === '23514'
}

/** True when the database refused a bot's skills for one that isn't a skill of its workspace or a system one. */
export function isInvalidSkill(error: SkillsWriteError | null): boolean {
  return error?.code === '23503'
}

export interface BotSkillsWrite {
  /** The bots whose list is now `skillIds`. */
  changed: string[]
  /** The bots whose list didn't change, with why. */
  failed: Array<{ id: string; error: string }>
}

/**
 * Give each bot exactly `skillIds`, in that order, one bot at a time
 * (replaceBotSkills: each bot's list changes whole or not at all). A failure
 * on one bot doesn't stop the others: the result says which didn't change.
 */
export async function writeBotSkills(
  service: SupabaseClient,
  args: { botIds: readonly string[]; skillIds: readonly string[] },
): Promise<BotSkillsWrite> {
  const out: BotSkillsWrite = { changed: [], failed: [] }
  for (const botId of args.botIds) {
    const error = await replaceBotSkills(service, { botId, skillIds: args.skillIds })
    if (error) out.failed.push({ id: botId, error: error.message })
    else out.changed.push(botId)
  }
  return out
}

/** A team the caller may put a full teammate on. */
export interface ManageableTeam {
  id: string
  name: string
  is_private: boolean
}

/**
 * The teams `memberId` may put a full teammate on (ai_team_member's manage
 * policy): an owner or admin any team they can see (one that isn't private,
 * or one they're on), anyone else the teams they lead. By name. Throws on a
 * failed read.
 */
export async function manageableTeams(
  service: SupabaseClient,
  args: { workspaceId: string; memberId: string; role: string | null | undefined },
): Promise<ManageableTeam[]> {
  const { data: seatRows, error: seatError } = await service.from('team_member').select('team_id, team_role').eq('member_id', args.memberId)
  if (seatError) throw new Error(`team seats read failed: ${seatError.message}`)
  const seats = (seatRows ?? []) as Array<{ team_id: string; team_role: string | null }>
  const { data: teamRows, error: teamError } = await service.from('team').select('id, name, is_private').eq('workspace_id', args.workspaceId)
  if (teamError) throw new Error(`teams read failed: ${teamError.message}`)
  const teams = (teamRows ?? []) as Array<{ id: string; name: string | null; is_private: boolean | null }>
  const onTeam = new Set(seats.map((s) => s.team_id))
  const leads = new Set(seats.filter((s) => s.team_role === 'lead').map((s) => s.team_id))
  const elevated = isOwnerOrAdmin(args.role)
  return teams
    .filter((t) => (elevated ? t.is_private === false || onTeam.has(t.id) : leads.has(t.id)))
    .map((t) => ({ id: t.id, name: t.name?.trim() || 'Untitled team', is_private: t.is_private !== false }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The teams `memberId` leads, by id. Throws on a failed read. */
export async function leadTeamIds(service: SupabaseClient, memberId: string): Promise<string[]> {
  const { data, error } = await service.from('team_member').select('team_id, team_role').eq('member_id', memberId)
  if (error) throw new Error(`team seats read failed: ${error.message}`)
  return ((data ?? []) as Array<{ team_id: string; team_role: string | null }>).filter((s) => s.team_role === 'lead').map((s) => s.team_id)
}
