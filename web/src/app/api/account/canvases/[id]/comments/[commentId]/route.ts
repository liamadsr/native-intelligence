import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { CommentsUnavailable, deleteComment, getComment, updateComment } from '@/lib/canvas/comments'
import { afterRecordComment, fenceRecordCommentMentions } from '@/lib/record-comments/mentions'
import { canvasRefusal } from '@/lib/canvas/responses'

type Ctx = { params: Promise<{ id: string; commentId: string }> }

const unavailable = () => apiError('Comments are not set up on this server yet.', { status: 503, code: 'COMMENTS_UNAVAILABLE' })

/** PATCH { body?, resolved? }: the author's new words, or a thread resolved / reopened. */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const { id, commentId } = await params
  const body = (await request.json().catch(() => null)) as { body?: unknown; resolved?: unknown; mentions?: unknown; records?: unknown } | null
  if (!body || typeof body !== 'object') return badRequest('Nothing to change.')
  try {
    if (body.body === undefined) {
      const result = await updateComment(supabase, id, commentId, member.id, { resolved: body.resolved })
      if (!result.ok) return canvasRefusal(result)
      return NextResponse.json({ comment: result.value })
    }
    // New words: what they @-mention is fenced again, and whoever is newly named is told.
    const words = typeof body.body === 'string' ? body.body.trim() : ''
    const before = await getComment(supabase, id, commentId)
    const mentions = await fenceRecordCommentMentions(supabase, { workspaceId, userId: user.id }, { mentions: body.mentions, records: body.records }, words)
    const result = await updateComment(supabase, id, commentId, member.id, { body: body.body, resolved: body.resolved, mentions: mentions.memberIds })
    if (!result.ok) return canvasRefusal(result)
    void afterRecordComment(supabase, { kind: 'canvas', recordId: id, workspaceId, userId: user.id, memberId: member.id, commentId, body: words, mentions, alreadyMentioned: before?.mentions ?? [] })
    return NextResponse.json({ comment: result.value })
  } catch (e) {
    if (e instanceof CommentsUnavailable) return unavailable()
    return serverError(e instanceof Error ? e.message : 'Could not change the comment')
  }
}

/** DELETE: the author takes a comment back (a thread goes with its replies). */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase } = auth
  const { id, commentId } = await params
  try {
    const result = await deleteComment(supabase, id, commentId)
    if (!result.ok) return canvasRefusal(result)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof CommentsUnavailable) return unavailable()
    return serverError(e instanceof Error ? e.message : 'Could not delete the comment')
  }
}
