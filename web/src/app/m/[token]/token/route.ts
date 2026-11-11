/**
 * POST /m/<token>/token → { join, call }: an admitted guest's LiveKit token
 * (phase 7), the first one and a rejoin after a lost connection. Only for a
 * guest a member let into the meeting's live call (573's state 'admitted',
 * its call_id), while the link works: a removed, declined or departed guest,
 * a revoked link or an ended call gets none (so a removal also stops any
 * token being renewed this way; LiveKit's own refresh of a connected
 * participant ends with their removal from the room).
 *
 * The token: identity `guest-<id>` (never a member id), the name they typed,
 * metadata `{"guest":true}` they can't change, ten minutes, publish the
 * microphone, camera and screen and subscribe, nothing else
 * (src/lib/team-calls/livekit.ts meetingGuestToken). The cookie is checked
 * first; limited per guest.
 *
 * Listen-only (phase 6's notice, enforced by the server for guests): while
 * the call has notes in a round, or a recording since it started, that the
 * guest has not said go to (573's notes_ack_round, recording_ack_at, written
 * only by POST /m/<token>/notice), the token publishes nothing. Nothing the
 * client sends changes that.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isSameOriginPost } from '@/lib/links/same-origin'
import { meetingGuestToken, teamCallsConfig } from '@/lib/team-calls/livekit'
import { readyRoom } from '@/lib/team-calls/routes'
import { meetingMemoryLimiter, MEETING_LIMITS } from '@/lib/meeting-links/limits'
import { tokenDigest } from '@/lib/meeting-links/link'
import { guestOf, linkInactive, noGuest, privateHeaders, smallBody, tooManyTries } from '@/lib/meeting-links/public'
import { meetingByDigest } from '@/lib/meeting-links/store'
import { guestNeedsNotice } from '@/lib/meeting-links/shape'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

function notLetIn(state: string): Response {
  return apiError('You are not in this call', { status: 409, code: 'NOT_ADMITTED', details: { state } })
}

export async function POST(request: NextRequest, { params }: Params) {
  const { token } = await params
  if (!isSameOriginPost(request)) return privateHeaders(apiError('Forbidden', { status: 403, code: 'FORBIDDEN' }))
  const config = teamCallsConfig()
  if (!config) return privateHeaders(linkInactive())
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  if (!meetingMemoryLimiter.hit(MEETING_LIMITS.tokenPerGuest, guestId)) return privateHeaders(tooManyTries())
  const body = await smallBody(request)
  if (body instanceof Response) return body
  try {
    const svc = getServiceClient()
    const meeting = await meetingByDigest(svc, tokenDigest(token))
    if (!meeting || meeting.revoked_at || Date.now() >= Date.parse(meeting.closes_at)) return privateHeaders(linkInactive())
    const { data: guest } = await svc
      .from('meeting_guest')
      .select('id, name, state, call_id, notes_ack_round, recording_ack_at')
      .eq('id', guestId)
      .eq('meeting_id', meeting.id)
      .maybeSingle<{ id: string; name: string; state: string; call_id: string | null; notes_ack_round: number; recording_ack_at: string | null }>()
    if (!guest) return privateHeaders(noGuest())
    if (guest.state !== 'admitted' || !guest.call_id) return privateHeaders(notLetIn(guest.state))
    const { data: call } = await svc
      .from('team_call')
      .select('id, room, status, started_at, channel_id, notes, notes_round, recording, recording_started_at')
      .eq('id', guest.call_id)
      .maybeSingle<{ id: string; room: string; status: string; started_at: string; channel_id: string; notes: boolean; notes_round: number; recording: string; recording_started_at: string | null }>()
    if (!call || call.status !== 'live' || call.channel_id !== meeting.channel_id) return privateHeaders(notLetIn('left'))
    let room: 'ready' | 'ended'
    try {
      room = await readyRoom(config, call)
    } catch {
      return privateHeaders(apiError('The call server could not be reached', { status: 503, code: 'CALLS_UNREACHABLE' }))
    }
    if (room === 'ended') return privateHeaders(notLetIn('left'))
    const listenOnly = guestNeedsNotice(call, guest)
    const jwt = await meetingGuestToken(config, { room: call.room, guestId: guest.id, name: guest.name, listenOnly })
    return privateHeaders(
      NextResponse.json({
        join: { url: config.url, token: jwt, room: call.room, callId: call.id, canPublish: !listenOnly },
        call: { notes: call.notes === true, recording: call.recording ?? 'off' },
      }),
    )
  } catch (err) {
    console.error('[meetings] guest token failed:', err instanceof Error ? err.message : 'unknown')
    return privateHeaders(serverError())
  }
}
