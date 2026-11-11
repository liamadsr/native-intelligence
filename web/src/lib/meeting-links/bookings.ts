/**
 * A meeting link as a booked meeting's place (server only; the service role).
 *
 * Availability's booking links and time offers choose where people meet with
 * `video` (the calendar provider's own link) and a `location`. Migration 585
 * adds one more choice, off by default and offered only where calling is set
 * up: `call_here`, a meeting link of ours. Then:
 *
 *   - when the booking's calendar event is written (src/lib/time-offers/
 *     accept.ts finishBooking), {@link bookingMeetingUrl} gets the booking's
 *     meeting: made and tied to the booking in one step by 585's
 *     meeting_create_for_booking (its host the booking's host, its title,
 *     start and length the booking's), or the one it already has (a retry, or
 *     a second attempt at once). Its link becomes the event's location and the
 *     booking's conference_url (the guest's /b and /t pages, the provider's
 *     invitation). These meetings don't use the host's own daily allowance
 *     for links: one per booking. finishBooking never lets a failure here fail
 *     the booking: it falls back to the provider's video link.
 *   - when the booking's time or state changes, by ANY writer, 585's trigger on
 *     meeting_booking moves the meeting's window or revokes its link. The app
 *     only drains the eject outbox at once after a cancellation
 *     ({@link bookingMeetingCancelled}): taking guests out of a live room is
 *     LiveKit's.
 *
 * The guest opens the link and waits in the lobby like any guest. Calling not
 * set up (no LiveKit settings): no link is ever made, whatever a link or an
 * offer says, and the booking keeps its provider video link as before.
 */
import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { drainTeamCallEjections, liveEjectDeps } from '@/lib/team-calls/eject'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { meetingLink, meetingToken, newTokenNonce, tokenDigest } from './link'

/** What of a booking this reads (src/lib/time-offers/types.ts MeetingBooking). */
export interface BookingForMeeting {
  id: string
  offerId: string | null
  linkId: string | null
}

/** Whether a booking may meet on a call here at all: calling is set up (the option shows only then). */
export function bookingCallsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return teamCallsConfig(env) !== null
}

/** Does this booking's link (or offer) meet on a call here? False while calling is not set up. Throws on a failed read. */
export async function bookingMeetsHere(svc: SupabaseClient, booking: Pick<BookingForMeeting, 'offerId' | 'linkId'>): Promise<boolean> {
  if (!bookingCallsAvailable()) return false
  const from = booking.linkId ? { table: 'booking_link', id: booking.linkId } : booking.offerId ? { table: 'time_offer', id: booking.offerId } : null
  if (!from) return false
  const { data, error } = await svc.from(from.table).select('call_here').eq('id', from.id).maybeSingle<{ call_here: boolean | null }>()
  if (error) throw new Error(`meetings: ${from.table} read failed: ${error.message}`)
  return data?.call_here === true
}

/**
 * The booking's meeting link: null when it doesn't meet here (or can't: calling
 * not set up, a host no longer in the workspace, a booking longer than a
 * meeting may be). Throws on a failed read or write; the caller
 * (finishBooking) falls back to the provider's video link then.
 */
export async function bookingMeetingUrl(svc: SupabaseClient, booking: BookingForMeeting): Promise<string | null> {
  if (!(await bookingMeetsHere(svc, booking))) return null
  const meetingId = randomUUID()
  const nonce = newTokenNonce()
  const { data, error } = await svc.rpc('meeting_create_for_booking', {
    booking_ref: booking.id,
    meeting_ref: meetingId,
    digest: tokenDigest(meetingToken(meetingId, nonce)),
    nonce,
  })
  if (error) throw new Error(`meetings: booking meeting not made: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { made_id?: string; made_nonce?: string | null; created?: boolean } | undefined
  if (!row?.made_id || !row.made_nonce) return null
  if (row.created) console.info(`[meetings] meeting=${row.made_id} booking=${booking.id} outcome=booking_link`)
  return meetingLink(row.made_id, row.made_nonce)
}

/**
 * A booking was cancelled: 585's trigger already revoked its meeting's link
 * and put any guests in its live call on the eject outbox; this takes them out
 * of the room now (the sweeper would, later). Never throws; true when it drained.
 */
export async function bookingMeetingCancelled(svc: SupabaseClient, bookingId: string): Promise<boolean> {
  const config = teamCallsConfig()
  if (!config) return false
  try {
    const { data } = await svc.from('meeting').select('id').eq('booking_id', bookingId).maybeSingle<{ id: string }>()
    if (!data) return false
    await drainTeamCallEjections(svc, liveEjectDeps(config))
    console.info(`[meetings] meeting=${data.id} booking=${bookingId} outcome=booking_cancelled`)
    return true
  } catch (err) {
    console.warn(`[meetings] booking=${bookingId} ejections not drained:`, err instanceof Error ? err.message : 'unknown')
    return false
  }
}
