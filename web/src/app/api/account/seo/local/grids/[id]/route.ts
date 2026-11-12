/**
 * /api/account/seo/local/grids/[id]: one local rank grid.
 *
 *   GET     { grid: LocalRankGridView, latest_scan: LocalScanView | null,
 *           result: LocalScanResult | null }: the grid, its newest scan and
 *           that scan's squares of positions. Free. The page polls this while
 *           a scan runs.
 *   PATCH   { keywords?, size?, radius_km?, center_latitude?,
 *           center_longitude?, device?, language_code? }: change the grid
 *           ({ grid }). The next scan uses it; earlier scans keep the grid
 *           they searched. 409 STILL_RUNNING while a scan runs.
 *   DELETE  delete the grid with its scans. 409 STILL_RUNNING while a scan
 *           runs.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import {
  deleteLocalGrid,
  getLocalGridDetail,
  updateLocalGrid,
} from '@/lib/seo/local/grids'
import { localFailureResponse, readBody, UUID } from '@/lib/seo/local/http'
import { getLocalScanResult } from '@/lib/seo/local/scans'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Grid not found')
  try {
    const svc = getServiceClient()
    const detail = await getLocalGridDetail(svc, auth.workspaceId, id)
    if (!detail) return notFound('Grid not found')
    const result = detail.latest_scan
      ? await getLocalScanResult(svc, auth.workspaceId, detail.latest_scan.id)
      : null
    return NextResponse.json({
      grid: detail.grid,
      latest_scan: result?.scan ?? detail.latest_scan,
      result,
    })
  } catch (err) {
    console.error('[seo-local] grid read failed', err)
    return serverError('Could not load the grid just now.')
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Grid not found')
  const body = await readBody(request)
  if (!body) return badRequest('Say what to change.')
  try {
    const out = await updateLocalGrid(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
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
    return NextResponse.json({ grid: out.grid })
  } catch (err) {
    console.error('[seo-local] grid update failed', err)
    return serverError('Could not change the grid just now.')
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Grid not found')
  try {
    const out = await deleteLocalGrid(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ deleted: true })
  } catch (err) {
    console.error('[seo-local] grid delete failed', err)
    return serverError('Could not delete the grid just now.')
  }
}
