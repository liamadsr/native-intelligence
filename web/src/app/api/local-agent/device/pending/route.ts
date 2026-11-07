/**
 * GET /api/local-agent/device/pending?deviceId=… — what this Mac should do now.
 *
 * Returns {start:[{sessionId, grantId, mode, request, resume:{eveSessionId, streamIndex}|null}],
 *          messages:[{id, sessionId, text, policy, author}], stops:[{sessionId}]},
 * only for this device's folders. Lazy reaping applies.
 */
import { NextResponse } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { pendingFor } from '@/lib/local-agent/device'
import { errorResponse, requireLocalAgentUser } from '@/lib/local-agent/http'

export async function GET(request: Request) {
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const deviceId = new URL(request.url).searchParams.get('deviceId')
  if (!deviceId) return badRequest('deviceId is required')
  try {
    return NextResponse.json(await pendingFor(getServiceClient(), auth.user.id, deviceId))
  } catch (err) {
    return errorResponse(err, 'device pending')
  }
}
