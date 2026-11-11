/**
 * The sweeper's part for meeting links (server only).
 *
 * A meeting's call where only guests are left: LiveKit keeps a room open
 * while anyone is in it, and guests count for it, so without this a call
 * the host left would run on with guests alone. Nobody can admit anyone
 * while no member is in the call (574's meeting_guest_decide asks for someone
 * in it), and the guest's page says the host has left. After a grace of
 * MEETING_GUEST_ONLY_GRACE_SECONDS with no member (a host's reconnect does
 * not end the meeting), the sweeper ends the call (565's team_call_end,
 * 'finished', its notes written as any call's) and closes its room, which
 * takes the guests out; 574's trigger lets them go.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { endCall, requestMissedNotices } from '@/lib/team-calls/store'
import { guestOnlyCalls } from './store'

/** How long guests may stay in a meeting's call with no member in it. */
export const MEETING_GUEST_ONLY_GRACE_SECONDS = 3 * 60

export interface GuestOnlyDeps {
  closeRoom: (room: string) => Promise<void>
}

/** End every meeting call left to guests past the grace. Returns how many. Never throws for one call. */
export async function endGuestOnlyCalls(svc: SupabaseClient, deps: GuestOnlyDeps): Promise<number> {
  const calls = await guestOnlyCalls(svc, MEETING_GUEST_ONLY_GRACE_SECONDS)
  let ended = 0
  for (const c of calls) {
    try {
      const missed = await endCall(svc, c.callId, 'finished')
      await requestMissedNotices(missed)
      await deps.closeRoom(c.room)
      ended++
      console.info(`[meetings] call=${c.callId} outcome=ended_guests_only`)
    } catch (err) {
      console.warn(`[meetings] call=${c.callId} guests-only call not ended:`, err instanceof Error ? err.message : 'unknown')
    }
  }
  return ended
}
