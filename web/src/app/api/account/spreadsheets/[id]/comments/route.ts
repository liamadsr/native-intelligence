import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { createReply, createThread, listThreads } from '@/lib/spreadsheets/comments'
import { spreadsheetRefusal } from '@/lib/spreadsheets/responses'
import { getSpreadsheetSummary } from '@/lib/spreadsheets/store'
import { afterRecordComment, fenceRecordCommentMentions } from '@/lib/record-comments/mentions'

type Params = { params: Promise<{ id: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GET: the spreadsheet's comment threads, open first. */
export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')
  try {
    // The comment policy lets through only what the caller reads; this makes an
    // unreadable spreadsheet a 404 rather than an empty list.
    if (!(await getSpreadsheetSummary(supabase, workspaceId, id))) return notFound('Spreadsheet not found.')
    return NextResponse.json({ threads: await listThreads(supabase, id) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the comments')
  }
}

/**
 * POST a comment:
 *  - a thread: { sheet_id, anchor, body, mentions?, records? }
 *  - a reply:  { parent_id, body, mentions?, records? }
 * `mentions` are member ids and `records` the records named with `@`: both are
 * kept only while their `@label` is in the words, and the teammates who can
 * open the spreadsheet are told.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the comment as an object.')
  try {
    if (!(await getSpreadsheetSummary(supabase, workspaceId, id))) return notFound('Spreadsheet not found.')
    // What it @-mentions (teammates, records), fenced for the author before it is stored.
    const words = typeof body.body === 'string' ? body.body.trim() : ''
    const mentions = await fenceRecordCommentMentions(supabase, { workspaceId, userId: user.id }, { mentions: body.mentions, records: body.records }, words)
    const after = (commentId: string, parentId: string | null) =>
      void afterRecordComment(supabase, { kind: 'spreadsheet', recordId: id, workspaceId, userId: user.id, memberId: member.id, commentId, parentId, body: words, mentions })
    if (typeof body.parent_id === 'string') {
      const reply = await createReply(supabase, {
        workspaceId,
        spreadsheetId: id,
        memberId: member.id,
        parentId: body.parent_id,
        body: body.body,
        mentions: mentions.memberIds,
      })
      if (!reply.ok) return spreadsheetRefusal(reply)
      after(reply.value.id, body.parent_id)
      return NextResponse.json({ comment: reply.value }, { status: 201 })
    }
    const thread = await createThread(supabase, {
      workspaceId,
      spreadsheetId: id,
      memberId: member.id,
      sheetId: Number(body.sheet_id),
      anchor: body.anchor,
      body: body.body,
      mentions: mentions.memberIds,
    })
    if (!thread.ok) return spreadsheetRefusal(thread)
    after(thread.value.id, null)
    return NextResponse.json({ comment: thread.value }, { status: 201 })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not add the comment')
  }
}
