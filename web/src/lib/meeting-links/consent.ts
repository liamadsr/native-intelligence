/**
 * A meeting guest's consent to notes and recording (server only).
 *
 * A guest says go to what is on, the notes and the recording, through their
 * page's notice (POST /m/<token>/notice: 667's meeting_guest_ack records
 * it), or by asking to join from an entry page that already said so
 * ({@link agreeOnEntry}). A go to the notes holds for the rest of that call
 * (a member turning them off and on again holds nobody who agreed); a go to
 * a recording holds for that recording. Until they have for what is on now:
 *   - their token is listen-only (the token route);
 *   - no notes file of theirs is made (574's meeting_guest_egress_claim);
 *   - and when notes or a recording come on while they are connected, the
 *     server takes their publishing away at once ({@link holdGuestsForNotice},
 *     run by the notes and recording routes before any egress starts):
 *     LiveKit unpublishes their tracks and their page shows the notice.
 * A guest who never says go stays listen-only and is never captured.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { holdGuestPublish, type TeamCallsConfig } from '@/lib/team-calls/livekit'
import { entryNotice, guestNeedsNotice } from './shape'

/** The guests connected to this call who must see the notice now, held to listen-only. Never throws; logs ids only. */
export async function holdGuestsForNotice(svc: SupabaseClient, config: TeamCallsConfig, callId: string): Promise<number> {
  try {
    const [{ data: call }, { data: guests }] = await Promise.all([
      svc.from('team_call').select('room, status, notes, notes_round, recording, recording_started_at').eq('id', callId).maybeSingle<{
        room: string
        status: string
        notes: boolean
        notes_round: number
        recording: string
        recording_started_at: string | null
      }>(),
      svc.from('meeting_guest').select('id, notes_ack_round, recording_ack_at').eq('call_id', callId).eq('state', 'admitted').eq('in_call', true),
    ])
    if (!call || call.status !== 'live') return 0
    let held = 0
    for (const g of (guests ?? []) as Array<{ id: string; notes_ack_round: number; recording_ack_at: string | null }>) {
      if (!guestNeedsNotice(call, g)) continue
      try {
        await holdGuestPublish(config, call.room, g.id)
        held++
      } catch (err) {
        // Not connected after all, or LiveKit unreachable: their notes file is refused by the database either way.
        console.warn(`[meetings] call=${callId} guest=${g.id} not held:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
      }
    }
    if (held) console.info(`[meetings] call=${callId} guests_held=${held}`)
    return held
  } catch (err) {
    console.warn(`[meetings] call=${callId} guests not checked:`, err instanceof Error ? err.message : 'unknown')
    return 0
  }
}

/**
 * The entry page's notice counts as the guest's go (POST /m/<token>/join):
 * when the page the server serves says the notes are on (the live call has
 * them, or every call starts with them: `notesAtStart`) and the guest asked to
 * join from it, that is their go to the notes for the call they are let into;
 * the same for a recording the live call is running. The server decides what
 * the page said (./shape.ts entryNotice, from the call it reads now). The
 * page's own `said` (what it showed when they pressed) can only narrow it: a
 * page served before the notes came on, which never showed them, is not
 * taken as a go. Written only on the guest's new waiting row. Never throws;
 * returns what was recorded (nothing when it could not be written: the
 * guest then sees the in-call notice, as before).
 */
export async function agreeOnEntry(
  svc: SupabaseClient,
  input: { guestId: string; callId: string | null; notesAtStart: boolean; said: unknown },
): Promise<{ notes: boolean; recording: boolean }> {
  const none = { notes: false, recording: false }
  try {
    const said = input.said && typeof input.said === 'object' ? (input.said as { notes?: unknown; recording?: unknown }) : {}
    if (said.notes !== true && said.recording !== true) return none
    let live: { notes: boolean; recording: string } | null = null
    if (input.callId) {
      const { data } = await svc.from('team_call').select('notes, recording, status').eq('id', input.callId).maybeSingle<{ notes: boolean; recording: string; status: string }>()
      live = data?.status === 'live' ? data : null
    }
    const shown = entryNotice(live, input.notesAtStart)
    const agreed = { notes: shown.notes && said.notes === true, recording: shown.recording && said.recording === true }
    if (!agreed.notes && !agreed.recording) return none
    const patch: Record<string, unknown> = {}
    if (agreed.notes) patch.notes_ack_round = 1
    if (agreed.recording) patch.recording_ack_at = new Date().toISOString()
    const { data: written, error } = await svc.from('meeting_guest').update(patch).eq('id', input.guestId).eq('state', 'waiting').select('id')
    if (error) {
      console.warn(`[meetings] guest=${input.guestId} entry go not recorded:`, error.message.slice(0, 120))
      return none
    }
    // No row: a member let them in (or they left) in between. Nothing was recorded, so the in-call notice asks.
    if (!Array.isArray(written) || written.length === 0) return none
    return agreed
  } catch (err) {
    console.warn(`[meetings] guest=${input.guestId} entry go not recorded:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
    return none
  }
}
