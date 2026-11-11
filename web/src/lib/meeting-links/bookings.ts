/**
 * A meeting link as a booked meeting's place (server only; the service role).
 *
 * Availability's booking links and time offers choose where people meet with
 * `video` (the calendar provider's own link) and a `location`. Migration 576
 * adds one more choice, off by default and offered only where calling is set
 * up: `call_here`, a meeting link of ours. Then:
 *
 *   - when the booking's calendar event is written (src/lib/time-offers/
 *     accept.ts finishBooking), {@link bookingMeetingUrl} makes the booking's
 *     meeting once (574's meeting_create_for: its host the booking's host, its
 *     title, start and length the booking's) and its link becomes the event's
 *     location and the booking's conference_url, which the guest's /b and /t
 *     pages and the provider's invitation show. No provider video link then.
 *     A retry finds the meeting it made (576's meeting.booking_id).
 *   - when the booking moves, is cancelled or fails, {@link bookingMeetingChanged}
 *     moves the meeting's window with it or revokes its link (576's
 *     meeting_booking_changed: waiting guests let go, guests in its call taken
 *     out).
 *
 * The guest opens the link and waits in the lobby like any guest. Calling not
 * set up (no LiveKit settings): no link is ever made, whatever a link or an
 * offer says, and the booking keeps its provider video link as before.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { drainTeamCallEjections, liveEjectDeps } from '@/lib/team-calls/eject'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { createMeetingLink } from './create'
import { meetingLink } from './link'
import { MEETING_MAX_MINUTES, MEETING_MIN_MINUTES, MEETING_TITLE_MAX } from './shape'

/** What of a booking this reads (src/lib/time-offers/types.ts MeetingBooking). */
export interface BookingForMeeting {
  id: string
  workspaceId: string
  hostUserId: string
  title: string
  startsAt: string
  endsAt: string
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

/** A booking's length in whole minutes, or null when a meeting can't be that long. */
function minutesOf(booking: Pick<BookingForMeeting, 'startsAt' | 'endsAt'>): number | null {
  const minutes = Math.round((Date.parse(booking.endsAt) - Date.parse(booking.startsAt)) / 60_000)
  return Number.isInteger(minutes) && minutes >= MEETING_MIN_MINUTES && minutes <= MEETING_MAX_MINUTES ? minutes : null
}

/**
 * The booking's meeting link, made once: null when it doesn't meet here (or
 * can't: calling not set up, a booking longer than a meeting may be). Throws
 * when it should have one and none could be made, so the booking's attempt
 * fails and is tried again (the same booking finds the meeting it made).
 */
export async function bookingMeetingUrl(svc: SupabaseClient, booking: BookingForMeeting): Promise<string | null> {
  if (!(await bookingMeetsHere(svc, booking))) return null
  const minutes = minutesOf(booking)
  if (minutes === null) return null
  const { data: made, error: readError } = await svc.from('meeting').select('id, token_nonce').eq('booking_id', booking.id).maybeSingle<{ id: string; token_nonce: string | null }>()
  if (readError) throw new Error(`meetings: booking meeting read failed: ${readError.message}`)
  if (made) return made.token_nonce ? meetingLink(made.id, made.token_nonce) : null
  const { data: host, error: hostError } = await svc
    .from('member')
    .select('id')
    .eq('user_id', booking.hostUserId)
    .eq('workspace_id', booking.workspaceId)
    .maybeSingle<{ id: string }>()
  if (hostError) throw new Error(`meetings: host read failed: ${hostError.message}`)
  if (!host) {
    // For good, not a hiccup: the booking keeps the provider's video link instead of failing.
    console.warn(`[meetings] booking=${booking.id} host not a member of its workspace: no meeting link`)
    return null
  }
  const meeting = await createMeetingLink(svc, {
    workspaceId: booking.workspaceId,
    title: booking.title.replace(/\s+/g, ' ').trim().slice(0, MEETING_TITLE_MAX) || 'Meeting',
    startsAt: booking.startsAt,
    minutes,
    hostMemberId: host.id,
  })
  const { error } = await svc.from('meeting').update({ booking_id: booking.id }).eq('id', meeting.meetingId)
  if (error) throw new Error(`meetings: booking meeting not tied to its booking: ${error.message}`)
  console.info(`[meetings] meeting=${meeting.meetingId} booking=${booking.id} outcome=booking_link`)
  return meeting.url
}

export interface BookingMeetingChange {
  bookingId: string
  /** Moved: its new start and end. */
  startsAt?: string
  endsAt?: string
  /** Cancelled or failed: the link is revoked. */
  cancelled?: boolean
}

/**
 * A booking moved, was cancelled or failed: its meeting (if it has one) follows.
 * Never throws; true when there was a meeting to change.
 */
export async function bookingMeetingChanged(svc: SupabaseClient, change: BookingMeetingChange): Promise<boolean> {
  try {
    const minutes = change.startsAt && change.endsAt ? Math.round((Date.parse(change.endsAt) - Date.parse(change.startsAt)) / 60_000) : null
    const { data, error } = await svc.rpc('meeting_booking_changed', {
      target_booking: change.bookingId,
      starts: change.cancelled ? null : (change.startsAt ?? null),
      minutes: change.cancelled ? null : minutes,
      cancelled: change.cancelled === true,
    })
    if (error) throw new Error(error.message)
    const row = (Array.isArray(data) ? data[0] : data) as { meeting_id?: string; call_id?: string | null; room?: string | null } | undefined
    if (!row?.meeting_id) return false
    console.info(`[meetings] meeting=${row.meeting_id} booking=${change.bookingId} outcome=${change.cancelled ? 'booking_cancelled' : 'booking_moved'}`)
    // Cancelled during its call: the guests in it go now (the sweeper would, later).
    const config = change.cancelled && row.call_id ? teamCallsConfig() : null
    if (config) await drainTeamCallEjections(svc, liveEjectDeps(config)).catch(() => undefined)
    return true
  } catch (err) {
    console.warn(`[meetings] booking=${change.bookingId} meeting not ${change.cancelled ? 'revoked' : 'moved'}:`, err instanceof Error ? err.message : 'unknown')
    return false
  }
}
