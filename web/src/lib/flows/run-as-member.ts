/**
 * The member a loop fire runs AS — and therefore whose Activity feed its ledger
 * row appears in. The flow's creator when they are still a member (the PATCH
 * route re-stamps created_by to whoever last edited the flow), else the
 * workspace owner, else nobody. Mirrors the run-skill executor's run-as
 * resolution and the failed-run notifier's recipient lookup.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export async function resolveRunAsMemberId(
  supabase: SupabaseClient,
  workspaceId: string,
  preferredUserId: string | null,
): Promise<string | null> {
  try {
    if (preferredUserId) {
      const { data: m } = await supabase
        .from('member')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', preferredUserId)
        .maybeSingle()
      if (m?.id) return m.id as string
    }
    const { data: owner } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle()
    return (owner?.id as string | undefined) ?? null
  } catch {
    return null
  }
}
