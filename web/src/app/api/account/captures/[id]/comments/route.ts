import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { getAllComments, createComment, resolveComment, parseAnchorFields } from '@/lib/comments'
import { sendCommentNotifications } from '@/lib/comment-notifications'
import { applyCommentMentions, fenceCommentMentions } from '@/lib/comment-mentions'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  // Verify capture belongs to this workspace (workspace-shared visibility —
  // teammates can read each other's captures and the comments on them).
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!capture) return notFound('Capture not found')

  // Return all comments (top-level + replies) with anchor fields for inline commenting
  const result = await getAllComments(supabase, 'capture', id)
  if (result.error) return serverError(result.error)
  return NextResponse.json({ comments: result.comments })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Member id (comment author) rides along with auth resolution — no separate
  // member query.
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  const { id } = await params
  const body = await request.json()
  if (!body.body?.trim()) return badRequest('Body is required')

  const anchor = parseAnchorFields(body)

  // What it @-mentions (teammates, records), fenced for the author before it is stored.
  const mentions = await fenceCommentMentions(supabase, { workspaceId, userId: auth.user.id }, { mentions: body.mentions, records: body.records }, body.body.trim())
  const result = await createComment(supabase, 'capture', id, member.id, body.body.trim(), body.parent_id, anchor, mentions)
  if (result.error) return badRequest(result.error)

  // The record mentions each record named, and a mention shares (non-blocking).
  void applyCommentMentions(supabase, { workspaceId, userId: auth.user.id, memberId: member.id, commentable: { type: 'capture', id }, mentions })

  // Fire comment notifications (non-blocking)
  sendCommentNotifications({
    supabase,
    workspaceId,
    commentableType: 'capture',
    commentableId: id,
    authorMemberId: member.id,
    commentBody: body.body.trim(),
    commentId: result.comment!.id,
    parentId: body.parent_id,
    mentionedMemberIds: mentions.memberIds,
  })

  return NextResponse.json({ comment: result.comment }, { status: 201 })
}

export async function PATCH(
  request: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const body = await request.json()
  const { comment_id, is_resolved } = body

  if (!comment_id || typeof comment_id !== 'string') {
    return badRequest('comment_id is required')
  }
  if (typeof is_resolved !== 'boolean') {
    return badRequest('is_resolved must be a boolean')
  }

  const result = await resolveComment(supabase, comment_id, is_resolved)
  if (result.error) return serverError(result.error)

  return NextResponse.json({ comment: result.comment })
}
