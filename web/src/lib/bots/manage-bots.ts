/**
 * The main agent manages the person's agents (GEN-1168): rename one, delete
 * one, or merge duplicates into one. The tools are rename_bot, delete_bot and
 * merge_bots (src/lib/ai/tools/bot-manage.ts); this is what they read and
 * write. SERVICE client throughout: every rule below is checked here, in code.
 *
 * Who may do what is the agent editor's rule (editable-fields.ts botRule), so
 * the chat can do exactly what the person could do from the Library's Agents
 * & skills card, and nothing more:
 *   - a loop's work agent: any member who can reach it;
 *   - a custom agent's work agent: the agent's author, or an owner or admin;
 *   - a full teammate (a role or custom agent's): owners, admins and its
 *     team's leads;
 *   - a built-in (system) teammate: never renamed or removed here.
 * Removing a work agent other people chat with is for owners and admins only
 * (its delete cascades into their chats, which are theirs alone), as on the
 * work-bot route.
 *
 * What a delete does (the foreign keys, ON DELETE): its chats and memories go
 * with it (cascade); its loops would lose their agent (set null), so a delete
 * is refused while any loop points at it; its runs, waiting items and history
 * stay, shown under the person's own agent (lib/work/bot-owner.ts); actions
 * assigned to it become unassigned.
 *
 * What a merge does, per group (one kept agent, its spares): every loop a
 * spare fronts is pointed at the kept one, then its work (runs, waiting items
 * and history), its open cards, the actions assigned to it and its memories,
 * then the spares are deleted (their chats with them: one chat per person and
 * agent, so a spare's chat cannot move onto the kept one). Each step leaves a
 * consistent workspace, so a merge that stops part way can simply be asked
 * again: a spare that still fronts a loop is never deleted.
 *
 * Only bots of one kind merge (two loop agents, two role teammates, ...):
 * moving a loop from a work agent to a full teammate would widen what its
 * runs' chats may do. Two full teammates merge only on the same custom agent,
 * two role teammates only in the same role, and two custom agents' work
 * agents only when they speak for the same agent: one persona's memories
 * never land in another's. An agent on a private team merges only into one on
 * that same team, so its memories and work never reach people outside it.
 * The caller must be able to change the agent kept, too. Nothing that is
 * working right now is removed: its run would lose its agent mid-way.
 *
 * Every name in a refusal is a name people typed (an agent's, a loop's), so
 * it goes through plainName: on one line, never a tag.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { botKindOf, botRule, isOwnerOrAdmin, personaKindOf, type BotKind, type PersonaFacts } from '@/lib/agents/editable-fields'
import { leadTeamIds } from '@/lib/agents/agent-bots'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'
import { cleanBotName, othersTalkTo, runAsUserFor } from '@/lib/flows/flow-bot'
import { plainName } from '@/lib/chat/teammate-report'
import { WORK_NEEDS_YOU_STATUSES, WORK_TERMINAL_STATUSES } from '@/lib/work/types'

/** Live work that is not waiting on anyone: an agent with any is working right now. */
const WORKING_STATUSES = ['queued', 'running', 'waiting_on_child'] as const

/** The ai_team_member columns every read here selects. */
const BOT_COLUMNS = 'id, workspace_id, team_id, name, is_system, system_key, fronts_only, role, bot_character, agent_recipe_id, created_at'

/** The most agents one workspace read considers (a workspace has a handful to a few dozen). */
export const BOTS_READ_MAX = 200
/** The most groups one merge takes, and the most spares in one group. */
export const MERGE_GROUPS_MAX = 10
export const MERGE_SPARES_MAX = 20
/** The most pending cards one spare's move rewrites. */
const CARDS_MOVE_MAX = 500

export interface ManagedBot {
  id: string
  workspace_id: string
  team_id: string | null
  name: string
  is_system: boolean
  system_key: string | null
  fronts_only: boolean
  role: string | null
  bot_character: string | null
  agent_recipe_id: string | null
  created_at: string | null
  kind: BotKind
  persona: PersonaFacts
  /** Its team is private (only an explicit false is open, as callerCanReachTeammate reads it). */
  team_private: boolean
}

/** The person asking, in the bots' workspace. */
export interface BotCaller {
  userId: string
  memberId: string
  role: string | null
  leads: ReadonlySet<string>
}

/** A loop an agent fronts, as the cards and checks read it. */
export interface FrontedLoop {
  id: string
  name: string
  created_by: string | null
}

/** What an agent has, as a delete or merge card counts it. */
export interface BotFootprint {
  loops: FrontedLoop[]
  /** Work queued or running now (a run that would lose its agent). */
  working: number
  /** Questions and reviews waiting on someone, and pending cards it raised. */
  waiting: number
  /** Finished runs. */
  history: number
  /** Open actions assigned to it. */
  actions: number
  /** Chat threads with it (anyone's). */
  chats: number
  memories: number
}

type Row = Omit<ManagedBot, 'kind' | 'persona' | 'team_private'>

/** The caller's member row and the teams they lead, in `workspaceId`; null when they aren't a member. Throws on a failed read. */
export async function readBotCaller(service: SupabaseClient, workspaceId: string, userId: string): Promise<BotCaller | null> {
  const { data, error } = await service
    .from('member')
    .select('id, role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`member read failed: ${error.message}`)
  const member = data as { id?: string; role?: string | null } | null
  if (!member?.id) return null
  return { userId, memberId: member.id, role: member.role ?? null, leads: new Set(await leadTeamIds(service, member.id)) }
}

async function withKinds(service: SupabaseClient, workspaceId: string, rows: Row[]): Promise<ManagedBot[]> {
  const recipeIds = [...new Set(rows.map((r) => r.agent_recipe_id).filter((id): id is string => !!id))]
  const personas = new Map<string, { is_system: boolean | null; workspace_id: string | null; category: string | null; created_by: string | null }>()
  if (recipeIds.length > 0) {
    const { data, error } = await service.from('recipe').select('id, is_system, workspace_id, category, created_by').in('id', recipeIds)
    if (error) throw new Error(`persona read failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; is_system: boolean | null; workspace_id: string | null; category: string | null; created_by: string | null }>) {
      personas.set(r.id, r)
    }
  }
  const teamIds = [...new Set(rows.map((r) => r.team_id).filter((id): id is string => !!id))]
  const open = new Set<string>()
  if (teamIds.length > 0) {
    const { data, error } = await service.from('team').select('id, is_private').eq('workspace_id', workspaceId).in('id', teamIds)
    if (error) throw new Error(`team read failed: ${error.message}`)
    for (const t of (data ?? []) as Array<{ id: string; is_private: boolean | null }>) if (t.is_private === false) open.add(t.id)
  }
  return rows.map((row) => {
    const recipe = row.agent_recipe_id ? (personas.get(row.agent_recipe_id) ?? null) : null
    const personaKind = personaKindOf(recipe, workspaceId)
    return {
      ...row,
      is_system: row.is_system === true,
      fronts_only: row.fronts_only === true,
      kind: botKindOf(row, personaKind),
      persona: { kind: personaKind, createdBy: recipe?.created_by ?? null },
      team_private: !row.team_id || !open.has(row.team_id),
    }
  })
}

/** These agents of `workspaceId`, by id (an id of another workspace's is simply missing). Throws on a failed read. */
export async function readBots(service: SupabaseClient, workspaceId: string, ids: readonly string[]): Promise<Map<string, ManagedBot>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const { data, error } = await service.from('ai_team_member').select(BOT_COLUMNS).eq('workspace_id', workspaceId).in('id', wanted)
  if (error) throw new Error(`agent read failed: ${error.message}`)
  const bots = await withKinds(service, workspaceId, (data ?? []) as Row[])
  return new Map(bots.map((b) => [b.id, b]))
}

/** Every agent of `workspaceId` that isn't built in, oldest first (capped). Throws on a failed read. */
export async function listCustomBots(service: SupabaseClient, workspaceId: string): Promise<ManagedBot[]> {
  const { data, error } = await service
    .from('ai_team_member')
    .select(BOT_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('is_system', false)
    .order('created_at', { ascending: true })
    .limit(BOTS_READ_MAX)
  if (error) throw new Error(`agent read failed: ${error.message}`)
  return withKinds(service, workspaceId, (data ?? []) as Row[])
}

/** Whether the caller can reach the agent at all (the private-team rule). A failed read is no. */
export async function callerReaches(service: SupabaseClient, bot: ManagedBot, caller: BotCaller): Promise<boolean> {
  return callerCanReachTeammate(service, {
    userId: caller.userId,
    workspaceId: bot.workspace_id,
    teammate: { isSystem: bot.is_system, teamId: bot.team_id },
    memberId: caller.memberId,
  }).catch(() => false)
}

/** The editor's rule for this agent's own fields (its name), for this caller. */
function ruleFor(bot: ManagedBot, caller: BotCaller, reaches: boolean) {
  return botRule(
    bot.kind,
    { userId: caller.userId, role: caller.role, leadsBotTeam: !!bot.team_id && caller.leads.has(bot.team_id), reachesBot: reaches },
    bot.persona,
  )
}

/**
 * Why the caller may not rename the agent, or null when they may. A built-in
 * teammate is never renamed here: the Assistant is the person's own agent,
 * whose name is in Settings → Preferences, and the area faces aren't drawn.
 */
export async function renameRefusal(service: SupabaseClient, bot: ManagedBot, caller: BotCaller): Promise<string | null> {
  if (bot.is_system) {
    return bot.system_key === 'assistant'
      ? 'That is the person’s own agent: its name is in Settings → Preferences.'
      : `${plainName(bot.name)} is built in, so it isn't renamed here.`
  }
  const rule = ruleFor(bot, caller, await callerReaches(service, bot, caller))
  return rule.editable ? null : rule.reason
}

/**
 * Why the caller may not remove the agent (delete it, or merge it away), or
 * null when they may: a built-in one never; otherwise the editor's rule, and a
 * work agent other people chat with only by an owner or admin.
 */
export async function removalRefusal(service: SupabaseClient, bot: ManagedBot, caller: BotCaller): Promise<string | null> {
  if (bot.is_system) return `${plainName(bot.name)} is built in, so it can't be removed.`
  const rule = ruleFor(bot, caller, await callerReaches(service, bot, caller))
  if (!rule.editable) return rule.reason
  if (bot.fronts_only && !isOwnerOrAdmin(caller.role) && (await othersTalkTo(service, { teammateId: bot.id, userId: caller.userId }))) {
    return `Other people have a chat with ${plainName(bot.name)}, and removing it would delete their chats. A workspace owner or admin can.`
  }
  return null
}

async function headCount(query: PromiseLike<{ count: number | null; error: { message: string } | null }>, what: string): Promise<number> {
  const { count, error } = await query
  if (error) throw new Error(`${what} count failed: ${error.message}`)
  return count ?? 0
}

/** The loops `botId` fronts in `workspaceId`, oldest first. Throws on a failed read. */
export async function loopsFronting(service: SupabaseClient, workspaceId: string, botId: string): Promise<FrontedLoop[]> {
  const { data, error } = await service
    .from('flow')
    .select('id, name, created_by')
    .eq('workspace_id', workspaceId)
    .eq('ai_team_member_id', botId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`loop read failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; name: string | null; created_by: string | null }>).map((f) => ({
    id: f.id,
    name: f.name?.trim() || 'Untitled loop',
    created_by: f.created_by ?? null,
  }))
}

/** What the agent has: its loops, work, waiting items, history, actions, chats and memories. Throws on a failed read. */
export async function footprintOf(service: SupabaseClient, bot: Pick<ManagedBot, 'id' | 'workspace_id'>): Promise<BotFootprint> {
  const ws = bot.workspace_id
  const jobs = (statuses: readonly string[]) =>
    service.from('tracked_job').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('ai_team_member_id', bot.id).in('status', [...statuses])
  const [loops, working, needsYou, cards, history, actions, chats, memories] = await Promise.all([
    loopsFronting(service, ws, bot.id),
    headCount(jobs(WORKING_STATUSES), 'work'),
    headCount(jobs(WORK_NEEDS_YOU_STATUSES), 'waiting work'),
    headCount(
      service.from('attention_item').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'pending').eq('payload->>raised_by_ai_member_id', bot.id),
      'card',
    ),
    headCount(jobs(WORK_TERMINAL_STATUSES), 'history'),
    headCount(
      service.from('actions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('assignee_ai_member_id', bot.id).is('completed_at', null),
      'action',
    ),
    headCount(service.from('chat_conversations').select('id', { count: 'exact', head: true }).eq('ai_team_member_id', bot.id), 'chat'),
    headCount(service.from('agent_memory').select('id', { count: 'exact', head: true }).eq('ai_team_member_id', bot.id), 'memory'),
  ])
  return { loops, working, waiting: needsYou + cards, history, actions, chats, memories }
}

/**
 * What a card about these agents showed, as one hash: each agent's id, name,
 * kind, team and persona, and the loops it fronts. The replay of an accepted
 * card recomputes it and refuses on a difference (a rename, a loop pointed at
 * a spare since), so it never does more than the card said. Counts of work
 * and history are left out: a run that finishes in between changes nothing
 * the person decided on.
 */
export function botStateHash(entries: ReadonlyArray<{ bot: ManagedBot; loops: readonly FrontedLoop[]; role: 'keep' | 'remove' }>): string {
  const rows = [...entries]
    .sort((a, b) => a.bot.id.localeCompare(b.bot.id))
    .map(({ bot, loops, role }) => [bot.id, role, bot.name, bot.kind, bot.team_id, bot.agent_recipe_id, loops.map((l) => l.id).sort()])
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/** One merge group as asked: the agent kept and the spares it takes in. */
export interface MergeGroupInput {
  keep_id: string
  remove_ids: string[]
}

/** One group, read and checked: what its card says. */
export interface CheckedGroup {
  keep: ManagedBot
  keepFootprint: BotFootprint
  spares: Array<{ bot: ManagedBot; footprint: BotFootprint }>
}

/**
 * What makes two agents the same agent, beyond their name: their kind, the
 * persona of a custom agent's teammate or work agent, a role teammate's role,
 * and a private team (an agent on one only merges within it). Agents with
 * different keys never merge.
 */
function sameAgentKey(bot: ManagedBot): string {
  const persona = bot.kind === 'agent_teammate' || bot.kind === 'agent_work_bot' ? (bot.agent_recipe_id ?? '') : ''
  const role = bot.kind === 'role_teammate' ? (bot.role ?? '') : ''
  return [bot.kind, persona, role, bot.team_private ? (bot.team_id ?? '') : ''].join('|')
}

/** Why `spare` can't merge into `keep` (both read in the same workspace), or null when it can. */
function mergeMismatch(keep: ManagedBot, spare: ManagedBot): string | null {
  const [a, b] = [plainName(spare.name), plainName(keep.name)]
  if (spare.kind !== keep.kind) {
    return `${a} and ${b} are different kinds of agent (${kindLabel(spare.kind)} and ${kindLabel(keep.kind)}), so they can't be merged.`
  }
  if ((keep.kind === 'agent_work_bot' || keep.kind === 'agent_teammate') && spare.agent_recipe_id !== keep.agent_recipe_id) {
    return `${a} and ${b} are built on different custom agents, so they can't be merged.`
  }
  if (keep.kind === 'role_teammate' && spare.role !== keep.role) return `${a} and ${b} have different roles, so they can't be merged.`
  if (spare.team_private && spare.team_id !== keep.team_id) {
    return `${a} is on a private team and ${b} isn't on that team, so merging would take ${a}'s work and memories outside it. Keep an agent on the same team.`
  }
  return null
}

/** A kind of agent, in the words a refusal uses. */
export function kindLabel(kind: BotKind): string {
  switch (kind) {
    case 'loop_work_bot':
      return 'a loop’s agent'
    case 'agent_work_bot':
      return 'a custom agent’s work agent'
    case 'role_teammate':
      return 'a role teammate'
    case 'agent_teammate':
      return 'a full teammate'
    default:
      return 'a built-in teammate'
  }
}

/**
 * Why the kept agent can't take `loops` over, or null when it can: each loop's
 * run-as member must be able to reach it (flow_check_ai_team_member refuses
 * the loop otherwise).
 */
async function loopsRefusal(service: SupabaseClient, keep: ManagedBot, loops: readonly FrontedLoop[]): Promise<string | null> {
  const checked = new Map<string, boolean>()
  for (const loop of loops) {
    const runAs = await runAsUserFor(service, { workspaceId: keep.workspace_id, createdBy: loop.created_by })
    const key = runAs ?? ''
    if (!checked.has(key)) {
      const ok = runAs
        ? await callerCanReachTeammate(service, {
            userId: runAs,
            workspaceId: keep.workspace_id,
            teammate: { isSystem: keep.is_system, teamId: keep.team_id },
          }).catch(() => false)
        : false
      checked.set(key, ok)
    }
    if (!checked.get(key)) {
      return `The loop "${plainName(loop.name)}" runs as someone who can't reach ${plainName(keep.name)} (it is on a private team), so it can't move there. Keep another agent, or move ${plainName(keep.name)} to an open team first.`
    }
  }
  return null
}

/**
 * Why the caller may not change the agent kept, or null when they may (the
 * editor's rule for its own fields: a merge hands it loops, work and
 * memories). Its reach is checked by whoever calls this.
 */
function keepRefusal(keep: ManagedBot, caller: BotCaller): string | null {
  const rule = ruleFor(keep, caller, true)
  return rule.editable ? null : `${plainName(keep.name)} would be the one kept, and ${rule.reason[0].toLowerCase()}${rule.reason.slice(1)}`
}

export type GroupCheck = { ok: true; group: CheckedGroup } | { ok: false; error: string }

/**
 * Read and check one group for this caller: the kept agent is theirs to reach
 * and isn't built in; each spare is a different agent of the same kind that
 * they may remove and that isn't working right now; and every loop a spare
 * fronts can move to the kept one. Throws on a failed read.
 */
export async function checkMergeGroup(
  service: SupabaseClient,
  args: { workspaceId: string; caller: BotCaller; group: MergeGroupInput; bots: ReadonlyMap<string, ManagedBot> },
): Promise<GroupCheck> {
  const { workspaceId, caller, group, bots } = args
  const keep = bots.get(group.keep_id)
  if (!keep || !(await callerReaches(service, keep, caller))) {
    return { ok: false, error: `No agent of yours has the id ${group.keep_id}. Call list_bot_work for the ids.` }
  }
  if (keep.is_system) return { ok: false, error: `${plainName(keep.name)} is built in: merge other agents into one of your own instead.` }
  const keepRefused = keepRefusal(keep, caller)
  if (keepRefused) return { ok: false, error: keepRefused }
  const spareIds = [...new Set(group.remove_ids)]
  if (spareIds.length === 0) return { ok: false, error: `Name at least one agent to merge into ${plainName(keep.name)}.` }
  if (spareIds.includes(keep.id)) return { ok: false, error: `${plainName(keep.name)} is the one kept, so it can't also be removed.` }
  const spares: CheckedGroup['spares'] = []
  for (const id of spareIds) {
    const bot = bots.get(id)
    if (!bot || !(await callerReaches(service, bot, caller))) {
      return { ok: false, error: `No agent of yours has the id ${id}. Call list_bot_work for the ids.` }
    }
    const mismatch = mergeMismatch(keep, bot)
    if (mismatch) return { ok: false, error: mismatch }
    const refused = await removalRefusal(service, bot, caller)
    if (refused) return { ok: false, error: refused }
    const footprint = await footprintOf(service, bot)
    if (footprint.working > 0) return { ok: false, error: `${plainName(bot.name)} is working right now. Merge it once that finishes.` }
    const loopsBlocked = await loopsRefusal(service, keep, footprint.loops)
    if (loopsBlocked) return { ok: false, error: loopsBlocked }
    spares.push({ bot, footprint })
  }
  return { ok: true, group: { keep, keepFootprint: await footprintOf(service, keep), spares } }
}

/** A group's agents, for botStateHash. */
export function groupHashEntries(group: CheckedGroup): Array<{ bot: ManagedBot; loops: readonly FrontedLoop[]; role: 'keep' | 'remove' }> {
  return [
    { bot: group.keep, loops: group.keepFootprint.loops, role: 'keep' as const },
    ...group.spares.map((s) => ({ bot: s.bot, loops: s.footprint.loops, role: 'remove' as const })),
  ]
}

/** A name compared for duplicates: case and spacing aside. */
function nameKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

/** A spare left out of an automatic cleanup, and why. */
export interface LeftAlone {
  bot_id: string
  name: string
  reason: string
}

/**
 * The duplicate groups among the caller's agents in one workspace: agents
 * that are the same agent (sameAgentKey: kind, persona or role, private team)
 * with the same name (case aside), of which they may remove the spares. In
 * each, the one kept fronts the most loops, then has the most history, then
 * is the oldest. A spare they may not remove, or that is working, stays as it
 * is and is named in `left_alone`, as is every spare of a group whose kept
 * agent they may not change; a group left with no spare is no group. Throws
 * on a failed read.
 */
export async function findDuplicateGroups(
  service: SupabaseClient,
  args: { workspaceId: string; caller: BotCaller },
): Promise<{ groups: CheckedGroup[]; left_alone: LeftAlone[] }> {
  const all = await listCustomBots(service, args.workspaceId)
  const reachable: ManagedBot[] = []
  for (const bot of all) if (await callerReaches(service, bot, args.caller)) reachable.push(bot)
  const byKey = new Map<string, ManagedBot[]>()
  for (const bot of reachable) {
    const key = `${sameAgentKey(bot)}|${nameKey(bot.name)}`
    byKey.set(key, [...(byKey.get(key) ?? []), bot])
  }
  const groups: CheckedGroup[] = []
  const leftAlone: LeftAlone[] = []
  for (const members of byKey.values()) {
    if (members.length < 2 || groups.length >= MERGE_GROUPS_MAX) continue
    const sized = await Promise.all(members.map(async (bot) => ({ bot, footprint: await footprintOf(service, bot) })))
    sized.sort(
      (a, b) =>
        b.footprint.loops.length - a.footprint.loops.length ||
        b.footprint.history - a.footprint.history ||
        (a.bot.created_at ?? '').localeCompare(b.bot.created_at ?? '') ||
        a.bot.id.localeCompare(b.bot.id),
    )
    const [kept, ...rest] = sized
    const keepRefused = keepRefusal(kept.bot, args.caller)
    if (keepRefused) {
      for (const spare of rest) leftAlone.push({ bot_id: spare.bot.id, name: spare.bot.name, reason: keepRefused })
      continue
    }
    const spares: CheckedGroup['spares'] = []
    for (const spare of rest.slice(0, MERGE_SPARES_MAX)) {
      const refused =
        (await removalRefusal(service, spare.bot, args.caller)) ??
        (spare.footprint.working > 0 ? `${plainName(spare.bot.name)} is working right now.` : null) ??
        (await loopsRefusal(service, kept.bot, spare.footprint.loops))
      if (refused) leftAlone.push({ bot_id: spare.bot.id, name: spare.bot.name, reason: refused })
      else spares.push(spare)
    }
    if (spares.length > 0) groups.push({ keep: kept.bot, keepFootprint: kept.footprint, spares })
  }
  return { groups, left_alone: leftAlone }
}

/** What one merge group did. */
export interface MergeOutcome {
  keep_id: string
  removed: string[]
  /** Spares not removed: a loop still points at them (one pointed there since), or their delete failed. */
  kept_back: string[]
  moved: { loops: number; work: number; cards: number; actions: number; memories: number }
  error?: string
}

async function moveColumn(
  service: SupabaseClient,
  args: { table: string; column: string; from: readonly string[]; to: string; workspaceId?: string },
): Promise<number> {
  let query = service.from(args.table).update({ [args.column]: args.to }).in(args.column, [...args.from])
  if (args.workspaceId) query = query.eq('workspace_id', args.workspaceId)
  const { data, error } = await query.select('id')
  if (error) throw new Error(`${args.table} move failed: ${error.message}`)
  return ((data ?? []) as unknown[]).length
}

/** The pending cards the spares raised, rewritten as raised by `keep` (the raiser lives in the card's payload). */
async function moveCards(service: SupabaseClient, workspaceId: string, from: readonly string[], keep: string): Promise<number> {
  const { data, error } = await service
    .from('attention_item')
    .select('id, payload')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .in('payload->>raised_by_ai_member_id', [...from])
    .limit(CARDS_MOVE_MAX)
  if (error) throw new Error(`card read failed: ${error.message}`)
  let moved = 0
  for (const card of (data ?? []) as Array<{ id: string; payload: Record<string, unknown> | null }>) {
    const { error: upError } = await service
      .from('attention_item')
      .update({ payload: { ...(card.payload ?? {}), raised_by_ai_member_id: keep } })
      .eq('id', card.id)
      .eq('status', 'pending')
    if (upError) throw new Error(`card move failed: ${upError.message}`)
    moved += 1
  }
  return moved
}

/**
 * Merge one checked group: its spares' loops, work, cards, actions and
 * memories move to the kept agent, then each spare that no loop points at any
 * more is deleted. Stops at the first failed step and says which; every step
 * before it stands, and asking again finishes it. SERVICE client.
 */
export async function mergeGroup(service: SupabaseClient, workspaceId: string, group: CheckedGroup): Promise<MergeOutcome> {
  const keep = group.keep.id
  const from = group.spares.map((s) => s.bot.id)
  const outcome: MergeOutcome = { keep_id: keep, removed: [], kept_back: [], moved: { loops: 0, work: 0, cards: 0, actions: 0, memories: 0 } }
  try {
    outcome.moved.loops = await moveColumn(service, { table: 'flow', column: 'ai_team_member_id', from, to: keep, workspaceId })
    outcome.moved.work = await moveColumn(service, { table: 'tracked_job', column: 'ai_team_member_id', from, to: keep, workspaceId })
    await moveColumn(service, { table: 'agent_run', column: 'ai_team_member_id', from, to: keep, workspaceId })
    outcome.moved.cards = await moveCards(service, workspaceId, from, keep)
    outcome.moved.actions = await moveColumn(service, { table: 'actions', column: 'assignee_ai_member_id', from, to: keep, workspaceId })
    outcome.moved.memories = await moveColumn(service, { table: 'agent_memory', column: 'ai_team_member_id', from, to: keep, workspaceId })
    // The main agent's chats on a teammate's behalf (not chats WITH it, which go with it).
    await moveColumn(service, { table: 'chat_conversations', column: 'agent_teammate_id', from, to: keep, workspaceId })
  } catch (err) {
    outcome.kept_back = from
    outcome.error = err instanceof Error ? err.message : String(err)
    return outcome
  }
  for (const id of from) {
    const done = await deleteBotRow(service, workspaceId, id)
    if (done.deleted) outcome.removed.push(id)
    else {
      outcome.kept_back.push(id)
      if (done.error && !outcome.error) outcome.error = done.error
    }
  }
  return outcome
}

/**
 * Delete one agent that isn't built in, unless a loop points at it (checked
 * right before, so a loop pointed there since keeps its agent). SERVICE client.
 */
export async function deleteBotRow(service: SupabaseClient, workspaceId: string, botId: string): Promise<{ deleted: boolean; error?: string }> {
  const { count, error: loopError } = await service
    .from('flow')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('ai_team_member_id', botId)
  if (loopError) return { deleted: false, error: `loop read failed: ${loopError.message}` }
  if ((count ?? 0) > 0) return { deleted: false, error: 'A loop points at it now.' }
  const { data, error } = await service
    .from('ai_team_member')
    .delete()
    .eq('id', botId)
    .eq('workspace_id', workspaceId)
    .eq('is_system', false)
    .select('id')
  if (error) return { deleted: false, error: error.message }
  return { deleted: ((data ?? []) as unknown[]).length > 0 }
}

/** Rename one agent (a checked caller, a cleaned name). SERVICE client. */
export async function renameBotRow(service: SupabaseClient, bot: ManagedBot, name: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const clean = cleanBotName(name)
  if (!clean) return { ok: false, error: 'Give it a name: a few words on one line.' }
  const { data, error } = await service
    .from('ai_team_member')
    .update({ name: clean })
    .eq('id', bot.id)
    .eq('workspace_id', bot.workspace_id)
    .select('name')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'That agent is gone.' }
  return { ok: true, name: (data as { name: string }).name }
}
