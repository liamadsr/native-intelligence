/**
 * /api/account/seo/google/analytics/report
 *
 *   POST  AnalyticsReportInput (src/lib/seo/google/view.ts): one of the fixed
 *         reports (organic_overview, organic_landing_pages, page_performance,
 *         key_events, traffic_acquisition, ecommerce_performance,
 *         site_search, audience_breakdown, measurement_health) for the
 *         workspace's chosen property, dated in its own time zone (default
 *         the last 28 complete days). Answers AnalyticsReport, discriminated
 *         by `kind` (table, overview, measurement_health).
 *
 * Any member may read it; it goes through the connection of whoever chose
 * the property. Free: Google charges nothing.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { runAnalyticsReport } from '@/lib/seo/google/analytics'
import { analyticsReportInput } from '@/lib/seo/google/input'
import { googleErrorResponse } from '@/lib/seo/google/respond'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = analyticsReportInput.safeParse(
    await request.json().catch(() => ({})),
  )
  if (!parsed.success)
    return badRequest(
      'That report request isn’t valid. Name a report; dates are YYYY-MM-DD.',
    )
  try {
    return NextResponse.json(
      await runAnalyticsReport(
        getServiceClient(),
        { workspaceId: auth.workspaceId, userId: auth.user.id },
        parsed.data,
      ),
    )
  } catch (err) {
    return googleErrorResponse(err, `analytics ${parsed.data.report}`)
  }
}
