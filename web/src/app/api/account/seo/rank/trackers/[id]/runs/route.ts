/**
 * /api/account/seo/rank/trackers/[id]/runs: a tracker's checks.
 *
 *   GET   ?offset&limit: the checks, newest first, a page at a time. Free.
 *   POST  { confirmed? }: start a check of every keyword now. SPENDS: the
 *         searches are bought from the data provider and metered against
 *         the workspace's monthly ceiling, so it goes through the access
 *         check (503 SEO_NOT_CONFIGURED or CHECK_FAILED, 403 FREE_PLAN,
 *         NOT_A_MEMBER or UNATTENDED). A check estimated above
 *         CONFIRM_ABOVE_USD answers 409 NEEDS_GO_AHEAD with
 *         details.estimate until it is sent with `confirmed: true` (the
 *         person saw the cost and pressed the button that names it). One
 *         check per tracker at a time: a second start is a 409
 *         ALREADY_RUNNING carrying the live check. It runs in the background
 *         for up to about two hours; poll the run.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import {
  isUuid,
  jsonBody,
  pageParams,
  rankFailureResponse,
} from '@/lib/seo/rank/http'
import { getTrackerRow, listRankRuns } from '@/lib/seo/rank/queries'
import { startRankCheck } from '@/lib/seo/rank/runs'
import { NextResponse, type NextRequest } from 'next/server'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  try {
    const svc = getServiceClient()
    if (!(await getTrackerRow(svc, auth.workspaceId, id)))
      return notFound('Tracker not found')
    return NextResponse.json(
      await listRankRuns(svc, auth.workspaceId, id, pageParams(request.url)),
    )
  } catch (err) {
    console.error('[seo-rank] run list failed', err)
    return serverError('Could not load the checks just now.')
  }
}

export async function POST(request: Request, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  // No body is a start without the person's yes.
  const body = await jsonBody(request)
  try {
    const out = await startRankCheck(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      { confirmed: body?.confirmed === true },
    )
    if (out.ok) return NextResponse.json({ run: out.run }, { status: 201 })
    return rankFailureResponse(
      out,
      out.code === 'ALREADY_RUNNING' ? { run: out.run } : undefined,
    )
  } catch (err) {
    console.error('[seo-rank] start failed', err)
    return serverError('Could not start the check just now.')
  }
}
