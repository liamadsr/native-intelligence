/**
 * Workspace fences for client-supplied ids. A foreign key only proves a row
 * exists; it does not prove it belongs to the caller's workspace, so any id a
 * request supplies for a workspace-scoped relation is checked here before it
 * is written. Extracted from the attention-items route (Sequence step 1) so
 * the actions POST route, the proposed-changes PATCH route and the apply
 * engine fence `assignee_ai_member_id` the same way `PATCH /actions/[id]`
 * always has.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Tables whose rows carry their own workspace_id column. */
export type WorkspaceScopedTable = 'projects' | 'member' | 'ai_team_member'

/** True iff a row with this id exists in the table AND belongs to the workspace. */
export async function existsInWorkspace(
  supabase: SupabaseClient,
  table: WorkspaceScopedTable,
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return !!data
}

/**
 * The refusal for an assignee teammate that isn't one of this workspace's
 * ASSIGNABLE teammates: another workspace's, a built-in loop's, or a loop's
 * work bot (isAssignableTeammate).
 */
export const FOREIGN_AI_MEMBER_ERROR =
  'assignee_ai_member_id must be an assignable AI teammate of this workspace (not a built-in loop or a loop’s agent)'

/**
 * True iff `id` is a teammate of the workspace that may be ASSIGNED work: not a
 * system teammate (a built-in loop's attribution, row 4) and not a work bot
 * (`fronts_only`, migration 302: a bot made for a loop speaks for work and
 * takes none). Every write that names an assignee teammate fences through
 * this, so a work bot can't be handed an action whose agent run would start on
 * an identity anchor (loadAgentPersona refuses those). The flags are read and
 * checked here, not filtered in the query, so a missing flag reads as false.
 */
export async function isAssignableTeammate(
  supabase: SupabaseClient,
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('ai_team_member')
    .select('id, is_system, fronts_only')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const row = data as { id?: string; is_system?: boolean | null; fronts_only?: boolean | null } | null
  return !!row?.id && row.is_system !== true && row.fronts_only !== true
}

/** Whether a teammate row may be assigned work (the in-memory twin of isAssignableTeammate). */
export function assignableTeammateRow(row: { is_system?: unknown; fronts_only?: unknown } | null | undefined): boolean {
  return !!row && row.is_system !== true && row.fronts_only !== true
}
