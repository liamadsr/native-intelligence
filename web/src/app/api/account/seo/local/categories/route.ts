/**
 * GET /api/account/seo/local/categories?q=&limit=: Google business
 * categories ranked by how many businesses use them, optionally those
 * containing q ("plumb" -> plumber, plumbing_supply_store). For the near
 * search's category filter.
 *
 * -> { categories: Array<{ category, business_count }>, matched }
 *
 * Free (the provider charges nothing for the list; one copy per process for a
 * week), but needs the server's search data key: 503 SEO_NOT_CONFIGURED
 * without it.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { SEO_NOT_CONFIGURED_MESSAGE } from '@/lib/seo/access'
import { isDataforseoConfigured } from '@/lib/seo/dataforseo'
import { seoErrorResponse, seoRefusalResponse } from '@/lib/seo/http'
import { listBusinessCategories } from '@/lib/seo/local/reference'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  if (!isDataforseoConfigured())
    return seoRefusalResponse({
      ok: false,
      code: 'SEO_NOT_CONFIGURED',
      message: SEO_NOT_CONFIGURED_MESSAGE,
    })
  const query = request.nextUrl.searchParams.get('q')?.slice(0, 80) ?? null
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 50)
  try {
    return NextResponse.json(
      await listBusinessCategories(query, Number.isFinite(limit) ? limit : 50),
    )
  } catch (err) {
    return seoErrorResponse(err, 'business categories')
  }
}
