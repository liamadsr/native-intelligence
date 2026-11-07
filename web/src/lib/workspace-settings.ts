/**
 * One read of `workspace.settings` for callers that need SEVERAL of the
 * policies stored in that jsonb blob.
 *
 * Trust policy, the claims auto-accept projection, the workspace edition (+ its
 * feature overrides), and the compute policy all live as sibling keys on the
 * SAME `workspace.settings` column. Each has a `resolveX(supabase, workspaceId)`
 * fetcher that does its own `select('settings')`, which is exactly right for a
 * caller that needs one of them — and exactly wrong for one that needs three:
 * the live-agent turn path (src/app/api/ai/live-agent/route.ts) was doing
 * three serial round-trips for one row on a route
 * that fires every ~3 seconds during an active recording.
 *
 * This is the shared fetch half. Pair it with the pure `…FromSettings`
 * normalizers:
 *
 *   const settings = await fetchWorkspaceSettings(supabase, workspaceId)
 *   const trust = resolveTrustPolicyFromSettings(settings)
 *   const claims = resolveClaimsAutoAcceptPolicyFromSettings(settings)
 *   const edition = resolveWorkspaceEditionFromSettings(settings)
 *
 * FAIL-OPEN, like every resolver it feeds: on any error (missing row, RLS,
 * network) it returns `null`, and every normalizer maps `null` to its own pure
 * default. So a failed read degrades to exactly the behavior the individual
 * fetchers' catch blocks produce — never a throw, never a different policy.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Read a workspace's raw `settings` blob. Never throws — returns `null` on any
 * failure (or a missing row), which every `…FromSettings` normalizer treats as
 * "no settings" and answers with its pure default. Works with both a
 * user-session client (RLS) and a service-role client.
 */
export async function fetchWorkspaceSettings(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<unknown> {
  try {
    const { data } = await supabase
      .from('workspace')
      .select('settings')
      .eq('id', workspaceId)
      .maybeSingle()
    return data?.settings ?? null
  } catch {
    return null
  }
}
