/**
 * /api/account/prospecting/lists/[id]/runs — kick off a discovery run, and
 * read this list's run history.
 *
 * THREE KINDS, ONE ROUTE. `kind` is `discover` (the default, and the whole of
 * the body when a user presses Find), `account_card`, or `people`. The two
 * targeted kinds carry `entry_ids` — the companies the user picked at the
 * consent gate — which `createRun` validates against this list before anything
 * is inserted. Validation lives THERE rather than here so the service-role
 * lane gets the same rules; the route's job is only to shape the body and map
 * the failure codes onto status codes.
 *
 * The route's whole job on POST is to create the `prospecting_run` row and
 * emit `prospecting/run.requested`. **It never calls Exa and never spends** —
 * every paid call happens inside the Inngest lane, after preflight has checked
 * both spend gates. A route that searched inline would run under the request
 * timeout, bill on a refresh, and have nowhere to record a cancel.
 *
 * Decision 5 again: ANY member can run a list. There is no role gate here —
 * the per-run budget and the workspace monthly ceiling are the control.
 *
 * The mapping that matters: a `23505` on `prospecting_run_one_live_per_list`
 * is a 409 `RUN_ALREADY_LIVE`, never a 500. Two presses of Find is a normal
 * thing for a user to do, and the database — not a race-prone application
 * check — is what decides which one wins.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { createRun, listRuns } from '@/lib/prospecting/runs'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const rawLimit = request.nextUrl.searchParams.get('limit')
  const limit = rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined

  const result = await listRuns(supabase, { workspaceId, listId: id, limit })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('List not found')
    return serverError()
  }
  return NextResponse.json({ runs: result.runs })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  // An empty body is the common case (run with the list's own budget), so a
  // missing/blank body is not an error — only malformed JSON is.
  let body: Record<string, unknown> = {}
  const raw = await request.text()
  if (raw.trim() !== '') {
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return badRequest('Invalid JSON body')
    }
  }

  const result = await createRun(supabase, {
    workspaceId,
    userId: user.id,
    listId: id,
    budgetDollars: body.budget_dollars,
    // Passed through UNVALIDATED on purpose: `createRun` owns every rule about
    // what a kind is and which entries a run may target, so the route cannot
    // drift from the lane that will also call it.
    kind: body.kind,
    entryIds: body.entry_ids,
  })

  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('List not found')
    // Same envelope shape LIST_NAME_TAKEN uses: the code the client branches
    // on is the envelope's own `code`, not `details.code`.
    if (result.code === 'RUN_ALREADY_LIVE') {
      return apiError(result.error, { status: 409, code: 'RUN_ALREADY_LIVE' })
    }
    if (result.code === 'LIST_ARCHIVED') {
      return apiError(result.error, { status: 400, code: 'LIST_ARCHIVED' })
    }
    if (result.code === 'INVALID_INPUT') return badRequest(result.error)
    return serverError()
  }

  // 201 for a run this request created; 200 for companies added to the people
  // search that was already running (queue-on-click — `createRun` joins a
  // live people run rather than 409ing a second one).
  return NextResponse.json(
    { run: result.run, ...(result.joined ? { joined: result.joined } : {}) },
    { status: result.joined ? 200 : 201 },
  )
}
