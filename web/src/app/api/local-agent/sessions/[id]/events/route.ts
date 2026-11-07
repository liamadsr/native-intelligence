/**
 * POST /api/local-agent/sessions/[id]/events — the Mac uploads transcript events.
 *
 * Body: {runId, events:[{seq, event}]}, at most 200. Inserts with conflict on
 * (session, run, seq) ignored, so a retried or overlapping upload is a no-op;
 * derives the session's state from the new events, renews the lease and moves
 * the ledger. Returns {stopRequested, inserted}.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { ingestEvents, parseEventUpload } from '@/lib/local-agent/device'
import { errorResponse, readJsonBody, requireLocalAgentUser } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const { id } = await ctx.params
  const body = await readJsonBody(request)
  if (body instanceof Response) return body
  try {
    const result = await ingestEvents(getServiceClient(), auth.user.id, id, parseEventUpload(body))
    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err, 'events upload')
  }
}
