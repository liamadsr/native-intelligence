/**
 * Comments on a file, pinned to a place on a page (migration 711;
 * lib/drive/file-comments.ts).
 *
 *   GET  ?attachment=<id> | ?message=<id>&path=<object path>
 *        → { comments, me } the file's comments the caller may read
 *   POST { attachment | message + path, body, parent_id?, page?, x?, y?, mentions?, records? }
 *        a new thread or a reply. The teammates it names who can open the file are told.
 *
 * On the caller's own client: 711's rules decide (whoever reads the file).
 * A mail attachment has no comments: its route never names one.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { addFileComment, listFileComments, noticeRecord, parseFileTarget, type FileCommentResult } from '@/lib/drive/file-comments'
import { afterRecordComment, fenceRecordCommentMentions } from '@/lib/record-comments/mentions'

function fileCommentRefusal(r: Extract<FileCommentResult<unknown>, { ok: false }>) {
  return apiError(r.error, { status: r.status, ...(r.code ? { code: r.code } : {}) })
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const p = request.nextUrl.searchParams
  const target = parseFileTarget({ attachment: p.get('attachment') ?? undefined, message: p.get('message') ?? undefined, path: p.get('path') ?? undefined })
  if (!target) return badRequest('Name the file: attachment, or message and path.')
  const result = await listFileComments(auth.supabase, auth.workspaceId, target)
  if (!result.ok) return fileCommentRefusal(result)
  return NextResponse.json({ comments: result.value, me: auth.member.id })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('A comment needs some words.')
  const target = parseFileTarget({ attachment: body.attachment, message: body.message, path: body.path })
  if (!target) return badRequest('Name the file: attachment, or message and path.')
  const words = typeof body.body === 'string' ? body.body.trim() : ''
  // What it @-mentions, fenced for the author before it is stored.
  const mentions = await fenceRecordCommentMentions(supabase, { workspaceId, userId: user.id }, { mentions: body.mentions, records: body.records }, words)
  // Never from the request: only the assistant's own tool writes a comment as the assistant's.
  const result = await addFileComment(supabase, workspaceId, member.id, target, { body: body.body, parent_id: body.parent_id, page: body.page, x: body.x, y: body.y, mentions: mentions.memberIds })
  if (!result.ok) return fileCommentRefusal(result)
  const fileName = typeof body.file_name === 'string' ? body.file_name.slice(0, 200) : null
  void afterRecordComment(supabase, {
    ...noticeRecord(target),
    workspaceId,
    userId: user.id,
    memberId: member.id,
    commentId: result.value.id,
    parentId: result.value.parent_id,
    body: words,
    mentions,
    ...(target.kind === 'chat' ? { recordTitle: fileName } : {}),
  })
  return NextResponse.json({ comment: result.value }, { status: 201 })
}
