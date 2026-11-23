import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { spreadsheetRefusal } from '@/lib/spreadsheets/responses'
import { deleteSpreadsheet, getSpreadsheet, saveSpreadsheet, spreadsheetEditableBy, updateSpreadsheetMeta } from '@/lib/spreadsheets/store'
import type { SpreadsheetExtras } from '@/lib/spreadsheets/types'
import { loadRecordSharing } from '@/lib/entity-access/store'

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET: one spreadsheet with its workbook, and whether the person may change it
 * (`can_edit`: false for someone it is shared with to view, migration 688).
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member, user } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')
  try {
    const spreadsheet = await getSpreadsheet(supabase, workspaceId, id)
    if (!spreadsheet) return notFound('Spreadsheet not found.')
    const [canEdit, sharing] = await Promise.all([spreadsheetEditableBy(supabase, id, user.id), loadRecordSharing(supabase, workspaceId, 'spreadsheet', id)])
    return NextResponse.json({ spreadsheet, member_id: member.id, can_edit: canEdit, sharing })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the spreadsheet')
  }
}

/**
 * PATCH, two shapes:
 *  - a save: { base_revision, workbook?, extras?, title? }. Refused with 409
 *    (code SPREADSHEET_REVISION_CONFLICT, details.current) when the
 *    spreadsheet moved on since base_revision.
 *  - about the record: { title?, visibility?, status? } with no base_revision.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the change as an object.')
  try {
    if (body.base_revision !== undefined) {
      if (body.workbook === undefined && body.extras === undefined && body.title === undefined) {
        return badRequest('A save carries the workbook, its extras or its title.')
      }
      const saved = await saveSpreadsheet(supabase, id, {
        workspaceId,
        memberId: member.id,
        baseRevision: Number(body.base_revision),
        workbook: body.workbook as string | undefined,
        extras: body.extras as SpreadsheetExtras | undefined,
        title: body.title,
      })
      if (!saved.ok) return spreadsheetRefusal(saved)
      return NextResponse.json({ spreadsheet: saved.value })
    }
    const updated = await updateSpreadsheetMeta(supabase, workspaceId, id, member.id, {
      title: body.title,
      visibility: body.visibility,
      status: body.status,
    })
    if (!updated.ok) return spreadsheetRefusal(updated)
    return NextResponse.json({ spreadsheet: updated.value })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not save the spreadsheet')
  }
}

/** DELETE: for good. Its maker, or an owner or admin of the workspace (the row policy decides). */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')
  try {
    const gone = await deleteSpreadsheet(supabase, workspaceId, id)
    if (!gone.ok) return spreadsheetRefusal(gone)
    return NextResponse.json({ success: true })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not delete the spreadsheet')
  }
}
