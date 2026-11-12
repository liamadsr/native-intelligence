/**
 * GET /api/account/seo/local/places?country=us&q=portland or: the places
 * (cities, counties, regions) of a country matching what was typed, best
 * first, for the business search's town picker.
 *
 * -> { places: LocalPlaceOption[] }
 *
 * Free (the provider's locations list costs nothing; one copy per country per
 * process for a day, the first read of a large country takes a few seconds),
 * but needs the server's search data key: 503 SEO_NOT_CONFIGURED without it.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { SEO_NOT_CONFIGURED_MESSAGE } from '@/lib/seo/access'
import { isDataforseoConfigured } from '@/lib/seo/dataforseo'
import { seoErrorResponse, seoRefusalResponse } from '@/lib/seo/http'
import { countryMarket, searchPlaces } from '@/lib/seo/local/reference'
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
  const country = request.nextUrl.searchParams.get('country') ?? 'us'
  const query = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 100)
  if (!countryMarket(country))
    return badRequest(
      'That country isn’t covered. Use a two-letter country code, like “us”.',
    )
  if (!query.trim()) return NextResponse.json({ places: [] })
  try {
    return NextResponse.json({ places: await searchPlaces(country, query, 10) })
  } catch (err) {
    return seoErrorResponse(err, 'local places')
  }
}
