/**
 * A meeting guest's consent to notes and recording (server only).
 *
 * A guest says go to what is on, the notes round and the recording, through
 * their page's notice (POST /m/<token>/notice: 574's meeting_guest_ack
 * records it). Until they have for what is on now:
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
import { guestNeedsNotice } from './shape'

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
