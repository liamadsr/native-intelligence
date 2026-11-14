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
 * Each answers no (null, false) when it cannot read: a turn or a tool call is
 * refused, a pass is let through (as it always was).
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

/**
 * Does this server turn still hold its lease (lease_id is it, lease_until not
 * passed)? The tool route's question for each tool call a call's server turn
 * makes: once the turn released its lease (its answer in), its session writes
 * nothing more, whatever became of its cancel. The lease, not the agent's
 * state: a turn still running when the call ended keeps its writes while the
 * call's finish waits for it. False when it cannot read (the call is refused).
 */
export async function callTurnLeaseHeld(captureId: string, lease: string): Promise<boolean> {
  const { data, error } = await getServiceClient()
    .from('team_call_live_agent')
    .select('lease_until')
    .eq('capture_id', captureId)
    .eq('lease_id', lease)
    .maybeSingle<{ lease_until: string | null }>()
  if (error || !data?.lease_until) return false
  const until = Date.parse(data.lease_until)
  return Number.isFinite(until) && until > Date.now()
}

/**
 * Is a server turn still holding back this call's end-of-meeting pass (655's
 * team_call_live_turn_busy: its lease, and a short margin past its end for a
 * write already started)? False when it cannot read: before 655 is applied no
 * server turn exists, and the owner's Reprocess runs as it always did.
 */
export async function callLiveTurnBusy(captureId: string): Promise<boolean> {
  const { data, error } = await getServiceClient().rpc('team_call_live_turn_busy', { target_capture: captureId })
  return !error && data === true
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
