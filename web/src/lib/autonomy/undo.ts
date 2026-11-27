/**
 * The Undo of an action the agent was about to take on its own
 * (docs/plans/earned-autonomy.md §5): the person's Dismiss of its card in the
 * undo window. Called from safety/approvals.ts denyToolCall, so it imports
 * nothing from there. Liam, 11-27, decision 4: "one undo or complaint drops
 * the kind back to 'ask', with a 14-day cooldown" (rules.ts reads demoted_at).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The person dismissed the cards of these approvals: any still scheduled is
 * UNDONE (it never runs), recorded as `undone`, and its kind goes straight
 * back to ask (decision 4). Returns the approval ids undone. Never throws.
 */
export async function undoScheduledActions(db: SupabaseClient, approvalIds: readonly string[]): Promise<Set<string>> {
  const undone = new Set<string>()
  if (!approvalIds.length) return undone
  try {
    const nowIso = new Date().toISOString()
    const { data, error } = await db
      .from('autonomy_action')
      .update({ status: 'undone', settled_at: nowIso, reason: 'stopped in its undo window' })
      .in('approval_id', [...approvalIds])
      .eq('status', 'scheduled')
      .select('id, workspace_id, user_id, approval_id, kind_key, tool')
    if (error) return undone
    for (const a of (data ?? []) as Array<{ id: string; workspace_id: string; user_id: string; approval_id: string; kind_key: string; tool: string }>) {
      undone.add(a.approval_id)
      const [, channelKey = 'unknown', audience = 'none'] = a.kind_key.split('|')
      await db.from('autonomy_outcome').upsert(
        { workspace_id: a.workspace_id, user_id: a.user_id, kind_key: a.kind_key, tool: a.tool, channel: channelKey.startsWith('app:') ? 'app' : channelKey, audience, source: 'autonomy_action', source_id: a.id, outcome: 'undone', edit_ratio: null },
        { onConflict: 'source,source_id,outcome', ignoreDuplicates: true },
      )
      await db
        .from('autonomy_kind')
        .update({ level: 'ask', demoted_at: nowIso, updated_at: nowIso })
        .eq('workspace_id', a.workspace_id)
        .eq('user_id', a.user_id)
        .eq('kind_key', a.kind_key)
    }
  } catch (err) {
    console.warn('[earned-autonomy] undo failed', err instanceof Error ? err.message : String(err))
  }
  return undone
}
