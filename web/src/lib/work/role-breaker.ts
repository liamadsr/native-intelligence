/**
 * The role's circuit breaker (docs/plans/agent-orchestration-product.md §B.1
 * row 6): a role's unattended attempts pause when its last N attempted items
 * were all dismissed. ANY dismissal counts (the ledger records no "opened").
 * Only attempts inside the quiet period, and after the role's manual resume,
 * count — so a paused role retries after a quiet stretch, or at once when
 * someone resumes it. Needs N of them, so a new role is never paused.
 *
 * One reading, two readers: the auto-attempt gate refuses on it, and the
 * Agents page's roster shows it. Needs the SERVICE client — `tracked_job`
 * SELECT is owner-only, and the breaker is a fact about the whole workspace's
 * attempts, not the caller's.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentAutonomyPolicy } from './agent-autonomy-policy'
import type { WorkRole } from './roles'

export type RoleBreakerPolicy = Pick<
  AgentAutonomyPolicy,
  'role_breaker_window' | 'role_breaker_quiet_days' | 'role_breaker_resumed_at'
>

export type RoleBreakerState =
  /** `since` is where the counted window starts (null when the breaker is off). */
  | { open: boolean; window: number; since: string | null }
  | { error: string }

export async function roleBreakerState(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    role: WorkRole
    /** Every teammate holding the role in the workspace. */
    teammateIds: string[]
    policy: RoleBreakerPolicy
    now: Date
  },
): Promise<RoleBreakerState> {
  const window = args.policy.role_breaker_window
  if (window <= 0 || args.teammateIds.length === 0) return { open: false, window, since: null }
  const quietSince = args.now.getTime() - args.policy.role_breaker_quiet_days * 86_400_000
  const resumedAt = Date.parse(args.policy.role_breaker_resumed_at[args.role] ?? '')
  const since = new Date(Number.isFinite(resumedAt) ? Math.max(quietSince, resumedAt) : quietSince).toISOString()
  const { data, error } = await supabase
    .from('tracked_job')
    .select('id, progress, created_at')
    .eq('workspace_id', args.workspaceId)
    .eq('origin', 'attempt')
    .in('ai_team_member_id', args.teammateIds)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(window)
  if (error) return { error: error.message }
  const rows = (data ?? []) as Array<{ progress: { review?: string } | null }>
  return { open: rows.length >= window && rows.every((r) => r.progress?.review === 'dismissed'), window, since }
}
