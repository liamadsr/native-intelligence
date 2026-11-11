/**
 * Booking a job on the owner's yes (roadmap B4). A customer picks an open
 * slot (by text through their agent's request_booking, or on the public
 * booking page), and:
 *
 *   1. REQUEST: the slot must still be open (./slots.ts, read again now);
 *      it is held (a meeting_booking, source customer, state requested, with
 *      its claim on the owner's time: never two on one time), and ONE
 *      approval goes to the owner: tool `confirm_booking`,
 *      external-write (it writes a calendar provider event and texts the
 *      customer), its card naming who, when, where and the quote. Nobody is
 *      in a chat to see it, so it asks in the owner's home thread and the
 *      reach router texts it when they are away, with its reply code: the
 *      owner answers "yes K7Q4MX" (src/lib/sms/approvals.ts) or taps the card.
 *   2. YES (src/lib/safety/approvals.ts executeStoredCall → confirmBooking):
 *      the booking must still be requested; the calendar event is made on
 *      the owner's calendar, the booking is confirmed with it, its quote
 *      marked booked, and the customer gets a confirmation text from the
 *      business's number. A slot the owner filled since is refused, and the
 *      customer is told to pick another.
 *   3. NO, or no answer within the approval's day (settleBookingApproval):
 *      the booking is declined or expired, the slot is open again, and a
 *      texting customer is told to pick another time (a number typed on the
 *      booking page is texted only after the owner's yes).
 *
 * Nothing is held for a booking a yes couldn't write (no Google or Outlook
 * calendar), and live requests are capped per business and per customer, so
 * neither the page nor one customer can fill the owner's approvals. A yes
 * that can't book (the calendar gone or refusing) releases the slot and
 * tells the customer.
 *
 * At accept the approval re-checks the booking itself (bookingApprovalPermits):
 * still requested, still this workspace's, and a texting customer still
 * active.
 *
 * The same card answers a booking link's request (src/lib/booking-links/
 * book.ts): confirmBooking and settleBookingApproval hand a link's booking to
 * confirmLinkRequest and settleLinkRequest there.
 *
 * Server only; service role. Pure over {@link BookingDeps}.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCalendarEvent, getCalendarProvider } from '@/lib/integrations/calendar'
import { sendSms } from '@/lib/twilio/client'
import { formatSmsReply } from '@/lib/twilio/sms-format'
import { appOrigin } from '@/lib/twilio/config'
import { isNanpNumber } from '@/lib/twilio/phone'
import { recordOutbound, unlinkedNumberOptedOut } from '@/lib/sms/store'
import { createToolApproval, type NewApproval, type NewApprovalResult } from '@/lib/safety/approvals'
import { cleanText } from './intake'
import { activeBusinessNumber } from './numbers'
import { bookingSetup, isSlotFree, openSlotAt, slotLabel } from './slots'
import {
  businessName,
  countLiveRequests,
  expireStaleBookings,
  getBooking,
  getQuote,
  insertBooking,
  keepBookingTime,
  moveBooking,
  quotesForCustomer,
  setBookingApproval,
  updateQuote,
  type InsertBookingResult,
} from './store'
import { BOOKING_NOTE_MAX, BOOKING_REQUEST_TTL_MS, QUOTE_ADDRESS_MAX, QUOTE_NAME_MAX, formatCents, quoteSummary, type BookingSource, type CustomerBooking, type CustomerQuote, type OpenSlot } from './types'

/** The held call's tool: what runs on the owner's yes. Never a registry tool, never a model's. */
export const CONFIRM_BOOKING_TOOL = 'confirm_booking'

/** What the approval context carries for a booking (set by the server only). */
export interface BookingApprovalContext {
  bookingId: string
}

export interface BookingRequestInput {
  start: string
  name: string
  address?: string | null
  quoteId?: string | null
  note?: string | null
  /** The customer's number: theirs by text (their guest row), what they typed on the booking page. */
  phone?: string | null
}

export type BookingRequestResult =
  | { ok: true; booking: CustomerBooking; approvalId: string; label: string }
  | { ok: false; code: 'SLOT_TAKEN' | 'BAD_INPUT' | 'CALENDAR_UNAVAILABLE' | 'TOO_MANY_PENDING' | 'FAILED'; message: string; slots?: OpenSlot[] }

export interface BookingDeps {
  openSlotAt: typeof openSlotAt
  insertBooking: (booking: Parameters<typeof insertBooking>[1]) => Promise<InsertBookingResult>
  createApproval: (approval: NewApproval) => Promise<NewApprovalResult>
  /** Whether the owner has a calendar a booking can be written to (Google or Outlook). */
  canBook: (ownerUserId: string) => Promise<boolean>
  /** Requests still waiting on the owner (fresh ones), for the business, and for this customer when one is named. */
  countLiveRequests: (workspaceId: string, sinceIso: string, who?: { phone: string | null; guestId: string | null }) => Promise<number>
  now?: () => number
}

/** Requests one business may have waiting on its owner at once (keeps a flood off the owner's approvals). */
export const BOOKING_LIVE_REQUESTS_MAX = 10
/** Requests one customer may have waiting at once: by text (their own number) and on the booking page (a typed one). */
export const BOOKING_REQUESTS_PER_CUSTOMER: Record<BookingSource, number> = { sms: 2, link: 1, phone: 2, owner: 10 }

const realBookingDeps = (supabase: SupabaseClient): BookingDeps => ({
  openSlotAt,
  insertBooking: (booking) => insertBooking(supabase, booking),
  createApproval: (approval) => createToolApproval(supabase, approval),
  // A provider event is what a yes writes: the desktop's local calendar can't take one.
  canBook: async (ownerUserId) => {
    const provider = await getCalendarProvider(ownerUserId)
    return provider === 'google' || provider === 'microsoft'
  },
  countLiveRequests: (workspaceId, sinceIso, who) => countLiveRequests(supabase, workspaceId, sinceIso, who),
})

/** The approval card's words: who, when, where, the quote. Pure. */
export function bookingCard(input: {
  kind: string
  customerName: string
  label: string
  address: string | null
  quote: Pick<CustomerQuote, 'items' | 'service' | 'totalCents' | 'currency'> | null
  source: BookingSource
}): { title: string; why: string } {
  const kind = input.kind.charAt(0).toUpperCase() + input.kind.slice(1)
  const price = input.quote ? formatCents(input.quote.totalCents, input.quote.currency) : null
  const title = [`${kind} for ${input.customerName.slice(0, 40)}`, input.label, input.address?.slice(0, 60), price].filter(Boolean).join(', ')
  const how = input.source === 'link' ? 'on your booking page' : 'by text'
  const what = input.quote ? ` Their quote: ${quoteSummary(input.quote)}.` : ''
  return {
    title,
    why: `${input.customerName.slice(0, 40)} picked this time ${how}.${what} Yes puts it on your calendar and texts them a confirmation.`,
  }
}

/**
 * Ask for a slot (step 1 of the header). Never throws: every outcome is a
 * result the customer's agent (or the booking page) can say.
 */
export async function requestBooking(
  supabase: SupabaseClient,
  args: {
    business: { workspaceId: string; ownerUserId: string }
    source: BookingSource
    /** A texting customer's row: their own quotes only, and their approval names them. */
    guest?: { id: string; displayName: string; contactId: string | null; phone: string | null } | null
    input: BookingRequestInput
  },
  deps: BookingDeps = realBookingDeps(supabase),
): Promise<BookingRequestResult> {
  const now = (deps.now ?? Date.now)()
  const name = cleanText(args.input.name, QUOTE_NAME_MAX)
  if (!name) return { ok: false, code: 'BAD_INPUT', message: "I need the customer's name for the booking." }
  const address = cleanText(args.input.address, QUOTE_ADDRESS_MAX)
  const note = cleanText(args.input.note, BOOKING_NOTE_MAX, { multiline: true })
  const phone = args.guest?.phone ?? args.input.phone ?? null

  // Their own quote only: one sent from their number.
  let quote: CustomerQuote | null = null
  if (args.input.quoteId) {
    const theirs = await quotesForCustomer(supabase, args.business.workspaceId, phone).catch(() => [])
    quote = theirs.find((q) => q.id === args.input.quoteId) ?? null
  }

  await expireStaleBookings(supabase, args.business.workspaceId, new Date(now - BOOKING_REQUEST_TTL_MS).toISOString())
  // Nothing is held for a booking a yes couldn't write.
  if (!(await deps.canBook(args.business.ownerUserId).catch(() => false))) {
    return { ok: false, code: 'CALENDAR_UNAVAILABLE', message: "Online booking isn't open right now. Pass the request to the owner with message_owner." }
  }
  // A flood (a script on the booking page, one customer asking again and again) never fills the owner's approvals.
  const since = new Date(now - BOOKING_REQUEST_TTL_MS).toISOString()
  try {
    if ((await deps.countLiveRequests(args.business.workspaceId, since)) >= BOOKING_LIVE_REQUESTS_MAX) {
      return { ok: false, code: 'TOO_MANY_PENDING', message: 'The owner has several requests waiting already. Try again a bit later, or message them.' }
    }
    if ((phone || args.guest) && (await deps.countLiveRequests(args.business.workspaceId, since, { phone, guestId: args.guest?.id ?? null })) >= BOOKING_REQUESTS_PER_CUSTOMER[args.source]) {
      return { ok: false, code: 'TOO_MANY_PENDING', message: "There's already a request waiting on the owner for this customer. Wait for their answer, or message them." }
    }
  } catch {
    return { ok: false, code: 'FAILED', message: "I couldn't hold that time. Try again in a moment." }
  }
  let open: Awaited<ReturnType<typeof openSlotAt>>
  try {
    open = await deps.openSlotAt(supabase, args.business, args.input.start, { now: () => now })
  } catch (err) {
    console.warn('[booking] slot check failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, code: 'CALENDAR_UNAVAILABLE', message: "I can't check the calendar right now. Try again in a little while." }
  }
  if (!open.slot) return { ok: false, code: 'SLOT_TAKEN', message: "That time isn't open any more. Pick another from find_open_slots." }

  const held = await deps.insertBooking({
    workspaceId: args.business.workspaceId,
    ownerUserId: args.business.ownerUserId,
    quoteId: quote?.id ?? null,
    contactId: quote?.contactId ?? args.guest?.contactId ?? null,
    guestId: args.guest?.id ?? null,
    source: args.source,
    kind: open.rules.bookingKind,
    startsAt: open.slot.start,
    endsAt: open.slot.end,
    customerName: name,
    customerPhone: phone,
    address,
    note,
    timeZone: open.timeZone,
  })
  if (!held.ok) {
    return held.reason === 'taken'
      ? { ok: false, code: 'SLOT_TAKEN', message: 'Someone just asked for that time. Pick another from find_open_slots.' }
      : { ok: false, code: 'FAILED', message: "I couldn't hold that time. Try again in a moment." }
  }
  const booking = held.booking
  const label = slotLabel(booking.startsAt, open.timeZone)
  const card = bookingCard({ kind: booking.kind, customerName: name, label, address, quote, source: args.source })
  const approval = await deps.createApproval({
    door: 'chat',
    userId: args.business.ownerUserId,
    workspaceId: args.business.workspaceId,
    toolName: CONFIRM_BOOKING_TOOL,
    sideEffect: 'external-write',
    // What the card shows is what runs: the booking, by id, as it was asked for.
    input: {
      booking_id: booking.id,
      when: label,
      starts_at: booking.startsAt,
      ends_at: booking.endsAt,
      customer: name,
      ...(phone ? { phone } : {}),
      ...(address ? { address } : {}),
      ...(quote ? { quote: quoteSummary(quote) } : {}),
      ...(note ? { note } : {}),
    },
    conversationId: null,
    context: {
      booking: { bookingId: booking.id },
      tools: { origin: { actor: 'agent', depth: 1 } },
      ...(args.guest ? { guest: { guestId: args.guest.id, name: args.guest.displayName } } : {}),
    },
    reason: 'customer_booking',
    card,
  })
  if (!approval.ok) {
    await moveBooking(supabase, { workspaceId: booking.workspaceId, bookingId: booking.id, from: 'requested', to: 'cancelled' }).catch(() => null)
    return approval.code === 'TOO_MANY_PENDING'
      ? { ok: false, code: 'TOO_MANY_PENDING', message: 'The owner has several requests waiting already. Try again a bit later, or message them.' }
      : { ok: false, code: 'FAILED', message: "I couldn't send that to the owner. Try again in a moment." }
  }
  await setBookingApproval(supabase, booking.workspaceId, booking.id, approval.approvalId).catch(() => {})
  return { ok: true, booking: { ...booking, approvalId: approval.approvalId }, approvalId: approval.approvalId, label }
}

// ── The owner's yes ─────────────────────────────────────────────────────────

/** What the customer is texted once the owner said yes. Pure. */
export function bookingConfirmedText(business: string, booking: Pick<CustomerBooking, 'kind' | 'address'>, label: string): string {
  return `${business}: your ${booking.kind} is booked for ${label}${booking.address ? ` at ${booking.address}` : ''}. Reply here if anything changes.`
}

/** What the customer is texted when the owner said no or didn't answer. Pure. */
export function bookingDeclinedText(business: string, booking: Pick<CustomerBooking, 'kind'>, label: string): string {
  return `${business}: sorry, we can't do the ${booking.kind} at ${label}. Text us here and we'll find another time.`
}

/**
 * Text a booking's customer from the business's number (never the Native Intelligence one).
 * The ledger row is a `guest_notice` for a customer with a row, else a
 * `notice`; `kind` overrides it (a reminder is a `notice` either way, so a
 * day's reminders never spend the global auto-reply cap or count as the
 * customer's daily-limit notice). Never throws; whether it went.
 */
export async function textBookingCustomer(
  supabase: SupabaseClient,
  booking: Pick<CustomerBooking, 'workspaceId' | 'customerPhone' | 'guestId'>,
  body: string,
  deps: { send?: typeof sendSms; kind?: 'notice' } = {},
): Promise<boolean> {
  try {
    const to = booking.customerPhone
    if (!to || !isNanpNumber(to) || (await unlinkedNumberOptedOut(supabase, to))) return false
    const number = await activeBusinessNumber(supabase, booking.workspaceId)
    if (!number) return false
    let sent = false
    for (const text of formatSmsReply(body, { origin: appOrigin() })) {
      const result = await (deps.send ?? sendSms)(to, text, { from: number.phone })
      if (!result.ok) break
      sent = true
      await recordOutbound(supabase, { phone: to, kind: deps.kind ?? (booking.guestId ? 'guest_notice' : 'notice'), sid: result.sid, guestId: booking.guestId })
    }
    return sent
  } catch {
    return false
  }
}

export interface ConfirmDeps {
  createEvent?: typeof createCalendarEvent
  hasCalendar?: (userId: string) => Promise<boolean>
  textCustomer?: (booking: CustomerBooking, body: string) => Promise<boolean>
  isSlotFree?: typeof isSlotFree
  timeZone?: (business: { workspaceId: string; ownerUserId: string }) => Promise<string>
  /** A booking link's request (default: src/lib/booking-links/book.ts confirmLinkRequest). */
  confirmLink?: (args: { userId: string; workspaceId: string; bookingId: string }) => Promise<Record<string, unknown>>
}

/** The business's zone, for the times in its texts. Never throws (UTC when unreadable). */
async function businessZone(supabase: SupabaseClient, business: { workspaceId: string; ownerUserId: string }): Promise<string> {
  try {
    return (await bookingSetup(supabase, business)).timeZone
  } catch {
    return 'UTC'
  }
}

/**
 * The owner's yes (step 2): runs once, from the approved call. Its result is
 * the approval's (the owner's home thread shows it). Never throws.
 */
export async function confirmBooking(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; bookingId: string },
  deps: ConfirmDeps = {},
): Promise<Record<string, unknown>> {
  try {
    const booking = await getBooking(supabase, args.workspaceId, args.bookingId)
    if (!booking || booking.ownerUserId !== args.userId) return { success: false, error: 'That booking is gone.' }
    if (booking.origin === 'link') {
      const confirmLink = deps.confirmLink ?? (async (a) => (await import('@/lib/booking-links/book')).confirmLinkRequest(supabase, a))
      return confirmLink(args)
    }
    if (booking.state !== 'requested') return { success: false, error: `That booking was already ${booking.state}.` }
    const business = { workspaceId: booking.workspaceId, ownerUserId: booking.ownerUserId }
    const name = await businessName(supabase, booking.workspaceId)
    const text = deps.textCustomer ?? ((b: CustomerBooking, body: string) => textBookingCustomer(supabase, b, body))
    const hasCalendar = deps.hasCalendar ?? (async (userId: string) => ['google', 'microsoft'].includes((await getCalendarProvider(userId)) ?? ''))
    const label = slotLabel(booking.startsAt, await (deps.timeZone ?? ((b) => businessZone(supabase, b)))(business))
    // Anything that stops the yes from booking releases the slot and tells the customer: never a hold left waiting.
    // An owner's own booking (book_quote) is never texted a "can't": its card promised only the confirmation.
    const release = async (to: 'declined' | 'cancelled') => {
      const moved = await moveBooking(supabase, { workspaceId: booking.workspaceId, bookingId: booking.id, from: 'requested', to }).catch(() => null)
      if (moved && moved.source !== 'owner') await text(moved, bookingDeclinedText(name, moved, label)).catch(() => false)
    }
    const told = (said: string) => (booking.source === 'owner' ? `${booking.customerName} was not told.` : `${booking.customerName} ${said}`)
    if (!(await hasCalendar(booking.ownerUserId))) {
      await release('cancelled')
      return { success: false, code: 'NO_CALENDAR', error: `No Google or Outlook calendar is connected, so the booking could not go on it. ${told("was told it isn't booked.")} Connect a calendar, then ask them again.` }
    }

    // The slot may have filled since they asked (the owner's own plans): their own hold doesn't count against it.
    const free = await (deps.isSlotFree ?? isSlotFree)(supabase, business, { start: booking.startsAt, end: booking.endsAt, exceptBookingId: booking.id })
    if (!free) {
      await release('declined')
      return { success: false, code: 'SLOT_TAKEN', error: `Something else is on your calendar then now, so it wasn't booked. ${told('was asked to pick another time.')}` }
    }
    // The yes keeps the time for good (a hold that lapsed is taken again, unless someone has it now).
    const kept = await keepBookingTime(supabase, booking)
    if (!kept.ok && kept.conflict) {
      await release('declined')
      return { success: false, code: 'SLOT_TAKEN', error: `That time was booked by something else meanwhile, so it wasn't booked. ${told('was asked to pick another time.')}` }
    }

    const quote = booking.quoteId ? await getQuote(supabase, booking.workspaceId, booking.quoteId).catch(() => null) : null
    const description = [
      `${booking.kind.charAt(0).toUpperCase()}${booking.kind.slice(1)} booked through Native Intelligence.`,
      `Customer: ${booking.customerName}${booking.customerPhone ? ` (${booking.customerPhone})` : ''}`,
      booking.address ? `Address: ${booking.address}` : null,
      quote ? `Quote: ${quoteSummary(quote)}` : null,
      booking.note ? `Note: ${booking.note}` : null,
    ]
      .filter(Boolean)
      .join('\n')
    let event: Awaited<ReturnType<typeof createCalendarEvent>>
    try {
      event = await (deps.createEvent ?? createCalendarEvent)(booking.ownerUserId, {
        title: `${booking.kind.charAt(0).toUpperCase()}${booking.kind.slice(1)}: ${booking.customerName}`.slice(0, 120),
        start: booking.startsAt,
        end: booking.endsAt,
        ...(booking.address ? { location: booking.address } : {}),
        description,
      })
    } catch (err) {
      await release('cancelled')
      return { success: false, code: 'CALENDAR_FAILED', error: `The calendar refused the event (${err instanceof Error ? err.message : String(err)}), so it isn't booked. ${told('was told to pick another time.')}` }
    }
    const confirmed = await moveBooking(supabase, { workspaceId: booking.workspaceId, bookingId: booking.id, from: 'requested', to: 'confirmed' }, { calendarEventId: event?.id ?? null })
    if (!confirmed) return { success: false, error: 'That booking changed while it was being confirmed.' }
    if (quote && quote.status !== 'done' && quote.status !== 'cancelled') await updateQuote(supabase, booking.workspaceId, quote.id, { status: 'booked' }).catch(() => null)
    const texted = await text(confirmed, bookingConfirmedText(name, confirmed, label))
    return {
      success: true,
      booking_id: confirmed.id,
      when: label,
      calendar_event_id: event?.id ?? null,
      customer_texted: texted,
      message: `Booked: ${confirmed.customerName}, ${label}. ${texted ? 'They got a confirmation text.' : "They couldn't be texted a confirmation: tell them yourself."}`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── The owner's no, or no answer ────────────────────────────────────────────

/**
 * The owner declined the booking's approval, or it lapsed (step 3): the
 * booking leaves its slot and the customer is told. Best effort; never throws.
 */
export async function settleBookingApproval(
  supabase: SupabaseClient,
  row: { workspace_id: string; context?: { booking?: Partial<BookingApprovalContext> } | null },
  outcome: 'denied' | 'expired',
  deps: { textCustomer?: (booking: CustomerBooking, body: string) => Promise<boolean> } = {},
): Promise<void> {
  const bookingId = row.context?.booking?.bookingId
  if (typeof bookingId !== 'string') return
  try {
    const found = await getBooking(supabase, row.workspace_id, bookingId)
    if (found?.origin === 'link') {
      const { settleLinkRequest } = await import('@/lib/booking-links/book')
      await settleLinkRequest(supabase, bookingId, outcome === 'denied' ? 'declined' : 'expired')
      return
    }
    await expireOrDecline(supabase, { workspaceId: row.workspace_id, bookingId }, outcome === 'denied' ? 'declined' : 'expired', deps)
  } catch (err) {
    console.warn('[booking] settle skipped:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * A customer's request leaves its slot, declined or expired, and a texting
 * customer is told: the owner's no, a lapsed approval, or a hold the sweep
 * found run out (src/lib/time-offers/sweep.ts). Throws on a failed write.
 */
export async function expireOrDecline(
  supabase: SupabaseClient,
  ref: { workspaceId: string; bookingId: string },
  to: 'declined' | 'expired',
  deps: { textCustomer?: (booking: CustomerBooking, body: string) => Promise<boolean> } = {},
): Promise<void> {
  const moved = await moveBooking(supabase, { workspaceId: ref.workspaceId, bookingId: ref.bookingId, from: 'requested', to })
  if (!moved) return
  // A number typed on the booking page is nobody's verified number, and the
  // owner didn't approve it: it is texted only after their yes (never on a
  // no or a lapse), so the page can't be used to text strangers.
  if (moved.source === 'link') return
  const name = await businessName(supabase, moved.workspaceId)
  const zone = await businessZone(supabase, { workspaceId: moved.workspaceId, ownerUserId: moved.ownerUserId })
  await (deps.textCustomer ?? ((b, body) => textBookingCustomer(supabase, b, body)))(moved, bookingDeclinedText(name, moved, slotLabel(moved.startsAt, zone)))
}

/**
 * The accept-time re-check of a booking's approval: the booking is still
 * requested and this workspace's, and a texting customer is still active.
 * Throws on a failed read.
 */
export async function bookingApprovalPermits(
  supabase: SupabaseClient,
  row: { workspace_id: string; user_id: string; tool: string; context?: { booking?: Partial<BookingApprovalContext>; guest?: { guestId?: unknown } } | null },
): Promise<boolean> {
  if (row.tool !== CONFIRM_BOOKING_TOOL) return false
  const bookingId = row.context?.booking?.bookingId
  if (typeof bookingId !== 'string') return false
  const booking = await getBooking(supabase, row.workspace_id, bookingId)
  if (!booking || booking.state !== 'requested' || booking.ownerUserId !== row.user_id) return false
  const guestId = row.context?.guest?.guestId
  if (typeof guestId === 'string') {
    const { data, error } = await supabase.from('agent_guest').select('state').eq('id', guestId).eq('owner_user_id', row.user_id).maybeSingle<{ state: string }>()
    if (error) throw new Error(error.message)
    if (!data || data.state !== 'active') return false
  }
  return true
}
