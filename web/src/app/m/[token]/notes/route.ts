/**
 * GET /m/<token>/notes → { lines: [{ at, speaker, text }], summary: [{ kind,
 * text }] } what a guest reads of the call's notes while they are in it
 * (phase 2: everyone in a call sees its notes). A guest has no database
 * session: their page asks every few seconds while its notes are open and
 * the tab is on screen.
 *
 * `lines`: the call's own words since the guest was let in (657), each with
 * its time, its speaker's label as the call shows it, and its words.
 * `summary`: the live agent's notes of the call as plain blocks (the owner's
 * decision, 2026-11-18; src/lib/team-calls/live-notes.ts says what that
 * means for a guest): headings, bullets and lines of words, never the raw
 * markdown, a link's address, a proposal's anchor or the agent's state.
 * Empty until the agent's first turn.
 *
 * Checked as every guest route is: the signed cookie first, with no read (a
 * forged or missing one is a 401 that touched nothing), then limits counted
 * in memory per guest and per address, then 657's team_call_guest_notes (by
 * the guest and the link's hash), which also says they are still let into
 * that live call. Only after its yes is the summary read, only while the
 * guest is in the room, and only of the live call their own row is let
 * into, notes on. 403 once they are
 * not (left, removed, the call or its notes over); 404 while the live notes
 * are off on this server. A summary that cannot be read costs the guest the
 * summary, never the lines.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { meetingMemoryLimiter, MEETING_LIMITS } from '@/lib/meeting-links/limits'
import { rateKeyOf, tokenDigest } from '@/lib/meeting-links/link'
import { guestOf, noGuest, privateHeaders, tooManyTries } from '@/lib/meeting-links/public'
import { guestLinesOf, guestSummaryOf, type SummaryBlock } from '@/lib/team-calls/live-notes'
import { teamCallLiveAgentOn } from '@/lib/team-calls/live-turns'

export const dynamic = 'force-dynamic'

/** The most lines one read carries (the newest). */
const GUEST_NOTES_MAX_LINES = 200

type Params = { params: Promise<{ token: string }> }

/**
 * The agent's notes of the call this guest is let into, as plain blocks.
 * Called only after 657 said the guest is in it: the guest's own row (in the
 * room now: 657's grace for a reconnect gives the lines said before they
 * dropped, never notes still being written) names the call, and the call
 * (live, notes on) names the capture.
 */
async function summaryFor(svc: ReturnType<typeof getServiceClient>, guestId: string): Promise<SummaryBlock[]> {
  const { data: guest, error: guestError } = await svc.from('meeting_guest').select('call_id').eq('id', guestId).eq('state', 'admitted').eq('in_call', true).maybeSingle<{ call_id: string | null }>()
  if (guestError) throw new Error(guestError.message)
  if (!guest?.call_id) return []
  const { data: call, error: callError } = await svc
    .from('team_call')
    .select('capture_id')
    .eq('id', guest.call_id)
    .eq('status', 'live')
    .eq('notes', true)
    .maybeSingle<{ capture_id: string | null }>()
  if (callError) throw new Error(callError.message)
  if (!call?.capture_id) return []
  const { data: notes, error: notesError } = await svc.from('team_call_live_notes').select('summary').eq('capture_id', call.capture_id).maybeSingle<{ summary: string | null }>()
  if (notesError) throw new Error(notesError.message)
  return guestSummaryOf(notes?.summary)
}

export async function GET(request: NextRequest, { params }: Params) {
  if (!teamCallLiveAgentOn()) return privateHeaders(notFound())
  const { token } = await params
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  if (!meetingMemoryLimiter.hit(MEETING_LIMITS.notesPerGuest, guestId) || !meetingMemoryLimiter.hit(MEETING_LIMITS.pollPerAddress, rateKeyOf(request.headers))) {
    return privateHeaders(tooManyTries())
  }
  try {
    const svc = getServiceClient()
    const { data, error } = await svc.rpc('team_call_guest_notes', {
      target_guest: guestId,
      token_digest: tokenDigest(token),
      max_lines: GUEST_NOTES_MAX_LINES,
    })
    if (error) throw new Error(error.message)
    const answer = (data ?? {}) as { allowed?: unknown; lines?: unknown }
    if (answer.allowed !== true) return privateHeaders(apiError('The call’s notes are for the people in it', { status: 403, code: 'NOT_IN_CALL' }))
    const summary = await summaryFor(svc, guestId).catch((err: unknown) => {
      console.error('[meetings] guest summary failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
      return [] as SummaryBlock[]
    })
    return privateHeaders(NextResponse.json({ lines: guestLinesOf(answer.lines), summary }))
  } catch (err) {
    console.error('[meetings] guest notes failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return privateHeaders(serverError())
  }
}
