/**
 * /api/account/prospecting/lists/[id] — detail, edit, delete.
 *
 * DELETE deletes (Liam, 2026-09-06: "add a way to delete a list"). It used to
 * archive, because the entries are the workspace's accumulated suppression
 * set (§6) and a delete cascades them — that trade is now the user's, stated
 * in the confirmation, and `deleteList` also takes the list's CRM group and
 * scoped views with it. A list with a run in flight is refused with a 409.
 *
 * A cross-workspace id is a 404, never a 403: the lib reads are
 * workspace-scoped, so an id the caller cannot see must not be confirmable.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { parseEntryFilters } from '@/lib/prospecting/entry-filters'
import { deleteList, getList, updateList } from '@/lib/prospecting/lists'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  // stage / min_fit_score / kind, all whitelisted and all pushed into SQL by
  // `listEntries`. An unrecognised value is dropped, not rejected — a stale
  // bookmark should render the unfiltered list rather than a 400.
  const filters = parseEntryFilters(request.nextUrl.searchParams)

  const result = await getList(supabase, { workspaceId, listId: id, ...filters })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('List not found')
    return serverError()
  }
  return NextResponse.json({
    list: result.list,
    entries: result.entries,
    entry_counts: result.entry_counts,
  })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const result = await updateList(supabase, { workspaceId, listId: id, input: body })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('List not found')
    if (result.code === 'LIST_NAME_TAKEN') {
      return apiError(result.error, { status: 409, code: 'LIST_NAME_TAKEN' })
    }
    if (result.code === 'INVALID_INPUT') return badRequest(result.error)
    return serverError()
  }

  // The bump flag is surfaced so the UI can say "entries found before this
  // edit are on version N" rather than silently drifting every badge.
  return NextResponse.json({ list: result.list, icp_version_bumped: result.icp_version_bumped })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const result = await deleteList(supabase, { workspaceId, listId: id })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('List not found')
    if (result.code === 'RUN_LIVE') return apiError(result.error, { status: 409, code: 'RUN_LIVE' })
    return serverError()
  }
  return NextResponse.json({ list: result.list, deleted: true, unpublished: result.unpublished })
}
