/**
 * Newest-first paging of a conversation's messages (A3: a home thread lives
 * for months, so opening it must not load every message). GET
 * /api/account/chat-history/[id] takes `?limit=N` (and `&before=<ui message
 * id>` for the page before a message) and answers the newest N messages
 * before that point, oldest first, with `hasMore` when older ones remain. With
 * no `limit` it answers the whole thread, as it always did (the live meeting
 * bridge's resync and the teammate chat read it that way).
 *
 * The cursor is a message's own id (`chat_messages.ui_message_id`, migration
 * 173), so a client pages back from the oldest message it holds, whatever it
 * loaded or kept: the row's (created_at, id) is the position, with id
 * breaking created_at ties, the same order both reads use.
 *
 * Client-safe constants; the read runs on the caller's RLS client.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { withCreatedAt } from './message-time'

/** The page the chat asks for when it opens a conversation or scrolls back. */
export const HISTORY_PAGE_SIZE = 100
/** The largest page answered. */
export const HISTORY_PAGE_MAX = 400

export interface HistoryPageRequest {
  limit: number
  /** The ui message id the page ends before (exclusive), or null for the newest page. */
  before: string | null
}

/** The paging asked for in `params`, or null for the whole thread (no `limit`). A bad limit is clamped. */
export function parseHistoryPage(params: URLSearchParams): HistoryPageRequest | null {
  const raw = params.get('limit')
  if (raw === null) return null
  const n = Number.parseInt(raw, 10)
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), HISTORY_PAGE_MAX) : HISTORY_PAGE_SIZE
  const before = params.get('before')
  return { limit, before: before && before.length <= 512 ? before : null }
}

export interface HistoryPage {
  messages: unknown[]
  hasMore: boolean
}

/**
 * One page of the conversation's messages, oldest first. A `before` id that
 * isn't one of the conversation's messages answers an empty page (nothing
 * older is knowable). Throws on a failed read.
 */
export async function readHistoryPage(
  supabase: SupabaseClient,
  args: { conversationId: string; userId: string; workspaceId: string } & HistoryPageRequest,
): Promise<HistoryPage> {
  let cursor: { created_at: string; id: string } | null = null
  if (args.before) {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, created_at')
      .eq('conversation_id', args.conversationId)
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .eq('ui_message_id', args.before)
      .maybeSingle<{ id: string; created_at: string }>()
    if (error) throw new Error(`history cursor read failed: ${error.message}`)
    if (!data) return { messages: [], hasMore: false }
    cursor = data
  }
  let q = supabase
    .from('chat_messages')
    .select('id, ui_message, created_at')
    .eq('conversation_id', args.conversationId)
    .eq('user_id', args.userId)
    .eq('workspace_id', args.workspaceId)
  if (cursor) {
    q = q.or(`created_at.lt."${cursor.created_at}",and(created_at.eq."${cursor.created_at}",id.lt.${cursor.id})`)
  }
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(args.limit + 1)
  if (error) throw new Error(`history page read failed: ${error.message}`)
  const rows = (data as Array<{ ui_message: unknown; created_at?: unknown }> | null) ?? []
  const hasMore = rows.length > args.limit
  // Each message carries its row's time (message-time.ts): the chat's day lines.
  return { messages: rows.slice(0, args.limit).reverse().map((r) => withCreatedAt(r.ui_message, r.created_at)), hasMore }
}
