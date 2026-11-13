/**
 * What the live agent's route asks of a call's capture before a turn on it
 * (server only; the service role). Two questions:
 *
 *   - Is this lease the running server turn's, and until when (655's
 *     team_call_live_turn_lease_until)? A server turn's key is bound to its
 *     lease (src/lib/live-agent/call-turn-key.ts), and it runs only while it
 *     holds it.
 *   - Are the call's notes being written live: the call live, this capture
 *     its current one, and the capture still open? Then no end-of-meeting pass
 *     (Reprocess) runs beside the server's turns; the call's own finish runs
 *     it when the call ends. A capture its owner closed by hand mid-call is
 *     not live, so its own finish (src/lib/inngest/team-call-notes.ts) runs.
 *
 * Each answers no (null, false) when it cannot read: a turn is refused, a
 * pass is let through (as it always was).
 */
import 'server-only'
import { getServiceClient } from '@/lib/admin'

/** The running turn's lease end (epoch ms) when `lease` is it, else null. */
export async function callTurnLeaseUntil(captureId: string, lease: string): Promise<number | null> {
  const { data, error } = await getServiceClient().rpc('team_call_live_turn_lease_until', { target_capture: captureId, turn_lease: lease })
  if (error || typeof data !== 'string') return null
  const until = Date.parse(data)
  return Number.isFinite(until) && until > Date.now() ? until : null
}

/** Is this call's capture being written live now (its call live, it the current capture, open)? */
export async function callNotesLive(captureId: string): Promise<boolean> {
  const svc = getServiceClient()
  const [{ data: call }, { data: capture }] = await Promise.all([
    svc.from('team_call').select('id').eq('capture_id', captureId).eq('status', 'live').limit(1).maybeSingle<{ id: string }>(),
    svc.from('captures').select('ended_at, is_transcript_locked').eq('id', captureId).maybeSingle<{ ended_at: string | null; is_transcript_locked: boolean | null }>(),
  ])
  return !!call && !!capture && !capture.ended_at && capture.is_transcript_locked !== true
}
