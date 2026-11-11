/**
 * A guest picks one of an offer's times (availability phase 3a), from
 * anywhere it can be picked: the offer's public page (/t/<token>), the
 * host's own agent reading the guest's reply (accept_time_offer), or the
 * business's assistant when the guest texts its number (pick_offered_time).
 *
 *   acceptOffer   idempotent: the same pick again answers the booking it
 *                 made. The slot must be one of the offer's own, still open;
 *                 the host's calendar is read again, live and strict (the
 *                 offer's own holds left out); then ONE transaction
 *                 (store.ts bookSlot, migration 554) turns that slot's hold
 *                 into the booking's claim, lets the offer's other holds go
 *                 and writes the booking in state 'booking'. Two picks at
 *                 once make exactly one booking: the other is told the offer
 *                 is booked. A time no longer free fails the pick, with the
 *                 times still open.
 *   finishBooking the provider event IS the confirmation: written on the
 *                 host's calendar with the guest as an attendee (and, for
 *                 a booking link every host attends, the other hosts), the
 *                 provider sending them the invitation, a video link when
 *                 asked, and an idempotency key from the booking's id (a
 *                 retry never makes a second event). The description holds
 *                 the guest's manage link and "Booked through Native
 *                 Intelligence". Success: 'confirmed', with the event. A
 *                 failure leaves it in 'booking' for the sweep (./sweep.ts),
 *                 which fails it after BOOKING_ATTEMPTS_MAX tries: its time
 *                 let go, and the host told. A booking link's guest who
 *                 gave only a mobile number (booked on the host's yes:
 *                 src/lib/booking-links/book.ts) is texted the confirmation
 *                 from the business's number instead.
 *
 * The host hears of each pick in their home thread (a line, kept there), and
 * of a failure where they are (routed).
 *
 * Server only; service role. Never throws: every outcome is a result.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCalendarEvent, deleteCalendarEvent } from '@/lib/integrations/calendar'
import { checkSpansFree } from '@/lib/availability/slot-check'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { textBookingCustomer } from '@/lib/customers/booking'
import { findContactByEmailOrPhone } from '@/lib/customers/contacts'
import { reportToOwner } from '@/lib/customers/reminders'
import { listMemberEmails } from '@/lib/workspace-member-emails'
import { appOrigin } from '@/lib/twilio/config'
import { normalizeE164 } from '@/lib/twilio/phone'
import { bookingCalendarAccount } from './host-calendar'
import { cleanEmail, oneLine } from './offers'
import { hostZone } from './manage'
import { bookSlot, deleteBookingClaims, deleteHolds, getBooking, getOffer, getOfferByTokenHash, recordFailedPick, releaseSlots, updateBooking } from './store'
import { manageTokenFor, manageTokenHash, manageUrl, offerTokenHash } from './tokens'
import { BOOKING_ATTEMPTS_MAX, GUEST_NOTE_MAX, RECIPIENT_NAME_MAX, openSlotsOf, type MeetingBooking, type OfferSlot, type TimeOffer } from './types'
import { bookedReport, bookedText, bookingEventWords, failedReport } from './words'

export type PickVia = 'link' | 'host' | 'customer'

export interface AcceptInput {
  /** The offer: by its link's token (the public page), or by id within a workspace (the agents). */
  offer: { token: string } | { id: string; workspaceId: string }
  /** The picked time's start, as the offer gave it. */
  slotStart: string
  /** What the guest typed on the page; the agents pass none: the offer's own recipient is the guest. */
  guest?: { name?: string | null; email?: string | null; timeZone?: string | null; note?: string | null }
  via: PickVia
  /** The host's agent: only the offer's own host may pick for its guest. */
  actingUserId?: string
  /** The business's assistant: only an offer made to this phone. */
  guestPhone?: string
}

export type AcceptFailure = {
  ok: false
  code: 'NOT_FOUND' | 'EXPIRED' | 'WITHDRAWN' | 'BOOKED' | 'SLOT_TAKEN' | 'BAD_INPUT' | 'NEEDS_EMAIL' | 'CALENDAR_UNKNOWN' | 'NO_CALENDAR' | 'FAILED'
  message: string
  /** The times still open, when the pick failed on its time. */
  openSlots?: OfferSlot[]
}

export type AcceptResult =
  | { ok: true; already: boolean; offer: TimeOffer; booking: MeetingBooking; manageUrl: string }
  | AcceptFailure

export interface AcceptDeps {
  now?: () => number
  origin?: string
  /** The manage token's secret (default: the OAuth state secret). */
  secret?: string
  checkFree?: typeof checkSpansFree
  calendarAccount?: typeof bookingCalendarAccount
  createEvent?: typeof createCalendarEvent
  deleteEvent?: typeof deleteCalendarEvent
  findContact?: (workspaceId: string, who: { email: string | null; phone: string | null }) => Promise<{ id: string } | null>
  /** The host's home-thread line (default: reportToOwner, routed when `routes`). */
  tellHost?: (args: { workspaceId: string; userId: string; messageId: string; text: string; routes: boolean }) => Promise<boolean>
  newId?: () => string
  /** The other attending hosts' sign-in emails, for the event's attendees (default: the workspace's member emails). */
  hostEmails?: (workspaceId: string, userIds: readonly string[]) => Promise<string[]>
  /** Text a mobile-only guest their confirmation (default: from the business's number, ../customers/booking.ts). */
  textGuest?: (booking: MeetingBooking, body: string) => Promise<boolean>
}

async function hostEmailsDefault(workspaceId: string, userIds: readonly string[]): Promise<string[]> {
  if (!userIds.length) return []
  const members = await listMemberEmails(workspaceId)
  return userIds.map((id) => members.find((m) => m.userId === id)?.email).filter((e): e is string => !!e)
}

const fail = (code: AcceptFailure['code'], message: string, openSlots?: OfferSlot[]): AcceptFailure => ({ ok: false, code, message, ...(openSlots ? { openSlots } : {}) })

function tellHostDefault(supabase: SupabaseClient): NonNullable<AcceptDeps['tellHost']> {
  return (args) => reportToOwner(supabase, args)
}

async function loadOffer(supabase: SupabaseClient, ref: AcceptInput['offer']): Promise<TimeOffer | null> {
  return 'token' in ref ? getOfferByTokenHash(supabase, offerTokenHash(ref.token)) : getOffer(supabase, ref.id, ref.workspaceId)
}

/** The guest a pick books: typed on the page, else the offer's own recipient. Pure. */
export function pickGuest(offer: TimeOffer, input: AcceptInput): { ok: true; guest: { name: string; email: string | null; phone: string | null; timeZone: string | null; note: string | null } } | AcceptFailure {
  if (input.via !== 'link') {
    // The agents book the offer's own recipient: never anyone a message named.
    return { ok: true, guest: { name: offer.recipientName, email: offer.recipientEmail, phone: offer.recipientPhone, timeZone: null, note: null } }
  }
  const typed = input.guest ?? {}
  const name = oneLine(typed.name, RECIPIENT_NAME_MAX) ?? offer.recipientName
  const rawEmail = typeof typed.email === 'string' && typed.email.trim() ? typed.email : null
  const email = rawEmail ? cleanEmail(rawEmail) : offer.recipientEmail
  if (rawEmail && !email) return fail('BAD_INPUT', 'That email address doesn\'t look right.')
  if (!email) return fail('NEEDS_EMAIL', 'Add your email so the invitation can reach you.')
  const timeZone = isTimeZone(typed.timeZone) ? typed.timeZone : null
  return { ok: true, guest: { name, email, phone: offer.recipientPhone, timeZone, note: oneLine(typed.note, GUEST_NOTE_MAX) } }
}

/** Pick a time (see the header). */
export async function acceptOffer(supabase: SupabaseClient, input: AcceptInput, deps: AcceptDeps = {}): Promise<AcceptResult> {
  const now = (deps.now ?? Date.now)()
  const origin = deps.origin ?? appOrigin()
  try {
    const offer = await loadOffer(supabase, input.offer)
    if (!offer || (offer.state === 'pending_send' && input.via === 'link')) return fail('NOT_FOUND', 'This offer does not exist.')
    if (input.via === 'host' && offer.hostUserId !== input.actingUserId) return fail('NOT_FOUND', 'No offer of yours with that id in this workspace (list_time_offers).')
    if (input.via === 'customer' && (!input.guestPhone || normalizeE164(input.guestPhone) !== offer.recipientPhone)) return fail('NOT_FOUND', 'No offer for this customer with that id.')

    const at = Date.parse(input.slotStart)
    const slot = Number.isFinite(at) ? offer.slots.find((s) => Date.parse(s.startsAt) === at) : undefined
    if (!slot) return fail('BAD_INPUT', 'That time is not one of the offered times.', openSlotsOf(offer, now))

    const picked = pickGuest(offer, input)
    if (!picked.ok) return picked

    // Already booked: the same pick again gets its booking back; any other pick is told.
    if (offer.state === 'booked') return answerBooked(supabase, offer, slot, picked.guest.email, deps)
    if (offer.state === 'pending_send') return fail('NOT_FOUND', "That offer hasn't been sent yet.")
    if (offer.state === 'withdrawn' || offer.state === 'declined') return fail('WITHDRAWN', `${offer.hostName} withdrew these times.`)
    if (offer.state === 'expired' || Date.parse(offer.expiresAt) <= now) return fail('EXPIRED', 'These times have expired.')
    if (slot.state !== 'open' || Date.parse(slot.startsAt) <= now) {
      await noteFailure(supabase, offer, input, 'slot_gone')
      return fail('SLOT_TAKEN', 'That time is no longer available.', openSlotsOf(offer, now).filter((s) => s.id !== slot.id))
    }

    // The host's calendar, live: something they added since makes the time unavailable.
    const free = await (deps.checkFree ?? checkSpansFree)({
      userId: offer.hostUserId,
      workspaceId: offer.workspaceId,
      timeZone: offer.timeZone,
      spans: [{ start: Date.parse(slot.startsAt), end: Date.parse(slot.endsAt) }],
      exceptClaims: { offerId: offer.id },
    })
    if (!free.known) return fail('CALENDAR_UNKNOWN', "The calendar couldn't be checked just now. Try again in a minute.")
    if (free.busy[0]) {
      // That time is gone for good: its hold goes, the rest stay open.
      await deleteHolds(supabase, offer.id, slot.id).catch(() => {})
      await releaseSlots(supabase, offer.id, slot.id).catch(() => {})
      await noteFailure(supabase, offer, input, 'calendar_busy')
      return fail('SLOT_TAKEN', 'That time is no longer available.', openSlotsOf(offer, now).filter((s) => s.id !== slot.id))
    }

    const account = await (deps.calendarAccount ?? bookingCalendarAccount)(supabase, offer.hostUserId, offer.workspaceId)
    if (!account) {
      await noteFailure(supabase, offer, input, 'no_calendar')
      return fail('NO_CALENDAR', `${offer.hostName}'s calendar isn't connected right now, so nothing was booked.`)
    }
    const contactId =
      offer.contactId ??
      (picked.guest.email ? ((await (deps.findContact ?? ((ws, who) => findContactByEmailOrPhone(supabase, ws, who)))(offer.workspaceId, { email: picked.guest.email, phone: null }).catch(() => null))?.id ?? null) : null)

    const bookingId = (deps.newId ?? randomUUID)()
    const outcome = await bookSlot(supabase, {
      offerId: offer.id,
      slotId: slot.id,
      bookingId,
      guest: picked.guest,
      manageTokenHash: manageTokenHash(manageTokenFor(bookingId, deps.secret)),
      calendarAccountId: account.id,
      contactId,
    })
    if (outcome.status === 'already') {
      const fresh = await loadOffer(supabase, input.offer)
      return fresh ? answerBooked(supabase, fresh, slot, picked.guest.email, deps) : fail('BOOKED', 'These times were just booked.')
    }
    if (outcome.status === 'closed') return outcome.state === 'expired' || outcome.state === 'open' ? fail('EXPIRED', 'These times have expired.') : fail('WITHDRAWN', `${offer.hostName} withdrew these times.`)
    if (outcome.status === 'missing') return fail('NOT_FOUND', 'This offer does not exist.')
    if (outcome.status === 'taken') {
      await noteFailure(supabase, offer, input, 'slot_taken')
      const fresh = (await loadOffer(supabase, input.offer)) ?? offer
      return fail('SLOT_TAKEN', 'That time is no longer available.', openSlotsOf(fresh, now).filter((s) => s.id !== slot.id))
    }

    const booking = await finishBooking(supabase, outcome.bookingId, deps)
    const bookedOffer = (await getOffer(supabase, offer.id)) ?? { ...offer, state: 'booked' as const, bookingId: outcome.bookingId }
    if (!booking) return fail('FAILED', 'The booking could not be read back. Try again in a moment.')
    return { ok: true, already: false, offer: bookedOffer, booking, manageUrl: manageUrl(origin, manageTokenFor(booking.id, deps.secret)) }
  } catch (err) {
    console.warn('[time-offers] pick failed:', err instanceof Error ? err.message : String(err))
    return fail('FAILED', "That didn't go through. Try again in a moment.")
  }
}

/** A failed pick on the public page counts toward its cap (the agents' don't). */
async function noteFailure(supabase: SupabaseClient, offer: TimeOffer, input: AcceptInput, reason: string): Promise<void> {
  if (input.via === 'link') await recordFailedPick(supabase, offer.id, reason)
}

/** A booked offer, asked again: the same slot (and, typed, the same email) is the booking it made; anything else is told it's booked. */
async function answerBooked(supabase: SupabaseClient, offer: TimeOffer, slot: OfferSlot, email: string | null, deps: AcceptDeps): Promise<AcceptResult> {
  const booking = offer.bookingId ? await getBooking(supabase, offer.bookingId) : null
  const bookedSlot = offer.slots.find((s) => s.state === 'booked')
  const same = !!booking && bookedSlot?.id === slot.id && (booking.guestEmail ?? null) === (email ?? null)
  if (!booking || !same) return fail('BOOKED', 'These times were already booked.')
  return { ok: true, already: true, offer, booking, manageUrl: manageUrl(deps.origin ?? appOrigin(), manageTokenFor(booking.id, deps.secret)) }
}

/**
 * Write a booking's provider event (see the header). Runs on a booking in
 * 'booking' only; the booking as it is after, or null when it is gone.
 * Never throws.
 */
export async function finishBooking(supabase: SupabaseClient, bookingId: string, deps: AcceptDeps = {}): Promise<MeetingBooking | null> {
  let booking: MeetingBooking | null
  try {
    booking = await getBooking(supabase, bookingId)
  } catch {
    return null
  }
  if (!booking || booking.state !== 'booking') return booking
  // Claim this attempt: a sweep and a request never write the same try twice.
  const attempt = await updateBooking(supabase, booking.id, ['booking'], { attempts: booking.attempts + 1 }, { attempts: booking.attempts }).catch(() => null)
  if (!attempt) return getBooking(supabase, bookingId).catch(() => null)

  const origin = deps.origin ?? appOrigin()
  const link = manageUrl(origin, manageTokenFor(attempt.id, deps.secret))
  const words = bookingEventWords(attempt, link)
  const tell = deps.tellHost ?? tellHostDefault(supabase)
  const zone = await hostZone(supabase, attempt)
  try {
    const otherHosts = attempt.otherHostIds.length ? await (deps.hostEmails ?? hostEmailsDefault)(attempt.workspaceId, attempt.otherHostIds) : []
    const attendees = [...(attempt.guestEmail ? [attempt.guestEmail] : []), ...otherHosts]
    const event = await (deps.createEvent ?? createCalendarEvent)(
      attempt.hostUserId,
      {
        title: words.title,
        description: words.description,
        start: attempt.startsAt,
        end: attempt.endsAt,
        ...(attempt.location ? { location: attempt.location } : {}),
        ...(attendees.length ? { attendees } : {}),
      },
      attempt.calendarAccountId ?? undefined,
      { sendInvites: true, video: attempt.video, idempotencyKey: attempt.id },
    )
    const confirmed = await updateBooking(supabase, attempt.id, ['booking'], {
      state: 'confirmed',
      calendar_event_id: event.id,
      calendar_id: event.calendarId ?? null,
      conference_url: event.conferenceUrl ?? null,
      calendar_account_id: event.accountId ?? attempt.calendarAccountId,
      last_error: null,
      confirmed_at: new Date().toISOString(),
    })
    if (!confirmed) {
      // Cancelled while the event was being written: the event goes too.
      await (deps.deleteEvent ?? deleteCalendarEvent)(attempt.hostUserId, event.id, { accountId: attempt.calendarAccountId ?? undefined, notifyAttendees: true }).catch(() => {})
      return getBooking(supabase, bookingId).catch(() => null)
    }
    // A mobile-only guest (a link's, booked on the host's yes) hears by text.
    const texted =
      !confirmed.guestEmail && confirmed.guestPhone && confirmed.source === 'link'
        ? await (deps.textGuest ?? ((b, body) => textBookingCustomer(supabase, { workspaceId: b.workspaceId, customerPhone: b.guestPhone, guestId: null }, body)))(confirmed, bookedText(confirmed, zone, link)).catch(() => false)
        : false
    await tell({ workspaceId: confirmed.workspaceId, userId: confirmed.hostUserId, messageId: `meeting-booking:${confirmed.id}:booked`, text: bookedReport(confirmed, zone, !!confirmed.guestEmail, texted), routes: false }).catch(() => false)
    return confirmed
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    if (attempt.attempts < BOOKING_ATTEMPTS_MAX) {
      // The sweep tries again (the same key: never a second event).
      return (await updateBooking(supabase, attempt.id, ['booking'], { last_error: reason }).catch(() => null)) ?? attempt
    }
    const failed = await updateBooking(supabase, attempt.id, ['booking'], { state: 'failed', last_error: reason }).catch(() => null)
    if (failed) {
      await deleteBookingClaims(supabase, failed.id).catch(() => {})
      await tell({ workspaceId: failed.workspaceId, userId: failed.hostUserId, messageId: `meeting-booking:${failed.id}:failed`, text: failedReport(failed, zone, reason), routes: true }).catch(() => false)
    }
    return failed ?? attempt
  }
}
