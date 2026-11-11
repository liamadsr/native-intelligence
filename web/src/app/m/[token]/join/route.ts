/**
 * POST /m/<token>/join { name } → { state: 'waiting' }: someone without an
 * account asks to join a meeting (phase 7). Public: no session; a same-origin
 * POST from the meeting's own page only.
 *
 * Limited per address and per link (looking the link up, then asking); the
 * name is 1 to 60 letters, digits, spaces and . ' - ( ). A guest asking again
 * with their cookie (a reload) gets their own place back, never a second one.
 * The guest waits (574's meeting_guest_request, at most 10 waiting at once);
 * their cookie (signed, http-only, this meeting's path only) is what their
 * lobby and token routes trust. Nobody in the call to let them in: the host
 * gets one notice. A link that doesn't work answers as one, whatever the
 * reason; a guest removed from this link, from this address, is refused.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isSameOriginPost } from '@/lib/links/same-origin'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { hitLimits, MEETING_LIMITS } from '@/lib/meeting-links/limits'
import { guestCookieOptions, MEETING_GUEST_COOKIE, signGuestCookie } from '@/lib/meeting-links/link'
import { guestOf, linkEarly, linkInactive, lookUpMeeting, privateHeaders, tooManyTries } from '@/lib/meeting-links/public'
import { cleanGuestName } from '@/lib/meeting-links/shape'
import { notifyHostWaiting, pollGuest, requestToJoin } from '@/lib/meeting-links/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const { token } = await params
  if (!isSameOriginPost(request)) return privateHeaders(apiError('Forbidden', { status: 403, code: 'FORBIDDEN' }))
  if (!teamCallsConfig()) return privateHeaders(linkInactive())
  const raw = await request.text().catch(() => '')
  if (raw.length > 2_000) return privateHeaders(badRequest('Too large'))
  let input: { name?: unknown } = {}
  try {
    input = raw ? (JSON.parse(raw) as { name?: unknown }) : {}
  } catch {
    return privateHeaders(badRequest('Invalid JSON body'))
  }
  try {
    const svc = getServiceClient()
    const found = await lookUpMeeting(svc, token, request.headers)
    if (found.kind === 'limited') return privateHeaders(tooManyTries())
    if (found.kind === 'inactive') return privateHeaders(linkInactive())
    if (found.kind === 'early') return privateHeaders(linkEarly(found.meeting))
    const { meeting, digest, rateKey } = found

    // Asked already (a reload): their own place, never a second one.
    const known = guestOf(request, token)
    if (known) {
      const poll = await pollGuest(svc, known, digest)
      if (poll && (poll.state === 'waiting' || poll.state === 'admitted')) return privateHeaders(NextResponse.json({ state: poll.state }))
    }

    const name = cleanGuestName(input.name)
    if (!name) return privateHeaders(apiError('Use 1 to 60 letters for your name.', { status: 400, code: 'BAD_NAME' }))
    const under = await hitLimits(svc, [
      [MEETING_LIMITS.joinPerAddress, rateKey],
      [MEETING_LIMITS.joinPerLink, digest.slice(0, 32)],
    ])
    if (!under) return privateHeaders(tooManyTries())

    const asked = await requestToJoin(svc, { meetingId: meeting.id, name, rateKey })
    switch (asked.outcome) {
      case 'waiting':
        break
      case 'early':
        return privateHeaders(linkEarly(meeting))
      case 'refused':
        return privateHeaders(apiError('You can’t join this meeting.', { status: 403, code: 'MEETING_REFUSED' }))
      case 'full':
        return privateHeaders(apiError('Too many people are waiting. Try again in a few minutes.', { status: 429, code: 'LOBBY_FULL' }))
      default:
        return privateHeaders(linkInactive())
    }
    const guestId = asked.guestId!
    const cookie = signGuestCookie(token, guestId, new Date(meeting.closes_at))
    const res = NextResponse.json({ state: 'waiting' })
    res.cookies.set(MEETING_GUEST_COOKIE, cookie.value, guestCookieOptions(token, cookie.expires))
    // Nobody in the call to let them in: the host hears of it (one notice at a time).
    if (asked.membersInCall === 0) after(() => notifyHostWaiting(svc, { meeting, guestId, guestName: name }).then(() => undefined))
    console.info(`[meetings] meeting=${meeting.id} guest=${guestId} outcome=waiting in_call=${asked.membersInCall}`)
    return privateHeaders(res)
  } catch (err) {
    console.error('[meetings] join failed:', err instanceof Error ? err.message : 'unknown')
    return privateHeaders(serverError())
  }
}
