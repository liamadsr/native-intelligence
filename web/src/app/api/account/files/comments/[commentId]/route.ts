/**
 * One comment on a file (migration 706).
 *
 *   PATCH  { body?, mentions?, records?, resolved? } new words (its author
 *          only: the database refuses anyone else), or resolve / reopen
 *          the thread (anyone who reads the file, as themself)
 *   DELETE one's own comment
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError } from '@/lib/api-errors'
import { deleteFileComment, fileOfComment, noticeRecord, updateFileComment } from '@/lib/drive/file-comments'
import { afterRecordComment, fenceRecordCommentMentions } from '@/lib/record-comments/mentions'

type Ctx = { params: Promise<{ commentId: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const { commentId } = await params
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>
  const editing = body.body !== undefined
  const words = typeof body.body === 'string' ? body.body.trim() : ''
  const before = editing ? await fileOfComment(supabase, workspaceId, commentId) : null
  const mentions = editing ? await fenceRecordCommentMentions(supabase, { workspaceId, userId: user.id }, { mentions: body.mentions, records: body.records }, words) : null
  const result = await updateFileComment(supabase, workspaceId, member.id, commentId, { body: body.body, mentions: mentions?.memberIds, resolved: body.resolved })
  if (!result.ok) return apiError(result.error, { status: result.status, ...(result.code ? { code: result.code } : {}) })
  // Newly named teammates hear of an edit; nobody hears of a reply again.
  if (editing && before && mentions) {
    void afterRecordComment(supabase, { ...noticeRecord(before.target), workspaceId, userId: user.id, memberId: member.id, commentId, body: words, mentions, alreadyMentioned: before.mentions })
  }
  return NextResponse.json({ comment: result.value })
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { commentId } = await params
  const result = await deleteFileComment(auth.supabase, auth.workspaceId, commentId)
  if (!result.ok) return apiError(result.error, { status: result.status, ...(result.code ? { code: result.code } : {}) })
  return NextResponse.json({ ok: true })
}
