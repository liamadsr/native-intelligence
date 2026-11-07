/**
 * POST /api/local-agent/sessions/[id]/stop — stop a local agent.
 *
 * A queued (or interrupted) session is cancelled at once; a live one gets
 * stop_requested_at and the doorbell, and the Mac settles it. Returns {session}.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { errorResponse, requireLocalAgentUser } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'
import { requestStop } from '@/lib/local-agent/store'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const { id } = await ctx.params
  try {
    return NextResponse.json({ session: await requestStop(getServiceClient(), auth.user.id, id) })
  } catch (err) {
    return errorResponse(err, 'stop')
  }
}
