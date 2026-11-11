/**
 * POST /m/<token>/notice → { ok: true } an admitted guest has seen that the
 * meeting's call has notes (or a recording) on and pressed "Join with
 * microphone" (phase 7; the guests' side of phase 6's notice route): their
 * listen-only connection may publish from now on, raised through LiveKit to
 * a guest token's sources, never more. Only for a guest let into the live
 * call; the cookie is checked first; limited per guest. 409 when they are
 * not connected (join first); 503 when LiveKit can't be asked.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isSameOriginPost } from '@/lib/links/same-origin'
import { allowGuestPublish, teamCallsConfig } from '@/lib/team-calls/livekit'
import { meetingMemoryLimiter, MEETING_LIMITS } from '@/lib/meeting-links/limits'
import { tokenDigest } from '@/lib/meeting-links/link'
import { guestOf, linkInactive, noGuest, privateHeaders, tooManyTries } from '@/lib/meeting-links/public'
import { meetingByDigest } from '@/lib/meeting-links/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const { token } = await params
  if (!isSameOriginPost(request)) return privateHeaders(apiError('Forbidden', { status: 403, code: 'FORBIDDEN' }))
  const config = teamCallsConfig()
  if (!config) return privateHeaders(linkInactive())
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  if (!meetingMemoryLimiter.hit(MEETING_LIMITS.tokenPerGuest, guestId)) return privateHeaders(tooManyTries())
  try {
    const svc = getServiceClient()
    const meeting = await meetingByDigest(svc, tokenDigest(token))
    if (!meeting || meeting.revoked_at || Date.now() >= Date.parse(meeting.closes_at)) return privateHeaders(linkInactive())
    const { data: guest } = await svc
      .from('meeting_guest')
      .select('state, call_id')
      .eq('id', guestId)
      .eq('meeting_id', meeting.id)
      .maybeSingle<{ state: string; call_id: string | null }>()
    if (!guest) return privateHeaders(noGuest())
    if (guest.state !== 'admitted' || !guest.call_id) return privateHeaders(apiError('You are not in this call', { status: 409, code: 'NOT_ADMITTED' }))
    const { data: call } = await svc.from('team_call').select('room, status').eq('id', guest.call_id).maybeSingle<{ room: string; status: string }>()
    if (!call || call.status !== 'live') return privateHeaders(apiError('You are not in this call', { status: 409, code: 'NOT_ADMITTED' }))
    try {
      await allowGuestPublish(config, call.room, guestId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/not.?found|does not exist/i.test(message)) return privateHeaders(apiError('You are not connected to this call', { status: 409, code: 'NOT_IN_CALL' }))
      console.warn(`[meetings] guest=${guestId} publish not allowed:`, message.slice(0, 120))
      return privateHeaders(apiError('The call server could not be reached', { status: 503, code: 'CALLS_UNREACHABLE' }))
    }
    console.info(`[meetings] guest=${guestId} outcome=notice_seen`)
    return privateHeaders(NextResponse.json({ ok: true }))
  } catch (err) {
    console.error('[meetings] guest notice failed:', err instanceof Error ? err.message : 'unknown')
    return privateHeaders(serverError())
  }
}
