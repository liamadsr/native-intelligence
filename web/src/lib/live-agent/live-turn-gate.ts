import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Is this chat turn a live call's turn? (one-chat plan, Slice 3: the person
 * talking to the call's live agent in its own chat, in the HUD.)
 *
 * The client says so by sending systemContext.liveCaptureId, but that field is
 * client-controlled, so the server decides: the turn is live only when its
 * conversation (the verified token's) IS that capture's conversation
 * (chat_conversations.capture_id), the capture is the caller's own in this
 * workspace, and the call is still going (no `ended_at`). Anything else (a
 * main-chat turn naming a capture, another member's capture, a finished call)
 * is an ordinary turn: no live block, no note-taker line, and the log and
 * recent exchange stay in.
 *
 * Best-effort: a failed read is "not live", never a failed turn.
 */
export async function isLiveCallTurn(
  supabase: SupabaseClient,
  input: { conversationId: string; captureId: unknown; workspaceId: string; userId: string },
): Promise<boolean> {
  const { conversationId, captureId, workspaceId, userId } = input
  if (typeof captureId !== 'string' || !UUID_RE.test(captureId)) return false
  try {
    const [conversationRead, captureRead] = await Promise.all([
      supabase
        .from('chat_conversations')
        .select('capture_id')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .maybeSingle<{ capture_id: string | null }>(),
      supabase
        .from('captures')
        .select('id, ended_at')
        .eq('id', captureId)
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .maybeSingle<{ id: string; ended_at: string | null }>(),
    ])
    if (conversationRead.error || captureRead.error) return false
    if (conversationRead.data?.capture_id !== captureId) return false
    return Boolean(captureRead.data && !captureRead.data.ended_at)
  } catch {
    return false
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
