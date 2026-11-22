import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { spreadsheetRefusal } from '@/lib/spreadsheets/responses'
import { getRevision, restoreRevision } from '@/lib/spreadsheets/revisions'
import { getSpreadsheetSummary } from '@/lib/spreadsheets/store'

type Params = { params: Promise<{ id: string; revisionId: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GET: one entry of the history with its workbook, to look at it. */
export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id, revisionId } = await params
  if (!UUID.test(id) || !UUID.test(revisionId)) return notFound('That version is not there.')
  try {
    if (!(await getSpreadsheetSummary(supabase, workspaceId, id))) return notFound('Spreadsheet not found.')
    const revision = await getRevision(supabase, id, revisionId)
    if (!revision) return notFound('That version is not there.')
    return NextResponse.json({ revision })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load that version')
  }
}

/**
 * POST { base_revision }: make this version the spreadsheet's workbook again.
 * It is an ordinary save (so the history gains an entry and nothing is
 * lost), refused with 409 when the spreadsheet moved on since base_revision.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  const { id, revisionId } = await params
  if (!UUID.test(id) || !UUID.test(revisionId)) return notFound('That version is not there.')
  const body = (await request.json().catch(() => null)) as { base_revision?: unknown } | null
  if (!body || body.base_revision === undefined) return badRequest('A restore names the revision it was made from.')
  try {
    const restored = await restoreRevision(supabase, { workspaceId, memberId: member.id, spreadsheetId: id, revisionId, baseRevision: Number(body.base_revision) })
    if (!restored.ok) return spreadsheetRefusal(restored)
    return NextResponse.json({ spreadsheet: restored.value })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not restore that version')
  }
}
