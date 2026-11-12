/**
 * POST /api/account/seo/backlinks/profile: one page of a domain's or page's
 * backlinks profile.
 *
 *   body  { tab: 'backlinks' | 'domains' | 'pages', target?, scope?, page?,
 *           page_size?, sort_field?, sort_order?, filters?, mode?,
 *           hide_spam?, refresh? }  no target: the workspace's own site.
 *
 * A stored page younger than 12 hours answers for free (`from_cache`);
 * otherwise, or with `refresh: true`, it is bought (a paid search-data call,
 * metered against the workspace's monthly ceiling) and stored. Any member
 * may ask; the access check refuses when search data is not set up or the
 * person is on the free plan. Too many filter conditions is a 400 before
 * anything is bought.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { getBacklinksProfile } from '@/lib/seo/backlinks/service'
import { backlinksProfileRequestSchema } from '@/lib/seo/backlinks/view'
import { seoRefusalResponse } from '@/lib/seo/http'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = backlinksProfileRequestSchema.safeParse(
    await request.json().catch(() => ({})),
  )
  if (!parsed.success) return badRequest('That backlinks lookup isn’t valid.')
  try {
    const out = await getBacklinksProfile(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (out.ok) return NextResponse.json({ profile: out.profile })
    if (out.code === 'NO_SITE')
      return apiError(out.message, { status: 400, code: out.code })
    return seoRefusalResponse(out)
  } catch (err) {
    return seoFailureResponse(err, 'backlinks profile')
  }
}
