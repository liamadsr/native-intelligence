/**
 * POST /api/local-agent/device — the desktop relay's 60 s heartbeat.
 *
 * Body: {deviceId, name, platform, appVersion, grants:[{grantId,label,path,mode,isGit}], liveJobIds?,
 * capabilities?, rejoin?}. `capabilities` (E2): what the Mac's app says it can
 * do, known names only (today `baseBranch`); a beat without it clears them.
 * Upserts the device (last_seen_at), mirrors its grants (a grant no longer
 * sent is revoked) and renews its working sessions' leases.
 * Returns {folders:[{id, grantId, label, mode, isGit}]}.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { heartbeat, parseHeartbeat } from '@/lib/local-agent/device'
import { errorResponse, readJsonBody, requireLocalAgentUser } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'

export async function POST(request: Request) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const body = await readJsonBody(request)
  if (body instanceof Response) return body
  try {
    const result = await heartbeat(getServiceClient(), auth.user.id, parseHeartbeat(body))
    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err, 'device heartbeat')
  }
}
