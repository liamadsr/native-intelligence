/**
 * GET /api/account/seo/locations: the countries and languages the SEO pages
 * can offer (SeoMarketOptions, src/lib/seo/keywords/view.ts): for each
 * country its languages, whether keyword data carries difficulty and intent
 * there (keyword_data: labs) or not (google_ads), and whether domain data
 * works there. A static list from the build, the same for every member: no
 * workspace read, no lookup, nothing spent, cacheable in the browser for a
 * day. Signed-in members only, like every account route.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { seoMarketOptions } from '@/lib/seo/keywords/view'
import { NextResponse } from 'next/server'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  return NextResponse.json(seoMarketOptions(), {
    headers: { 'Cache-Control': 'private, max-age=86400' },
  })
}
