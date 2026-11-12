/**
 * /api/account/seo/google/search-console/opportunities
 *
 *   POST  { start_date?, end_date?, limit? }: the workspace's search
 *         opportunities: striking-distance queries (best page ranking 5–20),
 *         low-CTR queries (well under the site's own rate at their position)
 *         and, when a Google Analytics property is chosen too, pages ranking
 *         4–20 scored with what their organic visitors did. Answers
 *         SearchOpportunities (src/lib/seo/google/view.ts); `pages` is null
 *         with `pages_unavailable` saying why when Analytics isn't there.
 *
 * Any member may read it. Free: Google charges nothing.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { opportunitiesInput } from '@/lib/seo/google/input'
import { getSearchOpportunities } from '@/lib/seo/google/opportunities'
import { googleErrorResponse } from '@/lib/seo/google/respond'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = opportunitiesInput.safeParse(
    await request.json().catch(() => ({})),
  )
  if (!parsed.success)
    return badRequest(
      'That request isn’t valid. Dates are YYYY-MM-DD; limit is 1 to 100.',
    )
  try {
    return NextResponse.json(
      await getSearchOpportunities(
        getServiceClient(),
        { workspaceId: auth.workspaceId, userId: auth.user.id },
        parsed.data,
      ),
    )
  } catch (err) {
    return googleErrorResponse(err, 'search opportunities')
  }
}
