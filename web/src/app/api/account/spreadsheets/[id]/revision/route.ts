import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { getSpreadsheetSummary } from '@/lib/spreadsheets/store'

type Params = { params: Promise<{ id: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET: just enough to tell whether the spreadsheet moved on since the editor
 * loaded it — the revision, who last saved and when, and that person's name.
 * The editor polls this every few seconds while the tab is visible; it never
 * carries the workbook, so it is cheap to ask often.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')
  try {
    const summary = await getSpreadsheetSummary(supabase, workspaceId, id)
    if (!summary) return notFound('Spreadsheet not found.')
    let editorName: string | null = null
    if (summary.last_edited_by) {
      const { data } = await supabase.from('member').select('display_name').eq('id', summary.last_edited_by).maybeSingle()
      const name = ((data as { display_name?: string | null } | null)?.display_name ?? '').trim()
      editorName = name || null
    }
    return NextResponse.json({
      revision: summary.revision,
      last_edited_by: summary.last_edited_by,
      updated_at: summary.updated_at,
      editor_name: editorName,
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not read the revision')
  }
}
