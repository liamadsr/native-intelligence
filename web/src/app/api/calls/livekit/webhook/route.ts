/**
 * POST /api/calls/livekit/webhook: LiveKit's room and participant events
 * for team calls (src/lib/team-calls/webhook.ts). The address the server's
 * LIVEKIT_WEBHOOK_URL points at (deploy/livekit). Not the phone line's
 * webhooks (src/app/api/calls/live): another feature.
 *
 * No session (it is LiveKit calling, so it sits outside /api/account, which
 * the proxy holds to a signed-in person). What vouches for a delivery is its
 * `Authorization`: a token signed with our API secret that carries the
 * body's hash, checked by the SDK's WebhookReceiver against the raw body.
 * Anything else is a 401 and changes nothing. A delivery is idempotent
 * (repeats and late arrivals change nothing they shouldn't); a failed write
 * is a 500, so LiveKit sends it again. 404 when calling is off.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { receiveTeamCallWebhook, teamCallsConfig } from '@/lib/team-calls/livekit'
import { applyTeamCallWebhook } from '@/lib/team-calls/webhook'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'

/** The most a delivery's body may be (an event is a few KB). */
const MAX_BODY_BYTES = 256 * 1024

export async function POST(request: NextRequest) {
  const config = teamCallsConfig()
  if (!config) return teamCallsUnavailable()
  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return apiError('Too large', { status: 413 })
  const event = await receiveTeamCallWebhook(config, body, request.headers.get('authorization'))
  if (!event) return apiError('Unauthorized', { status: 401, code: 'BAD_SIGNATURE' })
  try {
    const outcome = await applyTeamCallWebhook(getServiceClient(), event)
    console.info(`[team-calls-webhook] event=${event.event || '-'} room=${event.room?.name ?? '-'} outcome=${outcome}`)
    return NextResponse.json({ ok: true, outcome })
  } catch (err) {
    console.error(`[team-calls-webhook] event=${event.event || '-'} failed:`, err instanceof Error ? err.message : 'unknown')
    return serverError()
  }
}
