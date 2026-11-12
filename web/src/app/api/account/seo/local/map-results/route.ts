/**
 * POST /api/account/seo/local/map-results: the Google Maps list for one
 * search from one spot.
 *
 *   { keyword, business_id? | latitude + longitude | place + country?,
 *     zoom?, device?, depth?, refresh? } -> { result: LocalMapResults }
 *
 * From a tracked business, the search runs at its coordinate and its row is
 * marked (target_position). Paid, live, kept for 12 hours.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { seoErrorResponse } from '@/lib/seo/http'
import {
  localFailureResponse,
  optionalString,
  readBody,
  UUID,
} from '@/lib/seo/local/http'
import { readLocalMapResults } from '@/lib/seo/local/map-results'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = await readBody(request)
  if (!body) return badRequest('Give the search and where to make it.')
  const businessId = optionalString(body.business_id, 40)
  if (businessId && !UUID.test(businessId))
    return badRequest('That isn’t a tracked business.')
  try {
    const out = await readLocalMapResults(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      {
        keyword: body.keyword,
        business_id: businessId ?? null,
        latitude: body.latitude,
        longitude: body.longitude,
        place: optionalString(body.place, 120) ?? null,
        country: optionalString(body.country, 2) ?? null,
        zoom: body.zoom,
        device: body.device,
        depth: body.depth,
        refresh: body.refresh === true,
      },
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ result: out.result })
  } catch (err) {
    return seoErrorResponse(err, 'local map results')
  }
}
