/**
 * /api/account/seo/google/search-console/performance
 *
 *   POST  SearchConsolePerformanceInput (src/lib/seo/google/view.ts):
 *         clicks, impressions, CTR and position for the workspace's chosen
 *         site by query, page, country, device or date, with the window's
 *         totals and daily trend, and with `compare` the period before.
 *         Answers SearchConsolePerformance.
 *
 * Any member may read it; it goes through the connection of whoever chose
 * the site. Free: Google charges nothing.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { performanceInput } from '@/lib/seo/google/input'
import { googleErrorResponse } from '@/lib/seo/google/respond'
import { getSearchConsolePerformance } from '@/lib/seo/google/search-console'
import type { SearchConsolePerformanceInput } from '@/lib/seo/google/view'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = performanceInput.safeParse(
    await request.json().catch(() => ({})),
  )
  if (!parsed.success)
    return badRequest(
      'That request isn’t valid. Check the dates, dimensions and filters.',
    )
  try {
    const out = await getSearchConsolePerformance(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data as SearchConsolePerformanceInput,
    )
    return NextResponse.json(out)
  } catch (err) {
    return googleErrorResponse(err, 'search console performance')
  }
}
