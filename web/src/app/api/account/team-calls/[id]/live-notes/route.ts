/**
 * GET /api/account/team-calls/[id]/live-notes → { captureId, summary, state }
 * the call's shared live notes, for someone in the call (phase 2: the live
 * agent writes them on the server as people speak, src/lib/team-calls/
 * live-turns.ts). `summary`: the summary the agent last wrote; `state`: what
 * the agent is doing (655's team_call_live_notes: working with until when,
 * ready, failed or stopped), or null before its first turn.
 *
 * Read as the person, so the notes are theirs to read only as the capture is:
 * a member of the call's conversation (566's fence), never anyone else in the
 * workspace. After this first read the panel follows that small row over
 * Realtime (never the capture's own row, which carries the whole transcript).
 *
 * `feed`: why the call's words are not being written now (668: the
 * recorder's health), or null while they are.
 *
 * 404 while the call recorder is off here, or when the call or its notes are
 * not the person's to read; `captureId: null` while the call has no notes yet.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { getCall } from '@/lib/team-calls/store'
import { teamCallRecorderOn } from '@/lib/team-calls/recorder'
import { liveNotesOf, type LiveNotesRow } from '@/lib/team-calls/live-notes'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  // The recorder's notes: the live agent's summary when it is on, and the words' health either way.
  if (!teamCallRecorderOn()) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const call = await getCall(auth.supabase, id)
    if (!call) return notFound()
    if (!call.capture_id) return NextResponse.json({ captureId: null, summary: '', state: null, feed: null })
    // The narrow row (655), read as the person: its policy asks the capture, under the capture's own rules.
    const { data: notes, error } = await auth.supabase
      .from('team_call_live_notes')
      // Every column (668's feed_state included where it is applied; a database without it reads the rest).
      .select('*')
      .eq('capture_id', call.capture_id)
      .maybeSingle<LiveNotesRow>()
    if (error) throw new Error(error.message)
    if (notes) return NextResponse.json({ captureId: call.capture_id, ...liveNotesOf(notes) })
    // No turn yet: the capture itself, as the person may read it.
    const { data: capture, error: captureError } = await auth.supabase
      .from('captures')
      .select('id, ai_summary')
      .eq('id', call.capture_id)
      .maybeSingle<{ id: string; ai_summary: string | null }>()
    if (captureError) throw new Error(captureError.message)
    if (!capture) return notFound()
    return NextResponse.json({ captureId: capture.id, summary: capture.ai_summary ?? '', state: null, feed: null })
  } catch (err) {
    console.error('[call-live-notes] read failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return serverError()
  }
}
