/**
 * GET /m/<token>/notes → { lines: [{ at, speaker, text }] } what has been
 * said in the call since the guest was let in, while they are in it (phase 2:
 * everyone in a call sees its notes). A guest has no database session: their
 * page asks every few seconds while its notes are open and the tab is on
 * screen.
 *
 * Only the call's own words, never the live agent's summary: the agent also
 * reads the workspace (its people, earlier meetings, documents), so nothing
 * it writes can be promised to come from this call alone (657, and
 * src/lib/team-calls/live-notes.ts). Each line carries its time, its
 * speaker's label as the call shows it, and its words, nothing else.
 *
 * Checked as every guest route is: the signed cookie first, with no read (a
 * forged or missing one is a 401 that touched nothing), then limits counted
 * in memory per guest and per address, then one read (657's
 * team_call_guest_notes, by the guest and the link's hash), which also says
 * they are still let into that live call. 403 once they are not (left,
 * removed, the call or its notes over); 404 while the live notes are off on
 * this server.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { meetingMemoryLimiter, MEETING_LIMITS } from '@/lib/meeting-links/limits'
import { rateKeyOf, tokenDigest } from '@/lib/meeting-links/link'
import { guestOf, noGuest, privateHeaders, tooManyTries } from '@/lib/meeting-links/public'
import { guestLinesOf } from '@/lib/team-calls/live-notes'
import { teamCallLiveAgentOn } from '@/lib/team-calls/live-turns'

export const dynamic = 'force-dynamic'

/** The most lines one read carries (the newest). */
const GUEST_NOTES_MAX_LINES = 200

type Params = { params: Promise<{ token: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  if (!teamCallLiveAgentOn()) return privateHeaders(notFound())
  const { token } = await params
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  if (!meetingMemoryLimiter.hit(MEETING_LIMITS.notesPerGuest, guestId) || !meetingMemoryLimiter.hit(MEETING_LIMITS.pollPerAddress, rateKeyOf(request.headers))) {
    return privateHeaders(tooManyTries())
  }
  try {
    const { data, error } = await getServiceClient().rpc('team_call_guest_notes', {
      target_guest: guestId,
      token_digest: tokenDigest(token),
      max_lines: GUEST_NOTES_MAX_LINES,
    })
    if (error) throw new Error(error.message)
    const answer = (data ?? {}) as { allowed?: unknown; lines?: unknown }
    if (answer.allowed !== true) return privateHeaders(apiError('The call’s notes are for the people in it', { status: 403, code: 'NOT_IN_CALL' }))
    return privateHeaders(NextResponse.json({ lines: guestLinesOf(answer.lines) }))
  } catch (err) {
    console.error('[meetings] guest notes failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return privateHeaders(serverError())
  }
}
