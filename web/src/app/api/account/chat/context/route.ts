/**
 * GET /api/account/chat/context?conversationId=<uuid> — how full one of the
 * caller's chat conversations' context is: the side panel's Context card
 * (side-panels/context-section.tsx; the view: src/lib/chat/context-usage.ts).
 *
 *   → 200 { context: ChatContextUsage | null }: null while the conversation
 *     has no measured turn (a new chat, or one whose turns predate the
 *     measure). 400 a bad id; 404 NOT_FOUND when the conversation is not the
 *     caller's in this workspace.
 *
 * Read on the caller's own RLS client: the conversation by its owner, and the
 * session's newest usage rows by "Users can view own usage" (migration 158),
 * found as idle compaction finds them (metadata->>eve_session_id, newest
 * first). The card asks when it opens and after each turn: never polled.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { CHAT_USAGE_FEATURE } from '@/lib/chat/chat-usage-meter'
import { CONTEXT_ROWS_READ, contextFromRows, type ContextUsageRow } from '@/lib/chat/context-usage'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const conversationId = new URL(request.url).searchParams.get('conversationId') ?? ''
  if (!UUID_RE.test(conversationId)) return badRequest('conversationId must be a uuid')

  const { data: conv, error } = await supabase
    .from('chat_conversations')
    .select('id, eve_session_id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string; eve_session_id: string | null }>()
  if (error) return serverError()
  if (!conv) return notFound('Conversation not found')
  if (!conv.eve_session_id) return NextResponse.json({ context: null })

  const { data: rows, error: rowsError } = await supabase
    .from('ai_usage_logs')
    .select('model, created_at, metadata')
    .eq('user_id', user.id)
    .eq('feature', CHAT_USAGE_FEATURE)
    .eq('metadata->>eve_session_id', conv.eve_session_id)
    .order('created_at', { ascending: false })
    .limit(CONTEXT_ROWS_READ)
  if (rowsError) return serverError()

  return NextResponse.json({ context: contextFromRows((rows ?? []) as ContextUsageRow[]) })
}
