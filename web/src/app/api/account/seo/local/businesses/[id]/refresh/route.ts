/**
 * POST /api/account/seo/local/businesses/[id]/refresh: read the tracked
 * place's Google Business Profile now.
 *
 *   (no body) -> { business: TrackedBusinessView, profile:
 *                GoogleBusinessProfileResult | null, grids:
 *                LocalRankGridDetail[] }, the same shape as GET ../.
 *
 * Paid (one profile read, about half a cent: under the line that needs a
 * yes), always bought afresh; the access check runs first (403 or 503 with
 * its code). The place's rating, reviews and contact details are updated
 * from it. A POST, never a GET: a browser may prefetch or retry a GET, and a
 * GET must never spend.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { seoErrorResponse } from '@/lib/seo/http'
import {
  readGoogleBusinessProfile,
  resolveBusinessRef,
} from '@/lib/seo/local/businesses'
import { listLocalGrids } from '@/lib/seo/local/grids'
import { localFailureResponse, UUID } from '@/lib/seo/local/http'
import { getTrackedBusiness } from '@/lib/seo/local/queries'
import { NextResponse } from 'next/server'

export async function POST(
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
      { refresh: true },
    )
    if (!read.ok) return localFailureResponse(read)
    // Read after the profile, so the updated rating shows.
    const [business, grids] = await Promise.all([
      getTrackedBusiness(svc, auth.workspaceId, id),
      listLocalGrids(svc, auth.workspaceId, id),
    ])
    if (!business) return notFound('Business not found')
    return NextResponse.json({ business, profile: read.result, grids })
  } catch (err) {
    return seoErrorResponse(err, 'local business profile refresh')
  }
}
