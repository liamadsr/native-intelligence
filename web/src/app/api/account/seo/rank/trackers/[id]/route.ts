/**
 * /api/account/seo/rank/trackers/[id]: one rank tracker.
 *
 *   GET     the tracker (settings, schedule, newest check) and a summary per
 *           device it checks: keywords checked and found, counts in the top
 *           3 / 10 / 100, the average position, and the biggest movers since
 *           the previous check. Free (stored results).
 *   PATCH   { devices?, serp_depth?, schedule_interval?, schedule_time?,
 *           paused?, confirmed? }: change how it checks. The site and market
 *           stay (a new market is a new tracker). A change that turns on or
 *           raises what it spends on its own (a schedule on, resumed or more
 *           often, more devices or depth on a schedule) goes through the
 *           access check and answers 409 NEEDS_GO_AHEAD with
 *           details.estimate and details.previous_estimate until it is sent
 *           with `confirmed: true`. Show the estimate (POST ../../estimate
 *           with tracker_id) first. Pausing, or turning the schedule off,
 *           stops a scheduled check that is running.
 *   DELETE  delete it with its keywords, checks and history; a check still
 *           running is stopped first.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { isUuid, jsonBody, rankFailureResponse } from '@/lib/seo/rank/http'
import { getRankTrackerDetail } from '@/lib/seo/rank/queries'
import { deleteRankTracker, updateRankTracker } from '@/lib/seo/rank/trackers'
import { NextResponse, type NextRequest } from 'next/server'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  try {
    const detail = await getRankTrackerDetail(
      getServiceClient(),
      auth.workspaceId,
      id,
    )
    if (!detail) return notFound('Tracker not found')
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[seo-rank] read failed', err)
    return serverError('Could not load the tracker just now.')
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  const body = await jsonBody(request)
  if (!body) return badRequest('Send the settings to change.')
  try {
    const out = await updateRankTracker(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      body,
    )
    if (out.ok) return NextResponse.json({ tracker: out.tracker })
    return rankFailureResponse(out)
  } catch (err) {
    console.error('[seo-rank] update failed', err)
    return serverError('Could not change the tracker just now.')
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  try {
    const out = await deleteRankTracker(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
    )
    if (out.ok) return NextResponse.json({ deleted: true })
    return rankFailureResponse(out)
  } catch (err) {
    console.error('[seo-rank] delete failed', err)
    return serverError('Could not delete the tracker just now.')
  }
}
