/**
 * /api/account/seo/local/businesses: the Google places the workspace follows.
 *
 *   GET    { businesses: TrackedBusinessView[], grids: LocalRankGridDetail[],
 *          limits }: every tracked place and every rank grid with its
 *          newest scan. Free.
 *   POST   a listing from a search ({ title, cid | place_id, latitude,
 *          longitude, address?, category?, additional_categories?, phone?,
 *          website?, domain?, rating?, review_count?, is_claimed?, country? }):
 *          follow it. Free. 409 ALREADY_TRACKED (with the one already there)
 *          or LIMIT_REACHED.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { addTrackedBusiness } from '@/lib/seo/local/businesses'
import { listLocalGrids } from '@/lib/seo/local/grids'
import {
  localFailureResponse,
  optionalNumber,
  optionalString,
  readBody,
} from '@/lib/seo/local/http'
import {
  CONFIRM_ABOVE_USD,
  DEFAULT_GRID_SIZE,
  DEFAULT_RADIUS_KM,
  GRID_SIZES,
  MAX_GRIDS_PER_BUSINESS,
  MAX_KEYWORDS_PER_GRID,
  MAX_RADIUS_KM,
  MAX_TRACKED_BUSINESSES,
  MIN_RADIUS_KM,
} from '@/lib/seo/local/limits'
import { listTrackedBusinesses } from '@/lib/seo/local/queries'
import { NextResponse } from 'next/server'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const svc = getServiceClient()
    const [businesses, grids] = await Promise.all([
      listTrackedBusinesses(svc, auth.workspaceId),
      listLocalGrids(svc, auth.workspaceId),
    ])
    return NextResponse.json({
      businesses,
      grids,
      limits: {
        max_businesses: MAX_TRACKED_BUSINESSES,
        max_grids_per_business: MAX_GRIDS_PER_BUSINESS,
        max_keywords_per_grid: MAX_KEYWORDS_PER_GRID,
        grid_sizes: GRID_SIZES,
        default_grid_size: DEFAULT_GRID_SIZE,
        min_radius_km: MIN_RADIUS_KM,
        max_radius_km: MAX_RADIUS_KM,
        default_radius_km: DEFAULT_RADIUS_KM,
        confirm_above_usd: CONFIRM_ABOVE_USD,
      },
    })
  } catch (err) {
    console.error('[seo-local] businesses list failed', err)
    return serverError('Could not load your businesses just now.')
  }
}

export async function POST(request: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = await readBody(request)
  if (!body) return badRequest('Pick a business from a search.')
  try {
    const out = await addTrackedBusiness(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      {
        title: optionalString(body.title, 300) ?? '',
        cid: optionalString(body.cid, 64) ?? null,
        place_id: optionalString(body.place_id, 256) ?? null,
        latitude: optionalNumber(body.latitude) ?? null,
        longitude: optionalNumber(body.longitude) ?? null,
        address: optionalString(body.address, 300) ?? null,
        category: optionalString(body.category, 120) ?? null,
        additional_categories: Array.isArray(body.additional_categories)
          ? body.additional_categories
              .filter((entry): entry is string => typeof entry === 'string')
              .slice(0, 20)
          : [],
        phone: optionalString(body.phone, 60) ?? null,
        website: optionalString(body.website, 2048) ?? null,
        domain: optionalString(body.domain, 253) ?? null,
        rating: optionalNumber(body.rating) ?? null,
        review_count: optionalNumber(body.review_count) ?? null,
        is_claimed:
          typeof body.is_claimed === 'boolean' ? body.is_claimed : null,
        country: optionalString(body.country, 2) ?? null,
        language_code: optionalString(body.language_code, 10) ?? null,
      },
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ business: out.business }, { status: 201 })
  } catch (err) {
    console.error('[seo-local] business add failed', err)
    return serverError('Could not add that business just now.')
  }
}
