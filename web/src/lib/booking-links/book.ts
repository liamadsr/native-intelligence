/**
 * A guest books a time on a booking link (availability phase 4a), and the
 * host's yes or no to a request.
 *
 *   bookFromLink   the guest (a name, and an email or a US or Canadian
 *                  mobile, at least one; the link's answers) picks a start.
 *                  The time is read again, live (./times.ts: every host's
 *                  calendar, strictly; unknown is never free). The host:
 *                  the link's one, every host for `all` (the first
 *                  organizes, the rest attend), or for `any` the least
 *                  booked of those free then (./times.ts chooseHost). Then
 *                  ONE transaction (migration 581 book_meeting) writes the
 *                  booking and a claim for each attending host: the
 *                  exclusion constraint makes a second booking of the same
 *                  time impossible. Then either
 *                    - straight on: the provider event, the guest an
 *                      attendee (the provider sends the invitation), the
 *                      manage link in it, the host told
 *                      (src/lib/time-offers/accept.ts finishBooking);
 *                    - or the host's yes first, when the link asks first,
 *                      or when the guest gave only a mobile number (a typed
 *                      number is texted only on the host's yes, as a
 *                      customer's on a business's page): the booking waits
 *                      in 'requested', its claims held for
 *                      LINK_REQUEST_HOLD_MS, and ONE approval goes to the
 *                      organizer (tool confirm_booking, the customer
 *                      booking's: their home thread asks, the reach router
 *                      texts it when they are away).
 *   confirmLinkRequest  the yes: the booking must still be requested and
 *                  the host's; every host's calendar read again (its own
 *                  claim left out); its claims kept for good; then
 *                  finishBooking (a mobile-only guest is texted from the
 *                  business's number). A time no longer free, or a calendar
 *                  that can't be read, lets the time go and says why.
 *   settleLinkRequest  a no, or no answer: declined or expired, its claims
 *                  gone. The guest is not contacted (what they typed is
 *                  nobody's verified address); their manage page says so.
 *
 * A double click books once: the same guest at the same time again answers
 * the booking it made. Server only; service role. Never throws.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkSpansFree } from '@/lib/availability/slot-check'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { findContactByEmailOrPhone } from '@/lib/customers/contacts'
import { activeBusinessNumber } from '@/lib/customers/numbers'
import { createToolApproval, type NewApproval, type NewApprovalResult } from '@/lib/safety/approvals'
import { finishBooking, type AcceptDeps } from '@/lib/time-offers/accept'
import { bookingCalendarAccount } from '@/lib/time-offers/host-calendar'
import { hostZone } from '@/lib/time-offers/manage'
import { cleanEmail, hostDisplayName, oneLine } from '@/lib/time-offers/offers'
import { bookMeeting, bookingHosts, deleteBookingClaims, getBooking, keepBookingClaims, updateBooking, BOOKING_COLUMNS, toBooking, type BookingRow } from '@/lib/time-offers/store'
import { manageTokenFor, manageTokenHash, manageUrl } from '@/lib/time-offers/tokens'
import { RECIPIENT_NAME_MAX, type BookingAnswer, type MeetingBooking } from '@/lib/time-offers/types'
import { slotLabel, zoneLabel } from '@/lib/time-offers/words'
import { appOrigin } from '@/lib/twilio/config'
import { isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { hostLoad } from './store'
import { chooseHost, readLinkTimes, type LinkTimesResult } from './times'
import { ANSWER_MAX, LINK_NOTE_MAX, LINK_REQUEST_HOLD_MS, type BookingLink } from './types'

/** The held call's tool on the host's yes: the customer booking's (src/lib/customers/booking.ts), one card for both. */
export const CONFIRM_LINK_BOOKING_TOOL = 'confirm_booking'

export interface LinkBookingInput {
  start: string
  name: string
  email?: string | null
  phone?: string | null
  /** By question id. */
  answers?: Record<string, unknown> | null
  note?: string | null
  /** The guest's zone, as their browser has it. */
  timeZone?: string | null
}

export type LinkBookingFailure = {
  ok: false
  code: 'BAD_INPUT' | 'NEEDS_CONTACT' | 'NEEDS_EMAIL' | 'SLOT_TAKEN' | 'UNAVAILABLE' | 'NO_CALENDAR' | 'CLOSED' | 'TOO_MANY_PENDING' | 'FAILED'
  message: string
  /** The question an answer was missing for. */
  field?: string
}

export type LinkBookingResult = { ok: true; already: boolean; booking: MeetingBooking; manageUrl: string } | LinkBookingFailure

export interface LinkBookingDeps {
  now?: () => number
  origin?: string
  secret?: string
  newId?: () => string
  readTimes?: (link: BookingLink, range: { from: number; to: number }) => Promise<LinkTimesResult>
  /** Whether the workspace can text a guest (a live business number). */
  canText?: (workspaceId: string) => Promise<boolean>
  calendarAccount?: typeof bookingCalendarAccount
  findContact?: (workspaceId: string, who: { email: string | null; phone: string | null }) => Promise<{ id: string } | null>
  load?: (userIds: readonly string[], fromIso: string, toIso: string) => Promise<Map<string, number>>
  hostName?: (workspaceId: string, userId: string) => Promise<string | null>
  createApproval?: (approval: NewApproval) => Promise<NewApprovalResult>
  /** The provider write's seams (finishBooking). */
  accept?: AcceptDeps
}

const fail = (code: LinkBookingFailure['code'], message: string, field?: string): LinkBookingFailure => ({ ok: false, code, message, ...(field ? { field } : {}) })
const DAY_MS = 24 * 60 * 60_000

/** The guest's answers, read against the link's questions: by question, trimmed, required ones present. Pure. */
export function readGuestAnswers(link: Pick<BookingLink, 'questions'>, given: Record<string, unknown> | null | undefined): { ok: true; answers: BookingAnswer[] } | LinkBookingFailure {
  const out: BookingAnswer[] = []
  for (const q of link.questions) {
    const raw = given?.[q.id]
    const text = typeof raw === 'string' ? (q.kind === 'long' ? raw.replace(/\r\n/g, '\n').trim().slice(0, ANSWER_MAX) : oneLine(raw, ANSWER_MAX) ?? '') : ''
    if (!text) {
      if (q.required) return fail('BAD_INPUT', `Answer "${q.label}".`, q.id)
      continue
    }
    out.push({ id: q.id, label: q.label, answer: text })
  }
  return { ok: true, answers: out }
}

/** Who the guest is (see the header): a name, and an email or a US or Canadian mobile. Pure. */
export function readGuest(input: LinkBookingInput): { ok: true; name: string; email: string | null; phone: string | null } | LinkBookingFailure {
  const name = oneLine(input.name, RECIPIENT_NAME_MAX)
  if (!name) return fail('BAD_INPUT', 'Add your name.', 'name')
  const rawEmail = typeof input.email === 'string' && input.email.trim() ? input.email : null
  const email = rawEmail ? cleanEmail(rawEmail) : null
  if (rawEmail && !email) return fail('BAD_INPUT', "That email address doesn't look right.", 'email')
  const rawPhone = typeof input.phone === 'string' && input.phone.trim() ? input.phone : null
  const phone = rawPhone ? normalizeE164(rawPhone) : null
  if (rawPhone && (!phone || !isNanpNumber(phone))) return fail('BAD_INPUT', 'Add a US or Canadian mobile number.', 'phone')
  if (!email && !phone) return fail('NEEDS_CONTACT', 'Add your email or a mobile number, so the confirmation can reach you.')
  return { ok: true, name, email, phone }
}

/** The host's card for a request: who, what, when, and what yes does. Pure. */
export function requestCard(args: { linkTitle: string; guestName: string; label: string; invited: boolean }): { title: string; why: string } {
  const who = args.guestName.slice(0, 60)
  return {
    title: `${args.linkTitle.slice(0, 60)} with ${who}, ${args.label}?`,
    why: `${who} asked for this time on your booking link "${args.linkTitle.slice(0, 80)}". It's held for you until you answer. Yes books it on your calendar and ${args.invited ? 'the calendar sends them the invitation' : 'texts them a confirmation from the business number'}; no lets the time go.`,
  }
}

async function names(deps: LinkBookingDeps, supabase: SupabaseClient, workspaceId: string, userIds: readonly string[]): Promise<string> {
  const read = deps.hostName ?? ((ws: string, id: string) => hostDisplayName(supabase, ws, id))
  const all = (await Promise.all(userIds.map((id) => read(workspaceId, id).catch(() => null)))).filter((n): n is string => !!n)
  if (!all.length) return 'Your host'
  const joined = all.length <= 2 ? all.join(' and ') : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`
  return joined.slice(0, 120)
}

/** The same guest's live booking of this link at this start: a repeat of their own booking. */
async function sameBooking(supabase: SupabaseClient, linkId: string, startIso: string, who: { email: string | null; phone: string | null }): Promise<MeetingBooking | null> {
  const { data, error } = await supabase.from('meeting_booking').select(BOOKING_COLUMNS).eq('link_id', linkId).eq('starts_at', startIso).in('state', ['requested', 'booking', 'confirmed']).limit(5)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  const rows = ((data as BookingRow[] | null) ?? []).map(toBooking)
  return rows.find((b) => (who.email && b.guestEmail === who.email) || (who.phone && b.guestPhone === who.phone)) ?? null
}

/** Book a time on a link (see the header). The link must be a meeting link; the caller has checked it is live. */
export async function bookFromLink(supabase: SupabaseClient, args: { link: BookingLink; input: LinkBookingInput }, deps: LinkBookingDeps = {}): Promise<LinkBookingResult> {
  const { link, input } = args
  const now = (deps.now ?? Date.now)()
  const origin = deps.origin ?? appOrigin()
  try {
    if (!link.active || link.purpose !== 'meeting') return fail('CLOSED', 'This booking page is turned off.')
    const guest = readGuest(input)
    if (!guest.ok) return guest
    const answers = readGuestAnswers(link, input.answers)
    if (!answers.ok) return answers
    const at = Date.parse(input.start)
    if (!Number.isFinite(at)) return fail('BAD_INPUT', 'Pick a time.', 'start')
    const startIso = new Date(at).toISOString()

    // A mobile-only guest is texted: the workspace needs a number to text from.
    if (!guest.email && !(await (deps.canText ?? (async (ws: string) => !!(await activeBusinessNumber(supabase, ws))))(link.workspaceId).catch(() => false))) {
      return fail('NEEDS_EMAIL', 'Add your email, so the invitation can reach you.', 'email')
    }

    const repeat = await sameBooking(supabase, link.id, startIso, guest)
    if (repeat) return { ok: true, already: true, booking: repeat, manageUrl: manageUrl(origin, manageTokenFor(repeat.id, deps.secret)) }

    // The time, live: every host's calendar now.
    const read = await (deps.readTimes ?? ((l, r) => readLinkTimes(l, r, { supabase, now: () => now })))(link, { from: at, to: at + 1 })
    if (!read.known) return fail('UNAVAILABLE', "The calendar couldn't be checked just now. Try again in a minute.")
    const slot = read.slots.find((s) => s.start === at)
    if (!slot) return fail('SLOT_TAKEN', 'That time is no longer available. Pick another.')

    const order = link.hosts.map((h) => h.userId)
    let organizer: string | null
    let others: string[] = []
    if (link.hostMode === 'any') {
      const windowEnd = new Date(now + link.windowDays * DAY_MS).toISOString()
      const load = await (deps.load ?? ((ids, a, b) => hostLoad(supabase, ids, a, b)))(slot.hostIds, new Date(now).toISOString(), windowEnd)
      organizer = chooseHost(slot.hostIds, load, order)
    } else {
      organizer = slot.hostIds[0] ?? null
      if (link.hostMode === 'all') others = slot.hostIds.slice(1)
    }
    if (!organizer) return fail('SLOT_TAKEN', 'That time is no longer available. Pick another.')

    const account = await (deps.calendarAccount ?? bookingCalendarAccount)(supabase, organizer, link.workspaceId)
    if (!account) return fail('NO_CALENDAR', "This booking page can't take bookings right now.")
    const contactId = (await (deps.findContact ?? ((ws, who) => findContactByEmailOrPhone(supabase, ws, who)))(link.workspaceId, { email: guest.email, phone: guest.phone }).catch(() => null))?.id ?? null

    const askFirst = link.askFirst || !guest.email
    const id = (deps.newId ?? randomUUID)()
    const hostName = await names(deps, supabase, link.workspaceId, [organizer, ...others])
    const outcome = await bookMeeting(
      supabase,
      {
        id,
        workspace_id: link.workspaceId,
        host_user_id: organizer,
        host_name: hostName,
        source: 'link',
        link_id: link.id,
        guest_name: guest.name,
        guest_email: guest.email,
        guest_phone: guest.phone,
        guest_time_zone: isTimeZone(input.timeZone) ? input.timeZone : null,
        guest_note: oneLine(input.note, LINK_NOTE_MAX),
        contact_id: contactId,
        answers: answers.answers,
        title: link.title,
        starts_at: startIso,
        ends_at: new Date(slot.end).toISOString(),
        state: askFirst ? 'requested' : 'booking',
        video: link.video,
        location: link.video ? null : link.location,
        calendar_account_id: account.id,
        manage_token_hash: manageTokenHash(manageTokenFor(id, deps.secret)),
        other_host_ids: others,
        host_time_zone: read.timeZone,
      },
      askFirst ? new Date(now + LINK_REQUEST_HOLD_MS).toISOString() : null,
    )
    if (outcome.status === 'taken') return fail('SLOT_TAKEN', 'That time was just taken. Pick another.')
    if (outcome.status !== 'booked') return fail('FAILED', "That didn't go through. Try again in a moment.")
    const link_ = manageUrl(origin, manageTokenFor(id, deps.secret))

    if (!askFirst) {
      const booking = await finishBooking(supabase, id, { origin, secret: deps.secret, ...deps.accept })
      if (!booking) return fail('FAILED', 'The booking could not be read back. Try again in a moment.')
      return { ok: true, already: false, booking, manageUrl: link_ }
    }

    const booking = await getBooking(supabase, id)
    if (!booking) return fail('FAILED', 'The booking could not be read back. Try again in a moment.')
    const label = `${slotLabel(booking.startsAt, read.timeZone)} ${zoneLabel(read.timeZone, at)}`
    const approval = await (deps.createApproval ?? ((a) => createToolApproval(supabase, a)))({
      door: 'chat',
      userId: organizer,
      workspaceId: link.workspaceId,
      toolName: CONFIRM_LINK_BOOKING_TOOL,
      sideEffect: 'external-write',
      // What the card shows is what runs: the booking, by id, as it was asked for.
      input: {
        booking_id: id,
        when: label,
        starts_at: booking.startsAt,
        ends_at: booking.endsAt,
        guest: guest.name,
        ...(guest.email ? { email: guest.email } : {}),
        ...(guest.phone ? { phone: guest.phone } : {}),
        link: link.title,
      },
      conversationId: null,
      context: { booking: { bookingId: id }, tools: { origin: { actor: 'agent', depth: 1 } } },
      reason: 'booking_link',
      card: requestCard({ linkTitle: link.title, guestName: guest.name, label, invited: !!guest.email }),
    })
    if (!approval.ok) {
      await updateBooking(supabase, id, ['requested'], { state: 'cancelled', cancelled_at: new Date().toISOString() }).catch(() => null)
      await deleteBookingClaims(supabase, id).catch(() => {})
      return approval.code === 'TOO_MANY_PENDING'
        ? fail('TOO_MANY_PENDING', 'Too many requests are waiting on the host right now. Try again later.')
        : fail('FAILED', "That request couldn't reach the host. Try again in a moment.")
    }
    const withApproval = (await updateBooking(supabase, id, ['requested'], { approval_id: approval.approvalId }).catch(() => null)) ?? booking
    return { ok: true, already: false, booking: withApproval, manageUrl: link_ }
  } catch (err) {
    console.warn(`[booking-links] link=${link.id} booking failed:`, err instanceof Error ? err.message : String(err))
    return fail('FAILED', "That didn't go through. Try again in a moment.")
  }
}

// ── The host's yes or no ────────────────────────────────────────────────────

export interface ConfirmLinkDeps {
  checkFree?: typeof checkSpansFree
  accept?: AcceptDeps
}

/**
 * The host's yes to a link's request (see the header): runs once, from the
 * approved call. Its result is the approval's. Never throws.
 */
export async function confirmLinkRequest(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; bookingId: string },
  deps: ConfirmLinkDeps = {},
): Promise<Record<string, unknown>> {
  try {
    const booking = await getBooking(supabase, args.bookingId, args.workspaceId)
    if (!booking || booking.source !== 'link' || booking.hostUserId !== args.userId) return { success: false, error: 'That booking is gone.' }
    if (booking.state !== 'requested') return { success: false, error: `That booking was already ${booking.state}.` }
    const zone = await hostZone(supabase, booking)
    const label = `${slotLabel(booking.startsAt, zone)} ${zoneLabel(zone, Date.parse(booking.startsAt))}`
    const letGo = async (why: string, code: string) => {
      await settleLinkRequest(supabase, booking.id, 'declined')
      return { success: false, code, error: `${why} ${booking.guestName} was not told: reach them yourself if they should know.` }
    }

    // Every attending host's calendar, now: the booking's own claim isn't in its way.
    const span = [{ start: Date.parse(booking.startsAt), end: Date.parse(booking.endsAt) }]
    for (const userId of bookingHosts(booking)) {
      const free = await (deps.checkFree ?? checkSpansFree)({ userId, workspaceId: booking.workspaceId, timeZone: zone, spans: span, exceptClaims: { bookingId: booking.id } })
      if (!free.known) return letGo(`The calendar couldn't be checked, so ${label} wasn't booked and is free again.`, 'CALENDAR_UNKNOWN')
      if (free.busy[0]) return letGo(`Something else is on the calendar at ${label} now, so it wasn't booked.`, 'SLOT_TAKEN')
    }
    // The yes is fenced first: a request that lapsed or changed meanwhile is
    // left as it is, and no claim of its is made or kept again.
    const writing = await updateBooking(supabase, booking.id, ['requested'], { state: 'booking', decided_at: new Date().toISOString() })
    if (!writing) return { success: false, error: 'That booking changed while it was being confirmed.' }
    const kept = await keepBookingClaims(supabase, booking)
    if (!kept.ok) {
      await updateBooking(supabase, booking.id, ['booking'], { state: 'declined' }).catch(() => null)
      await deleteBookingClaims(supabase, booking.id).catch(() => {})
      return { success: false, code: kept.conflict ? 'SLOT_TAKEN' : 'FAILED', error: `${kept.conflict ? `${label} was booked by someone else meanwhile.` : `${label} couldn't be held (${kept.error}).`} ${booking.guestName} was not told: reach them yourself if they should know.` }
    }
    const done = await finishBooking(supabase, booking.id, deps.accept)
    const confirmed = done?.state === 'confirmed'
    return {
      success: confirmed || done?.state === 'booking',
      booking_id: booking.id,
      state: done?.state ?? 'booking',
      when: label,
      message: confirmed
        ? `Booked: ${booking.title} with ${booking.guestName}, ${label}. ${booking.guestEmail ? 'The calendar sent them the invitation.' : 'They get a confirmation text.'}`
        : done?.state === 'failed'
          ? `It couldn't be put on your calendar (${done.lastError ?? 'the calendar refused it'}), so ${booking.guestName} wasn't booked. Reach them yourself.`
          : `Held ${label} for ${booking.guestName}; the calendar event is being written and follows shortly.`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** A no, or no answer, to a link's request (see the header). Best effort; never throws. Whether it settled it. */
export async function settleLinkRequest(supabase: SupabaseClient, bookingId: string, outcome: 'declined' | 'expired'): Promise<boolean> {
  try {
    const moved = await updateBooking(supabase, bookingId, ['requested'], { state: outcome, decided_at: new Date().toISOString() })
    if (!moved) return false
    await deleteBookingClaims(supabase, bookingId)
    return true
  } catch (err) {
    console.warn('[booking-links] a request could not be settled:', err instanceof Error ? err.message : String(err))
    return false
  }
}
