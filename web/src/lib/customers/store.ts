/**
 * The customer front door's tables (migration 458), read and written with
 * the service role: a business's profile, its customers' quotes and
 * bookings. Every function takes the workspace and touches only its rows.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isE164 } from '@/lib/twilio/phone'
import { adoptBusinessEdition } from '@/lib/editions/resolve'
import type { ParsedQuote } from './intake'
import {
  BOOKING_SOURCES,
  BOOKING_STATES,
  QUOTE_SOURCES,
  QUOTE_STATUSES,
  type BookingSource,
  type BookingState,
  type BusinessProfile,
  type CustomerBooking,
  type CustomerQuote,
  type QuoteItem,
  type QuoteSource,
  type QuoteStatus,
} from './types'

// ── Business profile ────────────────────────────────────────────────────────

const PROFILE_SELECT =
  'workspace_id, owner_user_id, business_name, customer_facts, time_zone, booking_days, booking_start, booking_end, slot_minutes, lead_hours, horizon_days, booking_kind, booking_slug, reminders'

interface ProfileRow {
  workspace_id: string
  owner_user_id: string
  business_name: string
  customer_facts: string | null
  time_zone: string | null
  booking_days: number[] | null
  booking_start: string
  booking_end: string
  slot_minutes: number
  lead_hours: number
  horizon_days: number
  booking_kind: string | null
  booking_slug: string | null
  reminders?: boolean | null
}

export function toProfile(row: ProfileRow): BusinessProfile {
  return {
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    businessName: row.business_name,
    customerFacts: row.customer_facts,
    timeZone: row.time_zone,
    bookingDays: (Array.isArray(row.booking_days) ? row.booking_days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    bookingStart: row.booking_start,
    bookingEnd: row.booking_end,
    slotMinutes: row.slot_minutes,
    leadHours: row.lead_hours,
    horizonDays: row.horizon_days,
    bookingKind: row.booking_kind?.trim() || 'pickup',
    bookingSlug: row.booking_slug,
    reminders: row.reminders !== false,
  }
}

/** The workspace's business profile, or null. Throws on a failed read. */
export async function getBusinessProfile(supabase: SupabaseClient, workspaceId: string): Promise<BusinessProfile | null> {
  const { data, error } = await supabase.from('business_profile').select(PROFILE_SELECT).eq('workspace_id', workspaceId).maybeSingle<ProfileRow>()
  if (error) throw new Error(`business_profile read failed: ${error.message}`)
  return data ? toProfile(data) : null
}

/** The profile behind a public booking link, or null. Throws on a failed read. */
export async function getBusinessProfileBySlug(supabase: SupabaseClient, slug: string): Promise<BusinessProfile | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null
  const { data, error } = await supabase.from('business_profile').select(PROFILE_SELECT).eq('booking_slug', slug).maybeSingle<ProfileRow>()
  if (error) throw new Error(`business_profile read failed: ${error.message}`)
  return data ? toProfile(data) : null
}

export interface BusinessProfilePatch {
  businessName?: string
  customerFacts?: string | null
  timeZone?: string | null
  bookingDays?: number[]
  bookingStart?: string
  bookingEnd?: string
  slotMinutes?: number
  leadHours?: number
  horizonDays?: number
  bookingKind?: string
  bookingSlug?: string | null
  reminders?: boolean
}

export type ProfileWriteResult = { ok: true; profile: BusinessProfile } | { ok: false; reason: 'slug_taken' | 'invalid' | 'failed'; error?: string }

/**
 * Create or change the workspace's profile. A new one needs a business name;
 * the owner is the one who first wrote it. The table's checks hold the
 * shapes (a bad one is `invalid`, its message kept for the agent). A new
 * profile puts the workspace on the service-business edition, so the app and
 * the agent say its words (adoptBusinessEdition: never over an edition a
 * person chose).
 */
export async function upsertBusinessProfile(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string },
  patch: BusinessProfilePatch,
): Promise<ProfileWriteResult> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.businessName !== undefined) row.business_name = patch.businessName.trim()
  if (patch.customerFacts !== undefined) row.customer_facts = patch.customerFacts?.trim() || null
  if (patch.timeZone !== undefined) row.time_zone = patch.timeZone?.trim() || null
  if (patch.bookingDays !== undefined) row.booking_days = [...new Set(patch.bookingDays)].sort()
  if (patch.bookingStart !== undefined) row.booking_start = patch.bookingStart
  if (patch.bookingEnd !== undefined) row.booking_end = patch.bookingEnd
  if (patch.slotMinutes !== undefined) row.slot_minutes = patch.slotMinutes
  if (patch.leadHours !== undefined) row.lead_hours = patch.leadHours
  if (patch.horizonDays !== undefined) row.horizon_days = patch.horizonDays
  if (patch.bookingKind !== undefined) row.booking_kind = patch.bookingKind.trim()
  if (patch.bookingSlug !== undefined) row.booking_slug = patch.bookingSlug?.trim().toLowerCase() || null
  if (patch.reminders !== undefined) row.reminders = patch.reminders

  const existing = await getBusinessProfile(supabase, args.workspaceId)
  if (!existing && !row.business_name) return { ok: false, reason: 'invalid', error: 'A new business profile needs the business name.' }
  const write = existing
    ? supabase.from('business_profile').update(row).eq('workspace_id', args.workspaceId)
    : supabase.from('business_profile').insert({ workspace_id: args.workspaceId, owner_user_id: args.ownerUserId, ...row })
  const { data, error } = await write.select(PROFILE_SELECT).single<ProfileRow>()
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'slug_taken' }
    if (error.code === '23514') return { ok: false, reason: 'invalid', error: error.message }
    return { ok: false, reason: 'failed', error: error.message }
  }
  if (!existing) await adoptBusinessEdition(supabase, args.workspaceId, 'profile')
  return { ok: true, profile: toProfile(data) }
}

/**
 * Who a business's customers reach: its profile's owner, else the
 * workspace's owner member. Null when neither is found. Throws on a failed read.
 */
export async function businessOwnerUserId(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  const profile = await getBusinessProfile(supabase, workspaceId)
  if (profile) return profile.ownerUserId
  const { data, error } = await supabase
    .from('member')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ user_id: string }>()
  if (error) throw new Error(`member read failed: ${error.message}`)
  return data?.user_id ?? null
}

/** The business's name as customers read it: its profile's, else the workspace's. Never throws. */
export async function businessName(supabase: SupabaseClient, workspaceId: string): Promise<string> {
  try {
    const profile = await getBusinessProfile(supabase, workspaceId)
    if (profile?.businessName) return profile.businessName
    const { data } = await supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle<{ name: string | null }>()
    return data?.name?.trim() || 'the business'
  } catch {
    return 'the business'
  }
}

// ── Quotes ──────────────────────────────────────────────────────────────────

export const QUOTE_SELECT =
  'id, workspace_id, contact_id, source, external_id, status, customer_name, customer_email, customer_phone, address, service, items, total_cents, currency, requested_dates, notes, created_at, updated_at'

interface QuoteRow {
  id: string
  workspace_id: string
  contact_id: string | null
  source: string
  external_id: string | null
  status: string
  customer_name: string | null
  customer_email: string | null
  customer_phone: string | null
  address: string | null
  service: string | null
  items: unknown
  total_cents: number | null
  currency: string | null
  requested_dates: string[] | null
  notes: string | null
  created_at: string
  updated_at: string
}

export function toQuote(row: QuoteRow): CustomerQuote {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contactId: row.contact_id,
    source: (QUOTE_SOURCES as readonly string[]).includes(row.source) ? (row.source as QuoteSource) : 'owner',
    externalId: row.external_id,
    status: (QUOTE_STATUSES as readonly string[]).includes(row.status) ? (row.status as QuoteStatus) : 'new',
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    address: row.address,
    service: row.service,
    items: Array.isArray(row.items) ? (row.items.filter((i) => i && typeof i === 'object' && typeof (i as QuoteItem).description === 'string') as QuoteItem[]) : [],
    totalCents: row.total_cents,
    currency: row.currency || 'usd',
    requestedDates: Array.isArray(row.requested_dates) ? row.requested_dates : [],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type InsertQuoteResult = { ok: true; quote: CustomerQuote; created: boolean } | { ok: false; error: string }

/**
 * Store one quote. A form's own submission id stores it once: a re-post
 * from the same customer (the same email or number) returns the first
 * (`created: false`). The same id from someone else is a new quote, stored
 * without the id: a guessed or pre-posted id never swallows a real
 * customer's quote, nor hands back another's. Never throws.
 */
export async function insertQuote(
  supabase: SupabaseClient,
  args: { workspaceId: string; source: QuoteSource; contactId: string | null },
  quote: ParsedQuote,
): Promise<InsertQuoteResult> {
  const findExisting = async () => {
    if (!quote.externalId) return null
    const { data } = await supabase.from('customer_quote').select(QUOTE_SELECT).eq('workspace_id', args.workspaceId).eq('external_id', quote.externalId).maybeSingle<QuoteRow>()
    return data ? toQuote(data) : null
  }
  const sameCustomer = (q: CustomerQuote) =>
    (!!quote.customerEmail && q.customerEmail === quote.customerEmail) || (!!quote.customerPhone && q.customerPhone === quote.customerPhone)
  try {
    const existing = await findExisting()
    if (existing && sameCustomer(existing)) return { ok: true, quote: existing, created: false }
    // Someone else's id: a new quote, without it.
    const externalId = existing ? null : quote.externalId
    const { data, error } = await supabase
      .from('customer_quote')
      .insert({
        workspace_id: args.workspaceId,
        contact_id: args.contactId,
        source: args.source,
        status: 'new',
        external_id: externalId,
        customer_name: quote.customerName,
        customer_email: quote.customerEmail,
        customer_phone: quote.customerPhone,
        address: quote.address,
        service: quote.service,
        items: quote.items,
        total_cents: quote.totalCents,
        requested_dates: quote.requestedDates,
        notes: quote.notes,
        raw: quote.raw,
      })
      .select(QUOTE_SELECT)
      .single<QuoteRow>()
    if (data) return { ok: true, quote: toQuote(data), created: true }
    // Two posts of one submission raced: the other one stored it.
    if (error?.code === '23505' && externalId) {
      const raced = await findExisting()
      if (raced && sameCustomer(raced)) return { ok: true, quote: raced, created: false }
    }
    return { ok: false, error: error?.message ?? 'no row' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** One quote of the workspace's, or null. Throws on a failed read. */
export async function getQuote(supabase: SupabaseClient, workspaceId: string, quoteId: string): Promise<CustomerQuote | null> {
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return null
  const { data, error } = await supabase.from('customer_quote').select(QUOTE_SELECT).eq('workspace_id', workspaceId).eq('id', quoteId).maybeSingle<QuoteRow>()
  if (error) throw new Error(`customer_quote read failed: ${error.message}`)
  return data ? toQuote(data) : null
}

/** The workspace's quotes, newest first, optionally by status, contact or since. Throws on a failed read. */
export async function listQuotes(
  supabase: SupabaseClient,
  workspaceId: string,
  filter: { status?: QuoteStatus; contactId?: string; sinceIso?: string; limit?: number } = {},
): Promise<CustomerQuote[]> {
  let query = supabase.from('customer_quote').select(QUOTE_SELECT).eq('workspace_id', workspaceId)
  if (filter.status) query = query.eq('status', filter.status)
  if (filter.contactId) query = query.eq('contact_id', filter.contactId)
  if (filter.sinceIso) query = query.gte('created_at', filter.sinceIso)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(Math.max(1, Math.min(filter.limit ?? 20, 100)))
  if (error) throw new Error(`customer_quote read failed: ${error.message}`)
  return ((data ?? []) as QuoteRow[]).map(toQuote)
}

/**
 * One customer's own quotes: the ones sent from the number they are texting
 * (or calling) from, and nothing else. Never by their CRM contact: a contact
 * is matched on what an unverified form said, so a stranger could post
 * someone's email with their own number and read that person's quotes. Never
 * anyone else's. Throws on a failed read.
 */
export async function quotesForCustomer(supabase: SupabaseClient, workspaceId: string, phone: string | null, limit = 10): Promise<CustomerQuote[]> {
  if (!phone || !isE164(phone)) return []
  const { data, error } = await supabase
    .from('customer_quote')
    .select(QUOTE_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('customer_phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`customer_quote read failed: ${error.message}`)
  return ((data ?? []) as QuoteRow[]).map(toQuote)
}

export interface QuotePatch {
  status?: QuoteStatus
  totalCents?: number | null
  notes?: string | null
  items?: QuoteItem[]
}

/** Change one quote of the workspace's. Null when it isn't theirs. Throws on a failed write. */
export async function updateQuote(supabase: SupabaseClient, workspaceId: string, quoteId: string, patch: QuotePatch): Promise<CustomerQuote | null> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.status !== undefined) row.status = patch.status
  if (patch.totalCents !== undefined) row.total_cents = patch.totalCents
  if (patch.notes !== undefined) row.notes = patch.notes
  if (patch.items !== undefined) row.items = patch.items
  const { data, error } = await supabase.from('customer_quote').update(row).eq('workspace_id', workspaceId).eq('id', quoteId).select(QUOTE_SELECT).maybeSingle<QuoteRow>()
  if (error) throw new Error(`customer_quote update failed: ${error.message}`)
  return data ? toQuote(data) : null
}

// ── Bookings ────────────────────────────────────────────────────────────────

export const BOOKING_SELECT =
  'id, workspace_id, owner_user_id, quote_id, contact_id, guest_id, source, kind, starts_at, ends_at, customer_name, customer_phone, address, note, state, approval_id, calendar_event_id, customer_confirmed_at, created_at'

interface BookingRow {
  id: string
  workspace_id: string
  owner_user_id: string
  quote_id: string | null
  contact_id: string | null
  guest_id: string | null
  source: string
  kind: string
  starts_at: string
  ends_at: string
  customer_name: string
  customer_phone: string | null
  address: string | null
  note: string | null
  state: string
  approval_id: string | null
  calendar_event_id: string | null
  customer_confirmed_at?: string | null
  created_at: string
}

export function toBooking(row: BookingRow): CustomerBooking {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    quoteId: row.quote_id,
    contactId: row.contact_id,
    guestId: row.guest_id,
    source: (BOOKING_SOURCES as readonly string[]).includes(row.source) ? (row.source as BookingSource) : 'owner',
    kind: row.kind,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    address: row.address,
    note: row.note,
    state: (BOOKING_STATES as readonly string[]).includes(row.state) ? (row.state as BookingState) : 'cancelled',
    approvalId: row.approval_id,
    calendarEventId: row.calendar_event_id,
    customerConfirmedAt: row.customer_confirmed_at ? new Date(row.customer_confirmed_at).toISOString() : null,
    createdAt: row.created_at,
  }
}

/** One booking of the workspace's, or null. Throws on a failed read. */
export async function getBooking(supabase: SupabaseClient, workspaceId: string, bookingId: string): Promise<CustomerBooking | null> {
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return null
  const { data, error } = await supabase.from('customer_booking').select(BOOKING_SELECT).eq('workspace_id', workspaceId).eq('id', bookingId).maybeSingle<BookingRow>()
  if (error) throw new Error(`customer_booking read failed: ${error.message}`)
  return data ? toBooking(data) : null
}

/** The workspace's live bookings (requested or confirmed) in [fromIso, toIso). Throws on a failed read. */
export async function liveBookingsBetween(supabase: SupabaseClient, workspaceId: string, fromIso: string, toIso: string): Promise<CustomerBooking[]> {
  const { data, error } = await supabase
    .from('customer_booking')
    .select(BOOKING_SELECT)
    .eq('workspace_id', workspaceId)
    .in('state', ['requested', 'confirmed'])
    .lt('starts_at', toIso)
    .gt('ends_at', fromIso)
    .order('starts_at', { ascending: true })
    .limit(500)
  if (error) throw new Error(`customer_booking read failed: ${error.message}`)
  return ((data ?? []) as BookingRow[]).map(toBooking)
}

/** The workspace's bookings from `fromIso` on, soonest first, optionally by state. Throws on a failed read. */
export async function listBookings(
  supabase: SupabaseClient,
  workspaceId: string,
  filter: { fromIso?: string; state?: BookingState; guestId?: string; limit?: number } = {},
): Promise<CustomerBooking[]> {
  let query = supabase.from('customer_booking').select(BOOKING_SELECT).eq('workspace_id', workspaceId)
  if (filter.fromIso) query = query.gte('starts_at', filter.fromIso)
  if (filter.state) query = query.eq('state', filter.state)
  if (filter.guestId) query = query.eq('guest_id', filter.guestId)
  const { data, error } = await query.order('starts_at', { ascending: true }).limit(Math.max(1, Math.min(filter.limit ?? 20, 100)))
  if (error) throw new Error(`customer_booking read failed: ${error.message}`)
  return ((data ?? []) as BookingRow[]).map(toBooking)
}

export interface NewBooking {
  workspaceId: string
  ownerUserId: string
  quoteId?: string | null
  contactId?: string | null
  guestId?: string | null
  source: BookingSource
  kind: string
  startsAt: string
  endsAt: string
  customerName: string
  customerPhone?: string | null
  address?: string | null
  note?: string | null
}

export type InsertBookingResult = { ok: true; booking: CustomerBooking } | { ok: false; reason: 'taken' | 'failed'; error?: string }

/** Hold a slot (state requested). Another live booking at that start is `taken`. Never throws. */
export async function insertBooking(supabase: SupabaseClient, booking: NewBooking): Promise<InsertBookingResult> {
  try {
    const { data, error } = await supabase
      .from('customer_booking')
      .insert({
        workspace_id: booking.workspaceId,
        owner_user_id: booking.ownerUserId,
        quote_id: booking.quoteId ?? null,
        contact_id: booking.contactId ?? null,
        guest_id: booking.guestId ?? null,
        source: booking.source,
        state: 'requested',
        kind: booking.kind,
        starts_at: booking.startsAt,
        ends_at: booking.endsAt,
        customer_name: booking.customerName,
        customer_phone: booking.customerPhone ?? null,
        address: booking.address ?? null,
        note: booking.note ?? null,
      })
      .select(BOOKING_SELECT)
      .single<BookingRow>()
    if (data) return { ok: true, booking: toBooking(data) }
    if (error?.code === '23505') return { ok: false, reason: 'taken' }
    return { ok: false, reason: 'failed', error: error?.message }
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Move a booking from one state to another, fenced on the state it must be
 * in (a retried yes or no changes nothing twice). The moved booking, or null
 * when it wasn't in `from`. Throws on a failed write.
 */
export async function moveBooking(
  supabase: SupabaseClient,
  args: { workspaceId: string; bookingId: string; from: BookingState | readonly BookingState[]; to: BookingState },
  extra: { approvalId?: string | null; calendarEventId?: string | null } = {},
): Promise<CustomerBooking | null> {
  const from = Array.isArray(args.from) ? [...args.from] : [args.from as BookingState]
  const now = new Date().toISOString()
  const row: Record<string, unknown> = { state: args.to, updated_at: now }
  if (args.to !== 'requested') row.decided_at = now
  if (extra.approvalId !== undefined) row.approval_id = extra.approvalId
  if (extra.calendarEventId !== undefined) row.calendar_event_id = extra.calendarEventId
  const { data, error } = await supabase
    .from('customer_booking')
    .update(row)
    .eq('workspace_id', args.workspaceId)
    .eq('id', args.bookingId)
    .in('state', from)
    .select(BOOKING_SELECT)
    .maybeSingle<BookingRow>()
  if (error) throw new Error(`customer_booking update failed: ${error.message}`)
  return data ? toBooking(data) : null
}

/** Set the approval a requested booking waits on. Throws on a failed write. */
export async function setBookingApproval(supabase: SupabaseClient, workspaceId: string, bookingId: string, approvalId: string): Promise<void> {
  const { error } = await supabase.from('customer_booking').update({ approval_id: approvalId, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', bookingId)
  if (error) throw new Error(`customer_booking update failed: ${error.message}`)
}

/**
 * Requests still waiting on the owner: requested since `sinceIso` (an older
 * one has lapsed), for the business, or for one customer (their number, or
 * their customer row). Throws on a failed read.
 */
export async function countLiveRequests(
  supabase: SupabaseClient,
  workspaceId: string,
  sinceIso: string,
  who?: { phone: string | null; guestId: string | null },
): Promise<number> {
  let query = supabase.from('customer_booking').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('state', 'requested').gte('created_at', sinceIso)
  if (who) {
    const ors: string[] = []
    if (who.phone && isE164(who.phone)) ors.push(`customer_phone.eq.${who.phone}`)
    if (who.guestId && /^[0-9a-f-]{36}$/i.test(who.guestId)) ors.push(`guest_id.eq.${who.guestId}`)
    if (!ors.length) return 0
    query = query.or(ors.join(','))
  }
  const { count, error } = await query
  if (error) throw new Error(`customer_booking count failed: ${error.message}`)
  return count ?? 0
}

/**
 * Requested bookings whose owner never answered (their approval lapsed after
 * `olderThanIso`) leave the slot: marked expired. Best effort, never throws.
 */
export async function expireStaleBookings(supabase: SupabaseClient, workspaceId: string, olderThanIso: string): Promise<void> {
  try {
    await supabase
      .from('customer_booking')
      .update({ state: 'expired', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('state', 'requested')
      .lt('created_at', olderThanIso)
  } catch {
    // Best effort: the slot finder skips stale requests on its own.
  }
}
