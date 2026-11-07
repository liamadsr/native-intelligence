/**
 * The visibility fence: what a person may see, for list queries that run on a
 * SERVICE-ROLE client (the chat's tool route, P1's show and read_card cards,
 * and the kinds after them). RLS hides these rows from the person's own client,
 * but service role bypasses RLS, and the policies key off auth.uid(), which is
 * NULL there. So the fence restates each policy as plain query predicates, on
 * the query itself, so a page's count is right, not just its rows:
 *
 *   actions   their team must be visible: a public team of the workspace, or a
 *             private one the person is on (actions_select through team's
 *             "Users can view accessible teams", migrations 017 and 028);
 *   contacts  the contact_select_visibility policy's can_view_contact
 *             (migration 058; contact_visible_to, migration 234, is its
 *             explicit-user twin): workspace-wide, created by them, an owner or
 *             admin, team-visible and created by someone on one of their teams,
 *             or shared with them or one of their teams;
 *   companies the company_select_with_visible_contacts policy (migration 059):
 *             an owner or admin sees all; anyone else, companies with at least
 *             one contact they can see (merged contacts count, as they do in
 *             the policy);
 *   captures  their own private ones only, never eval captures: already in
 *             buildEntityQuery (visibility + is_eval) for every caller;
 *   documents workspace documents, and their own private ones (document_select,
 *             migration 369: a private document is its creator's alone, no
 *             admin override).
 *
 * Projects and initiatives are visible to every workspace member (their
 * policies are is_workspace_member alone), so they need no fence.
 *
 * resolveVisibilityFence reads the person's membership once; buildEntityQuery
 * applies it when handed one (QueryOptions.visibility), and the helpers below
 * answer the same question for one row or a few ids. It fails closed: no
 * membership in the workspace, nothing visible.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface VisibilityFence {
  workspaceId: string
  userId: string
  /** The person's member row in the workspace; null when they are not a member (nothing is visible). */
  memberId: string | null
  /** A workspace owner or admin: sees every contact and company. */
  isAdmin: boolean
  /** Teams whose actions the person sees: the public ones and the private ones they are on. */
  visibleTeamIds: string[]
  /**
   * The contact predicate as a PostgREST `or` filter, or null when every
   * contact is visible (an owner or admin). Never empty for a member: their
   * own and the workspace-wide contacts are always in it.
   */
  contactOr: string | null
}

/** A fence that lets nothing through (not a member, or the lookup failed). */
function closed(workspaceId: string, userId: string): VisibilityFence {
  return { workspaceId, userId, memberId: null, isAdmin: false, visibleTeamIds: [], contactOr: null }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids safe to paste into a PostgREST list. */
function ids(values: Iterable<unknown>): string[] {
  return [...new Set([...values].filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))]
}

/** Read what `userId` may see in `workspaceId`. Throws on a read error (the caller refuses the page). */
export async function resolveVisibilityFence(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<VisibilityFence> {
  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('id, role')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (memberError) throw new Error(`membership lookup failed: ${memberError.message}`)
  const me = member as { id?: string; role?: string } | null
  if (!me?.id) return closed(workspaceId, userId)
  const isAdmin = me.role === 'owner' || me.role === 'admin'

  const [teamsRes, seatsRes] = await Promise.all([
    supabase.from('team').select('id, is_private').eq('workspace_id', workspaceId),
    supabase.from('team_member').select('team_id').eq('member_id', me.id),
  ])
  if (teamsRes.error) throw new Error(`team lookup failed: ${teamsRes.error.message}`)
  if (seatsRes.error) throw new Error(`team membership lookup failed: ${seatsRes.error.message}`)
  const myTeams = new Set(ids(((seatsRes.data ?? []) as Array<{ team_id: string }>).map((s) => s.team_id)))
  const workspaceTeams = (teamsRes.data ?? []) as Array<{ id: string; is_private: boolean | null }>
  // Only an explicit false is public (the column is NOT NULL DEFAULT false).
  const visibleTeamIds = ids(workspaceTeams.filter((t) => t.is_private === false || myTeams.has(t.id)).map((t) => t.id))
  const myWorkspaceTeams = ids(workspaceTeams.filter((t) => myTeams.has(t.id)).map((t) => t.id))

  if (isAdmin) return { workspaceId, userId, memberId: me.id, isAdmin, visibleTeamIds, contactOr: null }

  const [matesRes, sharesRes] = await Promise.all([
    myWorkspaceTeams.length
      ? supabase.from('team_member').select('member_id').in('team_id', myWorkspaceTeams)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('contact_share')
      .select('contact_id')
      .or(
        [`shared_with_member_id.eq.${me.id}`, ...(myWorkspaceTeams.length ? [`shared_with_team_id.in.(${myWorkspaceTeams.join(',')})`] : [])].join(','),
      ),
  ])
  if (matesRes.error) throw new Error(`teammate lookup failed: ${matesRes.error.message}`)
  if (sharesRes.error) throw new Error(`contact share lookup failed: ${sharesRes.error.message}`)
  const teammates = ids(((matesRes.data ?? []) as Array<{ member_id: string }>).map((m) => m.member_id))
  const shared = ids(((sharesRes.data ?? []) as Array<{ contact_id: string }>).map((s) => s.contact_id))

  const contactOr = [
    'visibility.eq.workspace',
    `created_by_member_id.eq.${me.id}`,
    ...(teammates.length ? [`and(visibility.eq.team,created_by_member_id.in.(${teammates.join(',')}))`] : []),
    ...(shared.length ? [`id.in.(${shared.join(',')})`] : []),
  ].join(',')
  return { workspaceId, userId, memberId: me.id, isAdmin, visibleTeamIds, contactOr }
}

/**
 * The embed a fenced company query carries (buildEntityQuery adds it to the
 * select): the company's contacts, inner-joined, so only companies with at
 * least one contact the person can see come back, and the count agrees.
 */
export const COMPANY_FENCE_EMBED = 'visible_contacts'
export const COMPANY_FENCE_SELECT = `${COMPANY_FENCE_EMBED}:contact!inner(id, visibility, created_by_member_id)`

// The query builder's chain, structurally (it is typed off buildEntityQuery).
interface FenceableQuery {
  in(column: string, values: readonly string[]): unknown
  or(filters: string, opts?: { referencedTable?: string }): unknown
  eq(column: string, value: string): unknown
}

/** A UUID no row has: the fence's way of matching nothing. */
const NOTHING = '00000000-0000-0000-0000-000000000000'

/** Apply the fence to a query buildEntityQuery built for `entityType`. */
export function applyVisibilityFence(query: FenceableQuery, entityType: string, fence: VisibilityFence): void {
  if (!fence.memberId) {
    query.eq('id', NOTHING)
    return
  }
  if (entityType === 'action') query.in('team_id', fence.visibleTeamIds)
  else if (entityType === 'document') query.or(documentFenceOr(fence))
  else if (entityType === 'contact' && fence.contactOr) query.or(fence.contactOr)
  else if (entityType === 'company' && fence.contactOr) {
    query.or(fence.contactOr, { referencedTable: COMPANY_FENCE_EMBED })
  }
}

/** The document predicate (migration 369): workspace documents, and the person's own private ones. */
export function documentFenceOr(fence: VisibilityFence): string {
  return fence.memberId ? `visibility.eq.workspace,created_by.eq.${fence.memberId}` : 'visibility.eq.workspace'
}

/** Is this document one the person can see? Select `visibility, created_by`. */
export function documentVisible(fence: VisibilityFence, row: { visibility?: unknown; created_by?: unknown }): boolean {
  if (!fence.memberId) return false
  return row.visibility !== 'private' || (typeof row.created_by === 'string' && row.created_by === fence.memberId)
}

/** True when a fenced company query needs the contacts embed in its select. */
export function companyNeedsFenceEmbed(fence: VisibilityFence | undefined): boolean {
  return !!fence && !!fence.memberId && !!fence.contactOr
}

/** Rows as the caller should see them: without the fence's embed. */
export function stripFenceEmbed<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    if (!(COMPANY_FENCE_EMBED in row)) return row
    const { [COMPANY_FENCE_EMBED]: _embed, ...rest } = row
    void _embed
    return rest as T
  })
}

/**
 * Rows with any embedded team the person cannot see blanked out: a document
 * (or any row that embeds `team`) belongs to a private team's people alone, by
 * name too. The row itself stays when its own policy shows it.
 */
export function redactHiddenTeams<T extends Record<string, unknown>>(rows: T[], fence: VisibilityFence): T[] {
  return rows.map((row) => {
    if (!('team' in row) || row.team === null || row.team === undefined) return row
    const teamId = typeof row.team_id === 'string' ? row.team_id : (row.team as { id?: unknown })?.id
    return typeof teamId === 'string' && fence.visibleTeamIds.includes(teamId) ? row : { ...row, team: null }
  })
}

/** Is this action's team one the person can see? */
export function actionVisible(fence: VisibilityFence, row: { team_id?: unknown }): boolean {
  return !!fence.memberId && typeof row.team_id === 'string' && fence.visibleTeamIds.includes(row.team_id)
}

/** The contacts among `contactIds` the person can see. */
export async function visibleContactIds(supabase: SupabaseClient, fence: VisibilityFence, contactIds: string[]): Promise<Set<string>> {
  const wanted = ids(contactIds)
  if (!fence.memberId || wanted.length === 0) return new Set()
  const q = supabase.from('contact').select('id').eq('workspace_id', fence.workspaceId).in('id', wanted)
  if (fence.contactOr) q.or(fence.contactOr)
  const { data, error } = await q
  if (error) throw new Error(`contact visibility check failed: ${error.message}`)
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
}

/** The companies among `companyIds` the person can see. */
export async function visibleCompanyIds(supabase: SupabaseClient, fence: VisibilityFence, companyIds: string[]): Promise<Set<string>> {
  const wanted = ids(companyIds)
  if (!fence.memberId || wanted.length === 0) return new Set()
  if (!fence.contactOr) return new Set(wanted)
  const { data, error } = await supabase
    .from('contact')
    .select('company_id')
    .eq('workspace_id', fence.workspaceId)
    .in('company_id', wanted)
    .or(fence.contactOr)
  if (error) throw new Error(`company visibility check failed: ${error.message}`)
  return new Set(((data ?? []) as Array<{ company_id: string }>).map((r) => r.company_id))
}
