/**
 * The customer front door's tables (migration 458), read and written with
 * the service role: a business's profile, its customers' quotes and
 * bookings. Every function takes the workspace and touches only its rows.
 *
 * Since migration 581 the general booking model holds two of them:
 *   - a booking is a meeting_booking (source 'customer'; a booking link's,
 *     source 'link', reads here too, so the business's lists, reminders and
 *     the owner's move and cancel see every outside booking), written with
 *     its claim on the owner's time through book_meeting, the one atomic
 *     path offers and links take: the exclusion constraint keeps the owner
 *     from being booked twice, here or anywhere;
 *   - the profile's booking rules (days, hours, length, lead time, horizon,
 *     the job's word) are its job link's (src/lib/booking-links/), and its
 *     booking slug the workspace's profile handle. A profile without a job
 *     link yet reads its own columns until its first booking change makes
 *     one.
 * customer_booking and the profile's booking columns are no longer written:
 * they are the undo.
 *
 * Server only.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DayRange } from '@/lib/availability/engine'
import { getJobLink, getProfile, getProfileByHandle, insertLink, setProfileHandle, updateLink, type LinkColumns } from '@/lib/booking-links/store'
import type { BookingLink } from '@/lib/booking-links/types'
import { isE164 } from '@/lib/twilio/phone'
import { adoptBusinessEdition } from '@/lib/editions/resolve'
import { bookMeeting, deleteBookingClaims, keepBookingClaims } from '@/lib/time-offers/store'
import type { ParsedQuote } from './intake'
import {
  BOOKING_REQUEST_TTL_MS,
  BOOKING_SOURCES,
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

/** A profile as its own row has it (before 581, and a profile with no job link yet). */
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
    bookingWeekly: null,
    reminders: row.reminders !== false,
  }
}

/** Whether one range a day, the same on every bookable day, says all of `weekly`. Pure. */
function plainWeek(weekly: readonly (readonly DayRange[])[]): { days: number[]; start: string; end: string } | null {
  const ranges = weekly.flatMap((day, weekday) => day.map((r) => ({ weekday, ...r })))
  if (!ranges.length) return null
  const [first] = ranges
  const plain = weekly.every((day) => day.length === 0 || (day.length === 1 && day[0].start === first.start && day[0].end === first.end))
  return plain ? { days: weekly.flatMap((day, weekday) => (day.length ? [weekday] : [])), start: first.start, end: first.end } : null
}

/** A profile with its job link's booking rules and handle (migration 581) laid over its own. Pure. */
export function withJobLink(profile: BusinessProfile, link: BookingLink | null): BusinessProfile {
  if (!link) return profile
  const weekly = link.weeklyHours
  const plain = weekly ? plainWeek(weekly) : null
  const firstRange = weekly?.flat()[0]
  return {
    ...profile,
    bookingDays: weekly ? weekly.flatMap((day, weekday) => (day.length ? [weekday] : [])) : profile.bookingDays,
    bookingStart: plain?.start ?? firstRange?.start ?? profile.bookingStart,
    bookingEnd: plain?.end ?? firstRange?.end ?? profile.bookingEnd,
    bookingWeekly: weekly && !plain ? weekly : null,
    slotMinutes: link.durationMinutes,
    leadHours: Math.round(link.noticeMinutes / 60),
    horizonDays: link.windowDays,
    bookingKind: link.jobKind?.trim() || profile.bookingKind,
    bookingSlug: link.active && link.profileHandle ? link.profileHandle : null,
  }
}

/** The workspace's business profile, or null. Throws on a failed read. */
export async function getBusinessProfile(supabase: SupabaseClient, workspaceId: string): Promise<BusinessProfile | null> {
  const { data, error } = await supabase.from('business_profile').select(PROFILE_SELECT).eq('workspace_id', workspaceId).maybeSingle<ProfileRow>()
  if (error) throw new Error(`business_profile read failed: ${error.message}`)
  if (!data) return null
  return withJobLink(toProfile(data), await getJobLink(supabase, workspaceId))
}

/**
 * The profile behind a public booking link /book/<slug>, or null: the
 * workspace whose handle it is, while its job link is on. Throws on a failed
 * read.
 */
export async function getBusinessProfileBySlug(supabase: SupabaseClient, slug: string): Promise<BusinessProfile | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null
  const handle = await getProfileByHandle(supabase, slug)
  if (!handle || handle.userId) return null
  const profile = await getBusinessProfile(supabase, handle.workspaceId)
  return profile?.bookingSlug === slug ? profile : null
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

const BOOKING_FIELDS = ['bookingDays', 'bookingStart', 'bookingEnd', 'slotMinutes', 'leadHours', 'horizonDays', 'bookingKind', 'bookingSlug'] as const

/** "pickup" as a link's title: "Pickup". Pure. */
const titled = (kind: string) => `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`.slice(0, 120)

/**
 * The job link's columns for a profile with `patch` applied: its booking
 * rules as one link (one range a day, on the booking days), or the reason
 * they don't make one. Pure.
 */
export function jobLinkColumns(current: BusinessProfile, patch: BusinessProfilePatch): { columns: LinkColumns } | { error: string } {
  // A row read back without its defaults (458's) takes them here.
  const days = patch.bookingDays ?? current.bookingDays ?? [1, 2, 3, 4, 5]
  const start = patch.bookingStart ?? (current.bookingStart || '09:00')
  const end = patch.bookingEnd ?? (current.bookingEnd || '17:00')
  const hoursChanged = patch.bookingDays !== undefined || patch.bookingStart !== undefined || patch.bookingEnd !== undefined
  if (hoursChanged && start >= end) return { error: 'booking_start must be before booking_end.' }
  const weekly = hoursChanged || !current.bookingWeekly ? [0, 1, 2, 3, 4, 5, 6].map((d) => (days.includes(d) ? [{ start, end }] : [])) : current.bookingWeekly
  const minutes = patch.slotMinutes ?? (current.slotMinutes || 60)
  const kind = (patch.bookingKind ?? current.bookingKind ?? '').trim() || 'pickup'
  return {
    columns: {
      title: titled(kind),
      job_kind: kind,
      duration_minutes: minutes,
      step_minutes: minutes,
      notice_minutes: (patch.leadHours ?? current.leadHours ?? 24) * 60,
      window_days: patch.horizonDays ?? (current.horizonDays || 14),
      weekly_hours: weekly,
    },
  }
}

/** Write the job link (and its handle) for a profile change that touches booking. Never throws. */
async function writeJobLink(supabase: SupabaseClient, profile: BusinessProfile, patch: BusinessProfilePatch): Promise<ProfileWriteResult | null> {
  const made = jobLinkColumns(profile, patch)
  if ('error' in made) return { ok: false, reason: 'invalid', error: made.error }
  const columns: LinkColumns = { ...made.columns }
  if (patch.bookingSlug !== undefined) {
    if (patch.bookingSlug === null) columns.active = false
    else {
      const handle = await setProfileHandle(supabase, { workspaceId: profile.workspaceId, userId: null }, patch.bookingSlug)
      if (!handle.ok) return handle.reason === 'taken' ? { ok: false, reason: 'slug_taken' } : { ok: false, reason: handle.reason, error: handle.error }
      columns.profile_id = handle.profile.id
      columns.active = true
    }
  }
  try {
    const link = await getJobLink(supabase, profile.workspaceId)
    if (link) {
      const written = await updateLink(supabase, link, columns)
      return written.ok ? null : { ok: false, reason: written.reason === 'slug_taken' ? 'failed' : written.reason, error: written.error }
    }
    const handle = columns.profile_id === undefined ? await getProfile(supabase, { workspaceId: profile.workspaceId, userId: null }) : null
    const written = await insertLink(
      supabase,
      {
        workspace_id: profile.workspaceId,
        owner_user_id: profile.ownerUserId,
        profile_id: handle?.id ?? null,
        slug: 'book',
        purpose: 'job',
        title: columns.title ?? titled(profile.bookingKind),
        questions: [{ id: 'address', label: 'Address', required: false, kind: 'text' }],
        video: false,
        ask_first: true,
        host_mode: 'one',
        active: !!(handle ?? columns.profile_id),
        ...columns,
      },
      [{ userId: profile.ownerUserId, position: 0 }],
    )
    return written.ok ? null : { ok: false, reason: written.reason === 'slug_taken' ? 'failed' : written.reason, error: written.error }
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Create or change the workspace's profile. A new one needs a business name;
 * the owner is the one who first wrote it. Its own fields go on its row (the
 * table's checks hold the shapes: a bad one is `invalid`, its message kept
 * for the agent); its booking rules and slug go on its job link and handle
 * (see the header). A new profile puts the workspace on the
 * service-business edition, so the app and the agent say its words
 * (adoptBusinessEdition: never over an edition a person chose).
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
  if (patch.reminders !== undefined) row.reminders = patch.reminders
  const booking: BusinessProfilePatch = {}
  for (const key of BOOKING_FIELDS) if (patch[key] !== undefined) (booking as Record<string, unknown>)[key] = key === 'bookingSlug' ? (patch.bookingSlug?.trim().toLowerCase() || null) : key === 'bookingDays' ? [...new Set(patch.bookingDays)].sort() : patch[key]

  const existing = await getBusinessProfile(supabase, args.workspaceId)
  if (!existing && !row.business_name) return { ok: false, reason: 'invalid', error: 'A new business profile needs the business name.' }
  const write = existing
    ? supabase.from('business_profile').update(row).eq('workspace_id', args.workspaceId)
    : supabase.from('business_profile').insert({ workspace_id: args.workspaceId, owner_user_id: args.ownerUserId, ...row })
  const { data, error } = await write.select(PROFILE_SELECT).single<ProfileRow>()
  if (error) {
    if (error.code === '23514') return { ok: false, reason: 'invalid', error: error.message }
    return { ok: false, reason: 'failed', error: error.message }
  }
  if (!existing) await adoptBusinessEdition(supabase, args.workspaceId, 'profile')
  if (Object.keys(booking).length) {
    const failed = await writeJobLink(supabase, existing ?? toProfile(data), booking)
    if (failed) return failed
  }
  const profile = await getBusinessProfile(supabase, args.workspaceId)
  return profile ? { ok: true, profile } : { ok: false, reason: 'failed', error: 'The profile could not be read back.' }
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
    const { data: profile } = await supabase.from('business_profile').select('business_name').eq('workspace_id', workspaceId).maybeSingle<{ business_name: string | null }>()
    if (profile?.business_name) return profile.business_name
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
//
// meeting_booking rows (migration 581) as the customer flow reads them: a
// customer's job (source 'customer') or a booking link's (source 'link').

/** The meeting_booking columns a customer booking reads. */
export const BOOKING_SELECT =
  'id, workspace_id, host_user_id, source, channel, link_id, quote_id, contact_id, guest_id, kind, title, starts_at, ends_at, guest_name, guest_phone, address, guest_note, state, approval_id, calendar_event_id, calendar_account_id, customer_confirmed_at, created_at'

/** The bookings the customer flow reads: customers' jobs, and bookings from the workspace's links. */
export const CUSTOMER_FLOW_SOURCES = ['customer', 'link'] as const

/** A held hold's slack over the owner's approval: the approval settles a request before its claim lapses. */
const REQUEST_HOLD_GRACE_MS = 15 * 60_000

export interface BookingRow {
  id: string
  workspace_id: string
  host_user_id: string
  source: string
  channel: string | null
  link_id?: string | null
  quote_id: string | null
  contact_id: string | null
  guest_id: string | null
  kind: string | null
  title: string
  starts_at: string
  ends_at: string
  guest_name: string
  guest_phone: string | null
  address: string | null
  guest_note: string | null
  state: string
  approval_id: string | null
  calendar_event_id: string | null
  calendar_account_id?: string | null
  customer_confirmed_at?: string | null
  created_at: string
}

/** A meeting_booking's state as a customer booking reads it: one being written is not booked yet, a failed one is off. Pure. */
function customerState(state: string): BookingState {
  if (state === 'booking') return 'requested'
  if (state === 'requested' || state === 'confirmed' || state === 'declined' || state === 'expired' || state === 'cancelled') return state
  return 'cancelled'
}

export function toBooking(row: BookingRow): CustomerBooking {
  const origin = row.source === 'link' ? 'link' : 'customer'
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.host_user_id,
    origin,
    linkId: row.link_id ?? null,
    quoteId: row.quote_id,
    contactId: row.contact_id,
    guestId: row.guest_id,
    // A link's booking came by its page.
    source: (BOOKING_SOURCES as readonly string[]).includes(row.channel ?? '') ? (row.channel as BookingSource) : origin === 'link' ? 'link' : 'owner',
    // A link's booking has no job word: its title says what it is.
    kind: row.kind?.trim() || row.title,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    customerName: row.guest_name,
    customerPhone: row.guest_phone,
    address: row.address,
    note: row.guest_note,
    state: customerState(row.state),
    approvalId: row.approval_id,
    calendarEventId: row.calendar_event_id,
    calendarAccountId: row.calendar_account_id ?? null,
    customerConfirmedAt: row.customer_confirmed_at ? new Date(row.customer_confirmed_at).toISOString() : null,
    createdAt: row.created_at,
  }
}

/** One booking of the workspace's (a customer's, or a link's), or null. Throws on a failed read. */
export async function getBooking(supabase: SupabaseClient, workspaceId: string, bookingId: string): Promise<CustomerBooking | null> {
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return null
  const { data, error } = await supabase
    .from('meeting_booking')
    .select(BOOKING_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('id', bookingId)
    .in('source', [...CUSTOMER_FLOW_SOURCES])
    .maybeSingle<BookingRow>()
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return data ? toBooking(data) : null
}

/** The workspace's live bookings (requested or confirmed) in [fromIso, toIso). Throws on a failed read. */
export async function liveBookingsBetween(supabase: SupabaseClient, workspaceId: string, fromIso: string, toIso: string): Promise<CustomerBooking[]> {
  const { data, error } = await supabase
    .from('meeting_booking')
    .select(BOOKING_SELECT)
    .eq('workspace_id', workspaceId)
    .in('source', [...CUSTOMER_FLOW_SOURCES])
    .in('state', ['requested', 'booking', 'confirmed'])
    .lt('starts_at', toIso)
    .gt('ends_at', fromIso)
    .order('starts_at', { ascending: true })
    .limit(500)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return ((data ?? []) as BookingRow[]).map(toBooking)
}

/** The workspace's bookings from `fromIso` on, soonest first, optionally by state. Throws on a failed read. */
export async function listBookings(
  supabase: SupabaseClient,
  workspaceId: string,
  filter: { fromIso?: string; state?: BookingState; guestId?: string; limit?: number } = {},
): Promise<CustomerBooking[]> {
  let query = supabase.from('meeting_booking').select(BOOKING_SELECT).eq('workspace_id', workspaceId).in('source', [...CUSTOMER_FLOW_SOURCES])
  if (filter.fromIso) query = query.gte('starts_at', filter.fromIso)
  if (filter.state) query = filter.state === 'requested' ? query.in('state', ['requested', 'booking']) : query.eq('state', filter.state)
  if (filter.guestId) query = query.eq('guest_id', filter.guestId)
  const { data, error } = await query.order('starts_at', { ascending: true }).limit(Math.max(1, Math.min(filter.limit ?? 20, 100)))
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
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
  /** The business's zone, for the words about it. */
  timeZone?: string | null
}

export type InsertBookingResult = { ok: true; booking: CustomerBooking } | { ok: false; reason: 'taken' | 'failed'; error?: string }

/**
 * Hold a slot (state requested): the booking and its claim on the owner's
 * time in one transaction (book_meeting), the claim held as long as the
 * owner's approval waits. A time the owner's time is already claimed for
 * (another booking, an offer's hold, a link's meeting) is `taken`. Never
 * throws.
 */
export async function insertBooking(supabase: SupabaseClient, booking: NewBooking): Promise<InsertBookingResult> {
  try {
    const id = randomUUID()
    const kind = booking.kind.trim() || 'pickup'
    const outcome = await bookMeeting(
      supabase,
      {
        id,
        workspace_id: booking.workspaceId,
        host_user_id: booking.ownerUserId,
        host_name: (await businessName(supabase, booking.workspaceId)).slice(0, 120),
        source: 'customer',
        channel: booking.source,
        quote_id: booking.quoteId ?? null,
        contact_id: booking.contactId ?? null,
        guest_id: booking.guestId ?? null,
        kind,
        title: `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${booking.customerName}`.slice(0, 120),
        guest_name: booking.customerName,
        guest_phone: booking.customerPhone ?? null,
        address: booking.address ?? null,
        guest_note: booking.note ?? null,
        starts_at: booking.startsAt,
        ends_at: booking.endsAt,
        state: 'requested',
        video: false,
        // A customer's job has no manage page: never the hash of any token.
        manage_token_hash: `none:${id}`,
        host_time_zone: booking.timeZone ?? null,
      },
      new Date(Date.now() + BOOKING_REQUEST_TTL_MS + REQUEST_HOLD_GRACE_MS).toISOString(),
    )
    if (outcome.status === 'taken') return { ok: false, reason: 'taken' }
    if (outcome.status !== 'booked') return { ok: false, reason: 'failed', error: outcome.status }
    const written = await getBooking(supabase, booking.workspaceId, id)
    return written ? { ok: true, booking: written } : { ok: false, reason: 'failed', error: 'the booking could not be read back' }
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Leaving these lets the owner's time go: the booking's claims are deleted. */
const RELEASING: readonly BookingState[] = ['declined', 'expired', 'cancelled']

/**
 * Move a booking from one state to another, fenced on the state it must be
 * in (a retried yes or no changes nothing twice). A booking that leaves for
 * declined, expired or cancelled lets its time go (its claims deleted). The
 * moved booking, or null when it wasn't in `from`. Throws on a failed write.
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
  if (args.to === 'confirmed') row.confirmed_at = now
  if (args.to === 'cancelled') row.cancelled_at = now
  if (extra.approvalId !== undefined) row.approval_id = extra.approvalId
  if (extra.calendarEventId !== undefined) row.calendar_event_id = extra.calendarEventId
  const { data, error } = await supabase
    .from('meeting_booking')
    .update(row)
    .eq('workspace_id', args.workspaceId)
    .eq('id', args.bookingId)
    .in('source', [...CUSTOMER_FLOW_SOURCES])
    .in('state', from)
    .select(BOOKING_SELECT)
    .maybeSingle<BookingRow>()
  if (error) throw new Error(`meeting_booking update failed: ${error.message}`)
  if (!data) return null
  if (RELEASING.includes(args.to)) await deleteBookingClaims(supabase, data.id)
  return toBooking(data)
}

/**
 * The owner's yes keeps a requested booking's time for good: its claim loses
 * its hold's expiry (taken again when it had lapsed). `conflict` when someone
 * else's claim has the time now. Never throws.
 */
export async function keepBookingTime(supabase: SupabaseClient, booking: Pick<CustomerBooking, 'id' | 'workspaceId' | 'ownerUserId' | 'startsAt' | 'endsAt'>): Promise<{ ok: true } | { ok: false; conflict: boolean }> {
  try {
    const kept = await keepBookingClaims(supabase, { id: booking.id, workspaceId: booking.workspaceId, hostUserId: booking.ownerUserId, otherHostIds: [], startsAt: booking.startsAt, endsAt: booking.endsAt })
    return kept.ok ? { ok: true } : { ok: false, conflict: kept.conflict }
  } catch {
    return { ok: false, conflict: false }
  }
}

/** Set the approval a requested booking waits on. Throws on a failed write. */
export async function setBookingApproval(supabase: SupabaseClient, workspaceId: string, bookingId: string, approvalId: string): Promise<void> {
  const { error } = await supabase.from('meeting_booking').update({ approval_id: approvalId, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', bookingId)
  if (error) throw new Error(`meeting_booking update failed: ${error.message}`)
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
  let query = supabase
    .from('meeting_booking')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source', 'customer')
    .eq('state', 'requested')
    .gte('created_at', sinceIso)
  if (who) {
    const ors: string[] = []
    if (who.phone && isE164(who.phone)) ors.push(`guest_phone.eq.${who.phone}`)
    if (who.guestId && /^[0-9a-f-]{36}$/i.test(who.guestId)) ors.push(`guest_id.eq.${who.guestId}`)
    if (!ors.length) return 0
    query = query.or(ors.join(','))
  }
  const { count, error } = await query
  if (error) throw new Error(`meeting_booking count failed: ${error.message}`)
  return count ?? 0
}

/**
 * Requested bookings whose owner never answered (their approval lapsed after
 * `olderThanIso`) leave the slot: marked expired, their claims gone. Best
 * effort, never throws.
 */
export async function expireStaleBookings(supabase: SupabaseClient, workspaceId: string, olderThanIso: string): Promise<void> {
  try {
    const nowIso = new Date().toISOString()
    const { data } = await supabase
      .from('meeting_booking')
      .update({ state: 'expired', decided_at: nowIso, updated_at: nowIso })
      .eq('workspace_id', workspaceId)
      .eq('source', 'customer')
      .eq('state', 'requested')
      .lt('created_at', olderThanIso)
      .select('id')
    for (const row of (data as Array<{ id: string }> | null) ?? []) await deleteBookingClaims(supabase, row.id)
  } catch {
    // Best effort: the slot finder skips stale requests on its own.
  }
}
