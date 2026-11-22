/**
 * GET /api/account/conversations/[id]/shared — open an agent chat read-only
 * (docs/plans/mentions-everywhere.md, JOB 2): the caller's own past chat, or
 * one a teammate shared with them by @-mentioning it (conversation_share,
 * migration 671).
 *
 * chat_conversations and chat_messages stay OWNER-ONLY under RLS (many reads
 * rely on that; this route adds no policy). So the caller's RLS client can't
 * read a shared chat at all. Instead this route:
 *   (a) authenticates with requireWorkspaceMember() — { supabase, user,
 *       workspaceId, member };
 *   (b) decides access EXPLICITLY (decideSharedAccess): the caller owns the
 *       conversation (user_id), OR a conversation_share row names their member
 *       id as grantee in the SAME workspace as the conversation;
 *   (c) only then reads the conversation and its messages with the SERVICE
 *       client, filtered by that conversation id and workspace.
 *
 * Anything else — no such conversation, another workspace's, no share, a read
 * error — answers 404 (never 403: a grantee must not be told a chat exists).
 * Fail closed: any throw is a 404 too.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import {
  decideSharedAccess,
  shapeSharedMessages,
  SHARED_CONVERSATION_MESSAGE_CAP,
  type ConversationShareRow,
  type SharedConversationPayload,
  type SharedConversationRow,
  type SharedMessageRow,
} from '@/lib/chat/shared-conversation'
import { NextResponse, type NextRequest } from 'next/server'

type RouteContext = { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const auth = await requireWorkspaceMember({ select: 'id' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth

  try {
    const { id } = await params
    // A malformed id can't name a real chat → 404, like any id that doesn't.
    if (!UUID_RE.test(id)) return notFound()

    const service = getServiceClient()

    // The conversation row, read on the service client (the tables are
    // owner-only under RLS; this route is the one place a grantee reaches them).
    const { data: conv, error: convError } = await service
      .from('chat_conversations')
      .select('id, user_id, workspace_id, title')
      .eq('id', id)
      .maybeSingle<SharedConversationRow>()
    if (convError) return notFound()

    // The shares for this exact conversation + this caller's member, in the
    // conversation's own workspace. Read explicitly (not through RLS), so the
    // decision below is the only arbiter.
    let shares: ConversationShareRow[] = []
    if (conv && conv.user_id !== user.id) {
      const { data, error } = await service
        .from('conversation_share')
        .select('conversation_id, grantee_member_id, workspace_id')
        .eq('conversation_id', id)
        .eq('workspace_id', conv.workspace_id)
        .eq('grantee_member_id', member.id)
      if (error) return notFound()
      shares = (data ?? []) as ConversationShareRow[]
    }

    const role = decideSharedAccess({
      conversation: conv ?? null,
      callerUserId: user.id,
      workspaceId,
      callerMemberIds: [member.id],
      shares,
    })
    // No access, or no such conversation: 404 either way (never confirm it exists).
    if (!role || !conv) return notFound()

    // The owner's display name, for "Shared by <name>" (best-effort: null if it
    // can't be read; the chat still opens).
    const { data: owner } = await service
      .from('member')
      .select('display_name')
      .eq('user_id', conv.user_id)
      .eq('workspace_id', conv.workspace_id)
      .maybeSingle<{ display_name: string | null }>()

    // The messages, service client, scoped to this conversation and workspace,
    // newest first then reversed to reading order; the shaper caps and filters.
    const { data: rows, error: msgError } = await service
      .from('chat_messages')
      .select('ui_message, created_at')
      .eq('conversation_id', id)
      .eq('workspace_id', conv.workspace_id)
      .order('created_at', { ascending: false })
      .limit(SHARED_CONVERSATION_MESSAGE_CAP)
    if (msgError) return notFound()

    const ordered = ((rows ?? []) as SharedMessageRow[]).slice().reverse()
    const payload: SharedConversationPayload = {
      id: conv.id,
      title: conv.title,
      role,
      ownerName: owner?.display_name ?? null,
      messages: shapeSharedMessages(ordered),
    }
    return NextResponse.json(payload)
  } catch {
    // Fail closed: nothing about a chat leaks through an error.
    return notFound()
  }
}
