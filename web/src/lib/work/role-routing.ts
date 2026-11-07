/**
 * Role routing (plan Part 5 row 8, B PR 4): which teammate does a role's work.
 *
 * One resolver, three callers (and ensureRoleTeammates below, which gives a
 * workspace its role teammates the first time an attempt needs one):
 *   - the auto-attempt gate (auto-attempt.ts step 7) asks for the role's
 *     teammate that may work UNATTENDED: autonomy `attempt` and allowed to draft
 *     (`internal-write` among its classes). It reads on the service client, and
 *     it refuses with the gate's own reasons.
 *   - a person's Start (the rail's work card) asks for the role's teammate to
 *     work a task the person approved: any teammate holding the role whose
 *     autonomy is not `off`. It reads on the person's session client, so RLS
 *     decides which teammates they can hand work to (a private team's stay out).
 *   - a teammate handoff (delegation.ts, `delegate`) asks for the role's
 *     teammate that will draft the handed-over work: not `off`, not a system
 *     teammate, on a team the root's person can see, and allowed to draft —
 *     the run is the drafting ceiling narrowed to that teammate, so a read-only
 *     holder could not produce the document or draft it is asked for. These are
 *     the chat admission RPC's filters and order (_admit_chat_work_delegation,
 *     migration 299), applied in the query so the roster limit never hides a
 *     holder.
 *
 * The role's default is its OLDEST such teammate (created_at, id breaking a
 * tie; `roleHolders` below is the one place that order lives). There
 * is no per-role default setting yet; the settings surface (row 9) edits roles
 * and autonomy, and this rule is what "the workspace default per role" means
 * until a setting says otherwise. System teammates never route: their role is
 * NULL by a CHECK (migration 283).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isWorkRole, type WorkRole } from './roles'

/** How many teammates of one role the resolver looks at (the gate's roster size). */
export const ROLE_ROSTER_LIMIT = 20

export interface RoutedTeammate {
  id: string
  name: string
  /** Null only for a teammate a card names by id that holds no role. */
  role: WorkRole | null
  autonomy: string
  allowed_side_effects: string[]
}

export type RoleRouting =
  | { teammate: RoutedTeammate; roster: RoutedTeammate[] }
  | { teammate: null; roster: RoutedTeammate[]; reason: 'no_teammate' | 'teammate_not_attempt' | 'teammate_cannot_draft' | 'teammate_off' }
  | { error: string }

/** Why a teammate may run unattended: it attempts, and it may write drafts. */
export function mayAttempt(m: Pick<RoutedTeammate, 'autonomy' | 'allowed_side_effects'>): boolean {
  return m.autonomy === 'attempt' && m.allowed_side_effects.includes('internal-write')
}

/**
 * A role's holders in one workspace, the role's default first: oldest
 * (created_at), id breaking a tie. System teammates and work bots
 * (`fronts_only`, migration 302) are never among them by construction: both
 * CHECKs force their role NULL, and this filters on the role.
 */
function roleHolders<Columns extends string>(
  supabase: SupabaseClient,
  workspaceId: string,
  role: WorkRole,
  columns: Columns,
) {
  return supabase
    .from('ai_team_member')
    .select(columns)
    .eq('workspace_id', workspaceId)
    .eq('role', role)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
}

/**
 * The id of the role's default teammate (its oldest holder) whatever its
 * autonomy, or null when no teammate holds the role. For callers that only
 * need a FACE for work that is already running, not a teammate to hand work
 * to: the gate and a person's Start go through resolveRoleTeammate, which
 * filters on autonomy. Throws on a failed read; the caller picks the fallback.
 */
export async function roleDefaultTeammateId(
  supabase: SupabaseClient,
  workspaceId: string,
  role: WorkRole,
): Promise<string | null> {
  const { data, error } = await roleHolders(supabase, workspaceId, role, 'id').eq('is_system', false).limit(1)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ id?: string }>)[0]?.id ?? null
}

/**
 * Give a workspace its role teammates (Researcher, Writer, Correspondent,
 * Developer) the first time its role work needs one. Attempts are on by
 * default (Liam, 2026-10-17: opinionated platform, no configuration fatigue),
 * so a new workspace must not wait for someone to open Settings → Autonomy to
 * get the teammates an attempt routes to.
 *
 * It seeds ONLY a workspace where no teammate holds any role yet. A workspace
 * that has role teammates and lacks one role got there by a person's choice
 * (they removed it, or took its role away), and an unattended run must not
 * undo that; switching autonomy back on from Off (PATCH agent-autonomy) is the
 * explicit way to fill every missing role again.
 *
 * `seed_role_teammates` (migration 318) is idempotent: it takes a per-workspace
 * advisory lock and skips every role already held, so two verdicts racing here
 * create one set. It needs the service role (granted to service_role only).
 * Returns how many teammates it created, 0 when it did not need to; never
 * throws.
 */
export async function ensureRoleTeammates(
  service: SupabaseClient,
  args: { workspaceId: string; createdBy?: string | null },
): Promise<{ seeded: number } | { error: string }> {
  try {
    const held = await service
      .from('ai_team_member')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', args.workspaceId)
      .not('role', 'is', null)
    if (held.error) return { error: held.error.message }
    if ((held.count ?? 0) > 0) return { seeded: 0 }
    const { data, error } = await service.rpc('seed_role_teammates', {
      p_workspace_id: args.workspaceId,
      p_created_by: args.createdBy ?? null,
    })
    if (error) return { error: error.message }
    return { seeded: typeof data === 'number' ? data : 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** A roster row from an ai_team_member read (columns: ROSTER_COLUMNS). */
const ROSTER_COLUMNS = 'id, name, role, autonomy, allowed_side_effects, created_at'

function toRoster(data: unknown): RoutedTeammate[] {
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((m) => isWorkRole(m.role))
    .map((m) => ({
      id: m.id as string,
      name: (m.name as string) ?? '',
      role: m.role as WorkRole,
      autonomy: (m.autonomy as string) ?? 'propose',
      allowed_side_effects: Array.isArray(m.allowed_side_effects) ? (m.allowed_side_effects as string[]) : [],
    }))
}

export async function resolveRoleTeammate(
  supabase: SupabaseClient,
  args: { workspaceId: string; role: WorkRole; purpose: 'attempt' | 'start' | 'delegate'; requestingUserId?: string | null },
): Promise<RoleRouting> {
  if (args.purpose === 'delegate' && args.requestingUserId === undefined) {
    return { error: 'A handoff routes for its requesting user' }
  }
  // A service-role delegation has no session RLS. Its root's human identity
  // must explicitly fence private teammates, including every later handoff.
  let allowedTeams: string[] | undefined
  if (args.requestingUserId !== undefined) {
    if (!args.requestingUserId) return { error: 'Delegation has no requesting user' }
    const { data: member, error: memberError } = await supabase.from('member').select('id')
      .eq('workspace_id', args.workspaceId).eq('user_id', args.requestingUserId).maybeSingle()
    if (memberError || !member) return { error: 'Requester is no longer a workspace member' }
    const { data: teams, error: teamError } = await supabase.from('team').select('id, is_private').eq('workspace_id', args.workspaceId)
    if (teamError) return { error: 'Could not read teammate visibility' }
    const privateIds = (teams ?? []).filter((t) => t.is_private === true).map((t) => t.id as string)
    const privateMemberships = privateIds.length > 0
      ? await supabase.from('team_member').select('team_id').eq('member_id', member.id).in('team_id', privateIds)
      : { data: [], error: null }
    if (privateMemberships.error) return { error: 'Could not read private-team membership' }
    const privateAccess = new Set((privateMemberships.data ?? []).map((t) => t.team_id))
    allowedTeams = (teams ?? []).filter((t) => t.is_private === false || privateAccess.has(t.id)).map((t) => t.id as string)
    if (allowedTeams.length === 0) return { teammate: null, roster: [], reason: 'no_teammate' }
  }

  if (args.purpose === 'delegate') {
    const teams = allowedTeams ?? []
    const enabled = () => roleHolders(supabase, args.workspaceId, args.role, ROSTER_COLUMNS)
      .eq('is_system', false)
      .neq('autonomy', 'off')
      .in('team_id', teams)
    const drafting = await enabled().contains('allowed_side_effects', ['internal-write']).limit(1)
    if (drafting.error) return { error: drafting.error.message }
    const drafters = toRoster(drafting.data)
    if (drafters[0]) return { teammate: drafters[0], roster: drafters }
    // None may draft: say whether any enabled holder exists at all.
    const any = await enabled().limit(1)
    if (any.error) return { error: any.error.message }
    const others = toRoster(any.data)
    return { teammate: null, roster: others, reason: others.length > 0 ? 'teammate_cannot_draft' : 'no_teammate' }
  }

  let query = roleHolders(supabase, args.workspaceId, args.role, ROSTER_COLUMNS)
  if (allowedTeams) query = query.in('team_id', allowedTeams)
  const { data, error } = await query.limit(ROLE_ROSTER_LIMIT)
  if (error) return { error: error.message }
  const roster = toRoster(data)
  if (roster.length === 0) return { teammate: null, roster, reason: 'no_teammate' }

  if (args.purpose === 'start') {
    const teammate = roster.find((m) => m.autonomy !== 'off')
    return teammate ? { teammate, roster } : { teammate: null, roster, reason: 'teammate_off' }
  }

  // Unattended: the same order of refusals the gate always gave.
  const attempting = roster.filter((m) => m.autonomy === 'attempt')
  if (attempting.length === 0) return { teammate: null, roster, reason: 'teammate_not_attempt' }
  const teammate = attempting.find(mayAttempt)
  return teammate ? { teammate, roster } : { teammate: null, roster, reason: 'teammate_cannot_draft' }
}

/**
 * The teammate a person's Start hands a work card to: the one the card names
 * (`payload.assignee_ai_member_id`, when it is a routable teammate this person
 * can see in the card's workspace), else the default for the card's role, else
 * none (the run proceeds as before, with no persona). Never throws; a failed
 * read routes to no one rather than blocking the Start.
 */
export async function resolveStartTeammate(
  supabase: SupabaseClient,
  args: { workspaceId: string; payload: { role?: unknown; assignee_ai_member_id?: unknown } },
): Promise<RoutedTeammate | null> {
  try {
    const named = args.payload.assignee_ai_member_id
    if (typeof named === 'string' && named) {
      const { data } = await supabase
        .from('ai_team_member')
        .select('id, name, role, autonomy, allowed_side_effects, is_system, fronts_only')
        .eq('id', named)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle()
      const m = data as Record<string, unknown> | null
      // Never a system teammate or a work bot (fronts_only): neither takes work.
      if (m && !m.is_system && m.fronts_only !== true && m.autonomy !== 'off') {
        return {
          id: m.id as string,
          name: (m.name as string) ?? '',
          role: isWorkRole(m.role) ? m.role : null,
          autonomy: (m.autonomy as string) ?? 'propose',
          allowed_side_effects: Array.isArray(m.allowed_side_effects) ? (m.allowed_side_effects as string[]) : [],
        }
      }
    }
    if (!isWorkRole(args.payload.role)) return null
    const routed = await resolveRoleTeammate(supabase, { workspaceId: args.workspaceId, role: args.payload.role, purpose: 'start' })
    return 'teammate' in routed ? routed.teammate : null
  } catch {
    return null
  }
}
