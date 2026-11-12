/**
 * /api/account/seo/rank/trackers/[id]/keywords: a tracker's keywords.
 *
 *   GET     ?offset&limit: the keywords with their latest position on each
 *           device the tracker checks and the change since the previous
 *           check, pinned first, then alphabetical, a page at a time. Free.
 *   POST    { keywords: string[], confirmed? }: add keywords (lowercased,
 *           deduplicated, up to the per-tracker cap). Starts no check; a
 *           scheduled tracker checks them from its next due time on, so on
 *           one the add goes through the access check and answers 409
 *           NEEDS_GO_AHEAD with details.estimate and
 *           details.previous_estimate until it is sent with
 *           `confirmed: true`. Show the estimate first.
 *   DELETE  { keyword_ids: string[] }: stop following them. Their history
 *           stays. Unknown ids are ignored.
 *   PATCH   { keyword_ids: string[], pinned: boolean }: pin or unpin.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import {
  isUuid,
  jsonBody,
  pageParams,
  rankFailureResponse,
} from '@/lib/seo/rank/http'
import { getRankTracker, listRankKeywordRows } from '@/lib/seo/rank/queries'
import {
  addRankKeywords,
  pinRankKeywords,
  removeRankKeywords,
} from '@/lib/seo/rank/trackers'
import { NextResponse, type NextRequest } from 'next/server'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  try {
    const svc = getServiceClient()
    const tracker = await getRankTracker(svc, auth.workspaceId, id)
    if (!tracker) return notFound('Tracker not found')
    return NextResponse.json(
      await listRankKeywordRows(
        svc,
        tracker,
        auth.workspaceId,
        pageParams(request.url),
      ),
    )
  } catch (err) {
    console.error('[seo-rank] keyword list failed', err)
    return serverError('Could not load the keywords just now.')
  }
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  const body = await jsonBody(request)
  if (!body) return badRequest('Send { keywords: [...] }.')
  try {
    const out = await addRankKeywords(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      body.keywords,
      { confirmed: body.confirmed === true },
    )
    if (!out.ok) return rankFailureResponse(out)
    return NextResponse.json(out, { status: out.added.length > 0 ? 201 : 200 })
  } catch (err) {
    console.error('[seo-rank] keyword add failed', err)
    return serverError('Could not add the keywords just now.')
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  const body = await jsonBody(request)
  if (!body) return badRequest('Send { keyword_ids: [...] }.')
  try {
    const out = await removeRankKeywords(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
      body.keyword_ids,
    )
    return out.ok ? NextResponse.json(out) : rankFailureResponse(out)
  } catch (err) {
    console.error('[seo-rank] keyword remove failed', err)
    return serverError('Could not remove the keywords just now.')
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  const body = await jsonBody(request)
  if (!body || typeof body.pinned !== 'boolean')
    return badRequest('Send { keyword_ids: [...], pinned: true | false }.')
  try {
    const out = await pinRankKeywords(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
      body.keyword_ids,
      body.pinned,
    )
    return out.ok ? NextResponse.json(out) : rankFailureResponse(out)
  } catch (err) {
    console.error('[seo-rank] keyword pin failed', err)
    return serverError('Could not change the pins just now.')
  }
}
