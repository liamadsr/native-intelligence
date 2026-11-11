/**
 * Who a business's customer is, by their phone number (roadmap B2): the one
 * shared lookup for every channel a customer reaches the business on. A text
 * to the business's number uses it (./customer-spec.ts), and so does a call:
 * the voice work answers "I see your quote here…" from the same result, with
 * the same Customer preset (docs/plans/customer-front-door.md, "For voice").
 *
 *   findCustomerByPhone({ workspaceId, phone })
 *     → { contact, guest, quotes, bookings }
 *
 * Only that one customer's rows: their CRM contact (matched on the whole
 * number), their customer guest row (preset 'customer'), their quotes (sent
 * from that number: never by contact, which a form could have misled) and
 * their upcoming live bookings, and the time offers made to that number that
 * are still open (src/lib/time-offers/). Never another customer's. Server
 * only; service role.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isE164 } from '@/lib/twilio/phone'
import type { AgentGuest } from '@/lib/guests/store'
import { findContactByEmailOrPhone } from './contacts'
import { findCustomerGuest } from './customer-guests'
import { openRemindersForPhone, type CustomerReminder } from './reminder-store'
import { BOOKING_SELECT, quotesForCustomer, toBooking } from './store'
import type { CustomerBooking, CustomerQuote } from './types'
import { openOffersForPhone } from '@/lib/time-offers/store'
import type { TimeOffer } from '@/lib/time-offers/types'

export interface CustomerByPhone {
  workspaceId: string
  phone: string
  contact: { id: string; fullName: string; email: string | null } | null
  /** Their customer row (the texting agent's), when they have texted or called before. */
  guest: AgentGuest | null
  /** Newest first, at most 10. */
  quotes: CustomerQuote[]
  /** Requested or confirmed, from now on, soonest first. */
  bookings: CustomerBooking[]
  /** Reminders the business texted them lately whose job or meeting is still ahead (issue #11), soonest first. */
  reminders: CustomerReminder[]
  /** Time offers made to this number that are still open (availability phase 3a), newest first, at most 3. */
  offers: TimeOffer[]
  /** A one-line greeting hint a voice or text agent can open with, or null. */
  openingLine: string | null
}

/** Their live bookings from now on (by guest row or number). Throws on a failed read. */
async function upcomingBookings(supabase: SupabaseClient, workspaceId: string, who: { guestId: string | null; phone: string }, nowIso: string): Promise<CustomerBooking[]> {
  const ors = [`customer_phone.eq.${who.phone}`]
  if (who.guestId) ors.push(`guest_id.eq.${who.guestId}`)
  const { data, error } = await supabase
    .from('customer_booking')
    .select(BOOKING_SELECT)
    .eq('workspace_id', workspaceId)
    .in('state', ['requested', 'confirmed'])
    .gte('ends_at', nowIso)
    .or(ors.join(','))
    .order('starts_at', { ascending: true })
    .limit(5)
  if (error) throw new Error(`customer_booking read failed: ${error.message}`)
  return ((data ?? []) as Parameters<typeof toBooking>[0][]).map(toBooking)
}

/** Look one customer up by number (see the header). Throws on a failed read. */
export async function findCustomerByPhone(
  supabase: SupabaseClient,
  args: { workspaceId: string; phone: string },
  now: number = Date.now(),
): Promise<CustomerByPhone> {
  const phone = args.phone.trim()
  const empty: CustomerByPhone = { workspaceId: args.workspaceId, phone, contact: null, guest: null, quotes: [], bookings: [], reminders: [], offers: [], openingLine: null }
  if (!isE164(phone)) return empty
  const [contactRow, guest] = await Promise.all([findContactByEmailOrPhone(supabase, args.workspaceId, { email: null, phone }), findCustomerGuest(supabase, args.workspaceId, phone)])
  const [quotes, bookings, reminders, offers] = await Promise.all([
    quotesForCustomer(supabase, args.workspaceId, phone),
    upcomingBookings(supabase, args.workspaceId, { guestId: guest?.id ?? null, phone }, new Date(now).toISOString()),
    openRemindersForPhone(supabase, args.workspaceId, phone, now),
    openOffersForPhone(supabase, args.workspaceId, phone, new Date(now).toISOString()),
  ])
  const contact = contactRow ? { id: contactRow.id, fullName: contactRow.full_name, email: contactRow.email } : null
  return { ...empty, contact, guest, quotes, bookings, reminders, offers, openingLine: openingLine(contact, quotes, bookings) }
}

/** What a channel can open with: their booking, else their newest quote, else nothing. Pure. */
export function openingLine(
  contact: { fullName: string } | null,
  quotes: readonly Pick<CustomerQuote, 'status' | 'createdAt'>[],
  bookings: readonly Pick<CustomerBooking, 'state' | 'kind'>[],
): string | null {
  const first = contact && !/^Customer ending \d{4}$/.test(contact.fullName) ? contact.fullName.split(' ')[0] : null
  const hi = first ? `Hi ${first}` : 'Hi'
  const booking = bookings[0]
  if (booking) return booking.state === 'confirmed' ? `${hi}, I see your ${booking.kind} is booked.` : `${hi}, I see you asked to book a ${booking.kind}; it's waiting on the owner's OK.`
  const quote = quotes.find((q) => q.status !== 'cancelled' && q.status !== 'done')
  if (quote) return `${hi}, I see your quote here.`
  return null
}
