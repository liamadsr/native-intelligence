/**
 * Rows of migration 554: time_offer, time_offer_slot, meeting_booking,
 * host_time_claim, time_offer_failure, and the pick's one transaction
 * (book_time_offer_slot); and 581's general booking write (book_meeting:
 * a booking and its hosts' claims at once), which booking links and
 * customers' jobs book through. Every write is the service role's; every read here
 * is fenced by id, token hash, workspace or host. Throws on a failed read or
 * write, except where a function says what it answers.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingAnswer, MeetingBooking, MeetingBookingSource, MeetingBookingState, OfferMode, OfferSlot, OfferState, SendBy, TimeOffer } from './types'

const OFFER_COLUMNS =
  'id, workspace_id, host_user_id, created_by, host_name, recipient_name, recipient_email, recipient_phone, contact_id, title, duration_minutes, video, location, message, time_zone, state, sent_via, card_hash, recipients_shown, approval_id, booking_id, expires_at, created_at, mode, co_host_ids'
const SLOT_COLUMNS = 'id, offer_id, starts_at, ends_at, state'
export const BOOKING_COLUMNS =
  'id, workspace_id, host_user_id, host_name, source, offer_id, link_id, guest_name, guest_email, guest_phone, guest_time_zone, guest_note, contact_id, title, starts_at, ends_at, state, video, location, calendar_account_id, calendar_id, calendar_event_id, conference_url, attempts, reschedule_count, last_error, cancelled_by, answers, other_host_ids, host_time_zone, created_at, updated_at'

interface OfferRow {
  id: string
  workspace_id: string
  host_user_id: string
  created_by: string | null
  host_name: string
  recipient_name: string
  recipient_email: string | null
  recipient_phone: string | null
  contact_id: string | null
  title: string
  duration_minutes: number
  video: boolean
  location: string | null
  message: string | null
  time_zone: string
  state: OfferState
  sent_via: SendBy | null
  card_hash: string | null
  recipients_shown?: boolean | null
  approval_id: string | null
  booking_id: string | null
  expires_at: string
  created_at: string
  /** Migration 583: read as a pick and no co-hosts when missing. */
  mode?: OfferMode | null
  co_host_ids?: string[] | null
}

interface SlotRow {
  id: string
  offer_id: string
  starts_at: string
  ends_at: string
  state: OfferSlot['state']
}

export interface BookingRow {
  id: string
  workspace_id: string
  host_user_id: string
  host_name: string
  source: MeetingBooking['source']
  offer_id: string | null
  link_id?: string | null
  guest_name: string
  guest_email: string | null
  guest_phone: string | null
  guest_time_zone: string | null
  guest_note: string | null
  contact_id: string | null
  title: string
  starts_at: string
  ends_at: string
  state: MeetingBookingState
  video: boolean
  location: string | null
  calendar_account_id: string | null
  calendar_id: string | null
  calendar_event_id: string | null
  conference_url: string | null
  attempts: number
  reschedule_count: number
  last_error: string | null
  cancelled_by: 'guest' | 'host' | null
  answers?: unknown
  other_host_ids?: string[] | null
  host_time_zone?: string | null
  created_at: string
  updated_at: string
}

const iso = (value: string) => new Date(Date.parse(value)).toISOString()

function toSlot(row: SlotRow): OfferSlot {
  return { id: row.id, offerId: row.offer_id, startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), state: row.state }
}

function toOffer(row: OfferRow, slots: readonly SlotRow[]): TimeOffer {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    hostUserId: row.host_user_id,
    createdBy: row.created_by,
    hostName: row.host_name,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    recipientPhone: row.recipient_phone,
    contactId: row.contact_id,
    title: row.title,
    durationMinutes: row.duration_minutes,
    video: row.video,
    location: row.location,
    message: row.message,
    timeZone: row.time_zone,
    state: row.state,
    sentVia: row.sent_via,
    cardHash: row.card_hash,
    recipientsShown: row.recipients_shown === true,
    approvalId: row.approval_id,
    bookingId: row.booking_id,
    expiresAt: iso(row.expires_at),
    createdAt: row.created_at,
    slots: slots.map(toSlot).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    mode: row.mode === 'poll' ? 'poll' : 'pick',
    coHostIds: Array.isArray(row.co_host_ids) ? row.co_host_ids.filter((id) => typeof id === 'string' && id !== row.host_user_id) : [],
  }
}

export function toBooking(row: BookingRow): MeetingBooking {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    hostUserId: row.host_user_id,
    hostName: row.host_name,
    source: row.source,
    offerId: row.offer_id,
    linkId: row.link_id ?? null,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    guestTimeZone: row.guest_time_zone,
    guestNote: row.guest_note,
    contactId: row.contact_id,
    title: row.title,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    state: row.state,
    video: row.video,
    location: row.location,
    calendarAccountId: row.calendar_account_id,
    calendarId: row.calendar_id,
    calendarEventId: row.calendar_event_id,
    conferenceUrl: row.conference_url,
    attempts: row.attempts ?? 0,
    rescheduleCount: row.reschedule_count ?? 0,
    lastError: row.last_error,
    cancelledBy: row.cancelled_by ?? null,
    answers: readAnswers(row.answers),
    otherHostIds: Array.isArray(row.other_host_ids) ? row.other_host_ids.filter((id) => typeof id === 'string') : [],
    hostTimeZone: row.host_time_zone ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Stored answers, the unreadable ones dropped. Pure. */
export function readAnswers(value: unknown): BookingAnswer[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((a): a is BookingAnswer => !!a && typeof a === 'object' && typeof (a as BookingAnswer).id === 'string' && typeof (a as BookingAnswer).label === 'string' && typeof (a as BookingAnswer).answer === 'string')
    .map((a) => ({ id: a.id, label: a.label, answer: a.answer }))
}

/** Everyone an offer holds time of: its host, then a poll's co-hosts. Pure. */
export function offerHosts(offer: Pick<TimeOffer, 'hostUserId'> & Partial<Pick<TimeOffer, 'coHostIds'>>): string[] {
  return [offer.hostUserId, ...(offer.coHostIds ?? []).filter((id) => id !== offer.hostUserId)]
}

/** Everyone a booking claims time of: its organizer first, then the other attending hosts. Pure. */
export function bookingHosts(booking: Pick<MeetingBooking, 'hostUserId' | 'otherHostIds'>): string[] {
  return [booking.hostUserId, ...booking.otherHostIds.filter((id) => id !== booking.hostUserId)]
}

/** A unique key or the exclusion constraint said no (23505 / 23P01). */
export function isConflict(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505' || error?.code === '23P01'
}

async function slotsFor(supabase: SupabaseClient, offerIds: readonly string[]): Promise<SlotRow[]> {
  if (!offerIds.length) return []
  const { data, error } = await supabase.from('time_offer_slot').select(SLOT_COLUMNS).in('offer_id', [...offerIds])
  if (error) throw new Error(`time_offer_slot read failed: ${error.message}`)
  return (data as SlotRow[] | null) ?? []
}

async function withSlots(supabase: SupabaseClient, rows: readonly OfferRow[]): Promise<TimeOffer[]> {
  const slots = await slotsFor(supabase, rows.map((r) => r.id))
  return rows.map((row) => toOffer(row, slots.filter((s) => s.offer_id === row.id)))
}

// ── Offers ──────────────────────────────────────────────────────────────────

export interface NewOfferRow {
  workspaceId: string
  hostUserId: string
  createdBy: string | null
  hostName: string
  recipientName: string
  recipientEmail: string | null
  recipientPhone: string | null
  contactId: string | null
  title: string
  durationMinutes: number
  video: boolean
  /** Meet on a call here (migration 576): the booking gets one of our meeting links. */
  callHere?: boolean
  location: string | null
  message: string | null
  timeZone: string
  state: 'open' | 'pending_send'
  tokenHash: string | null
  sentVia: SendBy | null
  cardHash: string | null
  /** The person saw who it goes to (their own attended turn made it): see TimeOffer.recipientsShown. */
  recipientsShown?: boolean
  expiresAt: string
  slots: ReadonlyArray<{ startsAt: string; endsAt: string }>
  /** A poll (migration 583): its guests are written apart (./poll-store.ts). */
  mode?: OfferMode
  coHostIds?: readonly string[]
}

/** Write an offer and its slots (no holds yet: ./offers.ts places them). Throws on a failed write, the offer gone with it. */
export async function insertOffer(supabase: SupabaseClient, offer: NewOfferRow): Promise<TimeOffer> {
  const { data, error } = await supabase
    .from('time_offer')
    .insert({
      workspace_id: offer.workspaceId,
      host_user_id: offer.hostUserId,
      created_by: offer.createdBy,
      host_name: offer.hostName,
      recipient_name: offer.recipientName,
      recipient_email: offer.recipientEmail,
      recipient_phone: offer.recipientPhone,
      contact_id: offer.contactId,
      title: offer.title,
      duration_minutes: offer.durationMinutes,
      video: offer.video,
      ...(offer.callHere ? { call_here: true } : {}),
      location: offer.location,
      message: offer.message,
      time_zone: offer.timeZone,
      state: offer.state,
      token_hash: offer.tokenHash,
      sent_via: offer.sentVia,
      card_hash: offer.cardHash,
      recipients_shown: offer.recipientsShown === true,
      expires_at: offer.expiresAt,
      ...(offer.mode === 'poll' ? { mode: 'poll', co_host_ids: [...(offer.coHostIds ?? [])] } : {}),
    })
    .select(OFFER_COLUMNS)
    .single<OfferRow>()
  if (error || !data) throw new Error(`time_offer insert failed: ${error?.message ?? 'no row'}`)
  const slots = await supabase
    .from('time_offer_slot')
    .insert(offer.slots.map((s) => ({ offer_id: data.id, starts_at: s.startsAt, ends_at: s.endsAt, state: 'open' })))
    .select(SLOT_COLUMNS)
  if (slots.error) {
    await supabase.from('time_offer').delete().eq('id', data.id)
    throw new Error(`time_offer_slot insert failed: ${slots.error.message}`)
  }
  return toOffer(data, (slots.data as SlotRow[] | null) ?? [])
}

/** Delete an offer that never went anywhere (its slots and holds go with it). Never throws. */
export async function deleteOffer(supabase: SupabaseClient, offerId: string): Promise<void> {
  try {
    await supabase.from('host_time_claim').delete().eq('offer_id', offerId)
    await supabase.from('time_offer_slot').delete().eq('offer_id', offerId)
    await supabase.from('time_offer').delete().eq('id', offerId)
  } catch (err) {
    console.warn('[time-offers] an unused offer could not be deleted:', err instanceof Error ? err.message : String(err))
  }
}

/** One offer by id, fenced to a workspace when one is named. */
export async function getOffer(supabase: SupabaseClient, offerId: string, workspaceId?: string): Promise<TimeOffer | null> {
  let query = supabase.from('time_offer').select(OFFER_COLUMNS).eq('id', offerId)
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  const { data, error } = await query.maybeSingle<OfferRow>()
  if (error) throw new Error(`time_offer read failed: ${error.message}`)
  return data ? (await withSlots(supabase, [data]))[0] : null
}

/** One offer by its link's token hash: two indexed reads. */
export async function getOfferByTokenHash(supabase: SupabaseClient, tokenHash: string): Promise<TimeOffer | null> {
  const { data, error } = await supabase.from('time_offer').select(OFFER_COLUMNS).eq('token_hash', tokenHash).maybeSingle<OfferRow>()
  if (error) throw new Error(`time_offer read failed: ${error.message}`)
  return data ? (await withSlots(supabase, [data]))[0] : null
}

/** A host's offer waiting on the card with these words (the same card asked again reuses it). */
export async function pendingOfferWithCard(supabase: SupabaseClient, hostUserId: string, cardHash: string, nowIso: string): Promise<TimeOffer | null> {
  const { data, error } = await supabase
    .from('time_offer')
    .select(OFFER_COLUMNS)
    .eq('host_user_id', hostUserId)
    .eq('state', 'pending_send')
    .eq('card_hash', cardHash)
    .gt('expires_at', nowIso)
    .limit(1)
  if (error) throw new Error(`time_offer read failed: ${error.message}`)
  const row = ((data as OfferRow[] | null) ?? [])[0]
  return row ? (await withSlots(supabase, [row]))[0] : null
}

/** A workspace's offers, newest first; a host's own when one is named. */
export async function listOffers(
  supabase: SupabaseClient,
  args: { workspaceId: string; hostUserId?: string; states?: readonly OfferState[]; sinceIso?: string; limit?: number },
): Promise<TimeOffer[]> {
  let query = supabase.from('time_offer').select(OFFER_COLUMNS).eq('workspace_id', args.workspaceId)
  if (args.hostUserId) query = query.eq('host_user_id', args.hostUserId)
  if (args.states?.length) query = query.in('state', [...args.states])
  if (args.sinceIso) query = query.gte('created_at', args.sinceIso)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(args.limit ?? 20)
  if (error) throw new Error(`time_offer read failed: ${error.message}`)
  return withSlots(supabase, (data as OfferRow[] | null) ?? [])
}

/** How many offers a host has live (open, or waiting on their card) and unexpired. */
export async function countLiveOffers(supabase: SupabaseClient, hostUserId: string, nowIso: string): Promise<number> {
  const { count, error } = await supabase
    .from('time_offer')
    .select('id', { count: 'exact', head: true })
    .eq('host_user_id', hostUserId)
    .in('state', ['open', 'pending_send'])
    .gt('expires_at', nowIso)
  if (error) throw new Error(`time_offer count failed: ${error.message}`)
  return count ?? 0
}

/** Open offers for one phone number in a workspace, unexpired (a customer who texts the business). */
export async function openOffersForPhone(supabase: SupabaseClient, workspaceId: string, phone: string, nowIso: string): Promise<TimeOffer[]> {
  const { data, error } = await supabase
    .from('time_offer')
    .select(OFFER_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('recipient_phone', phone)
    .eq('state', 'open')
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(3)
  if (error) throw new Error(`time_offer read failed: ${error.message}`)
  return withSlots(supabase, (data as OfferRow[] | null) ?? [])
}

/**
 * Move an offer from one of `from` to `to` (with `patch`), only if it is still
 * in one of them: the updated offer, or null when it had moved on.
 */
export async function moveOffer(
  supabase: SupabaseClient,
  offerId: string,
  from: readonly OfferState[],
  to: OfferState,
  patch: { token_hash?: string | null; sent_via?: SendBy | null; approval_id?: string | null; recipients_shown?: boolean } = {},
): Promise<TimeOffer | null> {
  const { data, error } = await supabase
    .from('time_offer')
    .update({ state: to, ...patch, updated_at: new Date().toISOString() })
    .eq('id', offerId)
    .in('state', [...from])
    .select(OFFER_COLUMNS)
  if (error) throw new Error(`time_offer update failed: ${error.message}`)
  const row = ((data as OfferRow[] | null) ?? [])[0]
  return row ? (await withSlots(supabase, [row]))[0] : null
}

/** Record the approval an offer's card became. Best effort. */
export async function setOfferApproval(supabase: SupabaseClient, offerId: string, approvalId: string): Promise<void> {
  await supabase.from('time_offer').update({ approval_id: approvalId }).eq('id', offerId).eq('state', 'pending_send')
}

/** Offers past their expiry that are still live: the sweep's. */
export async function lapsedOffers(supabase: SupabaseClient, nowIso: string, limit = 100): Promise<Array<{ id: string }>> {
  const { data, error } = await supabase.from('time_offer').select('id').in('state', ['open', 'pending_send']).lte('expires_at', nowIso).limit(limit)
  if (error) throw new Error(`time_offer read failed: ${error.message}`)
  return (data as Array<{ id: string }> | null) ?? []
}

/** Mark an offer's open slots released, or one slot. */
export async function releaseSlots(supabase: SupabaseClient, offerId: string, slotId?: string): Promise<void> {
  let query = supabase.from('time_offer_slot').update({ state: 'released' }).eq('offer_id', offerId).eq('state', 'open')
  if (slotId) query = query.eq('id', slotId)
  const { error } = await query
  if (error) throw new Error(`time_offer_slot update failed: ${error.message}`)
}

// ── Claims ──────────────────────────────────────────────────────────────────

/** An expired hold never blocks: the host's are deleted before anything is inserted. */
export async function deleteExpiredHolds(supabase: SupabaseClient, hostUserId: string | null, nowIso: string): Promise<void> {
  let query = supabase.from('host_time_claim').delete().eq('kind', 'hold').lte('expires_at', nowIso)
  if (hostUserId) query = query.eq('host_user_id', hostUserId)
  const { error } = await query
  if (error) throw new Error(`host_time_claim delete failed: ${error.message}`)
}

/**
 * Hold every slot of an offer, in one insert (all or none). `conflict` when
 * another claim of the host's overlaps one of them.
 */
export async function insertHolds(supabase: SupabaseClient, offer: TimeOffer): Promise<{ ok: true } | { ok: false; conflict: boolean; error: string }> {
  // A poll's co-hosts are held with the host (migration 583): the booking claims them all.
  const hosts = offerHosts(offer)
  for (const host of hosts) await deleteExpiredHolds(supabase, host, new Date().toISOString())
  const { error } = await supabase.from('host_time_claim').insert(
    hosts.flatMap((host) => offer.slots.map((slot) => ({
      workspace_id: offer.workspaceId,
      host_user_id: host,
      starts_at: slot.startsAt,
      ends_at: slot.endsAt,
      kind: 'hold',
      claim_key: offer.id,
      offer_id: offer.id,
      slot_id: slot.id,
      expires_at: offer.expiresAt,
    }))),
  )
  if (!error) return { ok: true }
  return { ok: false, conflict: isConflict(error), error: error.message }
}

/** Let go of an offer's holds (one slot's, or all). */
export async function deleteHolds(supabase: SupabaseClient, offerId: string, slotId?: string): Promise<void> {
  let query = supabase.from('host_time_claim').delete().eq('offer_id', offerId).eq('kind', 'hold')
  if (slotId) query = query.eq('slot_id', slotId)
  const { error } = await query
  if (error) throw new Error(`host_time_claim delete failed: ${error.message}`)
}

/**
 * A booking's claims on a time, one per attending host, in one insert (a
 * move's new ones beside the old). Their ids, or `conflict` when another
 * claim of one host's overlaps: none was written.
 */
export async function insertBookingClaim(
  supabase: SupabaseClient,
  booking: Pick<MeetingBooking, 'id' | 'workspaceId' | 'hostUserId'> & Partial<Pick<MeetingBooking, 'otherHostIds'>>,
  span: { startsAt: string; endsAt: string },
): Promise<{ ok: true; ids: string[] } | { ok: false; conflict: boolean; error: string }> {
  const hosts = bookingHosts({ hostUserId: booking.hostUserId, otherHostIds: booking.otherHostIds ?? [] })
  for (const host of hosts) await deleteExpiredHolds(supabase, host, new Date().toISOString())
  const { data, error } = await supabase
    .from('host_time_claim')
    .insert(hosts.map((host) => ({ workspace_id: booking.workspaceId, host_user_id: host, starts_at: span.startsAt, ends_at: span.endsAt, kind: 'booking', claim_key: booking.id, booking_id: booking.id })))
    .select('id')
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id)
  if (error || ids.length !== hosts.length) return { ok: false, conflict: isConflict(error), error: error?.message ?? 'no row' }
  return { ok: true, ids }
}

/** Let go of a booking's claims, all of them, or all but some (a move's new ones). */
export async function deleteBookingClaims(supabase: SupabaseClient, bookingId: string, keepClaimIds?: readonly string[]): Promise<void> {
  let query = supabase.from('host_time_claim').delete().eq('booking_id', bookingId)
  for (const id of keepClaimIds ?? []) query = query.neq('id', id)
  const { error } = await query
  if (error) throw new Error(`host_time_claim delete failed: ${error.message}`)
}

/** Delete claims by id. */
export async function deleteClaims(supabase: SupabaseClient, claimIds: readonly string[]): Promise<void> {
  if (!claimIds.length) return
  const { error } = await supabase.from('host_time_claim').delete().in('id', [...claimIds])
  if (error) throw new Error(`host_time_claim delete failed: ${error.message}`)
}

/**
 * A requested booking the host said yes to keeps its time for good: its
 * claims lose their expiry. Claims that already lapsed (and were cleared)
 * are taken again: `conflict` when someone's claim has the time now.
 */
export async function keepBookingClaims(
  supabase: SupabaseClient,
  booking: Pick<MeetingBooking, 'id' | 'workspaceId' | 'hostUserId' | 'otherHostIds' | 'startsAt' | 'endsAt'>,
): Promise<{ ok: true } | { ok: false; conflict: boolean; error: string }> {
  const { data, error } = await supabase.from('host_time_claim').update({ expires_at: null }).eq('booking_id', booking.id).select('id')
  if (error) return { ok: false, conflict: false, error: error.message }
  if (((data as unknown[] | null) ?? []).length >= bookingHosts(booking).length) return { ok: true }
  await deleteBookingClaims(supabase, booking.id)
  const claimed = await insertBookingClaim(supabase, booking, { startsAt: booking.startsAt, endsAt: booking.endsAt })
  return claimed.ok ? { ok: true } : claimed
}

/** Bookings whose claim's hold ran out (a request the host never answered): the sweep's to expire. */
export async function lapsedRequestClaims(supabase: SupabaseClient, nowIso: string, limit = 100): Promise<string[]> {
  const { data, error } = await supabase.from('host_time_claim').select('booking_id').eq('kind', 'booking').lte('expires_at', nowIso).limit(limit)
  if (error) throw new Error(`host_time_claim read failed: ${error.message}`)
  return [...new Set(((data as Array<{ booking_id: string | null }> | null) ?? []).map((r) => r.booking_id).filter((id): id is string => !!id))]
}

/** Claims of bookings that ended over a day ago: nothing reads them any more. */
export async function deleteEndedBookingClaims(supabase: SupabaseClient, beforeIso: string): Promise<void> {
  const { error } = await supabase.from('host_time_claim').delete().eq('kind', 'booking').lt('ends_at', beforeIso)
  if (error) throw new Error(`host_time_claim delete failed: ${error.message}`)
}

// ── The pick ────────────────────────────────────────────────────────────────

export type BookSlotOutcome =
  | { status: 'booked'; bookingId: string }
  | { status: 'already'; bookingId: string | null; slotId: string | null }
  | { status: 'closed'; state: OfferState | null }
  | { status: 'taken' }
  | { status: 'missing' }

/** The pick's transaction (migration 554 book_time_offer_slot). Throws on a failed call. */
export async function bookSlot(
  supabase: SupabaseClient,
  args: {
    offerId: string
    slotId: string
    bookingId: string
    guest: { name: string; email: string | null; phone: string | null; timeZone: string | null; note: string | null }
    manageTokenHash: string
    calendarAccountId: string | null
    contactId: string | null
  },
): Promise<BookSlotOutcome> {
  const { data, error } = await supabase.rpc('book_time_offer_slot', {
    p_offer_id: args.offerId,
    p_slot_id: args.slotId,
    p_booking_id: args.bookingId,
    p_guest: { name: args.guest.name, email: args.guest.email ?? '', phone: args.guest.phone ?? '', time_zone: args.guest.timeZone ?? '', note: args.guest.note ?? '' },
    p_manage_token_hash: args.manageTokenHash,
    p_calendar_account_id: args.calendarAccountId,
    p_contact_id: args.contactId,
  })
  if (error) throw new Error(`book_time_offer_slot failed: ${error.message}`)
  const out = (data ?? {}) as { status?: string; booking_id?: string | null; slot_id?: string | null; state?: OfferState | null }
  switch (out.status) {
    case 'booked':
      return { status: 'booked', bookingId: out.booking_id as string }
    case 'already':
      return { status: 'already', bookingId: out.booking_id ?? null, slotId: out.slot_id ?? null }
    case 'closed':
      return { status: 'closed', state: out.state ?? null }
    case 'taken':
      return { status: 'taken' }
    default:
      return { status: 'missing' }
  }
}

export type BookMeetingOutcome = { status: 'booked'; bookingId: string } | { status: 'taken' } | { status: 'exists'; bookingId: string } | { status: 'invalid' }

/** A new booking as book_meeting writes it (migration 581): the row's own columns. */
export interface NewMeetingBooking {
  id: string
  workspace_id: string
  host_user_id: string
  host_name: string
  source: MeetingBookingSource
  link_id?: string | null
  channel?: string | null
  guest_name: string
  guest_email?: string | null
  guest_phone?: string | null
  guest_time_zone?: string | null
  guest_note?: string | null
  contact_id?: string | null
  quote_id?: string | null
  guest_id?: string | null
  kind?: string | null
  address?: string | null
  answers?: BookingAnswer[]
  title: string
  starts_at: string
  ends_at: string
  state: Extract<MeetingBookingState, 'requested' | 'booking'>
  video?: boolean
  location?: string | null
  calendar_account_id?: string | null
  manage_token_hash: string
  other_host_ids?: string[]
  host_time_zone?: string | null
}

/**
 * The general booking write (migration 581 book_meeting): the hosts' lapsed
 * claims cleared, then the booking and a claim for each host (organizer
 * first) in one transaction. `taken` when one host's time is claimed:
 * nothing was written. A request's claims hold until `claimExpiresAt`.
 * Throws on a failed call.
 */
export async function bookMeeting(supabase: SupabaseClient, booking: NewMeetingBooking, claimExpiresAt: string | null = null): Promise<BookMeetingOutcome> {
  const hosts = bookingHosts({ hostUserId: booking.host_user_id, otherHostIds: booking.other_host_ids ?? [] })
  const { data, error } = await supabase.rpc('book_meeting', { p_booking: booking, p_hosts: hosts, p_claim_expires_at: claimExpiresAt })
  if (error) throw new Error(`book_meeting failed: ${error.message}`)
  const out = (data ?? {}) as { status?: string }
  if (out.status === 'booked') return { status: 'booked', bookingId: booking.id }
  if (out.status === 'taken') return { status: 'taken' }
  if (out.status === 'exists') return { status: 'exists', bookingId: booking.id }
  return { status: 'invalid' }
}

export type MoveMeetingOutcome = 'moved' | 'changed' | 'taken'

/**
 * Move a confirmed booking and every claim of its together (migration 581
 * move_meeting_booking), fenced on its start still being `fromStart`.
 * Throws on a failed call.
 */
export async function moveMeetingBooking(
  supabase: SupabaseClient,
  args: { bookingId: string; fromStart: string; startsAt: string; endsAt: string; customerConfirmedAt: string | null },
): Promise<MoveMeetingOutcome> {
  const { data, error } = await supabase.rpc('move_meeting_booking', {
    p_booking_id: args.bookingId,
    p_from_start: args.fromStart,
    p_starts_at: args.startsAt,
    p_ends_at: args.endsAt,
    p_customer_confirmed_at: args.customerConfirmedAt,
  })
  if (error) throw new Error(`move_meeting_booking failed: ${error.message}`)
  const status = (data as { status?: string } | null)?.status
  return status === 'moved' || status === 'taken' ? status : 'changed'
}

// ── Bookings ────────────────────────────────────────────────────────────────

export async function getBooking(supabase: SupabaseClient, bookingId: string, workspaceId?: string): Promise<MeetingBooking | null> {
  let query = supabase.from('meeting_booking').select(BOOKING_COLUMNS).eq('id', bookingId)
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  const { data, error } = await query.maybeSingle<BookingRow>()
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return data ? toBooking(data) : null
}

/** One booking by its manage link's hash: one indexed read. */
export async function getBookingByManageHash(supabase: SupabaseClient, hash: string): Promise<MeetingBooking | null> {
  const { data, error } = await supabase.from('meeting_booking').select(BOOKING_COLUMNS).eq('manage_token_hash', hash).maybeSingle<BookingRow>()
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return data ? toBooking(data) : null
}

/** A workspace's bookings from offers and booking links (customers' jobs have their own list), newest first; a host's own when one is named. */
export async function listBookings(
  supabase: SupabaseClient,
  args: { workspaceId: string; hostUserId?: string; sinceIso?: string; limit?: number; sources?: readonly MeetingBookingSource[] },
): Promise<MeetingBooking[]> {
  let query = supabase.from('meeting_booking').select(BOOKING_COLUMNS).eq('workspace_id', args.workspaceId).in('source', [...(args.sources ?? ['offer', 'link'])])
  if (args.hostUserId) query = query.eq('host_user_id', args.hostUserId)
  if (args.sinceIso) query = query.gte('created_at', args.sinceIso)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(args.limit ?? 20)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return ((data as BookingRow[] | null) ?? []).map(toBooking)
}

export type BookingPatch = Partial<
  Pick<BookingRow, 'calendar_id' | 'calendar_event_id' | 'conference_url' | 'attempts' | 'reschedule_count' | 'last_error' | 'cancelled_by' | 'starts_at' | 'ends_at' | 'calendar_account_id' | 'contact_id'>
> & { confirmed_at?: string; cancelled_at?: string; decided_at?: string; approval_id?: string | null }

/**
 * Change a booking only while it is in one of `from` (and, with `rescheduleCount`,
 * only if it has moved that many times): the booking as it is now, or null
 * when it had changed under us.
 */
export async function updateBooking(
  supabase: SupabaseClient,
  bookingId: string,
  from: readonly MeetingBookingState[],
  patch: BookingPatch & { state?: MeetingBookingState },
  guard: { rescheduleCount?: number; attempts?: number } = {},
): Promise<MeetingBooking | null> {
  let query = supabase
    .from('meeting_booking')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', bookingId)
    .in('state', [...from])
  if (guard.rescheduleCount !== undefined) query = query.eq('reschedule_count', guard.rescheduleCount)
  if (guard.attempts !== undefined) query = query.eq('attempts', guard.attempts)
  const { data, error } = await query.select(BOOKING_COLUMNS)
  if (error) throw new Error(`meeting_booking update failed: ${error.message}`)
  const row = ((data as BookingRow[] | null) ?? [])[0]
  return row ? toBooking(row) : null
}

/** Bookings left in 'booking' since before `beforeIso`: the sweep's to finish or fail. */
export async function stuckBookings(supabase: SupabaseClient, beforeIso: string, limit = 50): Promise<MeetingBooking[]> {
  const { data, error } = await supabase.from('meeting_booking').select(BOOKING_COLUMNS).eq('state', 'booking').lt('updated_at', beforeIso).limit(limit)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return ((data as BookingRow[] | null) ?? []).map(toBooking)
}

// ── Failed picks ────────────────────────────────────────────────────────────

/** Failed picks on an offer since `sinceIso`. */
export async function countFailedPicks(supabase: SupabaseClient, offerId: string, sinceIso: string): Promise<number> {
  const { count, error } = await supabase.from('time_offer_failure').select('id', { count: 'exact', head: true }).eq('offer_id', offerId).gte('created_at', sinceIso)
  if (error) throw new Error(`time_offer_failure count failed: ${error.message}`)
  return count ?? 0
}

/** Record a failed pick. Best effort. */
export async function recordFailedPick(supabase: SupabaseClient, offerId: string, reason: string): Promise<void> {
  try {
    await supabase.from('time_offer_failure').insert({ offer_id: offerId, reason: reason.slice(0, 40) })
  } catch {
    // The count is a cap, not a record.
  }
}

/** Failed picks older than `beforeIso`: no cap counts them any more (the sweep's). */
export async function deleteOldFailedPicks(supabase: SupabaseClient, beforeIso: string): Promise<void> {
  const { error } = await supabase.from('time_offer_failure').delete().lt('created_at', beforeIso)
  if (error) throw new Error(`time_offer_failure delete failed: ${error.message}`)
}
