/**
 * Every loop has a bot (docs/plans/bots-v3.md, Phase 3): the teammate a loop
 * points at (`flow.ai_team_member_id`, migration 302), whose bot tells you
 * about its runs. What you pick is a bot; what's stored is a teammate.
 *
 *   - Pointing at a teammate that already wears a bot: the loop names it.
 *   - Picking a free character (or, from Phase 6, building one): a WORK BOT is
 *     made server-side (`fronts_only`, the global 'loop-work-bot' anchor
 *     persona, propose-only limits), named after its character (the
 *     catalogue's name: pick Ember, meet Ember) unless the person names it, in
 *     a team the person is on that the loop's run-as member can also reach,
 *     and the loop names it. The loop's own name is the line under it.
 *   - Saying nothing (a new loop from the AI tools, MCP or an old client): the
 *     default, in the plan's order: the teammate that already holds one of the
 *     loop's skills, else Captures for a verdict skill, else a new work bot on
 *     the first free face, named after that face. The back-fill
 *     (scripts/backfill-loop-bots.ts) uses the same order.
 *   - A rebuilt loop keeps its agent (GEN-1168): asking for a new agent under
 *     the name of a spare loop agent (one no loop points at any more, kept
 *     because it has a chat, memories or history) takes that agent back
 *     instead of minting a duplicate of it (spareLoopBot); picking its face
 *     does already. Only on that name or face: an unrelated new loop never
 *     inherits a stranger's chats and memories.
 *
 * Who may make a work bot: whoever can edit the loop (any workspace member,
 * migration 107), on the SERVICE client after these checks. Full teammates
 * stay with owners, admins and team leads (ai_team_member's RLS); a work bot is
 * the one kind a plain member may make, rename, re-face and delete
 * (work-bots routes).
 *
 * The database has the last word (flow_check_ai_team_member): another
 * workspace's teammate, a system teammate with another job, and a bot on a
 * private team the editor or the run-as member is not on are refused there
 * too. The checks here only turn those into readable 400s first.
 *
 * Faces and names come from the catalogue (bot-characters.ts): nothing here
 * names a character.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { characterName, type BotCharacterType } from '@/lib/bots/bot-faces'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'
import { firstFreeBotCharacter, isBotCharacterType, FREE_BOT_CHARACTER_ORDER } from '@/lib/bots/teammate-faces'
import { agentsWorkBotsSpeakFor } from '@/lib/bots/agent-bot-names'
import { asVoiceId } from '@/lib/bots/voice-id'
import {
  flowSkillIds,
  flowTeammateKey,
  systemKeyForFlow,
  systemTeammateId,
  type SystemTeammateKey,
} from '@/lib/work/system-teammates'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

/** The global identity anchor every work bot is bound to (migration 302). */
export const WORK_BOT_ANCHOR_SLUG = 'loop-work-bot'

/** The system teammates whose job is fronting loops (Captures, migration 318); the trigger's list. */
export const LOOP_FRONTING_SYSTEM_KEYS: readonly SystemTeammateKey[] = ['captures']

/** A work bot's name is a teammate name: one line, bounded. */
export const WORK_BOT_NAME_MAX = 60

/** The ai_team_member columns every bot read here selects. */
const MATE_COLUMNS = 'id, workspace_id, team_id, name, is_system, system_key, fronts_only, bot_character, agent_recipe_id, created_at'

export interface FlowBotMate {
  id: string
  workspace_id: string
  team_id: string | null
  name: string
  is_system: boolean
  system_key: string | null
  fronts_only: boolean
  bot_character: string | null
  /** The recipe it is built on: the loop anchor, or (Phase 6) the custom agent it speaks for. */
  agent_recipe_id?: string | null
}

/** What a request asked for. */
export type FlowBotChoice =
  | { kind: 'teammate'; teammateId: string }
  | { kind: 'character'; character: BotCharacterType; name: string | null }
  /**
   * A new work agent for this loop (`bot_new: true`): never an existing teammate, whatever face it's
   * handed, except a spare loop agent of the same name (a rebuilt loop's own, spareLoopBot).
   */
  | { kind: 'new'; name: string | null }

/** `bot_name` from a body: a cleaned name, null for none, or an Error for a non-string. */
function botNameOf(body: Record<string, unknown>): string | null | Error {
  const rawName = body.bot_name
  if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
    return new Error('bot_name must be a string')
  }
  return cleanBotName(rawName as string | null | undefined)
}

/**
 * The agent a flow write asks for, from its body: `ai_team_member_id` (an
 * existing teammate), `bot_new: true` (a new work agent made for this loop,
 * with an optional `bot_name`; it never reuses a teammate), or
 * `bot_character` (a character, with an optional `bot_name`: a reachable
 * teammate already wearing it, else a work agent made wearing it). Undefined
 * when the body says nothing about it; an Error for a bad value, for two
 * picks at once, or for a clear (`ai_team_member_id: null`): a loop always has
 * an agent, it can be changed but not cleared.
 */
export function parseFlowBotInput(body: Record<string, unknown>): FlowBotChoice | undefined | Error {
  const hasMate = Object.prototype.hasOwnProperty.call(body, 'ai_team_member_id')
  const hasFace = Object.prototype.hasOwnProperty.call(body, 'bot_character')
  const hasNew = Object.prototype.hasOwnProperty.call(body, 'bot_new') && body.bot_new !== undefined && body.bot_new !== false
  if (hasNew) {
    if (body.bot_new !== true) return new Error('bot_new must be true or false')
    if (hasMate && body.ai_team_member_id !== undefined) return new Error('Pick either ai_team_member_id or bot_new, not both')
    const name = botNameOf(body)
    if (name instanceof Error) return name
    return { kind: 'new', name }
  }
  if (!hasMate && !hasFace) return undefined
  if (hasMate && body.ai_team_member_id !== undefined) {
    const id = body.ai_team_member_id
    if (id === null || id === '') return new Error('A loop always has an agent: pick another one instead of clearing it')
    if (typeof id !== 'string') return new Error('ai_team_member_id must be a teammate id')
    return { kind: 'teammate', teammateId: id }
  }
  const face = body.bot_character
  if (face === undefined) return undefined
  if (!isBotCharacterType(face)) return new Error('bot_character must be one of the characters')
  // One face: a loop's bot never wears the assistant's own face (nor picks the Assistant by it).
  if (agentFaceRefused(face)) return new Error(AGENT_FACE_RESERVED_ERROR)
  const name = botNameOf(body)
  if (name instanceof Error) return name
  return { kind: 'character', character: face, name }
}

/** A work bot's name: whitespace collapsed, bounded, null when empty. */
export function cleanBotName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, WORK_BOT_NAME_MAX).trim()
  return name || null
}

/** Whether a teammate may front a loop at all (the trigger's job rule, minus reachability). */
export function mayFrontLoop(mate: Pick<FlowBotMate, 'is_system' | 'system_key'>, seedKey?: string | null): boolean {
  if (!mate.is_system) return true
  if (!mate.system_key || !LOOP_FRONTING_SYSTEM_KEYS.includes(mate.system_key as SystemTeammateKey)) return false
  const seeded = systemKeyForFlow({ seed_key: seedKey ?? null })
  return !seeded || seeded === mate.system_key
}

async function readMate(service: SupabaseClient, workspaceId: string, id: string): Promise<FlowBotMate | null> {
  const { data, error } = await service
    .from('ai_team_member')
    .select(MATE_COLUMNS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`teammate read failed: ${error.message}`)
  return (data as FlowBotMate | null) ?? null
}

async function reaches(service: SupabaseClient, workspaceId: string, userId: string, mate: FlowBotMate): Promise<boolean> {
  return callerCanReachTeammate(service, {
    userId,
    workspaceId,
    teammate: { isSystem: mate.is_system === true, teamId: mate.team_id ?? null },
  })
}

/** The teams a user sits on in a workspace (empty when they aren't a member). */
async function seatsOf(service: SupabaseClient, workspaceId: string, userId: string): Promise<Set<string>> {
  const { data: member } = await service
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  const memberId = (member as { id?: string } | null)?.id ?? null
  if (!memberId) return new Set()
  const { data: seats } = await service.from('team_member').select('team_id').eq('member_id', memberId)
  return new Set(((seats ?? []) as Array<{ team_id: string }>).map((s) => s.team_id))
}

/**
 * The user a loop runs as (run-as-member.ts, and the trigger's rule): its
 * creator while still a member, else the workspace owner. Null when neither.
 */
export async function runAsUserFor(
  service: SupabaseClient,
  args: { workspaceId: string; createdBy: string | null | undefined },
): Promise<string | null> {
  if (args.createdBy) {
    const { data } = await service
      .from('member')
      .select('user_id')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.createdBy)
      .maybeSingle()
    if ((data as { user_id?: string } | null)?.user_id) return args.createdBy
  }
  const { data: owner } = await service
    .from('member')
    .select('user_id')
    .eq('workspace_id', args.workspaceId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  return (owner as { user_id?: string } | null)?.user_id ?? null
}

/**
 * The team a work bot made by `userId` goes in. Every pick must also be one the
 * loop's run-as member (`runAsUserId`, when it's someone else) can reach, or
 * the flow trigger refuses the bot: a team that isn't private, or one they are
 * on. In order: the flow's team when the editor is on it, else the editor's
 * oldest team, else the workspace's oldest team that isn't private (both can
 * reach it), else null.
 */
export async function workBotTeamFor(
  service: SupabaseClient,
  args: { workspaceId: string; userId: string; flowTeamId?: string | null; runAsUserId?: string | null },
): Promise<string | null> {
  const seatIds = await seatsOf(service, args.workspaceId, args.userId)
  if (seatIds.size > 0) {
    const otherRunAs = args.runAsUserId && args.runAsUserId !== args.userId ? args.runAsUserId : null
    const runAsSeats = otherRunAs ? await seatsOf(service, args.workspaceId, otherRunAs) : null
    const { data: teams } = await service
      .from('team')
      .select('id, is_private, created_at')
      .eq('workspace_id', args.workspaceId)
      .in('id', [...seatIds])
      .order('created_at', { ascending: true })
    // Only an explicit false is public (the trigger's and callerCanReachTeammate's rule).
    const fits = (t: { id: string; is_private: boolean | null }) => !runAsSeats || t.is_private === false || runAsSeats.has(t.id)
    const mine = ((teams ?? []) as Array<{ id: string; is_private: boolean | null }>).filter(fits)
    const flowTeam = args.flowTeamId ? mine.find((t) => t.id === args.flowTeamId) : undefined
    if (flowTeam) return flowTeam.id
    if (mine[0]) return mine[0].id
  }
  const { data: open } = await service
    .from('team')
    .select('id, created_at')
    .eq('workspace_id', args.workspaceId)
    .eq('is_private', false)
    .order('created_at', { ascending: true })
    .limit(1)
  return ((open ?? []) as Array<{ id: string }>)[0]?.id ?? null
}

/** The work-bot anchor recipe's id (global: workspace_id NULL). Throws when it's missing (302 not applied). */
async function workBotAnchorId(service: SupabaseClient): Promise<string> {
  const { data, error } = await service
    .from('recipe')
    .select('id')
    .eq('slug', WORK_BOT_ANCHOR_SLUG)
    .eq('category', 'agent')
    .is('workspace_id', null)
    .maybeSingle()
  if (error) throw new Error(`work bot anchor read failed: ${error.message}`)
  const id = (data as { id?: string } | null)?.id
  if (!id) throw new Error('work bot anchor recipe is missing (migration 302)')
  return id
}

/** The faces worn in a workspace (every teammate, private teams included: the service client). */
async function wornFaces(service: SupabaseClient, workspaceId: string): Promise<string[]> {
  const { data } = await service
    .from('ai_team_member')
    .select('bot_character')
    .eq('workspace_id', workspaceId)
    .not('bot_character', 'is', null)
  return ((data ?? []) as Array<{ bot_character: string | null }>).map((r) => r.bot_character).filter((f): f is string => !!f)
}

/** The face a new work bot gets when none was picked: the first free one, else the free order's first (never a reserved face). */
export async function freeFaceFor(service: SupabaseClient, workspaceId: string): Promise<BotCharacterType> {
  return firstFreeBotCharacter(await wornFaces(service, workspaceId)) ?? FREE_BOT_CHARACTER_ORDER[0]
}

export type WorkBotResult = { teammate: FlowBotMate } | { error: string; status: 400 | 500 }

/**
 * Make a work bot: `fronts_only`, role NULL, the anchor persona, autonomy
 * 'propose' and side effects {read} (its chat adds the propose-only tools,
 * chat-ceiling.ts), wearing `character`, named `name` (or the character's
 * catalogue name), in `teamId`. SERVICE client: the caller has checked who may.
 *
 * A custom agent's work bot (Phase 6, library/agent-bot.ts) is built on the
 * agent instead of the anchor (`agentRecipeId`): it speaks for that agent's
 * runs, which find it by their persona. Its limits are the same.
 */
export async function createWorkBot(
  service: SupabaseClient,
  args: {
    workspaceId: string
    teamId: string
    name: string | null
    character: BotCharacterType
    createdBy: string | null
    /** The custom agent it speaks for; absent, the loop work-bot anchor. */
    agentRecipeId?: string | null
    /** The voice it starts with (migration 308, a checked voice id); absent or null, Automatic. */
    voice?: string | null
  },
): Promise<WorkBotResult> {
  let anchor: string
  try {
    anchor = args.agentRecipeId ?? (await workBotAnchorId(service))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'work bot anchor missing', status: 500 }
  }
  const name = cleanBotName(args.name) ?? characterName(args.character)
  // A voice id only, whoever called (the routes check it first): anything else starts on Automatic.
  const voice = asVoiceId(args.voice)
  const { data, error } = await service
    .from('ai_team_member')
    .insert({
      workspace_id: args.workspaceId,
      team_id: args.teamId,
      name,
      agent_recipe_id: anchor,
      team_role: 'member',
      created_by: args.createdBy,
      bot_character: args.character,
      ...(voice ? { voice } : {}),
      fronts_only: true,
      role: null,
      autonomy: 'propose',
      allowed_side_effects: ['read'],
    })
    .select(MATE_COLUMNS)
    .single()
  if (error || !data) return { error: error?.message ?? 'agent insert failed', status: 500 }
  return { teammate: data as FlowBotMate }
}

export type FlowBotResolution = { teammateId: string; created: boolean } | { error: string; status: 400 | 500 }

/**
 * The teammate a flow write points at, for what the request asked: an existing
 * teammate (checked: this workspace, may front loops, reachable by the
 * editor), or a character (the first teammate the editor can reach that wears
 * it and may front loops, else a work bot made for it). SERVICE client.
 */
export async function resolveFlowBotChoice(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    choice: FlowBotChoice
    flowTeamId?: string | null
    seedKey?: string | null
    /** The user the loop runs as, when it isn't the editor (a work bot's team must suit both). */
    runAsUserId?: string | null
  },
): Promise<FlowBotResolution> {
  try {
    if (args.choice.kind === 'teammate') {
      const mate = await readMate(service, args.workspaceId, args.choice.teammateId)
      if (!mate) return { error: 'That agent is not one of this workspace’s agents', status: 400 }
      if (!mayFrontLoop(mate, args.seedKey)) return { error: 'That built-in agent does not front loops', status: 400 }
      if (!(await reaches(service, args.workspaceId, args.userId, mate))) {
        return { error: 'That agent is on a private team you are not on', status: 400 }
      }
      return { teammateId: mate.id, created: false }
    }

    if (args.choice.kind === 'new') {
      // A loop made again under its old agent's name takes that agent back (GEN-1168), whatever its face.
      if (args.choice.name) {
        const spare = await spareLoopBot(service, { ...args, name: args.choice.name })
        if (spare) return { teammateId: spare.id, created: false }
      }
      // Otherwise a new one: a free face (or any, when every one is worn), never a teammate already wearing it.
      return await makeWorkBotForFlow(service, {
        workspaceId: args.workspaceId,
        userId: args.userId,
        flowTeamId: args.flowTeamId ?? null,
        runAsUserId: args.runAsUserId ?? null,
        name: args.choice.name,
        character: await freeFaceFor(service, args.workspaceId),
      })
    }

    const { data, error } = await service
      .from('ai_team_member')
      .select(MATE_COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('bot_character', args.choice.character)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    for (const mate of (data ?? []) as FlowBotMate[]) {
      if (!mayFrontLoop(mate, args.seedKey)) continue
      if (await reaches(service, args.workspaceId, args.userId, mate)) return { teammateId: mate.id, created: false }
    }
    return await makeWorkBotForFlow(service, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      flowTeamId: args.flowTeamId ?? null,
      runAsUserId: args.runAsUserId ?? null,
      // Unnamed: the character's catalogue name (createWorkBot), never the loop's.
      name: args.choice.name,
      character: args.choice.character,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'agent lookup failed', status: 500 }
  }
}

async function makeWorkBotForFlow(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    flowTeamId: string | null
    runAsUserId: string | null
    name: string | null
    character: BotCharacterType
  },
): Promise<FlowBotResolution> {
  const teamId = await workBotTeamFor(service, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    flowTeamId: args.flowTeamId,
    runAsUserId: args.runAsUserId,
  })
  if (!teamId) return { error: 'Join a team first: a loop’s agent lives on a team', status: 400 }
  const made = await createWorkBot(service, {
    workspaceId: args.workspaceId,
    teamId,
    name: args.name,
    character: args.character,
    createdBy: args.userId,
  })
  if ('error' in made) return made
  return { teammateId: made.teammate.id, created: true }
}

/** How many of a workspace's loop agents one spare lookup reads. */
const SPARE_LOOKUP_LIMIT = 50

/**
 * A loop's agent that no loop points at any more (GEN-1168): a work agent on
 * the loop anchor whose loop was deleted or given another agent, kept because
 * it has a chat, memories or history (retireWorkBotIfUnused). A loop made
 * again under its name takes it back instead of minting a duplicate of it:
 * the oldest one named `name` (case and spacing aside), wearing `character`
 * when one is given, that the editor, and the loop's run-as member when
 * that's someone else, can both reach. A custom agent's work agent is never
 * one (it speaks for its agent). Null when none. SERVICE client; throws on a
 * failed read.
 */
export async function spareLoopBot(
  service: SupabaseClient,
  args: { workspaceId: string; userId: string; runAsUserId?: string | null; character?: string | null; name: string },
): Promise<FlowBotMate | null> {
  const wanted = cleanBotName(args.name)?.toLocaleLowerCase()
  if (!wanted) return null
  const anchor = await workBotAnchorId(service)
  let query = service
    .from('ai_team_member')
    .select(MATE_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('fronts_only', true)
    .eq('is_system', false)
    .eq('agent_recipe_id', anchor)
  if (args.character) query = query.eq('bot_character', args.character)
  const { data, error } = await query.order('created_at', { ascending: true }).limit(SPARE_LOOKUP_LIMIT)
  if (error) throw new Error(`spare agent read failed: ${error.message}`)
  const runAs = args.runAsUserId && args.runAsUserId !== args.userId ? args.runAsUserId : null
  for (const mate of (data ?? []) as FlowBotMate[]) {
    if (cleanBotName(mate.name)?.toLocaleLowerCase() !== wanted) continue
    const { count, error: loopError } = await service
      .from('flow')
      .select('id', { count: 'exact', head: true })
      .eq('ai_team_member_id', mate.id)
    if (loopError) throw new Error(`loop read failed: ${loopError.message}`)
    if ((count ?? 0) > 0) continue
    if (!(await reaches(service, args.workspaceId, args.userId, mate))) continue
    if (runAs && !(await reaches(service, args.workspaceId, runAs, mate))) continue
    return mate
  }
  return null
}

/** The run_skill actions of a flow, as far as the default reads them. */
interface FlowActionLike {
  type: string
  enabled?: boolean
  config?: unknown
}

/** How many of a loop's skill holders one lookup reads (a skill is held by a handful of bots in a workspace). */
const SKILL_HOLDERS_LIMIT = 50

/**
 * The teammate that already holds one of the loop's skills
 * (`ai_team_member_skill`), oldest first, that may front loops and that
 * `userId` can reach (the editor of a new loop; the run-as member's user in the
 * back-fill). Null when none. One read, fenced to the workspace in the join
 * (a system skill is held across every workspace).
 */
export async function skillHolderFor(
  service: SupabaseClient,
  args: { workspaceId: string; userId: string; actions: readonly FlowActionLike[] | null | undefined; seedKey?: string | null },
): Promise<string | null> {
  const skillIds = flowSkillIds(args.actions)
  if (skillIds.length === 0) return null
  const { data: holds, error } = await service
    .from('ai_team_member_skill')
    .select(`ai_team_member!inner(${MATE_COLUMNS})`)
    .in('skill_recipe_id', skillIds)
    .eq('ai_team_member.workspace_id', args.workspaceId)
    .limit(SKILL_HOLDERS_LIMIT)
  if (error) throw new Error(`skill holder read failed: ${error.message}`)
  type Holder = FlowBotMate & { created_at?: string | null }
  const byId = new Map<string, Holder>()
  // A to-one embed comes back as one row (an array only in the generated types).
  for (const hold of (holds ?? []) as unknown as Array<{ ai_team_member: Holder | Holder[] | null }>) {
    for (const mate of [hold.ai_team_member].flat()) if (mate?.id) byId.set(mate.id, mate)
  }
  // Oldest first, id breaking a tie.
  const mates = [...byId.values()].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))
  for (const mate of mates) {
    if (!mayFrontLoop(mate, args.seedKey)) continue
    if (await reaches(service, args.workspaceId, args.userId, mate)) return mate.id
  }
  return null
}

/** What a loop's default bot would be, without making anything. */
export type FlowBotSuggestion = { kind: 'teammate'; teammateId: string } | { kind: 'character'; character: BotCharacterType }

/**
 * A loop's default bot, in the plan's order, WITHOUT making one:
 *   1. a seeded loop's own system teammate (Captures);
 *   2. the teammate that holds one of its skills (skillHolderFor);
 *   3. Captures, for a loop that runs a verdict-class skill;
 *   4. a new work bot: the first free face (the caller makes it, or the editor
 *      preselects it). SERVICE client. Throws on a failed read.
 */
export async function suggestFlowBot(
  service: SupabaseClient,
  args: { workspaceId: string; userId: string; seedKey?: string | null; actions: readonly FlowActionLike[] | null | undefined },
): Promise<FlowBotSuggestion> {
  const seeded = systemKeyForFlow({ seed_key: args.seedKey ?? null })
  if (seeded) {
    const id = await systemTeammateId(service, args.workspaceId, seeded)
    if (id) return { kind: 'teammate', teammateId: id }
  }
  const holder = await skillHolderFor(service, args)
  if (holder) return { kind: 'teammate', teammateId: holder }
  const key = await flowTeammateKey(service, args.workspaceId, { seed_key: null, actions: args.actions })
  if (key === 'captures') {
    const id = await systemTeammateId(service, args.workspaceId, 'captures')
    if (id) return { kind: 'teammate', teammateId: id }
  }
  return { kind: 'character', character: await freeFaceFor(service, args.workspaceId) }
}

/**
 * A loop's default bot (suggestFlowBot), made when it is a new work bot,
 * named after its face (the catalogue's name). SERVICE client (the work-bot insert and the
 * private-team reads).
 */
export async function defaultFlowBot(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    flowTeamId?: string | null
    seedKey?: string | null
    actions: readonly FlowActionLike[] | null | undefined
    /** The user the loop runs as, when it isn't `userId`. */
    runAsUserId?: string | null
  },
): Promise<FlowBotResolution> {
  try {
    const suggestion = await suggestFlowBot(service, args)
    if (suggestion.kind === 'teammate') return { teammateId: suggestion.teammateId, created: false }
    return await makeWorkBotForFlow(service, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      flowTeamId: args.flowTeamId ?? null,
      runAsUserId: args.runAsUserId ?? null,
      name: null,
      character: suggestion.character,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'agent lookup failed', status: 500 }
  }
}

/** One bot the loop editor's picker offers: a teammate the person can reach that may front loops. */
export interface FlowBotOption {
  id: string
  name: string
  bot_character: string | null
  fronts_only: boolean
  is_system: boolean
  system_key: string | null
  /** The loops its bot already fronts, by name (oldest first). */
  fronts: string[]
  /** A custom agent's work bot: the agent it speaks for, by name (Phase 6). */
  agent?: string | null
}

/**
 * What the loop editor's "Its bot" picker offers: the bots the person's
 * teammates wear (every teammate they can reach that may front loops, system
 * ones limited to Captures) with the loops each already fronts,
 * and the characters nobody in the workspace wears yet (catalogue order, past
 * the reserved faces: the Assistant's `chat`).
 * Teammates are read on the SESSION client (RLS), then the private-team rule
 * explicitly (an admin's RLS sees every team); faces and fronts on the SERVICE
 * client, scoped to the workspace.
 */
export async function listFlowBotOptions(
  session: SupabaseClient,
  service: SupabaseClient,
  args: { workspaceId: string; userId: string },
): Promise<{ teammates: FlowBotOption[]; free_characters: BotCharacterType[] }> {
  const [{ data: mates, error }, worn, { data: fronted }] = await Promise.all([
    session.from('ai_team_member').select(MATE_COLUMNS).eq('workspace_id', args.workspaceId).order('created_at', { ascending: true }),
    wornFaces(service, args.workspaceId),
    service
      .from('flow')
      .select('name, ai_team_member_id, created_at')
      .eq('workspace_id', args.workspaceId)
      .not('ai_team_member_id', 'is', null)
      .order('created_at', { ascending: true }),
  ])
  if (error) throw new Error(`teammate read failed: ${error.message}`)
  const frontsBy = new Map<string, string[]>()
  for (const f of (fronted ?? []) as Array<{ name: string | null; ai_team_member_id: string }>) {
    const list = frontsBy.get(f.ai_team_member_id) ?? []
    list.push(f.name?.trim() || 'Untitled loop')
    frontsBy.set(f.ai_team_member_id, list)
  }
  const agents = await agentsWorkBotsSpeakFor(service, (mates ?? []) as FlowBotMate[])
  const teammates: FlowBotOption[] = []
  for (const mate of (mates ?? []) as FlowBotMate[]) {
    if (!mayFrontLoop(mate)) continue
    if (!(await reaches(service, args.workspaceId, args.userId, mate).catch(() => false))) continue
    teammates.push({
      id: mate.id,
      name: mate.name,
      bot_character: mate.bot_character ?? null,
      fronts_only: mate.fronts_only === true,
      is_system: mate.is_system === true,
      system_key: mate.system_key ?? null,
      fronts: frontsBy.get(mate.id) ?? [],
      agent: agents.get(mate.id) ?? null,
    })
  }
  const taken = new Set(worn)
  return { teammates, free_characters: FREE_BOT_CHARACTER_ORDER.filter((c) => !taken.has(c)) }
}

/** A database refusal from flow_check_ai_team_member (check_violation) as a readable message, else null. */
export function flowBotRefusal(error: { code?: string; message?: string } | null | undefined): string | null {
  if (!error || error.code !== '23514') return null
  return error.message ?? 'That agent can’t front this loop'
}

/** One loop as the back-fill reads it. */
export interface BackfillFlow {
  id: string
  workspace_id: string
  team_id: string | null
  name: string
  created_by: string | null
  seed_key: string | null
  actions: readonly FlowActionLike[] | null
}

export type BackfillOutcome =
  | { flowId: string; kind: 'set'; teammateId: string; created: boolean }
  | { flowId: string; kind: 'would-set'; teammateId: string | null; plan: string }
  | { flowId: string; kind: 'skipped'; reason: string }
  | { flowId: string; kind: 'failed'; error: string }

/**
 * Give one existing loop its bot (scripts/backfill-loop-bots.ts), in the same
 * order as a new loop's default (defaultFlowBot): a seeded loop's system
 * teammate, the skill's holder, Captures for a verdict skill, else a new work bot
 * named after its face. Reachability is the RUN-AS member's (the trigger checks
 * the same, with no editor under the service client). Writes only a loop whose
 * column is still empty, so a re-run never overrides a choice. A dry run makes
 * nothing: it says which existing teammate it would name, or that it would
 * make a work bot. SERVICE client.
 */
export async function backfillFlowBot(
  service: SupabaseClient,
  flow: BackfillFlow,
  opts: { execute: boolean },
): Promise<BackfillOutcome> {
  try {
    const userId = await runAsUserFor(service, { workspaceId: flow.workspace_id, createdBy: flow.created_by })
    if (!userId) return { flowId: flow.id, kind: 'skipped', reason: 'no run-as member' }

    if (!opts.execute) {
      const seeded = systemKeyForFlow({ seed_key: flow.seed_key })
      if (seeded) return { flowId: flow.id, kind: 'would-set', teammateId: null, plan: `system teammate ${seeded}` }
      const holder = await skillHolderFor(service, { workspaceId: flow.workspace_id, userId, actions: flow.actions })
      if (holder) return { flowId: flow.id, kind: 'would-set', teammateId: holder, plan: 'skill holder' }
      const key = await flowTeammateKey(service, flow.workspace_id, { seed_key: null, actions: flow.actions })
      if (key === 'captures') return { flowId: flow.id, kind: 'would-set', teammateId: null, plan: 'Captures (verdict skill)' }
      return { flowId: flow.id, kind: 'would-set', teammateId: null, plan: 'a new work bot' }
    }

    const bot = await defaultFlowBot(service, {
      workspaceId: flow.workspace_id,
      userId,
      flowTeamId: flow.team_id,
      seedKey: flow.seed_key,
      actions: flow.actions,
    })
    if ('error' in bot) return { flowId: flow.id, kind: 'failed', error: bot.error }
    const { data, error } = await service
      .from('flow')
      .update({ ai_team_member_id: bot.teammateId })
      .eq('id', flow.id)
      .is('ai_team_member_id', null)
      .select('id')
    if (error || !data || (data as unknown[]).length === 0) {
      if (bot.created) await service.from('ai_team_member').delete().eq('id', bot.teammateId)
      return error
        ? { flowId: flow.id, kind: 'failed', error: error.message }
        : { flowId: flow.id, kind: 'skipped', reason: 'already has a bot' }
    }
    return { flowId: flow.id, kind: 'set', teammateId: bot.teammateId, created: bot.created }
  } catch (err) {
    return { flowId: flow.id, kind: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Whether any row of `table` points at the teammate (a head count; a failed read counts as "yes"). */
async function anyRowFor(service: SupabaseClient, table: string, teammateId: string): Promise<boolean> {
  const { count, error } = await service
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('ai_team_member_id', teammateId)
  if (error) return true
  return (count ?? 0) > 0
}

/**
 * Delete a work bot nobody needs any more, after a loop stopped naming it (a
 * re-pick, or the loop's delete), so a dropped pick never keeps a face out of
 * the free characters. Only a `fronts_only` bot of this workspace that:
 *   - fronts no loop;
 *   - has no chat thread with anyone (chat_conversations cascade on delete, and
 *     they are their owners' alone);
 *   - remembers nothing (agent_memory cascades too);
 *   - fronted no run yet (tracked_job keeps its history: it would lose its face);
 *   - speaks for no custom agent (Phase 6: built on an agent, not the anchor).
 * Anything else stays, to be renamed, re-faced or deleted by a person from the
 * loop editor. Fail-soft: true only when it deleted the bot. SERVICE client.
 */
export async function retireWorkBotIfUnused(
  service: SupabaseClient,
  args: { workspaceId: string; teammateId: string | null | undefined },
): Promise<boolean> {
  if (!args.teammateId) return false
  try {
    const mate = await readMate(service, args.workspaceId, args.teammateId)
    if (!mate || mate.fronts_only !== true) return false
    const { count: fronting, error } = await service
      .from('flow')
      .select('id', { count: 'exact', head: true })
      .eq('ai_team_member_id', mate.id)
    if (error || (fronting ?? 0) > 0) return false
    if (await speaksForAnAgent(service, mate.id)) return false
    for (const table of ['chat_conversations', 'agent_memory', 'tracked_job']) {
      if (await anyRowFor(service, table, mate.id)) return false
    }
    const { error: delError } = await service
      .from('ai_team_member')
      .delete()
      .eq('id', mate.id)
      .eq('workspace_id', args.workspaceId)
      .eq('fronts_only', true)
    return !delError
  } catch {
    return false
  }
}

/** Whether a work bot is a custom agent's (built on an agent recipe, not the anchor). A failed read counts as yes. */
async function speaksForAnAgent(service: SupabaseClient, teammateId: string): Promise<boolean> {
  const { data: mate, error } = await service.from('ai_team_member').select('agent_recipe_id').eq('id', teammateId).maybeSingle()
  if (error) return true
  const recipeId = (mate as { agent_recipe_id?: string | null } | null)?.agent_recipe_id
  if (!recipeId) return false
  const { data: recipe, error: recipeError } = await service.from('recipe').select('slug').eq('id', recipeId).maybeSingle()
  if (recipeError) return true
  return (recipe as { slug?: string | null } | null)?.slug !== WORK_BOT_ANCHOR_SLUG
}

/**
 * Whether people other than `userId` have a chat thread with the teammate. A
 * work bot's delete would cascade into those threads (owner-only by RLS,
 * migration 300), so a plain member may not delete a bot others talk to. A
 * failed read counts as "yes" (fail closed). SERVICE client.
 */
export async function othersTalkTo(service: SupabaseClient, args: { teammateId: string; userId: string }): Promise<boolean> {
  const { count, error } = await service
    .from('chat_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('ai_team_member_id', args.teammateId)
    .neq('user_id', args.userId)
  if (error) return true
  return (count ?? 0) > 0
}
