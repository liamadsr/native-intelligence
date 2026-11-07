/**
 * The live agent → main agent bridge (one-chat rework: the live agent's chat
 * moves into the HUD and goes away with the call). When a capture is
 * processed, what the live agent left open rides its `capture.processed`
 * event as COUNTS (the capture id is the pointer: the asks live in its
 * conversation, the proposals on the capture):
 *   • openAsks          its questions nobody answered in the call: assistant
 *                       messages in the capture's conversation tagged
 *                       `ask_user` whose picker is still open
 *                       (conversation-writer.ts hasPendingLiveQuestion's test);
 *   • pendingProposals  the changes the live agent staged on the capture
 *                       while the call ran (proposed_change, status pending,
 *                       created up to the capture's end: the batch
 *                       extraction's come after it) that still wait.
 * Only for a capture that HAD a live agent (it has a conversation of its own,
 * migration 173): a batch-only capture's proposals are its ordinary review
 * pile, said quietly.
 * With either, the router makes the event a home turn (router.ts
 * turnRuleFor 'live_followups'), so the main agent picks them up after the
 * call. Never a message body. Never throws: a failed read counts nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The most recent ask messages looked at. */
const ASK_ROWS = 20

export interface LiveFollowups {
  openAsks?: number
  pendingProposals?: number
}

/** True when a stored ask_user message still has its picker open. Pure. */
export function isOpenAsk(uiMessage: unknown): boolean {
  const parts = (uiMessage as { parts?: Array<{ type?: unknown; state?: unknown }> } | null)?.parts
  return Array.isArray(parts) && parts.some((p) => p?.type === 'tool-ask_user' && p.state === 'input-available')
}

export async function captureLiveFollowups(supabase: SupabaseClient, args: { workspaceId: string; captureId: string }): Promise<LiveFollowups> {
  const out: LiveFollowups = {}
  let conversationIds: string[] = []
  try {
    // One is expected (a unique index), but never assume it: several are all read.
    const { data: convs, error } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('capture_id', args.captureId)
      .eq('workspace_id', args.workspaceId)
      .limit(5)
    if (error) return out
    conversationIds = ((convs as Array<{ id?: unknown }> | null) ?? []).map((c) => c.id).filter((id): id is string => typeof id === 'string')
  } catch {
    return out
  }
  // No live agent in this meeting: nothing of its was left open.
  if (!conversationIds.length) return out
  try {
    const { data: asks, error } = await supabase
      .from('chat_messages')
      .select('ui_message')
      .in('conversation_id', conversationIds)
      .eq('role', 'assistant')
      .filter('ui_message->metadata->>kind', 'eq', 'ask_user')
      .order('created_at', { ascending: false })
      .limit(ASK_ROWS)
    if (!error) {
      const open = ((asks as Array<{ ui_message?: unknown }> | null) ?? []).filter((r) => isOpenAsk(r.ui_message)).length
      if (open > 0) out.openAsks = open
    }
  } catch {
    // No asks known.
  }
  try {
    // Only what the LIVE agent staged: proposals made while the call ran (up
    // to its end), not the batch extraction's, which come after it.
    const { data: capture, error: captureError } = await supabase
      .from('captures')
      .select('ended_at')
      .eq('id', args.captureId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    const endedAt = (capture as { ended_at?: unknown } | null)?.ended_at
    if (!captureError && typeof endedAt === 'string') {
      const { count, error } = await supabase
        .from('proposed_change')
        .select('id', { count: 'exact', head: true })
        .eq('capture_id', args.captureId)
        .eq('workspace_id', args.workspaceId)
        .eq('status', 'pending')
        .lte('created_at', endedAt)
      if (!error && (count ?? 0) > 0) out.pendingProposals = count as number
    }
  } catch {
    // No proposals known.
  }
  return out
}
