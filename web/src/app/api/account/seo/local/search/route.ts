/**
 * POST /api/account/seo/local/search: find a business on Google Maps.
 *
 *   { query, place, country? }        by name (or a trade word) in a town
 *   { near: { latitude, longitude, radius_km? }, query?, categories?,
 *     min_rating?, min_reviews?, is_claimed? }
 *                                     around a coordinate
 *   + limit?, refresh?
 *
 * Answers { result: LocalBusinessSearchResult }. Paid: a fresh stored search
 * answers for free (from_cache), otherwise the access check runs first.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { seoErrorResponse } from '@/lib/seo/http'
import { findLocalBusinesses } from '@/lib/seo/local/businesses'
import {
  localFailureResponse,
  optionalNumber,
  optionalString,
  readBody,
} from '@/lib/seo/local/http'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = await readBody(request)
  if (!body) return badRequest('Say what to search for.')
  const near =
    body.near && typeof body.near === 'object'
      ? (body.near as Record<string, unknown>)
      : null
  try {
    const out = await findLocalBusinesses(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      {
        query: optionalString(body.query, 200) ?? null,
        place: optionalString(body.place, 120) ?? null,
        country: optionalString(body.country, 2) ?? null,
        near:
          near &&
          typeof near.latitude === 'number' &&
          typeof near.longitude === 'number'
            ? {
                latitude: near.latitude,
                longitude: near.longitude,
                radius_km: optionalNumber(near.radius_km),
              }
            : null,
        categories: Array.isArray(body.categories)
          ? body.categories
              .filter((entry): entry is string => typeof entry === 'string')
              .slice(0, 10)
          : null,
        min_rating: optionalNumber(body.min_rating) ?? null,
        min_reviews: optionalNumber(body.min_reviews) ?? null,
        is_claimed:
          typeof body.is_claimed === 'boolean' ? body.is_claimed : null,
        limit: optionalNumber(body.limit) ?? null,
        refresh: body.refresh === true,
      },
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ result: out.result })
  } catch (err) {
    return seoErrorResponse(err, 'local business search')
  }
}
