/**
 * POST /api/account/seo/local/estimate: what one scan costs, by the price
 * list. Free maths, never buys anything.
 *
 *   { grid_id }                                   a stored grid
 *   { business_id?, keywords | keyword_count, size?, radius_km?,
 *     center_latitude?, center_longitude? }       a grid being drawn
 *
 * -> { estimate: LocalScanEstimate }
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { estimateLocalScan } from '@/lib/seo/local/grids'
import { localFailureResponse, readBody, UUID } from '@/lib/seo/local/http'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = await readBody(request)
  if (!body) return badRequest('Say which grid.')
  for (const key of ['grid_id', 'business_id'] as const) {
    if (
      body[key] !== undefined &&
      (typeof body[key] !== 'string' || !UUID.test(body[key] as string))
    )
      return badRequest('That isn’t a grid or a tracked business.')
  }
  try {
    const out = await estimateLocalScan(getServiceClient(), auth.workspaceId, {
      grid_id: body.grid_id,
      business_id: body.business_id,
      keywords: body.keywords,
      keyword_count: body.keyword_count,
      size: body.size,
      radius_km: body.radius_km,
      center_latitude: body.center_latitude,
      center_longitude: body.center_longitude,
    })
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ estimate: out.estimate })
  } catch (err) {
    console.error('[seo-local] estimate failed', err)
    return serverError('Could not estimate that just now.')
  }
}
