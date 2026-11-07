/**
 * /api/account/prospecting/lists/[id]/entries — list + hand-add by domain.
 *
 * POST is the "ships alone and is useful" half of PR 1: with no run engine
 * yet, a user pastes a domain and the list fills by hand, then Save promotes
 * it to the CRM. It goes through the SAME `companyCandidateKey` the run engine
 * will use, so a hand-added company suppresses a later discovery of itself.
 *
 * A `UNIQUE (list_id, candidate_key)` collision is 200 `{status:'exists'}`
 * with the existing entry — not an error. That is layer 2 of the dedup story
 * doing its job, and the UI wants to scroll to the row rather than show a
 * failure.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { parseEntryFilters } from '@/lib/prospecting/entry-filters'
import { addEntryByDomain, getList } from '@/lib/prospecting/lists'
import { createRun } from '@/lib/prospecting/runs'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  // The SAME parser the detail route uses: stage / min_fit_score / kind, whitelisted
  // and pushed into SQL. Two hand-rolled copies is how one route ends up
  // accepting a filter the other silently ignores.
  const filters = parseEntryFilters(request.nextUrl.searchParams)

  // Load through getList so a cross-workspace list id is a 404 rather than an
  // empty entry array that reads as "this list is empty".
  const result = await getList(supabase, { workspaceId, listId: id, ...filters })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('List not found')
    return serverError()
  }
  return NextResponse.json({ entries: result.entries, entry_counts: result.entry_counts })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const domain = typeof body.domain === 'string' ? body.domain : ''
  if (!domain.trim()) return badRequest('domain is required')

  // The list must exist in this workspace before the insert: without this the
  // FK would reject a foreign list id as a 500 rather than a 404, and a valid
  // one in ANOTHER workspace would be writable under a service client.
  const { data: list, error: listError } = await supabase
    .from('prospect_list')
    .select('id, icp_version')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (listError) {
    console.error('[prospecting] entry add list check failed:', listError.message)
    return serverError()
  }
  if (!list) return notFound('List not found')

  const result = await addEntryByDomain(supabase, {
    workspaceId,
    listId: id,
    domain,
    name: typeof body.name === 'string' ? body.name : null,
    icpVersion: (list as { icp_version: number }).icp_version,
  })

  if (!result.ok) {
    if (result.code === 'INVALID_DOMAIN' || result.code === 'PERSONAL_DOMAIN') {
      // The envelope's own `code`, not `details` — badRequest()'s second
      // argument is `details`, which would have buried the real code under
      // `details.code` while `code` stayed the generic 'BAD_REQUEST'. Same
      // shape LIST_NAME_TAKEN uses in lists/route.ts.
      return apiError(result.error, { status: 400, code: result.code })
    }
    if (result.code === 'INVALID_INPUT') return badRequest(result.error)
    return serverError()
  }

  // A hand-added company gets its profile (and score) the way a discovered
  // one does — automatically. Best effort: a run already live on the list
  // wins the one-live lock, and the strip's "Enrich · N" fallback catches
  // the row up later; the add itself never fails on this.
  let autoProfileRunId: string | null = null
  if (result.status === 'created') {
    const started = await createRun(supabase, {
      workspaceId,
      userId: user.id,
      listId: id,
      kind: 'account_card',
      entryIds: [result.entry.id],
    })
    if (started.ok) autoProfileRunId = started.run.id
    else if (started.code !== 'RUN_ALREADY_LIVE') {
      console.error('[prospecting] auto-profile after add failed:', started.code, started.error)
    }
  }

  // 'exists' is a 200: nothing was created, but the caller gets the row it
  // asked about and the client reconciles rather than retrying.
  return NextResponse.json(
    { entry: result.entry, status: result.status, auto_profile_run_id: autoProfileRunId },
    { status: result.status === 'created' ? 201 : 200 },
  )
}
