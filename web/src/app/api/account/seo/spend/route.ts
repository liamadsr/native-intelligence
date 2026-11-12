/**
 * GET /api/account/seo/spend: what the SEO pages need to know before
 * anything is bought, so every page can say "not set up" or show the month's
 * spend without spending.
 *
 *   200  SeoSpendView (src/lib/seo/spend-view.ts):
 *        { spent_dollars, cap_dollars, resets_at, configured, can_buy,
 *          refusal: { code, message } | null }
 *        configured: the server has the search-data provider's key.
 *        can_buy: this person may make paid lookups now (configured, and not
 *        on the free plan); refusal says why not. The ceiling itself is
 *        checked at each call (402 SPEND_LIMIT_REACHED there).
 *
 * Free. Any member may read it.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { checkSeoDataAccess } from '@/lib/seo/access'
import { isDataforseoConfigured } from '@/lib/seo/dataforseo'
import { seoSpendSummary } from '@/lib/seo/spend'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import { NextResponse } from 'next/server'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const [summary, access] = await Promise.all([
      seoSpendSummary(getServiceClient(), auth.workspaceId),
      checkSeoDataAccess({
        userId: auth.user.id,
        workspaceId: auth.workspaceId,
      }),
    ])
    const body: SeoSpendView = {
      ...summary,
      configured: isDataforseoConfigured(),
      can_buy: access.ok,
      refusal: access.ok
        ? null
        : { code: access.code, message: access.message },
    }
    return NextResponse.json(body)
  } catch (err) {
    console.error('[seo-spend] read failed', err)
    return serverError(
      'Could not read this month’s search data spend just now.',
    )
  }
}
