/**
 * GET /m/<token>/lobby → { state, notes, recording, open }: a waiting guest's
 * page asks, every few seconds while it is on screen, whether they were let
 * in (phase 7). Guests have no database session, so this short poll is how
 * the lobby reaches them.
 *
 * Cheap on purpose: the signed cookie is checked first, with no read (a
 * forged or missing one is a 401 that touched nothing), then limits counted
 * in memory per guest and per address, then one read (574's
 * meeting_guest_poll, by the guest and the link's hash), which also says
 * they are still there. `notes` and `recording`: what the meeting's live
 * call has on, for the notice the guest sees before any audio is sent;
 * `needsNotice`: the server holds their publishing until they say go to it;
 * `membersInCall`: none means the host has left (the call ends after a few
 * minutes with no member in it).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { meetingMemoryLimiter, MEETING_LIMITS } from '@/lib/meeting-links/limits'
import { clearedGuestCookieOptions, MEETING_GUEST_COOKIE, rateKeyOf, tokenDigest } from '@/lib/meeting-links/link'
import { guestOf, noGuest, privateHeaders, tooManyTries } from '@/lib/meeting-links/public'
import { pollGuest } from '@/lib/meeting-links/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const { token } = await params
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  if (!meetingMemoryLimiter.hit(MEETING_LIMITS.pollPerGuest, guestId) || !meetingMemoryLimiter.hit(MEETING_LIMITS.pollPerAddress, rateKeyOf(request.headers))) {
    return privateHeaders(tooManyTries())
  }
  try {
    const poll = await pollGuest(getServiceClient(), guestId, tokenDigest(token))
    if (!poll) {
      const res = noGuest()
      const out = NextResponse.json(await res.json(), { status: res.status })
      out.cookies.set(MEETING_GUEST_COOKIE, '', clearedGuestCookieOptions(token))
      return privateHeaders(out)
    }
    return privateHeaders(
      NextResponse.json({ state: poll.state, notes: poll.notes, recording: poll.recording, open: poll.open, needsNotice: poll.needsNotice, membersInCall: poll.membersInCall }),
    )
  } catch (err) {
    console.error('[meetings] lobby failed:', err instanceof Error ? err.message : 'unknown')
    return privateHeaders(serverError())
  }
}
