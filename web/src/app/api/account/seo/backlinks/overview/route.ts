/**
 * POST /api/account/seo/backlinks/overview: the backlinks overview of a
 * domain or page.
 *
 *   body  { target?, scope?, refresh? }  no target: the workspace's own site.
 *
 * A stored overview younger than 12 hours answers for free (`from_cache`);
 * otherwise, or with `refresh: true`, it is bought (a paid search-data call,
 * metered against the workspace's monthly ceiling) and stored. Any member
 * may ask; the access check refuses when search data is not set up or the
 * person is on the free plan.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { getBacklinksOverview } from '@/lib/seo/backlinks/service'
import { backlinksOverviewRequestSchema } from '@/lib/seo/backlinks/view'
import { seoRefusalResponse } from '@/lib/seo/http'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = backlinksOverviewRequestSchema.safeParse(
    await request.json().catch(() => ({})),
  )
  if (!parsed.success) return badRequest('That backlinks lookup isn’t valid.')
  try {
    const out = await getBacklinksOverview(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (out.ok) return NextResponse.json({ overview: out.overview })
    if (out.code === 'NO_SITE')
      return apiError(out.message, { status: 400, code: out.code })
    return seoRefusalResponse(out)
  } catch (err) {
    return seoFailureResponse(err, 'backlinks overview')
  }
}
