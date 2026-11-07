/**
 * "Open work": the ONE definition of which actions are someone's (or a
 * project's) unfinished work, so every count and list agrees with
 * `list_actions` and the `my-todo-list` skill:
 *
 *   - top level: a sub-action is part of its parent, never counted alone;
 *   - not dismissed: a dismissed proposal is nobody's work;
 *   - confirmed only, when the caller asks (a person's to-do list): a
 *     meeting's suggestion isn't a to-do until someone accepts it;
 *   - in an open state: backlog, unstarted or started. An action whose state
 *     doesn't resolve counts as open (actions.status_id is NOT NULL since
 *     migration 020, so this is belt and braces, never a reason to drop a row);
 *   - for a person: assigned through the `action_assignee` join table, the
 *     record of who holds an action (the `assignee_id` column is only the
 *     first assignee).
 *
 * Used by get_dashboard_summary, list_projects' progress, get_project_context
 * and the email-draft contact context. `list_actions` applies the same rules
 * with its own status and confirmation params.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Workflow-state categories that count as open work. */
export const OPEN_STATE_CATEGORIES = ['backlog', 'unstarted', 'started'] as const

/** Workflow-state categories that close an action. */
export const CLOSED_STATE_CATEGORIES = ['completed', 'canceled'] as const

export interface OpenWorkOptions {
  /** Accepted work only (a person's to-do list); otherwise confirmed and suggested. */
  confirmedOnly?: boolean
}

/** True when a state category counts as open; a missing category does. */
export function isOpenStateCategory(category: string | null | undefined): boolean {
  return !category || (OPEN_STATE_CATEGORIES as readonly string[]).includes(category)
}

/** The in-memory twin of {@link filterOpenWork}, for rows already read. */
export function isOpenWork(
  row: { parent_id?: string | null; confirmation?: string | null; category?: string | null },
  options: OpenWorkOptions = {},
): boolean {
  if (row.parent_id) return false
  if (row.confirmation === 'dismissed') return false
  if (options.confirmedOnly && row.confirmation !== 'confirmed') return false
  return isOpenStateCategory(row.category)
}

/** True when a row counts at all (top level, not dismissed, confirmed when asked), whatever its state. */
export function countsAsWork(
  row: { parent_id?: string | null; confirmation?: string | null },
  options: OpenWorkOptions = {},
): boolean {
  return isOpenWork({ ...row, category: null }, options)
}

/** The workspace's closed workflow states, all and completed alone. */
export interface ClosedStates {
  /** Every state in a closed category (completed or canceled). */
  ids: string[]
  /** The completed ones. */
  completedIds: string[]
}

/** Read the ids of the workspace's closed workflow states (two small queries). */
export async function loadClosedStates(supabase: SupabaseClient, workspaceId: string): Promise<ClosedStates> {
  const { data: teams } = await supabase.from('team').select('id').eq('workspace_id', workspaceId)
  const teamIds = ((teams ?? []) as Array<{ id: string }>).map((t) => t.id)
  if (teamIds.length === 0) return { ids: [], completedIds: [] }
  const { data: states } = await supabase
    .from('workflow_state')
    .select('id, category')
    .in('team_id', teamIds)
    .in('category', [...CLOSED_STATE_CATEGORIES])
  const rows = (states ?? []) as Array<{ id: string; category: string }>
  return {
    ids: rows.map((s) => s.id),
    completedIds: rows.filter((s) => s.category === 'completed').map((s) => s.id),
  }
}

/**
 * The embed an actions query selects to filter by assignee through the join
 * table: add it to the select, then pass `memberId` to {@link filterOpenWork}.
 */
export const OPEN_WORK_ASSIGNEE_EMBED = 'assigned:action_assignee!inner(member_id)'

/** The PostgREST filters this needs, as a Supabase query builder exposes them. */
interface FilterChain {
  is(column: string, value: null): FilterChain
  eq(column: string, value: unknown): FilterChain
  neq(column: string, value: unknown): FilterChain
  or(filters: string): FilterChain
}

/**
 * Narrow an `actions` query to open work. `closedStateIds` comes from
 * {@link loadClosedStates}: excluding the closed states (rather than an inner
 * join on the open ones) keeps a row whose state doesn't resolve. `memberId`
 * needs {@link OPEN_WORK_ASSIGNEE_EMBED} in the select.
 */
export function filterOpenWork<T>(
  query: T,
  options: OpenWorkOptions & { closedStateIds: readonly string[]; memberId?: string },
): T {
  // Unconstrained T + a local cast: a recursive `T extends Filterable<T>` over
  // Supabase's builder type hit TS2589 in Next's production type check.
  let q = (query as unknown as FilterChain).is('parent_id', null)
  q = options.confirmedOnly ? q.eq('confirmation', 'confirmed') : q.neq('confirmation', 'dismissed')
  if (options.memberId) q = q.eq('assigned.member_id', options.memberId)
  // State ids come from the database (uuids), never from the model, so they
  // are safe to splice into the filter string.
  if (options.closedStateIds.length > 0) {
    q = q.or(`status_id.is.null,status_id.not.in.(${options.closedStateIds.join(',')})`)
  }
  return q as unknown as T
}
