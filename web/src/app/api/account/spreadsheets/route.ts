import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { spreadsheetRefusal } from '@/lib/spreadsheets/responses'
import { createSpreadsheet, listSpreadsheets } from '@/lib/spreadsheets/store'

/** GET: the workspace's spreadsheets, newest first (?archived=1 for the archived ones). */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  try {
    const spreadsheets = await listSpreadsheets(supabase, workspaceId, {
      archived: request.nextUrl.searchParams.get('archived') === '1',
    })
    return NextResponse.json({ spreadsheets })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load spreadsheets')
  }
}

/** POST { title?, visibility? }: a new workbook with one empty sheet. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the new spreadsheet as an object.')
  try {
    const made = await createSpreadsheet(supabase, {
      workspaceId,
      memberId: member.id,
      title: body.title ?? body.name,
      visibility: body.visibility,
    })
    if (!made.ok) return spreadsheetRefusal(made)
    return NextResponse.json({ spreadsheet: made.value }, { status: 201 })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not create the spreadsheet')
  }
}
