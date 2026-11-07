import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { getAllComments, createComment, resolveComment, parseAnchorFields } from '@/lib/comments'
import { sendCommentNotifications } from '@/lib/comment-notifications'
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

  const result = await createComment(supabase, 'capture', id, member.id, body.body.trim(), body.parent_id, anchor)
  if (result.error) return badRequest(result.error)

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
