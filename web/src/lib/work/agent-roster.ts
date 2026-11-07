/**
 * The Agents page's roster (plan Part 5 row 7): every teammate in the caller's
 * workspaces, with its role's breaker state. A bot's own read (`?teammate=`,
 * bots-v4.md Phase 1a) asks for its one entry (`teammateIds`).
 *
 * Two clients, on purpose:
 *   - the teammates are read on the SESSION client, so `ai_team_member`'s RLS
 *     decides which ones the caller sees (a private team's stay hidden);
 *   - the breaker is read on the SERVICE client. It is a fact about the whole
 *     workspace's attempts, and `tracked_job` SELECT is owner-only. It reads
 *     the same rows the auto-attempt gate reads (role-breaker.ts), over the
 *     same teammate set: every teammate holding the role, oldest first, max 20,
 *     including ones hidden from the caller.
 *
 * Only roles the gate may attempt (ATTEMPTABLE_ROLES) get a breaker; any other
 * role never has attempt rows, so its `breaker` is null. A failed breaker read
 * is logged and leaves `breaker` null; it never hides the roster. With no
 * service client (the always-on light read) no breaker is read at all.
 *
 * With `userId`, each entry also says whether that user may talk to it
 * (`reachable`, bots-v4 Phase C): the private-team rule
 * (callerReachableTeammateIds, callerCanReachTeammate's rule for many at
 * once), on the SESSION client. RLS alone can't say it: the "Admins and leads
 * can manage AI team members" policy shows owners and admins a private team's
 * teammates they may not chat with (the mint would refuse them). An agent's
 * page offers its notices only for a reachable bot (`true`) and the owner rule
 * moves an unreachable one's work to the Assistant (bot-owner.ts); the crew
 * draws them, and those it can't say of. A failed read is logged and leaves
 * every non-system teammate unknown (`null`): the page closes on them
 * (fail-closed, as it reads `=== true`), while the crew still
 * draws them (a bot's chat the mint refuses is the worst of it), rather than
 * every custom and work bot vanishing until the next read. The roster stands.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BotCharacterType } from '@/lib/bots/bot-faces'
import { asBotCharacter } from '@/lib/bots/teammate-faces'
import { asVoiceId } from '@/lib/bots/voice-id'
import { agentsWorkBotsSpeakFor } from '@/lib/bots/agent-bot-names'
import { ROSTER_LIMIT as SHARED_ROSTER_LIMIT } from './bot-owner'
import { callerReachableTeammateIds } from '@/lib/chat/teammate-access'
import { resolveAgentAutonomyPolicy } from './agent-autonomy-policy'
import { ATTEMPTABLE_ROLES } from './auto-attempt'
import { roleBreakerState } from './role-breaker'
import { isWorkRole, type WorkRole } from './roles'

export interface RosterBreaker {
  /** The role's unattended attempts are paused: its last `window` attempts were all dismissed. */
  paused: boolean
  window: number
}

export interface RosterTeammate {
  id: string
  workspace_id: string
  team_id: string | null
  name: string
  avatar_url: string | null
  role: WorkRole | null
  autonomy: string | null
  /** The side-effect classes it may use on its own (an attempt needs 'internal-write'). */
  allowed_side_effects: string[]
  is_system: boolean
  system_key: string | null
  /** A work bot (migration 302): made for loops, takes no assignments, has no role or autonomy to set. */
  fronts_only: boolean
  /** The loops its bot fronts (`flow.ai_team_member_id`), by name, oldest first (bots-v3 Phase 3). */
  fronts: string[]
  /** A custom agent's work bot: the agent it speaks for, by name (bots-v3 Phase 6, agent-bot-names.ts). */
  speaks_for_agent?: string | null
  /** The bot character it wears (migration 294); null = none, drawn as its icon or initials. */
  bot_character: BotCharacterType | null
  /**
   * The agent (persona recipe) it's built on, or null (bots-v4 Phase C). The
   * id only; whether the recipe is readable is the recipe's own RLS.
   */
  agent_recipe_id?: string | null
  /**
   * The caller may talk to it under the private-team rule (callerCanReachTeammate):
   * an unreachable bot's work is the Assistant's (bot-owner.ts). Set
   * when the roster was read for a user; absent, read it as unreachable.
   * Null when the reach read failed (unknown): the agent's page treats it as
   * unreachable, the crew draws it (teammate-faces.ts drawnBots).
   */
  reachable?: boolean | null
  /** Null when the role cannot attempt (or has none), or the breaker read failed. */
  breaker: RosterBreaker | null
  /**
   * The voice its bot speaks in (migration 308, bots-v4 Phase B2): a desktop
   * voice id it chose; null or absent, Automatic (lib/bots/bot-voice.ts).
   * In the light read too: the crew and the overlay take it from here.
   */
  voice?: string | null
}

/** The cap is shared with the owner rule (bot-owner.ts): at it, a teammate missing from the roster is unknown. */
const ROSTER_LIMIT = SHARED_ROSTER_LIMIT
/** The gate's teammate set for a role (auto-attempt.ts step 7). */
const ROLE_TEAMMATES_LIMIT = 20

export async function loadAgentRoster(args: {
  session: SupabaseClient
  /** Reads the breakers. Null skips them: every `breaker` is null (the light read). */
  service: SupabaseClient | null
  workspaceIds: string[]
  /** Only these teammates (one bot's read, `?teammate=`); absent: every teammate in the workspaces. */
  teammateIds?: string[]
  /** Whose `reachable` each entry carries (the private-team rule); absent: none is set. */
  userId?: string
  now: Date
}): Promise<{ roster: RosterTeammate[]; error: string | null }> {
  if (args.workspaceIds.length === 0 || args.teammateIds?.length === 0) return { roster: [], error: null }
  let mates = args.session
    .from('ai_team_member')
    .select('id, workspace_id, team_id, name, avatar_url, role, autonomy, allowed_side_effects, is_system, system_key, fronts_only, bot_character, voice, agent_recipe_id, created_at')
    .in('workspace_id', args.workspaceIds)
  if (args.teammateIds) mates = mates.in('id', args.teammateIds)
  // Oldest first, then by id: seeded teammates share a `created_at` (a batch
  // at a time), and ties must read the same in every window and on every
  // reload. The first voice a face's teammates chose depends on this order
  // (bot-voice.ts chosenVoicesOf), and so does which 200 the limit keeps.
  const { data, error } = await mates.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(ROSTER_LIMIT)
  if (error) return { roster: [], error: error.message }

  const rows = (data ?? []) as Array<
    Omit<RosterTeammate, 'breaker' | 'role' | 'bot_character' | 'fronts_only' | 'fronts' | 'voice'> & {
      role: unknown
      bot_character?: unknown
      voice?: unknown
      fronts_only?: unknown
      agent_recipe_id?: string | null
    }
  >
  // Whom the caller may talk to (the private-team rule), on the session
  // client, read beside the loops and agents below. On a failed read, system
  // teammates stay reachable and every other is unknown (`null`): closed for
  // the menu, still drawn by the crew, never a failed roster.
  const userId = args.userId
  const reachLoad: Promise<{ ids: Set<string>; failed: boolean } | null> = userId
    ? callerReachableTeammateIds(args.session, {
        userId,
        teammates: rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, isSystem: Boolean(r.is_system), teamId: r.team_id ?? null })),
      }).then(
        (ids) => ({ ids, failed: false }),
        (err: unknown) => {
          console.error('[agent-roster] reach read failed:', err instanceof Error ? err.message : err)
          return { ids: new Set(rows.filter((r) => r.is_system).map((r) => r.id)), failed: true }
        },
      )
    : Promise.resolve(null)
  // The loops each teammate's bot fronts, on the session client (any member
  // reads a workspace's flows). Fail-soft: a failed read leaves every list empty.
  const fronts = new Map<string, string[]>()
  try {
    let fronted = args.session
      .from('flow')
      .select('name, ai_team_member_id, created_at')
      .in('workspace_id', args.workspaceIds)
      .not('ai_team_member_id', 'is', null)
    if (args.teammateIds) fronted = fronted.in('ai_team_member_id', args.teammateIds)
    const { data: flows, error: flowsErr } = await fronted.order('created_at', { ascending: true })
    if (flowsErr) throw new Error(flowsErr.message)
    for (const f of (flows ?? []) as Array<{ name: string | null; ai_team_member_id: string }>) {
      const list = fronts.get(f.ai_team_member_id) ?? []
      list.push(f.name?.trim() || 'Untitled loop')
      fronts.set(f.ai_team_member_id, list)
    }
  } catch (err) {
    console.error('[agent-roster] fronted loops read failed:', err instanceof Error ? err.message : err)
  }
  // The custom agent each agent's work bot speaks for (session client: the
  // recipe's RLS applies too). Fail-soft, like the loops.
  const agents = await agentsWorkBotsSpeakFor(
    args.session,
    rows.map((r) => ({ id: r.id, workspace_id: r.workspace_id, fronts_only: r.fronts_only === true, agent_recipe_id: r.agent_recipe_id ?? null })),
  )
  const reachable = await reachLoad
  const breakers = new Map<string, RosterBreaker | null>()
  const wanted = new Map<string, Set<WorkRole>>()
  const service = args.service
  if (service) {
    for (const r of rows) {
      if (!isWorkRole(r.role) || !ATTEMPTABLE_ROLES.includes(r.role)) continue
      if (!wanted.has(r.workspace_id)) wanted.set(r.workspace_id, new Set())
      wanted.get(r.workspace_id)!.add(r.role)
    }
    await Promise.all(
      [...wanted].map(async ([workspaceId, roles]) => {
        try {
          const policy = await resolveAgentAutonomyPolicy(service, workspaceId)
          const { data: mates, error: matesErr } = await service
            .from('ai_team_member')
            .select('id, role, created_at')
            .eq('workspace_id', workspaceId)
            .in('role', [...roles])
            .order('created_at', { ascending: true })
          if (matesErr) throw new Error(matesErr.message)
          await Promise.all(
            [...roles].map(async (role) => {
              const teammateIds = ((mates ?? []) as Array<{ id: string; role: string }>)
                .filter((m) => m.role === role)
                .slice(0, ROLE_TEAMMATES_LIMIT)
                .map((m) => m.id)
              const state = await roleBreakerState(service, { workspaceId, role, teammateIds, policy, now: args.now })
              if ('error' in state) {
                console.error('[agent-roster] breaker read failed:', workspaceId, role, state.error)
                breakers.set(`${workspaceId}:${role}`, null)
                return
              }
              breakers.set(`${workspaceId}:${role}`, { paused: state.open, window: state.window })
            }),
          )
        } catch (err) {
          console.error('[agent-roster] breaker read failed:', workspaceId, err instanceof Error ? err.message : err)
        }
      }),
    )
  }

  return {
    roster: rows.map((r) => {
      const role = isWorkRole(r.role) ? r.role : null
      return {
        id: r.id,
        workspace_id: r.workspace_id,
        team_id: r.team_id ?? null,
        name: r.name,
        avatar_url: r.avatar_url ?? null,
        role,
        autonomy: r.autonomy ?? null,
        allowed_side_effects: Array.isArray(r.allowed_side_effects) ? r.allowed_side_effects : [],
        is_system: Boolean(r.is_system),
        system_key: r.system_key ?? null,
        fronts_only: r.fronts_only === true,
        fronts: fronts.get(r.id) ?? [],
        speaks_for_agent: agents.get(r.id) ?? null,
        bot_character: asBotCharacter(r.bot_character),
        agent_recipe_id: r.agent_recipe_id ?? null,
        ...(reachable ? { reachable: reachable.ids.has(r.id) ? true : reachable.failed ? null : false } : {}),
        breaker: role ? (breakers.get(`${r.workspace_id}:${role}`) ?? null) : null,
        voice: asVoiceId(r.voice),
      }
    }),
    error: null,
  }
}
