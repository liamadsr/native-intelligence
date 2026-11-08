/**
 * A text to a business's own number (roadmap B2; src/lib/sms/inbound.ts
 * branches here on the `To` number, after STOP / START / HELP, the opt-out
 * and the per-number rate limit, which hold for everyone). In this order:
 *
 *   1. one of the business's own people (a member's verified phone, on
 *      either line: src/lib/sms/store.ts findBusinessPerson, the same rule
 *      inbound.ts resolves WHICH person by) is not a customer: null, and the
 *      person's own path takes it, as if they had texted the Native Intelligence number but
 *      in this business's workspace, whichever workspace their phone is
 *      linked to. inbound.ts asks here only for a sender it found none for;
 *   2. the owner's own guest (their Household, say) reaches the agent the
 *      owner made for them, as by the Native Intelligence number;
 *   3. anyone else is the business's customer: their customer row is found
 *      or made (./customer-guests.ts, linked to their CRM contact when the
 *      number matches one), past their daily cap one notice a day, and the
 *      text goes to their thread with a text turn carrying their `guestId`.
 *      Their first text also gets a short welcome at once, naming the
 *      business, with the opt-out. Only a US or Canadian number becomes a
 *      customer: anything else is refused in silence (no turn, no text).
 *
 * Every reply here answers a number nobody verified: NANP only and the global
 * auto-reply cap (the deps' `autoReply`), as a guest's.
 *
 * Pure over {@link BusinessTextDeps}; {@link supabaseBusinessTextDeps} is the real store.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { GUEST_DAILY_TEXT_CAP, deliverGuestText } from '@/lib/guests/texting'
import { findActiveGuestByPhone, touchGuestInbound, type AgentGuest } from '@/lib/guests/store'
import { countGuestMessagesSince, findBusinessPerson, markInboundGuest } from '@/lib/sms/store'
import { isNanpNumber } from '@/lib/twilio/phone'
import { findContactByEmailOrPhone } from './contacts'
import { ensureCustomerGuest } from './customer-guests'
import type { BusinessNumber } from './numbers'
import { businessName, getBusinessProfile } from './store'

const DAY_MS = 24 * 60 * 60_000

export type BusinessTextOutcome = 'customer_queued' | 'customer_welcomed' | 'customer_no_text' | 'customer_limited' | 'customer_limited_ignored' | 'customer_refused' | 'owner_guest_queued'

export interface BusinessTextResult {
  outcome: BusinessTextOutcome
  reply: string | null
}

export interface BusinessTextDeps {
  /** True when this phone is a verified phone (either line) of a member of the business's workspace. */
  isBusinessPerson(phone: string, workspaceId: string): Promise<boolean>
  /** The owner's own active guest on this phone (never a customer row), or null. */
  ownersGuest(phone: string, ownerUserId: string): Promise<AgentGuest | null>
  /** The customer's row, made on their first text; `created` for a new one. */
  ensureCustomer(number: BusinessNumber, phone: string): Promise<{ guest: AgentGuest; created: boolean }>
  businessName(workspaceId: string): Promise<string>
  /** The job word ("pickup"), for the welcome. */
  bookingKind(workspaceId: string): Promise<string>
  countInboundSince(guestId: string, sinceMs: number): Promise<number>
  markInbound(sid: string, kind: 'guest_text' | 'limited', guestId: string): Promise<void>
  noticedSince(phone: string, sinceMs: number): Promise<boolean>
  autoReply(phone: string, kind: 'guest_welcome' | 'guest_notice', text: string, guestId: string | null): Promise<string | null>
  deliver(args: { guest: AgentGuest; text: string; sid: string }): Promise<void>
}

export function customerWelcomeReply(business: string, kind: string): string {
  return `Thanks for texting ${business}! Our assistant will answer here in a moment: ask about prices, your quote, or booking a ${kind}. Msg & data rates may apply. Reply STOP to opt out.`
}

export function customerLimitedReply(business: string): string {
  return `That's the most texts ${business} can answer today. Try again tomorrow.`
}

export const CUSTOMER_NO_TEXT_REPLY = 'I can only read words for now, not pictures. Text me what you need.'

/** The HELP answer for a business's number: who it is, and the opt-out. */
export function businessHelpReply(business: string): string {
  return `${business}: text this number for quotes and bookings. Msg & data rates may apply. Reply STOP to opt out.`
}

/** The START answer for a business's number. */
export function businessStartReply(business: string): string {
  return `You're subscribed to ${business} texts again. Text this number anytime. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.`
}

/**
 * A text to a business's number (see the header): the result, or null when
 * the sender is one of the business's own people (their own path takes it).
 * Throws on a failed store call.
 */
export async function handleBusinessText(
  input: { number: BusinessNumber; phone: string; text: string; sid: string | null; numMedia: number },
  deps: BusinessTextDeps,
  now: number = Date.now(),
): Promise<BusinessTextResult | null> {
  const { number, phone, text, sid } = input
  // 1. The business's own people: not a customer.
  if (await deps.isBusinessPerson(phone, number.workspaceId)) return null

  // 2. The owner's own guest: the agent the owner made for them.
  const own = await deps.ownersGuest(phone, number.ownerUserId)
  if (own) {
    if (!text || !sid) return { outcome: 'customer_no_text', reply: input.numMedia > 0 ? CUSTOMER_NO_TEXT_REPLY : null }
    await deps.markInbound(sid, 'guest_text', own.id)
    await deps.deliver({ guest: own, text, sid })
    return { outcome: 'owner_guest_queued', reply: null }
  }

  // 3. A customer: a US or Canadian number only (Native Intelligence texts nowhere else:
  // against SMS pumping, ../twilio/phone.ts isNanpNumber), never answered.
  if (!isNanpNumber(phone)) return { outcome: 'customer_refused', reply: null }
  if (!text || !sid) return { outcome: 'customer_no_text', reply: input.numMedia > 0 ? CUSTOMER_NO_TEXT_REPLY : null }
  const { guest, created } = await deps.ensureCustomer(number, phone)
  if ((await deps.countInboundSince(guest.id, now - DAY_MS)) >= GUEST_DAILY_TEXT_CAP) {
    await deps.markInbound(sid, 'limited', guest.id)
    if (await deps.noticedSince(phone, now - DAY_MS)) return { outcome: 'customer_limited_ignored', reply: null }
    const reply = await deps.autoReply(phone, 'guest_notice', customerLimitedReply(await deps.businessName(number.workspaceId)), guest.id)
    return { outcome: reply ? 'customer_limited' : 'customer_limited_ignored', reply }
  }
  await deps.markInbound(sid, 'guest_text', guest.id)
  await deps.deliver({ guest, text, sid })
  if (!created) return { outcome: 'customer_queued', reply: null }
  const [name, kind] = await Promise.all([deps.businessName(number.workspaceId), deps.bookingKind(number.workspaceId)])
  const reply = await deps.autoReply(phone, 'guest_welcome', customerWelcomeReply(name, kind), guest.id)
  return { outcome: reply ? 'customer_welcomed' : 'customer_queued', reply }
}

/** The real store behind {@link handleBusinessText}. `autoReply` / `noticedSince` are the inbound handler's. */
export function supabaseBusinessTextDeps(
  supabase: SupabaseClient,
  args: { autoReply: BusinessTextDeps['autoReply']; noticedSince: BusinessTextDeps['noticedSince'] },
): BusinessTextDeps {
  return {
    // The inbound handler's businessPerson rule, so the two never disagree.
    isBusinessPerson: async (phone, workspaceId) => (await findBusinessPerson(supabase, phone, workspaceId)) !== null,
    ownersGuest: async (phone, ownerUserId) => {
      const guest = await findActiveGuestByPhone(supabase, phone)
      return guest && guest.ownerUserId === ownerUserId ? guest : null
    },
    ensureCustomer: async (number, phone) => {
      const contact = await findContactByEmailOrPhone(supabase, number.workspaceId, { email: null, phone })
      return ensureCustomerGuest(supabase, { number, phone, contact: contact ? { id: contact.id, fullName: contact.full_name } : null })
    },
    businessName: (workspaceId) => businessName(supabase, workspaceId),
    bookingKind: async (workspaceId) => (await getBusinessProfile(supabase, workspaceId).catch(() => null))?.bookingKind ?? 'pickup',
    countInboundSince: (guestId, sinceMs) => countGuestMessagesSince(supabase, guestId, 'in', sinceMs),
    markInbound: (sid, kind, guestId) => markInboundGuest(supabase, sid, kind, guestId),
    noticedSince: args.noticedSince,
    autoReply: args.autoReply,
    deliver: async ({ guest, text, sid }) => {
      await deliverGuestText(supabase, { guest, text, sid })
      await touchGuestInbound(supabase, guest.id)
    },
  }
}
