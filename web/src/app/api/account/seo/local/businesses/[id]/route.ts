/**
 * /api/account/seo/local/businesses/[id]: one tracked Google place.
 *
 *   GET     { business: TrackedBusinessView, profile:
 *           GoogleBusinessProfileResult | null, grids:
 *           LocalRankGridDetail[] }. Free, always: the profile is the stored
 *           read, whatever its age (null until one is made). A GET never
 *           spends (a browser may prefetch or retry one), so `?refresh` is
 *           ignored: a fresh profile is POST ./refresh.
 *   DELETE  stop following it, with its grids and their scans. 409
 *           STILL_RUNNING while one of its scans runs.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { seoErrorResponse } from '@/lib/seo/http'
import {
  readGoogleBusinessProfile,
  removeTrackedBusiness,
  resolveBusinessRef,
} from '@/lib/seo/local/businesses'
import { listLocalGrids } from '@/lib/seo/local/grids'
import { localFailureResponse, UUID } from '@/lib/seo/local/http'
import { getTrackedBusiness } from '@/lib/seo/local/queries'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Business not found')
  try {
    const svc = getServiceClient()
    const resolved = await resolveBusinessRef(svc, auth.workspaceId, {
      business_id: id,
    })
    if (!resolved.ok) return notFound('Business not found')
    const read = await readGoogleBusinessProfile(
      svc,
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      resolved.ref,
      { storedOnly: true },
    )
    if (!read.ok) return localFailureResponse(read)
    const [business, grids] = await Promise.all([
      getTrackedBusiness(svc, auth.workspaceId, id),
      listLocalGrids(svc, auth.workspaceId, id),
    ])
    if (!business) return notFound('Business not found')
    return NextResponse.json({ business, profile: read.result, grids })
  } catch (err) {
    return seoErrorResponse(err, 'local business profile')
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Business not found')
  try {
    const out = await removeTrackedBusiness(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ deleted: true })
  } catch (err) {
    console.error('[seo-local] business remove failed', err)
    return serverError('Could not remove that business just now.')
  }
}
