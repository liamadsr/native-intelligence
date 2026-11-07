/**
 * What the person may see, for the page cards' reads (./page-server.ts).
 *
 * `show` and `read_card` run on the service client, which RLS does not fence.
 * Lists drawn by the views system take the shared visibility fence
 * (src/lib/views/visibility-fence.ts: actions of visible teams, visible
 * contacts and companies). The page cards read a few tables that fence does
 * not cover, and each applies here, by hand, the visibility the page itself
 * has under RLS (the policies are named on each helper). A name lookup goes
 * through these too, so a refusal never lists a record the person could not
 * open.
 */
import { fenceOf, type CardScope } from './server'

export type FenceScope = CardScope

/** The person's member row in the workspace, or null when they have none. */
export async function memberOf(scope: FenceScope): Promise<{ id: string } | null> {
  const fence = await fenceOf(scope)
  return fence.memberId ? { id: fence.memberId } : null
}

/** The teams the person belongs to (team_member), by id. */
export async function myTeamIds(scope: FenceScope, memberId: string): Promise<Set<string>> {
  const { data, error } = await scope.supabase.from('team_member').select('team_id').eq('member_id', memberId)
  if (error) throw new Error(`could not read team membership: ${error.message}`)
  return new Set(((data ?? []) as Array<{ team_id: string }>).map((r) => r.team_id))
}

export interface VisibleTeam {
  id: string
  name: string
  is_private: boolean
}

/**
 * The workspace's teams the person can see: `team` RLS ("Users can view
 * accessible teams") is `is_workspace_member AND (NOT is_private OR
 * is_team_member)`. A private team's board, name and actions are its members'
 * alone.
 */
export async function visibleTeams(scope: FenceScope): Promise<VisibleTeam[]> {
  // The shared fence already knows which teams the person sees.
  const fence = await fenceOf(scope)
  if (!fence.memberId || fence.visibleTeamIds.length === 0) return []
  const { data, error } = await scope.supabase
    .from('team')
    .select('id, name, is_private')
    .eq('workspace_id', scope.workspaceId)
    .in('id', fence.visibleTeamIds)
    .order('name')
    .limit(500)
  if (error) throw new Error(`could not read teams: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; name: string; is_private: boolean | null }>).map((t) => ({
    id: t.id,
    name: t.name,
    is_private: t.is_private !== false,
  }))
}

/**
 * An embedded bot on a row (flows carry `bot:ai_team_member_id(id, name, …)`)
 * that the person cannot see, blanked. `ai_team_member` RLS ("Workspace
 * members can view AI team members") is a system bot, or one whose team is
 * visible: a bot on a private team the person is not on is that team's.
 */
export async function scrubHiddenBots(
  scope: FenceScope,
  rows: Record<string, unknown>[],
  visibleTeamIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  const botId = (row: Record<string, unknown>) => {
    const bot = row.bot as { id?: unknown } | null | undefined
    return bot && typeof bot.id === 'string' ? bot.id : null
  }
  const ids = [...new Set(rows.map(botId).filter((id): id is string => !!id))]
  if (ids.length === 0) return rows
  const { data, error } = await scope.supabase
    .from('ai_team_member')
    .select('id, team_id, is_system')
    .eq('workspace_id', scope.workspaceId)
    .in('id', ids)
  if (error) throw new Error(`could not check bots: ${error.message}`)
  const teams = new Set(visibleTeamIds)
  const seen = new Set(
    ((data ?? []) as Array<{ id: string; team_id: string | null; is_system: boolean | null }>)
      .filter((b) => b.is_system === true || (!!b.team_id && teams.has(b.team_id)))
      .map((b) => b.id),
  )
  return rows.map((row) => {
    const id = botId(row)
    return id && !seen.has(id) ? { ...row, bot: null } : row
  })
}

export interface PackageRow {
  id: string
  name: string
  visibility: string
  team_id: string | null
  created_by: string
}

/**
 * The knowledge packages the person can see: `package_row_visible_to`
 * (migration 124 and on): a workspace package, one they made, a team package
 * of a team they are in, or one shared with them or one of their teams.
 */
export async function visiblePackages<T extends PackageRow>(scope: FenceScope, rows: T[]): Promise<T[]> {
  const member = await memberOf(scope)
  if (!member || rows.length === 0) return []
  const teams = await myTeamIds(scope, member.id)
  const open = rows.filter((p) => p.visibility === 'workspace' || p.created_by === scope.userId || (p.visibility === 'team' && !!p.team_id && teams.has(p.team_id)))
  const rest = rows.filter((p) => !open.includes(p))
  if (rest.length === 0) return open
  const { data, error } = await scope.supabase
    .from('knowledge_package_share')
    .select('package_id, shared_with_member_id, shared_with_team_id')
    .in('package_id', rest.map((p) => p.id))
  if (error) throw new Error(`could not read package shares: ${error.message}`)
  const shared = new Set(
    ((data ?? []) as Array<{ package_id: string; shared_with_member_id: string | null; shared_with_team_id: string | null }>)
      .filter((s) => s.shared_with_member_id === member.id || (!!s.shared_with_team_id && teams.has(s.shared_with_team_id)))
      .map((s) => s.package_id),
  )
  return rows.filter((p) => open.includes(p) || shared.has(p.id))
}

/**
 * A library item (agent or skill, `recipe`) the person can see in this
 * workspace: `recipe_select_visibility` lets through a system item, a public
 * one, or the workspace's own when it is workspace-wide or theirs.
 */
export function recipeVisible(
  row: { is_system?: boolean | null; visibility?: string | null; workspace_id?: string | null; created_by?: string | null },
  scope: FenceScope,
): boolean {
  if (row.is_system) return true
  if (row.workspace_id !== scope.workspaceId) return false
  if (row.visibility === 'workspace' || row.visibility === 'public') return true
  return row.visibility === 'personal' && row.created_by === scope.userId
}

/**
 * An eval case the person can see: `eval_case_member_select` is a workspace
 * case, or a private one they made. As a PostgREST `or` filter.
 */
export function evalCaseFence(userId: string): string {
  return `visibility.eq.workspace,created_by.eq.${userId}`
}
