/**
 * A booked meeting changed after the pick (availability phase 3a), or after
 * a booking link booked it (phase 4a): by the guest on their manage page
 * (/b/<token>), or by the host (cancel_offered_meeting).
 *
 *   cancelMeeting      the booking leaves 'confirmed' (or 'booking', or a
 *                      request still waiting on the host's yes) first,
 *                      so two cancels never both run; then the provider event
 *                      is deleted with the attendees told (the provider's
 *                      cancellation); a provider that refuses puts it back.
 *                      Its claim goes: the time is free again.
 *   rescheduleTimes    the host's open times for the same length over the
 *                      next RESCHEDULE_DAYS days, from the engine (working
 *                      hours minus everything busy, the booking's own event
 *                      and claim left out); for a meeting every host attends
 *                      (a link's host_mode all), the times all of them have.
 *   rescheduleMeeting  the new time must be one of those, read again now. A
 *                      new claim per host is taken BESIDE the old (the exclusion
 *                      constraint lets one booking's claims overlap), the
 *                      provider event moves with the attendees told, then the
 *                      booking takes the new time and the old claim goes. A
 *                      failure anywhere leaves the booking as it was. At most
 *                      RESCHEDULES_MAX moves.
 *
 * The host hears of a guest's change in their home thread, routed to them.
 *
 * Server only; service role. Never throws: every outcome is a result.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteCalendarEvent, updateCalendarEvent } from '@/lib/integrations/calendar'
import { listCountedEvents } from '@/lib/availability/busy'
import { intersectAll, type Span } from '@/lib/availability/engine'
import { readFreeTime } from '@/lib/availability/find-times'
import { readWorkingHours } from '@/lib/availability/schedule'
import { reportToOwner } from '@/lib/customers/reminders'
import { appOrigin } from '@/lib/twilio/config'
import { bookingHosts, deleteBookingClaims, deleteClaims, getBooking, getBookingByManageHash, getOffer, insertBookingClaim, updateBooking } from './store'
import { manageTokenFor, manageTokenHash, manageUrl } from './tokens'
import { RESCHEDULE_DAYS, RESCHEDULES_MAX, type MeetingBooking } from './types'
import { bookingEventWords, guestChangeReport } from './words'

export type ManageFailure = { ok: false; code: 'NOT_FOUND' | 'CLOSED' | 'STARTED' | 'LIMIT' | 'SLOT_TAKEN' | 'CALENDAR_UNKNOWN' | 'FAILED' | 'BAD_INPUT'; message: string }
const fail = (code: ManageFailure['code'], message: string): ManageFailure => ({ ok: false, code, message })

export interface ManageDeps {
  now?: () => number
  origin?: string
  secret?: string
  updateEvent?: typeof updateCalendarEvent
  deleteEvent?: typeof deleteCalendarEvent
  /** The host's free time (default: readFreeTime over their working hours and counted calendars). */
  freeTime?: (booking: MeetingBooking, range: { from: number; to: number }) => Promise<{ known: true; free: Span[]; timeZone: string } | { known: false; reason: string }>
  tellHost?: (args: { workspaceId: string; userId: string; messageId: string; text: string; routes: boolean }) => Promise<boolean>
}

/** A booking by its manage link's token. Throws on a failed read. */
export async function bookingForManageToken(supabase: SupabaseClient, token: string): Promise<MeetingBooking | null> {
  return getBookingByManageHash(supabase, manageTokenHash(token))
}

/** Whether a booking can still be cancelled or moved: live, and not yet started. Pure. */
export function changeable(booking: Pick<MeetingBooking, 'state' | 'startsAt'>, now: number): ManageFailure | null {
  if (booking.state === 'cancelled') return fail('CLOSED', 'This meeting was cancelled.')
  if (booking.state === 'failed') return fail('CLOSED', "This meeting couldn't be booked, so there is nothing to change.")
  if (booking.state === 'declined' || booking.state === 'expired') return fail('CLOSED', "This time wasn't confirmed, so there is nothing to change.")
  if (Date.parse(booking.startsAt) <= now) return fail('STARTED', 'This meeting has already started.')
  return null
}

/** The zone the host's words use: the booking's own, else its offer's. */
export async function hostZone(supabase: SupabaseClient, booking: MeetingBooking): Promise<string> {
  if (booking.hostTimeZone) return booking.hostTimeZone
  const offer = booking.offerId ? await getOffer(supabase, booking.offerId).catch(() => null) : null
  return offer?.timeZone ?? 'UTC'
}

/** Cancel a booked meeting (see the header). */
export async function cancelMeeting(
  supabase: SupabaseClient,
  args: { booking: MeetingBooking; by: 'guest' | 'host' },
  deps: ManageDeps = {},
): Promise<{ ok: true; booking: MeetingBooking } | ManageFailure> {
  const now = (deps.now ?? Date.now)()
  const { booking } = args
  const blocked = changeable(booking, now)
  if (blocked) return blocked
  try {
    const cancelled = await updateBooking(supabase, booking.id, ['confirmed', 'booking', 'requested'], { state: 'cancelled', cancelled_by: args.by, cancelled_at: new Date(now).toISOString() })
    if (!cancelled) return fail('CLOSED', 'This meeting changed just now. Reload to see it.')
    if (booking.calendarEventId) {
      try {
        await (deps.deleteEvent ?? deleteCalendarEvent)(booking.hostUserId, booking.calendarEventId, { accountId: booking.calendarAccountId ?? undefined, notifyAttendees: true })
      } catch (err) {
        // The calendar still has it: so does the booking.
        await updateBooking(supabase, booking.id, ['cancelled'], { state: booking.state, cancelled_by: null }).catch(() => null)
        return fail('FAILED', `The calendar couldn't take the cancellation (${err instanceof Error ? err.message : String(err)}). Nothing changed: try again in a moment.`)
      }
    }
    await deleteBookingClaims(supabase, booking.id).catch(() => {})
    if (args.by === 'guest') {
      const zone = await hostZone(supabase, booking)
      await (deps.tellHost ?? ((a) => reportToOwner(supabase, a)))({
        workspaceId: booking.workspaceId,
        userId: booking.hostUserId,
        messageId: `meeting-booking:${booking.id}:cancelled`,
        text: guestChangeReport(booking, zone, { kind: 'cancelled' }),
        routes: true,
      }).catch(() => false)
    }
    return { ok: true, booking: cancelled }
  } catch (err) {
    return fail('FAILED', err instanceof Error ? err.message : String(err))
  }
}

const QUARTER_MS = 15 * 60_000
/** The most times a move offers. */
export const RESCHEDULE_TIMES_MAX = 40

/** Starts on the half hour inside free windows, each with room for the meeting, soonest first. Pure. */
export function startsInWindows(windows: readonly Span[], durationMs: number, max: number = RESCHEDULE_TIMES_MAX): Span[] {
  const step = 2 * QUARTER_MS
  const out: Span[] = []
  for (const w of [...windows].sort((a, b) => a.start - b.start)) {
    for (let start = Math.ceil(w.start / step) * step; start + durationMs <= w.end; start += step) {
      if (out.length >= max) return out
      out.push({ start, end: start + durationMs })
    }
  }
  return out
}

async function defaultFreeTime(supabase: SupabaseClient, booking: MeetingBooking, range: { from: number; to: number }, now: number) {
  const durationMinutes = Math.round((Date.parse(booking.endsAt) - Date.parse(booking.startsAt)) / 60_000)
  // Every attending host's time: the organizer's zone words the times.
  const reads = await Promise.all(
    bookingHosts(booking).map(async (userId) => {
      const hours = await readWorkingHours(supabase, { userId, workspaceId: booking.workspaceId })
      // The booking's own event and claim are where it is now, not busy against its move.
      const read = await readFreeTime(
        { userId, workspaceId: booking.workspaceId, schedule: hours, from: range.from, to: range.to, durationMinutes, bufferMinutes: 10, now },
        {
          listEvents: async (user, options) => {
            const events = await listCountedEvents(user, { ...options, exceptClaims: { bookingId: booking.id } })
            return booking.calendarEventId ? events.filter((e) => e.id !== booking.calendarEventId) : events
          },
        },
      )
      return { read, timeZone: hours.timeZone }
    }),
  )
  const unknown = reads.find((r) => !r.read.known)
  if (unknown && !unknown.read.known) return unknown.read
  const free = intersectAll(reads.map((r) => (r.read.known ? r.read.free : []))).filter((s) => s.end - s.start >= durationMinutes * 60_000)
  return { known: true as const, free, timeZone: booking.hostTimeZone ?? reads[0].timeZone }
}

/** The host's open times a booking can move to (see the header). */
export async function rescheduleTimes(
  supabase: SupabaseClient,
  booking: MeetingBooking,
  deps: ManageDeps = {},
): Promise<{ ok: true; timeZone: string; times: Span[] } | ManageFailure> {
  const now = (deps.now ?? Date.now)()
  const blocked = changeable(booking, now)
  if (blocked) return blocked
  if (booking.state !== 'confirmed') return fail('CLOSED', "This meeting isn't on the calendar yet: try again in a minute.")
  if (booking.rescheduleCount >= RESCHEDULES_MAX) return fail('LIMIT', `This meeting was already moved ${RESCHEDULES_MAX} times. Ask ${booking.hostName} directly.`)
  try {
    const range = { from: now, to: now + RESCHEDULE_DAYS * 24 * 60 * 60_000 }
    const read = await (deps.freeTime ?? ((b, r) => defaultFreeTime(supabase, b, r, now)))(booking, range)
    if (!read.known) return fail('CALENDAR_UNKNOWN', "The calendar couldn't be checked just now. Try again in a minute.")
    const duration = Date.parse(booking.endsAt) - Date.parse(booking.startsAt)
    const current = Date.parse(booking.startsAt)
    return { ok: true, timeZone: read.timeZone, times: startsInWindows(read.free, duration).filter((s) => s.start !== current) }
  } catch (err) {
    return fail('FAILED', err instanceof Error ? err.message : String(err))
  }
}

/** Move a booking to one of its open times (see the header). */
export async function rescheduleMeeting(
  supabase: SupabaseClient,
  args: { booking: MeetingBooking; start: string; by: 'guest' | 'host' },
  deps: ManageDeps = {},
): Promise<{ ok: true; booking: MeetingBooking } | ManageFailure> {
  const at = Date.parse(args.start)
  if (!Number.isFinite(at)) return fail('BAD_INPUT', 'Pick a new time.')
  const options = await rescheduleTimes(supabase, args.booking, deps)
  if (!options.ok) return options
  const pick = options.times.find((t) => t.start === at)
  if (!pick) return fail('SLOT_TAKEN', 'That time is no longer available. Pick another.')
  const booking = args.booking
  const span = { startsAt: new Date(pick.start).toISOString(), endsAt: new Date(pick.end).toISOString() }
  try {
    const claim = await insertBookingClaim(supabase, booking, span)
    if (!claim.ok) return claim.conflict ? fail('SLOT_TAKEN', 'That time was just taken. Pick another.') : fail('FAILED', `The new time couldn't be held (${claim.error}).`)
    const releaseNew = () => deleteClaims(supabase, claim.ids).catch(() => {})
    const words = bookingEventWords(booking, manageUrl(deps.origin ?? appOrigin(), manageTokenFor(booking.id, deps.secret)))
    // The move is fenced before the calendar is touched: of two moves at once
    // (a double submit, two tabs) only the one that wins here writes the
    // provider; the other leaves it alone.
    const moved = await updateBooking(
      supabase,
      booking.id,
      ['confirmed'],
      { starts_at: span.startsAt, ends_at: span.endsAt, reschedule_count: booking.rescheduleCount + 1 },
      { rescheduleCount: booking.rescheduleCount },
    )
    if (!moved) {
      await releaseNew()
      return fail('CLOSED', 'This meeting changed just now. Reload to see it.')
    }
    if (booking.calendarEventId) {
      try {
        await (deps.updateEvent ?? updateCalendarEvent)(booking.hostUserId, booking.calendarEventId, { start: span.startsAt, end: span.endsAt, description: words.description }, { accountId: booking.calendarAccountId ?? undefined, notifyAttendees: true })
      } catch (err) {
        // The calendar kept the old time: so does the booking (unless it changed again since), and the new claim goes.
        await updateBooking(supabase, booking.id, ['confirmed'], { starts_at: booking.startsAt, ends_at: booking.endsAt, reschedule_count: booking.rescheduleCount }, { rescheduleCount: booking.rescheduleCount + 1 }).catch(() => null)
        await releaseNew()
        return fail('FAILED', `The calendar couldn't move the meeting (${err instanceof Error ? err.message : String(err)}). It is still at its old time.`)
      }
    }
    await deleteBookingClaims(supabase, booking.id, claim.ids).catch(() => {})
    if (args.by === 'guest') {
      const zone = await hostZone(supabase, moved)
      await (deps.tellHost ?? ((a) => reportToOwner(supabase, a)))({
        workspaceId: moved.workspaceId,
        userId: moved.hostUserId,
        messageId: `meeting-booking:${moved.id}:moved:${moved.rescheduleCount}`,
        text: guestChangeReport(moved, zone, { kind: 'moved', fromIso: booking.startsAt }),
        routes: true,
      }).catch(() => false)
    }
    return { ok: true, booking: moved }
  } catch (err) {
    return fail('FAILED', err instanceof Error ? err.message : String(err))
  }
}

/** A booking of the host's, for their own tools. Throws on a failed read. */
export async function hostBooking(supabase: SupabaseClient, args: { workspaceId: string; userId: string; bookingId: string }): Promise<MeetingBooking | null> {
  const booking = await getBooking(supabase, args.bookingId, args.workspaceId)
  return booking && booking.hostUserId === args.userId ? booking : null
}
