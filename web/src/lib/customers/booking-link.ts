/**
 * The public booking link (roadmap B4): /book/<slug>, the business's own
 * page where a customer picks an open slot and leaves their name, mobile
 * number and address. It shows open times only (./slots.ts), never anything
 * of the owner's calendar, and a request goes the same way as one by text
 * (./booking.ts requestBooking, source 'link'): the slot is held, the owner
 * gets a text to approve, and the customer is texted from the business's
 * number once they do.
 *
 * Public, so it is capped: BOOKING_LINK_HOURLY_CAP requests per business per
 * hour, BOOKING_LINK_PHONE_DAILY_CAP per number per day, a US or Canadian
 * mobile only (the confirmation is a text), and a honeypot field.
 *
 * Server only; pure over {@link BookingLinkDeps}.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, badRequest, notFound, rateLimited, serverError } from '@/lib/api-errors'
import { isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { requestBooking, type BookingRequestResult } from './booking'
import { activeBusinessNumber } from './numbers'
import { findOpenSlots, slotLabel } from './slots'
import { getBusinessProfileBySlug } from './store'
import type { BusinessProfile, OpenSlot } from './types'

export const BOOKING_LINK_HOURLY_CAP = 10
export const BOOKING_LINK_PHONE_DAILY_CAP = 2
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
/** How far ahead the page shows. */
export const BOOKING_PAGE_DAYS = 14

export interface BookingPageSlot extends OpenSlot {
  label: string
  /** The local day it falls on, for grouping: "Tue, Nov 3". */
  day: string
  /** Its time alone: "10:00 AM". */
  time: string
}

export type BookingPageState =
  | { kind: 'missing' }
  | { kind: 'unavailable'; businessName: string; phone: string | null }
  | { kind: 'open'; businessName: string; bookingKind: string; timeZone: string; slots: BookingPageSlot[]; phone: string | null }

export interface BookingLinkDeps {
  profileBySlug(slug: string): Promise<BusinessProfile | null>
  businessPhone(workspaceId: string): Promise<string | null>
  openSlots(business: { workspaceId: string; ownerUserId: string }): Promise<{ slots: OpenSlot[]; timeZone: string; kind: string }>
  countLinkRequestsSince(workspaceId: string, sinceIso: string, phone?: string): Promise<number>
  request(business: { workspaceId: string; ownerUserId: string }, input: { start: string; name: string; phone: string; address: string | null; note: string | null }): Promise<BookingRequestResult>
  now?: () => number
}

function part(startIso: string, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(startIso))
  } catch {
    return startIso
  }
}

/** Slots as the page shows them, labelled in the business's zone. Pure. */
export function pageSlots(slots: readonly OpenSlot[], timeZone: string): BookingPageSlot[] {
  return slots.map((slot) => ({
    ...slot,
    label: slotLabel(slot.start, timeZone),
    day: part(slot.start, timeZone, { weekday: 'short', month: 'short', day: 'numeric' }),
    time: part(slot.start, timeZone, { hour: 'numeric', minute: '2-digit' }),
  }))
}

/** What the page renders for a slug. Never throws. */
export async function loadBookingPage(slug: string, deps: BookingLinkDeps): Promise<BookingPageState> {
  let profile: BusinessProfile | null
  try {
    profile = await deps.profileBySlug(slug)
  } catch {
    return { kind: 'missing' }
  }
  if (!profile) return { kind: 'missing' }
  const phone = await deps.businessPhone(profile.workspaceId).catch(() => null)
  try {
    const found = await deps.openSlots({ workspaceId: profile.workspaceId, ownerUserId: profile.ownerUserId })
    return { kind: 'open', businessName: profile.businessName, bookingKind: found.kind, timeZone: found.timeZone, slots: pageSlots(found.slots, found.timeZone), phone }
  } catch (err) {
    console.warn(`[booking-link] ws=${profile.workspaceId} slots unavailable:`, err instanceof Error ? err.message : String(err))
    return { kind: 'unavailable', businessName: profile.businessName, phone }
  }
}

/** POST /api/public/book/<slug>: a customer asking for a slot (see the header). */
export async function handleBookingLinkPost(request: Request, slug: string, deps: BookingLinkDeps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the booking as JSON.')
  // A honeypot a person never fills: answered as if taken, so a bot learns nothing.
  if (typeof body.website === 'string' && body.website.trim()) return Response.json({ ok: true, status: 'requested' })
  const start = typeof body.start === 'string' ? body.start : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const phone = normalizeE164(body.phone)
  if (!start || !Number.isFinite(Date.parse(start))) return badRequest('Pick a time.')
  if (!name || name.length > 120) return badRequest('Add your name.')
  if (!phone || !isNanpNumber(phone)) return badRequest('Add a US or Canadian mobile number, so we can text you the confirmation.')
  const address = typeof body.address === 'string' && body.address.trim() ? body.address.trim().slice(0, 300) : null
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 1000) : null

  let profile: BusinessProfile | null
  try {
    profile = await deps.profileBySlug(slug)
  } catch {
    return serverError('Booking is not available right now.')
  }
  if (!profile) return notFound('This booking page does not exist.')
  const business = { workspaceId: profile.workspaceId, ownerUserId: profile.ownerUserId }
  const now = (deps.now ?? Date.now)()
  try {
    if ((await deps.countLinkRequestsSince(business.workspaceId, new Date(now - HOUR_MS).toISOString())) >= BOOKING_LINK_HOURLY_CAP) return rateLimited('Too many bookings right now. Try again in a little while.')
    if ((await deps.countLinkRequestsSince(business.workspaceId, new Date(now - DAY_MS).toISOString(), phone)) >= BOOKING_LINK_PHONE_DAILY_CAP) {
      return rateLimited("You've already asked for a time today. We'll text you to confirm.")
    }
  } catch {
    return serverError('Booking is not available right now.')
  }

  const result = await deps.request(business, { start, name, phone, address, note })
  if (!result.ok) {
    if (result.code === 'SLOT_TAKEN') return apiError('That time was just taken. Pick another.', { status: 409, code: 'SLOT_TAKEN' })
    if (result.code === 'CALENDAR_UNAVAILABLE') return apiError('Booking is not available right now. Try again soon.', { status: 503, code: 'UNAVAILABLE' })
    if (result.code === 'TOO_MANY_PENDING') return rateLimited('Too many bookings are waiting right now. Try again later.')
    return serverError("We couldn't send that request. Try again in a moment.")
  }
  console.info(`[booking-link] ws=${business.workspaceId} booking=${result.booking.id} requested`)
  return Response.json({ ok: true, status: 'requested', when: result.label }, { status: 201 })
}

/**
 * The page's open times, kept a minute per business on this instance: a
 * public page reloaded (or scraped) must not read the owner's calendar
 * provider on every load. A request re-checks its slot live either way.
 */
const PAGE_SLOTS_TTL_MS = 60_000
const pageSlotsCache = new Map<string, { at: number; value: { slots: OpenSlot[]; timeZone: string; kind: string } }>()

/** The real store behind the page and its route. */
export function supabaseBookingLinkDeps(supabase: SupabaseClient): BookingLinkDeps {
  return {
    profileBySlug: (slug) => getBusinessProfileBySlug(supabase, slug),
    businessPhone: async (workspaceId) => (await activeBusinessNumber(supabase, workspaceId))?.phone ?? null,
    openSlots: async (business) => {
      const cached = pageSlotsCache.get(business.workspaceId)
      if (cached && Date.now() - cached.at < PAGE_SLOTS_TTL_MS) return cached.value
      const found = await findOpenSlots(supabase, business, { days: BOOKING_PAGE_DAYS, max: 40 })
      const value = { slots: found.slots, timeZone: found.timeZone, kind: found.rules.bookingKind }
      if (pageSlotsCache.size > 500) pageSlotsCache.clear()
      pageSlotsCache.set(business.workspaceId, { at: Date.now(), value })
      return value
    },
    countLinkRequestsSince: async (workspaceId, sinceIso, phone) => {
      let query = supabase.from('customer_booking').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('source', 'link').gte('created_at', sinceIso)
      if (phone) query = query.eq('customer_phone', phone)
      const { count, error } = await query
      if (error) throw new Error(`customer_booking count failed: ${error.message}`)
      return count ?? 0
    },
    request: (business, input) => requestBooking(supabase, { business, source: 'link', input }),
  }
}
