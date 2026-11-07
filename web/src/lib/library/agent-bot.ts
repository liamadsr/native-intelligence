/**
 * A custom agent's bot (docs/plans/bots-v3.md, Phase 6). A persona can back
 * several teammates, so the bot can't hang off the persona row: making a
 * custom agent ("Give it a bot") also makes the agent's teammate, wearing the
 * face picked (one of the characters, or a built bot).
 *
 *   - The creator can manage teammates (a workspace owner or admin, or a team
 *     lead): a FULL teammate built on the agent, assignable, on a team they
 *     manage (an owner's or admin's own oldest team, else the workspace's
 *     oldest; a lead's oldest led team). This was the old "Make assignable",
 *     now done every time; Teams still adds the agent to other teams.
 *   - Anyone else: a WORK BOT (`fronts_only`, propose-only limits: phase 3's
 *     rules, flow-bot.ts createWorkBot) on a team they're on, which speaks for
 *     the agent's runs and takes no assignments. An owner, admin or lead can
 *     field the agent as a full teammate later, as before.
 *
 * Either way the teammate is built on the agent itself (`agent_recipe_id`):
 * that is how a persona's runs find their teammate (work/persona-teammate.ts,
 * used by the work ledger), and how its work bot's chat knows what it speaks for. It
 * joins the crew straight away: the crew reads the roster, which lists it.
 *
 * Every shared agent gets its bot (bots-v4 B1): made with no face picked, it
 * wears the first free one (agentBotFace). A new bot on an agent that already
 * has bots starts with the skills they always check (decision 11), but never
 * their voice: it speaks in the one picked as it's made (`voice`, bots-v4 B2,
 * checked by the route), else Automatic.
 *
 * SERVICE client: the checks are here, as the work-bot route's are, because
 * the MCP server has no session for RLS to judge. The name is the agent's.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { characterName, type BotCharacterType } from '@/lib/bots/bot-faces'
import { cleanBotName, createWorkBot, freeFaceFor, othersTalkTo, workBotTeamFor } from '@/lib/flows/flow-bot'
import { agentSkillIds, pinnableOnly, replaceBotSkills } from '@/lib/agents/agent-bots'
import { isBotCharacterType } from '@/lib/bots/teammate-faces'
import { asVoiceId } from '@/lib/bots/voice-id'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'

/** Whether an agent made with this sharing gets its bot: every shared one (a personal agent has none). */
export function agentGetsABot(visibility: string | null | undefined): boolean {
  return visibility === 'workspace' || visibility === 'public'
}

/** The face an agent's new bot wears: the one picked, else the first nobody in the workspace wears. */
export async function agentBotFace(service: SupabaseClient, workspaceId: string, picked: unknown): Promise<BotCharacterType> {
  return isBotCharacterType(picked) ? picked : await freeFaceFor(service, workspaceId)
}

/**
 * Give a new bot on an agent the skills the agent's other bots always check
 * (their oldest's list), through the database's one write of a bot's skills
 * (replaceBotSkills). Fail-soft: the bot is made either way, and the caller
 * gets why it missed them (null when it didn't) to say so; they can be given
 * in the editor.
 */
async function startWithAgentSkills(
  service: SupabaseClient,
  args: { workspaceId: string; agentId: string; teammateId: string },
): Promise<string | null> {
  try {
    const others = await pinnableOnly(service, {
      workspaceId: args.workspaceId,
      ids: await agentSkillIds(service, { workspaceId: args.workspaceId, agentId: args.agentId, excludeId: args.teammateId }),
    })
    if (others.length === 0) return null
    const error = await replaceBotSkills(service, { botId: args.teammateId, skillIds: others })
    return error ? error.message : null
  } catch (err) {
    return err instanceof Error ? err.message : 'its agent’s skills couldn’t be read'
  }
}

/** What the bot made on an agent missed: its agent's skills (the editor and the agent routes say so). */
export function skillsErrorMessage(error: string): string {
  return `It didn’t get the skills its persona’s other agents always check (${error}). Add them in the persona’s editor.`
}

export type AgentBotKind = 'full' | 'work_bot'

/**
 * A personal agent has no bot: its bot would sit on a team everyone sees, and
 * its chat would speak from an agent only its author may read. Share it with
 * the workspace first.
 */
export const PERSONAL_AGENT_BOT_ERROR =
  'A personal persona can’t have an agent: share it with the workspace to give it one.'

/** Why an agent with bots can't be made personal (bots-v4 B1): a personal agent has no bot. */
export const PERSONAL_WITH_BOTS_ERROR =
  'A personal persona can’t have an agent, and this one has agents on its teams. Keep it shared with the workspace.'

export interface AgentBotTeammate {
  id: string
  name: string
  team_id: string | null
  bot_character: string | null
  fronts_only: boolean
}

export type AgentBotResult =
  /** `skillsError`: the bot was made, but without its agent's skills, and why (null when it got them, or there were none). */
  | { teammate: AgentBotTeammate; kind: AgentBotKind; skillsError: string | null }
  | { error: string; status: 400 | 500 }

const COLUMNS = 'id, name, team_id, bot_character, fronts_only'

interface TeamRow {
  id: string
  created_at?: string | null
}

const byAge = (a: TeamRow, b: TeamRow) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))

/**
 * The team a FULL teammate made by this member goes on, or null when they may
 * not make one (the ai_team_member manage policy, mig 144: a workspace owner or
 * admin on any team, a lead on the teams they lead).
 */
export async function teamForFullTeammate(
  service: SupabaseClient,
  args: { workspaceId: string; memberId: string; role: string | null | undefined },
): Promise<string | null> {
  const { data: seatRows, error: seatError } = await service
    .from('team_member')
    .select('team_id, team_role')
    .eq('member_id', args.memberId)
  if (seatError) throw new Error(`team seats read failed: ${seatError.message}`)
  const seats = (seatRows ?? []) as Array<{ team_id: string; team_role: string | null }>
  const elevated = args.role === 'owner' || args.role === 'admin'
  const wanted = elevated ? seats.map((s) => s.team_id) : seats.filter((s) => s.team_role === 'lead').map((s) => s.team_id)

  if (wanted.length > 0) {
    const { data: teams, error } = await service
      .from('team')
      .select('id, created_at')
      .eq('workspace_id', args.workspaceId)
      .in('id', wanted)
    if (error) throw new Error(`teams read failed: ${error.message}`)
    const mine = ((teams ?? []) as TeamRow[]).sort(byAge)
    if (mine[0]) return mine[0].id
  }
  if (!elevated) return null
  // An owner or admin on no team: the workspace's oldest.
  const { data: all, error } = await service.from('team').select('id, created_at').eq('workspace_id', args.workspaceId)
  if (error) throw new Error(`teams read failed: ${error.message}`)
  return ((all ?? []) as TeamRow[]).sort(byAge)[0]?.id ?? null
}

/** Make the agent's teammate, full or a work bot by the creator's role (see the module note). */
export async function makeAgentTeammate(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    agent: { id: string; name: string }
    character: BotCharacterType
    /** The voice it starts with (a checked voice id); absent or null, Automatic. Never copied from the agent's other bots. */
    voice?: string | null
  },
): Promise<AgentBotResult> {
  try {
    const { data: member, error: memberError } = await service
      .from('member')
      .select('id, role')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .maybeSingle()
    if (memberError) throw new Error(`member read failed: ${memberError.message}`)
    const caller = member as { id: string; role: string | null } | null
    if (!caller) return { error: 'Only a member of this workspace can give a persona an agent', status: 400 }

    const name = cleanBotName(args.agent.name) ?? characterName(args.character)
    // A voice id only, whoever called (the routes check it first): anything else starts on Automatic.
    const voice = asVoiceId(args.voice)
    const fullTeam = await teamForFullTeammate(service, { workspaceId: args.workspaceId, memberId: caller.id, role: caller.role })
    if (fullTeam) {
      const { data, error } = await service
        .from('ai_team_member')
        .insert({
          workspace_id: args.workspaceId,
          team_id: fullTeam,
          name,
          agent_recipe_id: args.agent.id,
          team_role: 'member',
          created_by: args.userId,
          bot_character: args.character,
          ...(voice ? { voice } : {}),
        })
        .select(COLUMNS)
        .single()
      if (error || !data) return { error: error?.message ?? 'Could not make the persona’s agent', status: 500 }
      const teammate = data as AgentBotTeammate
      const skillsError = await startWithAgentSkills(service, { workspaceId: args.workspaceId, agentId: args.agent.id, teammateId: teammate.id })
      return { teammate, kind: 'full', skillsError }
    }

    const teamId = await workBotTeamFor(service, { workspaceId: args.workspaceId, userId: args.userId })
    if (!teamId) return { error: 'Join a team first: an agent lives on a team', status: 400 }
    const made = await createWorkBot(service, {
      workspaceId: args.workspaceId,
      teamId,
      name,
      character: args.character,
      createdBy: args.userId,
      agentRecipeId: args.agent.id,
      voice,
    })
    if ('error' in made) return made
    const skillsError = await startWithAgentSkills(service, { workspaceId: args.workspaceId, agentId: args.agent.id, teammateId: made.teammate.id })
    return {
      teammate: {
        id: made.teammate.id,
        name: made.teammate.name,
        team_id: made.teammate.team_id,
        bot_character: made.teammate.bot_character,
        fronts_only: true,
      },
      kind: 'work_bot',
      skillsError,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not make the persona’s agent', status: 500 }
  }
}

export type ReleaseAgentBotsResult =
  | { ok: true; removed: number }
  | { ok: false; status: 409 | 500; code: string; message: string }

const listNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? 'An agent') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

const privately = (count: number) => `${count} on ${count === 1 ? 'a private team' : 'private teams'}`

/**
 * Clear the way to delete a custom agent. Its teammates are built on it
 * (`agent_recipe_id`, ON DELETE RESTRICT, migration 144), so the recipe can't
 * go while any remain:
 *
 *   - its work bots (`fronts_only`, made with the agent for a plain member)
 *     speak only for this agent, so they go with it. As with the work-bot
 *     route, a plain member may not delete a bot other people have a chat with
 *     (it would delete their chats): a 409 that says so.
 *   - a FULL teammate built on it is someone's assignable teammate, with work
 *     and chats of its own: never deleted as a side effect. A 409 names it,
 *     to be removed from Teams first.
 *
 * The 409s name only the teammates the caller can reach (the private-team
 * rule, callerCanReachTeammate): one on a private team they're not on is
 * counted, never named, as the editor does.
 *
 * Checks every teammate before deleting any, so a refusal changes nothing.
 * SERVICE client: the caller has checked they may delete the agent (its
 * author, or a workspace owner or admin).
 */
export async function releaseAgentBots(
  service: SupabaseClient,
  args: { workspaceId: string; agentId: string; userId: string; elevated: boolean },
): Promise<ReleaseAgentBotsResult> {
  const { data, error } = await service
    .from('ai_team_member')
    .select('id, name, fronts_only, team_id, is_system')
    .eq('workspace_id', args.workspaceId)
    .eq('agent_recipe_id', args.agentId)
  if (error) return { ok: false, status: 500, code: 'AGENT_TEAMMATES_READ_FAILED', message: error.message }
  const mates = (data ?? []) as Array<{ id: string; name: string; fronts_only: boolean | null; team_id: string | null; is_system: boolean | null }>

  // Whether the caller may know of a teammate, by name.
  let memberId: string | null | undefined
  const reaches = async (mate: (typeof mates)[number]) => {
    if (memberId === undefined) {
      const { data: me, error: meError } = await service
        .from('member')
        .select('id')
        .eq('workspace_id', args.workspaceId)
        .eq('user_id', args.userId)
        .maybeSingle()
      if (meError) throw new Error(`membership lookup failed: ${meError.message}`)
      memberId = (me as { id: string } | null)?.id ?? null
    }
    return callerCanReachTeammate(service, {
      userId: args.userId,
      workspaceId: args.workspaceId,
      teammate: { isSystem: mate.is_system === true, teamId: mate.team_id ?? null },
      memberId,
    })
  }

  const fielded = mates.filter((m) => m.fronts_only !== true)
  const bots = mates.filter((m) => m.fronts_only === true)
  try {
    if (fielded.length > 0) {
      const named: string[] = []
      for (const mate of fielded) if (await reaches(mate)) named.push(mate.name)
      const hidden = fielded.length - named.length
      const one = fielded.length === 1
      return {
        ok: false,
        status: 409,
        code: 'AGENT_FIELDED',
        message:
          `${listNames(hidden > 0 ? [...named, privately(hidden)] : named)} ${one ? 'is an agent' : 'are agents'} built on this persona. ` +
          `Remove ${one ? 'it' : 'them'} from Teams first, then delete the persona.` +
          (hidden > 0 ? ` ${hidden === 1 ? 'The one on a private team is' : 'Those on private teams are'} for an owner, an admin or the team’s lead to remove.` : ''),
      }
    }

    if (!args.elevated) {
      for (const bot of bots) {
        if (await othersTalkTo(service, { teammateId: bot.id, userId: args.userId })) {
          const which = (await reaches(bot)) ? `${bot.name}, this persona’s agent,` : 'this persona’s agent (on a private team),'
          return {
            ok: false,
            status: 409,
            code: 'AGENT_BOT_IN_USE',
            message: `Other people have a chat with ${which} and deleting the persona would delete their chats. Ask an owner or admin to delete it.`,
          }
        }
      }
    }
  } catch (err) {
    return { ok: false, status: 500, code: 'AGENT_TEAMMATES_READ_FAILED', message: err instanceof Error ? err.message : 'Could not read the persona’s agents' }
  }

  if (bots.length === 0) return { ok: true, removed: 0 }

  const { error: deleteError } = await service
    .from('ai_team_member')
    .delete()
    .eq('workspace_id', args.workspaceId)
    .eq('agent_recipe_id', args.agentId)
    .eq('fronts_only', true)
    .in(
      'id',
      bots.map((b) => b.id),
    )
  if (deleteError) return { ok: false, status: 500, code: 'AGENT_BOT_DELETE_FAILED', message: deleteError.message }
  return { ok: true, removed: bots.length }
}

/** A recipe delete refused by a row still built on it (23503), as words a person can act on; else null. */
export function agentInUseMessage(error: { code?: string } | null | undefined): string | null {
  if (error?.code !== '23503') return null
  return 'Something still uses this persona (an agent built on it). Remove it from Teams first, then delete the persona.'
}
