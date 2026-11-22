import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { listRevisions } from '@/lib/spreadsheets/revisions'
import { getSpreadsheetSummary } from '@/lib/spreadsheets/store'

type Params = { params: Promise<{ id: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GET: the spreadsheet's history, newest first, without the workbooks. */
export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')
  try {
    // The history's own policy lets through only what the caller reads; this makes a missing one a 404, not an empty list.
    if (!(await getSpreadsheetSummary(supabase, workspaceId, id))) return notFound('Spreadsheet not found.')
    return NextResponse.json({ revisions: await listRevisions(supabase, id) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the history')
  }
}
