/**
 * The owner moves or cancels a customer's booking (issue #11's follow-up:
 * the reminder report says "Tell me if you want it back"). The owner's agent
 * holds two tools for it (src/lib/ai/tools/business.ts):
 *
 *   move_booking    a confirmed booking to another start, the same length.
 *                   Nothing else may be on the owner's calendar or booked
 *                   then (isSlotFree, the check the owner's yes makes); the
 *                   booking hours bind customers, not the owner. The booking
 *                   moves with its claim on the owner's time, in one
 *                   transaction (migration 581 move_meeting_booking: the
 *                   exclusion constraint keeps two from one time), its
 *                   calendar event follows (a calendar that
 *                   refuses puts the booking back), the customer's yes to the
 *                   old time is cleared, and the customer is texted the
 *                   new time. Its reminder follows it the same day; to
 *                   another day it is let go, so the day before the new date
 *                   reminds them again. A booking that changed again while
 *                   its calendar moved (the customer's own move) is left as
 *                   it is, and nobody is texted.
 *   cancel_booking  a confirmed booking not yet started: it is cancelled,
 *                   its calendar event deleted (one that can't be is
 *                   reported; the booking stays cancelled), its reminder
 *                   answered `cancelled` (the customer's agent knows, and a
 *                   later STOP doesn't tell the owner it still stands), its
 *                   quote opened again (booked → accepted, so book_quote can
 *                   book another time), and the customer is texted.
 *
 * A requested booking is the owner's card to answer (yes books it; no asks
 * the customer for another time), so neither tool touches one. Owners and
 * admins only. The customer's text is fixed wording from the business's
 * number (./booking.ts textBookingCustomer: never a number that said STOP);
 * `tellCustomer: false` skips it, for a customer the owner already told.
 *
 * The customer's own move from their reminder (./reminder-replies.ts) shares
 * {@link rescheduleWithCalendar}.
 *
 * A booking from one of the workspace's booking links (src/lib/booking-links/)
 * is in the same lists and takes both tools the same way; its calendar event
 * has the guest on it, so the provider tells them of the move or the
 * cancellation too.
 *
 * Server only; service role, every read fenced to the workspace.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteCalendarEvent, updateCalendarEvent } from '@/lib/integrations/calendar'
import { textBookingCustomer } from './booking'
import { cleanText } from './intake'
import { remindersCancelled, remindersFollowBooking } from './reminder-store'
import { bookingSetup, isSlotFree, localDate, localStartInstant, slotLabel, type FindOpenSlotsDeps } from './slots'
import { moveMeetingBooking } from '@/lib/time-offers/store'
import { bookingMeetingCancelled } from '@/lib/meeting-links/bookings'
import { businessName, expireStaleBookings, getBooking, moveBooking } from './store'
import { BOOKING_REQUEST_TTL_MS, type CustomerBooking } from './types'

type ToolOutput = Record<string, unknown>

/** Where a booking's calendar event ended up after a move. */
export type CalendarAfterMove = 'moved' | 'none' | 'stuck'

export type RescheduleResult = { ok: true; booking: CustomerBooking; calendar: CalendarAfterMove } | { ok: false; code: 'SLOT_TAKEN' | 'CHANGED' | 'CALENDAR_FAILED' }

/** Moves a booking's calendar event (default: the owner's connected calendar). */
export type MoveEvent = (ownerUserId: string, eventId: string, slot: { start: string; end: string }) => Promise<unknown>

const defaultMoveEvent: MoveEvent = (userId, eventId, slot) => updateCalendarEvent(userId, eventId, { start: slot.start, end: slot.end })

/** A link's booking's event: on its own account, its guest told by the provider. */
const linkMoveEvent =
  (booking: Pick<CustomerBooking, 'calendarAccountId'>): MoveEvent =>
  (userId, eventId, slot) =>
    updateCalendarEvent(userId, eventId, { start: slot.start, end: slot.end }, { accountId: booking.calendarAccountId ?? undefined, notifyAttendees: true })

/**
 * Move a confirmed booking to [slot.start, slot.end), fenced on it still
 * being where it was (a second move wins nothing), and its calendar event
 * with it. `confirmedAt` is the customer's yes it now carries: the moment
 * they picked it, or null when the owner moved it. A calendar that refuses
 * puts the booking back; when its old time was taken meanwhile it can't go
 * back, so it stays moved with the calendar `stuck` at the old time. The
 * check that the new time is free is the caller's. Throws on a failed write
 * other than a taken slot.
 */
export async function rescheduleWithCalendar(
  supabase: SupabaseClient,
  booking: CustomerBooking,
  slot: { start: string; end: string },
  opts: { nowIso: string; confirmedAt: string | null; moveEvent?: MoveEvent },
): Promise<RescheduleResult> {
  const outcome = await moveMeetingBooking(supabase, { bookingId: booking.id, fromStart: booking.startsAt, startsAt: slot.start, endsAt: slot.end, customerConfirmedAt: opts.confirmedAt })
  if (outcome === 'taken') return { ok: false, code: 'SLOT_TAKEN' }
  if (outcome === 'changed') return { ok: false, code: 'CHANGED' }
  const moved: CustomerBooking = (await getBooking(supabase, booking.workspaceId, booking.id)) ?? { ...booking, startsAt: slot.start, endsAt: slot.end, customerConfirmedAt: opts.confirmedAt }
  if (!booking.calendarEventId) return { ok: true, booking: moved, calendar: 'none' }
  try {
    await (opts.moveEvent ?? (booking.origin === 'link' ? linkMoveEvent(booking) : defaultMoveEvent))(booking.ownerUserId, booking.calendarEventId, slot)
    return { ok: true, booking: moved, calendar: 'moved' }
  } catch (err) {
    console.warn('[bookings] calendar move failed:', err instanceof Error ? err.message : String(err))
    let back: Awaited<ReturnType<typeof moveMeetingBooking>> | null = null
    try {
      back = await moveMeetingBooking(supabase, { bookingId: booking.id, fromStart: slot.start, startsAt: booking.startsAt, endsAt: booking.endsAt, customerConfirmedAt: booking.customerConfirmedAt })
    } catch (backErr) {
      console.warn('[bookings] booking not put back:', backErr instanceof Error ? backErr.message : String(backErr))
    }
    if (back === 'moved') return { ok: false, code: 'CALENDAR_FAILED' }
    console.warn('[bookings] booking not put back:', back ?? 'the move back failed')
    return { ok: true, booking: moved, calendar: 'stuck' }
  }
}

// ── The customer's texts ───────────────────────────────────────────────────

/** What the customer is texted when the owner moved their booking. Pure. */
export function bookingMovedText(business: string, booking: Pick<CustomerBooking, 'kind' | 'address'>, label: string): string {
  return `${business}: your ${booking.kind} has moved to ${label}${booking.address ? ` at ${booking.address}` : ''}. Reply here if that time doesn't work.`
}

/** What the customer is texted when the owner cancelled their booking. Pure. */
export function bookingCancelledText(business: string, booking: Pick<CustomerBooking, 'kind'>, label: string): string {
  return `${business}: your ${booking.kind} on ${label} is cancelled. Reply here if you'd like another time.`
}

// ── The owner's tools ──────────────────────────────────────────────────────

/** Seams for the tests. */
export interface BookingChangeDeps {
  now?: () => number
  /** The business's zone: the owner's local times are read in it (default: its booking setup's). */
  timeZone?: (business: { workspaceId: string; ownerUserId: string }) => Promise<string>
  /** The owner's calendar, for the free check (default: their connected calendars). */
  listEvents?: FindOpenSlotsDeps['listEvents']
  moveEvent?: MoveEvent
  deleteEvent?: (ownerUserId: string, eventId: string) => Promise<unknown>
  textCustomer?: (booking: CustomerBooking, body: string) => Promise<boolean>
  /** After a cancellation: guests still in its meeting's call taken out now (585's trigger revoked the link; default: src/lib/meeting-links/bookings.ts). */
  meetingCancelled?: (bookingId: string) => Promise<boolean>
}

const refuse = (code: string, error: string): ToolOutput => ({ success: false, code, error })

/** The workspace's owner or an admin: they answer its customers. Null when they may; else the refusal. Throws on a failed read. */
async function managerRefusal(supabase: SupabaseClient, workspaceId: string, userId: string, verb: string): Promise<ToolOutput | null> {
  const { data, error } = await supabase.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ role: string | null }>()
  if (error) throw new Error(`member read failed: ${error.message}`)
  if (!data) return refuse('NOT_A_MEMBER', 'Not a workspace member.')
  if (data.role !== 'owner' && data.role !== 'admin') return refuse('NOT_ALLOWED', `Only the workspace owner or an admin ${verb}. Ask them.`)
  return null
}

/** The booking, when it is this workspace's and confirmed; else the refusal. Throws on a failed read. */
async function confirmedBooking(supabase: SupabaseClient, workspaceId: string, bookingId: string, nothing: string): Promise<{ booking: CustomerBooking } | { refusal: ToolOutput }> {
  const booking = await getBooking(supabase, workspaceId, bookingId)
  if (!booking) return { refusal: refuse('NOT_FOUND', `No booking with that id in this workspace (list_bookings shows them). ${nothing}`) }
  if (booking.state === 'requested') {
    return { refusal: refuse('WAITING', `That booking still waits on the owner's yes: answer its card instead (no asks the customer to pick another time). ${nothing}`) }
  }
  if (booking.state !== 'confirmed') return { refusal: refuse('NOT_BOOKED', `That booking is ${booking.state}. ${nothing}`) }
  return { booking }
}

const who = (booking: Pick<CustomerBooking, 'customerName'>) => cleanText(booking.customerName, 40) ?? 'The customer'

/** What the owner reads about the customer's text. Pure. */
function toldLine(booking: Pick<CustomerBooking, 'customerName'>, tellCustomer: boolean, texted: boolean, what: string): string {
  if (!tellCustomer) return `${who(booking)} wasn't texted.`
  return texted ? `${who(booking)} got a text ${what}.` : `${who(booking)} couldn't be texted: tell them yourself.`
}

/**
 * A booked quote whose booking was cancelled, back to accepted (book_quote
 * refuses a booked one), unless another live booking still holds it. Fenced
 * on it still being booked. Throws on a failed read or write.
 */
async function reopenQuote(supabase: SupabaseClient, workspaceId: string, quoteId: string, nowIso: string): Promise<void> {
  const { data: live, error } = await supabase.from('meeting_booking').select('id').eq('workspace_id', workspaceId).eq('quote_id', quoteId).in('state', ['requested', 'booking', 'confirmed']).limit(1)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  if (live?.length) return
  const reopened = await supabase.from('customer_quote').update({ status: 'accepted', updated_at: nowIso }).eq('workspace_id', workspaceId).eq('id', quoteId).eq('status', 'booked')
  if (reopened.error) throw new Error(`customer_quote update failed: ${reopened.error.message}`)
}

/**
 * move_booking (see the header). `start` is the business's local time, like
 * 2026-11-12T10:00. Never throws on a refusal; throws on a failed read.
 */
export async function ownerMoveBooking(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; bookingId: string; start: string; tellCustomer: boolean },
  deps: BookingChangeDeps = {},
): Promise<ToolOutput> {
  const nothing = 'Nothing was moved.'
  const denied = await managerRefusal(supabase, args.workspaceId, args.userId, "moves a customer's booking")
  if (denied) return denied
  const found = await confirmedBooking(supabase, args.workspaceId, args.bookingId, nothing)
  if ('refusal' in found) return found.refusal
  const booking = found.booking
  const business = { workspaceId: booking.workspaceId, ownerUserId: booking.ownerUserId }
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const zone = await (deps.timeZone ?? (async (b) => (await bookingSetup(supabase, b)).timeZone))(business)

  const at = localStartInstant(args.start, zone)
  if (at === null) return refuse('BAD_START', `${args.start} is not a time that exists in ${zone} (pass the business's local time, like 2026-11-12T10:00). ${nothing}`)
  if (at <= now) return refuse('PAST', `That time has already passed. ${nothing}`)
  if (at === Date.parse(booking.startsAt)) return { success: true, status: 'unchanged', when: slotLabel(booking.startsAt, zone), message: "That's the time it's already booked for." }
  const length = Date.parse(booking.endsAt) - Date.parse(booking.startsAt)
  const slot = { start: new Date(at).toISOString(), end: new Date(at + length).toISOString() }
  const label = slotLabel(slot.start, zone)

  // A request the owner never answered still holds its slot's key until it is marked expired.
  await expireStaleBookings(supabase, booking.workspaceId, new Date(now - BOOKING_REQUEST_TTL_MS).toISOString())
  let free: boolean
  try {
    // The booking itself, and its own calendar event, never block its new time (a 2-hour job moving an hour later).
    free = await isSlotFree(supabase, business, { start: slot.start, end: slot.end }, {
      now: () => now,
      ...(deps.listEvents ? { listEvents: deps.listEvents } : {}),
      except: { bookingId: booking.id, eventId: booking.calendarEventId },
    })
  } catch (err) {
    console.warn('[bookings] free check failed:', err instanceof Error ? err.message : String(err))
    return refuse('CALENDAR_UNAVAILABLE', `I can't read your calendar right now, so I can't check ${label} is free. ${nothing}`)
  }
  if (!free) return refuse('SLOT_TAKEN', `Something else is on your calendar or booked at ${label}. Pick another time (find_booking_slots shows open ones). ${nothing}`)

  const moved = await rescheduleWithCalendar(supabase, booking, slot, { nowIso, confirmedAt: null, moveEvent: deps.moveEvent })
  if (!moved.ok) {
    if (moved.code === 'SLOT_TAKEN') return refuse('SLOT_TAKEN', `Another booking just took ${label}. ${nothing}`)
    if (moved.code === 'CHANGED') return refuse('CHANGED', `That booking just changed (list_bookings shows it now). ${nothing}`)
    return refuse('CALENDAR_FAILED', `Your calendar wouldn't move its event, so the booking stays at ${slotLabel(booking.startsAt, zone)}. ${nothing}`)
  }
  // The customer may have moved it again from their reminder while the calendar was moving: theirs stands.
  const current = await getBooking(supabase, booking.workspaceId, booking.id)
  if (!current || current.state !== 'confirmed' || Date.parse(current.startsAt) !== at) {
    return refuse('CHANGED', 'That booking changed again while it was moving (list_bookings shows it now; check your calendar matches). Nobody was texted.')
  }
  const day = (iso: string) => {
    const d = localDate(Date.parse(iso), zone)
    return `${d.y}-${d.m}-${d.d}`
  }
  await remindersFollowBooking(supabase, { workspaceId: booking.workspaceId, bookingId: booking.id, startsAt: slot.start, newDay: day(slot.start) !== day(booking.startsAt), nowIso }).catch((err) =>
    console.warn('[bookings] reminders not moved:', err instanceof Error ? err.message : String(err)),
  )

  let texted = false
  if (args.tellCustomer) {
    const name = await businessName(supabase, booking.workspaceId)
    texted = await (deps.textCustomer ?? ((b, text) => textBookingCustomer(supabase, b, text)))(current, bookingMovedText(name, current, label)).catch(() => false)
  }
  const calendar =
    moved.calendar === 'moved'
      ? " It's moved on your calendar too."
      : moved.calendar === 'stuck'
        ? ` Your calendar wouldn't move, so it still shows ${slotLabel(booking.startsAt, zone)}: move that event yourself.`
        : ''
  return {
    success: true,
    status: 'moved',
    booking_id: booking.id,
    from: slotLabel(booking.startsAt, zone),
    when: label,
    calendar: moved.calendar,
    customer_texted: texted,
    message: `Moved ${who(booking)}'s ${booking.kind} to ${label}.${calendar} ${toldLine(booking, args.tellCustomer, texted, 'with the new time')}`,
  }
}

/** cancel_booking (see the header). Never throws on a refusal; throws on a failed read. */
export async function ownerCancelBooking(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; bookingId: string; tellCustomer: boolean },
  deps: BookingChangeDeps = {},
): Promise<ToolOutput> {
  const nothing = 'Nothing was cancelled.'
  const denied = await managerRefusal(supabase, args.workspaceId, args.userId, "cancels a customer's booking")
  if (denied) return denied
  const found = await confirmedBooking(supabase, args.workspaceId, args.bookingId, nothing)
  if ('refusal' in found) return found.refusal
  const booking = found.booking
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  if (Date.parse(booking.startsAt) <= now) return refuse('STARTED', `That ${booking.kind} has already started or passed (a finished job is complete_job). ${nothing}`)
  const business = { workspaceId: booking.workspaceId, ownerUserId: booking.ownerUserId }
  // The zone only words the texts: a read that fails never stops the cancel.
  const zone = await (deps.timeZone ?? (async (b) => (await bookingSetup(supabase, b)).timeZone))(business).catch(() => 'UTC')

  const cancelled = await moveBooking(supabase, { workspaceId: booking.workspaceId, bookingId: booking.id, from: 'confirmed', to: 'cancelled' })
  if (!cancelled) return refuse('CHANGED', `That booking just changed (list_bookings shows it now). ${nothing}`)
  // A booking meeting on a call here: 585's trigger revoked its link with the cancellation; anyone still in its call goes now.
  await (deps.meetingCancelled ?? ((id) => bookingMeetingCancelled(supabase, id)))(booking.id).catch(() => false)
  // Its time as it was cancelled (a move may have landed since it was read).
  const label = slotLabel(cancelled.startsAt, zone)

  let calendar: 'deleted' | 'none' | 'stuck' = 'none'
  if (booking.calendarEventId) {
    try {
      // A link's booking's guest is on its event: the provider tells them.
      const link = booking.origin === 'link' ? { accountId: booking.calendarAccountId ?? undefined, notifyAttendees: true } : undefined
      await (deps.deleteEvent ?? ((userId: string, eventId: string) => deleteCalendarEvent(userId, eventId, link)))(booking.ownerUserId, booking.calendarEventId)
      calendar = 'deleted'
    } catch (err) {
      console.warn('[bookings] calendar delete failed:', err instanceof Error ? err.message : String(err))
      calendar = 'stuck'
    }
  }
  await remindersCancelled(supabase, { workspaceId: booking.workspaceId, bookingId: booking.id, nowIso }).catch((err) =>
    console.warn('[bookings] reminders not cancelled:', err instanceof Error ? err.message : String(err)),
  )
  if (booking.quoteId) {
    await reopenQuote(supabase, booking.workspaceId, booking.quoteId, nowIso).catch((err) =>
      console.warn('[bookings] quote not reopened:', err instanceof Error ? err.message : String(err)),
    )
  }

  let texted = false
  if (args.tellCustomer) {
    const name = await businessName(supabase, booking.workspaceId)
    texted = await (deps.textCustomer ?? ((b, text) => textBookingCustomer(supabase, b, text)))(cancelled, bookingCancelledText(name, cancelled, label)).catch(() => false)
  }
  const onCalendar =
    calendar === 'deleted' ? ' It\'s off your calendar too.' : calendar === 'stuck' ? " Your calendar wouldn't delete its event: remove it yourself." : ''
  return {
    success: true,
    status: 'cancelled',
    booking_id: booking.id,
    when: label,
    calendar,
    customer_texted: texted,
    message: `Cancelled ${who(booking)}'s ${booking.kind} on ${label}.${onCalendar} ${toldLine(booking, args.tellCustomer, texted, 'saying so')}`,
  }
}
