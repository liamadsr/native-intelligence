/**
 * /api/account/seo/rank/estimate: what rank checks cost, before anything is
 * saved or started. Free maths: nothing is bought.
 *
 *   POST  { tracker_id, add_keywords?, devices?, serp_depth?,
 *         schedule_interval?, schedule_time?, paused? }: a saved tracker as
 *         it is (`before`) and with the change (`after`), and whether the
 *         change raises what it spends on its own ({ before, after,
 *         raises_cost }).
 *         { keywords?, language_code?, devices?, serp_depth?,
 *         schedule_interval? }: a tracker not yet saved ({ estimate }).
 *
 * Each estimate is the most one check costs (every keyword and device read
 * the maximum number of times) and that per month on the schedule.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { isUuid, jsonBody, rankFailureResponse } from '@/lib/seo/rank/http'
import { estimateDraft, previewTrackerChange } from '@/lib/seo/rank/trackers'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = await jsonBody(request)
  if (!body) return badRequest('Send the tracker or its settings.')
  try {
    if (body.tracker_id !== undefined) {
      if (!isUuid(body.tracker_id))
        return badRequest('That isn’t a tracker id.')
      if (body.add_keywords !== undefined && !Array.isArray(body.add_keywords))
        return badRequest('add_keywords is a list.')
      const out = await previewTrackerChange(
        getServiceClient(),
        { workspaceId: auth.workspaceId },
        body.tracker_id,
        {
          input: {
            devices: body.devices,
            serp_depth: body.serp_depth,
            schedule_interval: body.schedule_interval,
            schedule_time: body.schedule_time,
            paused: body.paused,
          },
          addKeywords: (body.add_keywords as unknown[] | undefined) ?? [],
        },
      )
      if (!out.ok) return rankFailureResponse(out)
      return NextResponse.json({
        before: out.before,
        after: out.after,
        raises_cost: out.raises_cost,
      })
    }
    const out = estimateDraft(body)
    return out.ok
      ? NextResponse.json({ estimate: out.estimate })
      : rankFailureResponse(out)
  } catch (err) {
    console.error('[seo-rank] estimate failed', err)
    return serverError('Could not work out the estimate just now.')
  }
}
