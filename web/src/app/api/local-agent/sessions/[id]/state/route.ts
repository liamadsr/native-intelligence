/**
 * POST /api/local-agent/sessions/[id]/state — the launcher's `session` and
 * `cursor` lines and process exits.
 *
 * Body: {runId, previousRunId?, deviceId?, eveSessionId?, streamIndex?, status?, error?}.
 * Only the session's current run may write. `previousRunId` rebinds the
 * session from that run (the claim's provisional one, or the run a resume
 * replaced) to `runId` first; the relay holds its uploads until `applied`.
 * Returns {applied, stopRequested}.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { parseStateUpdate, updateState } from '@/lib/local-agent/device'
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
    return NextResponse.json(await updateState(getServiceClient(), auth.user.id, id, parseStateUpdate(body)))
  } catch (err) {
    return errorResponse(err, 'state update')
  }
}
