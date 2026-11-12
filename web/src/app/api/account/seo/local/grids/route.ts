/**
 * /api/account/seo/local/grids: local rank grids.
 *
 *   GET  ?business_id=   { grids: LocalRankGridDetail[] }: the grids (of one
 *                        tracked place, or all), each with its newest scan.
 *   POST { business_id, keywords, size?, radius_km?, center_latitude?,
 *        center_longitude?, device?, language_code? }: create one ({ grid:
 *        LocalRankGridView }, 201). The centre defaults to the place's own
 *        coordinate. 409 LIMIT_REACHED past the per-place cap.
 *
 * Free: creating a grid spends nothing; a scan does.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { createLocalGrid, listLocalGrids } from '@/lib/seo/local/grids'
import { localFailureResponse, readBody, UUID } from '@/lib/seo/local/http'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const businessId = request.nextUrl.searchParams.get('business_id')
  if (businessId && !UUID.test(businessId))
    return badRequest('That isn’t a tracked business.')
  try {
    return NextResponse.json({
      grids: await listLocalGrids(
        getServiceClient(),
        auth.workspaceId,
        businessId,
      ),
    })
  } catch (err) {
    console.error('[seo-local] grids list failed', err)
    return serverError('Could not load your rank grids just now.')
  }
}

export async function POST(request: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = await readBody(request)
  if (
    !body ||
    typeof body.business_id !== 'string' ||
    !UUID.test(body.business_id)
  )
    return badRequest('Which tracked business is the grid for?')
  try {
    const out = await createLocalGrid(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      body.business_id,
      {
        keywords: body.keywords,
        size: body.size,
        radius_km: body.radius_km,
        center_latitude: body.center_latitude,
        center_longitude: body.center_longitude,
        device: body.device,
        language_code: body.language_code,
      },
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ grid: out.grid }, { status: 201 })
  } catch (err) {
    console.error('[seo-local] grid create failed', err)
    return serverError('Could not create the grid just now.')
  }
}
