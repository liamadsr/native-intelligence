/**
 * /api/account/seo/rank/trackers: the workspace's rank trackers.
 *
 *   GET    ?offset&limit: the trackers, newest first, a page at a time, each
 *          with its keyword count and newest check; plus the workspace's own
 *          domain (the form's default), whether search data is set up on the
 *          server, the month's search data spend, and the caps. Free.
 *   POST   { domain?, location_code?, language_code?, location_name?,
 *          devices?, serp_depth?, schedule_interval?, schedule_time?,
 *          keywords?, confirmed? }: set a tracker up. Starts no check; a
 *          schedule other than manual spends from its first due time on, so
 *          it goes through the access check (503 / 403 as every SEO route),
 *          and with keywords it answers 409 NEEDS_GO_AHEAD with
 *          details.estimate until it is sent with `confirmed: true` (the
 *          person saw the monthly cost, POST ../estimate, and pressed the
 *          button that names it).
 *
 * Any member may read and set up.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { isDataforseoConfigured } from '@/lib/seo/dataforseo'
import { isSeoError } from '@/lib/seo/errors'
import { seoErrorResponse } from '@/lib/seo/http'
import { jsonBody, pageParams, rankFailureResponse } from '@/lib/seo/rank/http'
import {
  DEFAULT_DEVICES,
  DEFAULT_SCHEDULE_INTERVAL,
  DEFAULT_SERP_DEPTH,
  MAX_KEYWORDS_PER_ADD,
  MAX_KEYWORDS_PER_TRACKER,
  MAX_SERP_DEPTH,
  MAX_TRACKERS_PER_WORKSPACE,
  MIN_SERP_DEPTH,
} from '@/lib/seo/rank/limits'
import { listRankTrackers } from '@/lib/seo/rank/queries'
import { createRankTracker } from '@/lib/seo/rank/trackers'
import { workspaceSiteUrl } from '@/lib/seo/site'
import { seoSpendSummary } from '@/lib/seo/spend'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const svc = getServiceClient()
    const [trackers, site, spend] = await Promise.all([
      listRankTrackers(svc, auth.workspaceId, pageParams(request.url)),
      workspaceSiteUrl(svc, auth.workspaceId),
      seoSpendSummary(svc, auth.workspaceId).catch(() => null),
    ])
    return NextResponse.json({
      trackers,
      default_domain: site ? new URL(site).host.replace(/^www\./, '') : null,
      configured: isDataforseoConfigured(),
      spend,
      limits: {
        max_trackers: MAX_TRACKERS_PER_WORKSPACE,
        max_keywords_per_tracker: MAX_KEYWORDS_PER_TRACKER,
        max_keywords_per_add: MAX_KEYWORDS_PER_ADD,
        min_depth: MIN_SERP_DEPTH,
        max_depth: MAX_SERP_DEPTH,
        default_depth: DEFAULT_SERP_DEPTH,
        default_devices: DEFAULT_DEVICES,
        default_schedule: DEFAULT_SCHEDULE_INTERVAL,
      },
    })
  } catch (err) {
    console.error('[seo-rank] list failed', err)
    return serverError('Could not load your rank trackers just now.')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = await jsonBody(request)
  if (!body) return badRequest('Send the tracker’s settings.')
  try {
    const out = await createRankTracker(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      body,
    )
    if (out.ok)
      return NextResponse.json(
        { tracker: out.tracker, keywords: out.keywords },
        { status: 201 },
      )
    return rankFailureResponse(
      out,
      'tracker_id' in out && out.tracker_id
        ? { tracker_id: out.tracker_id }
        : undefined,
    )
  } catch (err) {
    if (isSeoError(err)) return seoErrorResponse(err, 'rank tracker create')
    console.error('[seo-rank] create failed', err)
    return serverError('Could not set up the tracker just now.')
  }
}
