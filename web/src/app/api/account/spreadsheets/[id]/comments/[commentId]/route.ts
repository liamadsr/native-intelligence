import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { deleteComment, editComment, moveAnchor, setResolved } from '@/lib/spreadsheets/comments'
import { spreadsheetRefusal } from '@/lib/spreadsheets/responses'
import { getSpreadsheetSummary } from '@/lib/spreadsheets/store'

type Params = { params: Promise<{ id: string; commentId: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * PATCH one comment, one of three shapes:
 *  - edit one's own body: { body, mentions? }
 *  - resolve / reopen a thread: { resolved: boolean }
 *  - move a thread's anchor: { anchor, sheet_id? }
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  const { id, commentId } = await params
  if (!UUID.test(id) || !UUID.test(commentId)) return notFound('Comment not found.')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the change as an object.')
  try {
    if (!(await getSpreadsheetSummary(supabase, workspaceId, id))) return notFound('Spreadsheet not found.')
    if (typeof body.resolved === 'boolean') {
      const result = await setResolved(supabase, { spreadsheetId: id, commentId, memberId: member.id, resolved: body.resolved })
      if (!result.ok) return spreadsheetRefusal(result)
      return NextResponse.json({ comment: result.value })
    }
    if (body.anchor !== undefined) {
      const result = await moveAnchor(supabase, { spreadsheetId: id, commentId, anchor: body.anchor, sheetId: body.sheet_id })
      if (!result.ok) return spreadsheetRefusal(result)
      return NextResponse.json({ comment: result.value })
    }
    if (body.body !== undefined) {
      const result = await editComment(supabase, { spreadsheetId: id, commentId, body: body.body, mentions: body.mentions })
      if (!result.ok) return spreadsheetRefusal(result)
      return NextResponse.json({ comment: result.value })
    }
    return badRequest('A change edits the body, resolves the thread, or moves the anchor.')
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not change the comment')
  }
}

/** DELETE one's own comment. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id, commentId } = await params
  if (!UUID.test(id) || !UUID.test(commentId)) return notFound('Comment not found.')
  try {
    if (!(await getSpreadsheetSummary(supabase, workspaceId, id))) return notFound('Spreadsheet not found.')
    const gone = await deleteComment(supabase, { spreadsheetId: id, commentId })
    if (!gone.ok) return spreadsheetRefusal(gone)
    return NextResponse.json({ success: true })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not delete the comment')
  }
}
