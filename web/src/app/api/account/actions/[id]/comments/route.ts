import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { getComments, createComment } from '@/lib/comments'
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

  // Verify action belongs to this user's workspace
  const { data: action } = await supabase
    .from('actions')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!action) return notFound('Action not found')

  const result = await getComments(supabase, 'action', id)
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

  // What it @-mentions (teammates, records), fenced for the author before it is stored.
  const mentions = await fenceCommentMentions(supabase, { workspaceId, userId: auth.user.id }, { mentions: body.mentions, records: body.records }, body.body.trim())
  const result = await createComment(supabase, 'action', id, member.id, body.body.trim(), body.parent_id, undefined, mentions)
  if (result.error) return badRequest(result.error)

  // The record mentions each record named, and a mention shares (non-blocking).
  void applyCommentMentions(supabase, { workspaceId, userId: auth.user.id, memberId: member.id, commentable: { type: 'action', id }, mentions })

  // Fire comment notifications (non-blocking)
  sendCommentNotifications({
    supabase,
    workspaceId,
    commentableType: 'action',
    commentableId: id,
    authorMemberId: member.id,
    commentBody: body.body.trim(),
    commentId: result.comment!.id,
    parentId: body.parent_id,
    mentionedMemberIds: mentions.memberIds,
  })

  return NextResponse.json({ comment: result.comment }, { status: 201 })
}
