/**
 * Rows of migration 583: a poll's guests (time_offer_recipient) and their
 * answers (time_offer_response), and the poll's two transactions under the
 * offer's lock: answer_time_offer (one guest's whole answer) and
 * book_time_offer_poll (the booking). Every write is the service role's;
 * every read is fenced by offer, token hash or workspace. Throws on a failed
 * read or write, except where a function says what it answers.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getOffer } from './store'
import type { AnswerVia, OfferState, PollRecipient, TimeOffer, TimeOfferPoll } from './types'

export const RECIPIENT_COLUMNS =
  'id, offer_id, workspace_id, position, name, email, phone, contact_id, peer_user_id, token_hash, answered_at, answered_via, note, nudges, nudged_at, attending, declined_at'

interface RecipientRow {
  id: string
  offer_id: string
  workspace_id: string
  position: number
  name: string
  email: string | null
  phone: string | null
  contact_id: string | null
  peer_user_id: string | null
  token_hash: string | null
  answered_at: string | null
  answered_via: AnswerVia | null
  note: string | null
  nudges: number | null
  nudged_at: string | null
  attending: boolean | null
  declined_at: string | null
}

interface ResponseRow {
  recipient_id: string
  slot_id: string
  works: boolean
}

function toRecipient(row: RecipientRow, responses: readonly ResponseRow[]): PollRecipient {
  return {
    id: row.id,
    offerId: row.offer_id,
    workspaceId: row.workspace_id,
    position: row.position ?? 0,
    name: row.name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    contactId: row.contact_id ?? null,
    peerUserId: row.peer_user_id ?? null,
    sent: !!row.token_hash,
    answeredAt: row.answered_at ?? null,
    answeredVia: row.answered_via ?? null,
    note: row.note ?? null,
    nudges: row.nudges ?? 0,
    nudgedAt: row.nudged_at ?? null,
    attending: row.attending ?? null,
    declinedAt: row.declined_at ?? null,
    works: row.answered_at ? responses.filter((r) => r.recipient_id === row.id && r.works).map((r) => r.slot_id) : [],
  }
}

/** Every guest of these offers with their answers: two reads, whatever the count. */
export async function recipientsFor(supabase: SupabaseClient, offerIds: readonly string[]): Promise<PollRecipient[]> {
  if (!offerIds.length) return []
  const [rows, answers] = await Promise.all([
    supabase.from('time_offer_recipient').select(RECIPIENT_COLUMNS).in('offer_id', [...offerIds]),
    supabase.from('time_offer_response').select('recipient_id, slot_id, works').in('offer_id', [...offerIds]),
  ])
  if (rows.error) throw new Error(`time_offer_recipient read failed: ${rows.error.message}`)
  if (answers.error) throw new Error(`time_offer_response read failed: ${answers.error.message}`)
  const responses = (answers.data as ResponseRow[] | null) ?? []
  return ((rows.data as RecipientRow[] | null) ?? []).map((r) => toRecipient(r, responses)).sort((a, b) => a.position - b.position)
}

/** Offers with their guests (a pick's list is empty). */
export async function withRecipients(supabase: SupabaseClient, offers: readonly TimeOffer[]): Promise<TimeOfferPoll[]> {
  const polls = offers.filter((o) => o.mode === 'poll')
  const recipients = await recipientsFor(supabase, polls.map((o) => o.id))
  return offers.map((o) => ({ ...o, recipients: recipients.filter((r) => r.offerId === o.id) }))
}

/** One poll by id (fenced to a workspace when named), with its guests. Null for a pick or nothing. */
export async function getPoll(supabase: SupabaseClient, offerId: string, workspaceId?: string): Promise<TimeOfferPoll | null> {
  const offer = await getOffer(supabase, offerId, workspaceId)
  if (!offer || offer.mode !== 'poll') return null
  return (await withRecipients(supabase, [offer]))[0]
}

/** A poll guest by their link's token hash, with the whole poll: three indexed reads. */
export async function getPollByRecipientHash(supabase: SupabaseClient, tokenHash: string): Promise<{ poll: TimeOfferPoll; recipient: PollRecipient } | null> {
  const { data, error } = await supabase.from('time_offer_recipient').select('id, offer_id').eq('token_hash', tokenHash).maybeSingle<{ id: string; offer_id: string }>()
  if (error) throw new Error(`time_offer_recipient read failed: ${error.message}`)
  if (!data) return null
  const poll = await getPoll(supabase, data.offer_id)
  const recipient = poll?.recipients.find((r) => r.id === data.id)
  return poll && recipient ? { poll, recipient } : null
}

/** A poll guest by their own manage link's hash (a group meeting's /b/<token>). */
export async function getRecipientByManageHash(supabase: SupabaseClient, hash: string): Promise<{ poll: TimeOfferPoll; recipient: PollRecipient } | null> {
  const { data, error } = await supabase.from('time_offer_recipient').select('id, offer_id').eq('manage_token_hash', hash).maybeSingle<{ id: string; offer_id: string }>()
  if (error) throw new Error(`time_offer_recipient read failed: ${error.message}`)
  if (!data) return null
  const poll = await getPoll(supabase, data.offer_id)
  const recipient = poll?.recipients.find((r) => r.id === data.id)
  return poll && recipient ? { poll, recipient } : null
}

export interface NewRecipientRow {
  name: string
  email: string | null
  phone: string | null
  contactId: string | null
  peerUserId: string | null
}

/** Write a poll's guests, in order (no tokens yet: ./polls.ts sets them when the poll is sent). Throws on a failed write. */
export async function insertRecipients(supabase: SupabaseClient, offer: Pick<TimeOffer, 'id' | 'workspaceId'>, rows: readonly NewRecipientRow[]): Promise<PollRecipient[]> {
  const { data, error } = await supabase
    .from('time_offer_recipient')
    .insert(rows.map((r, i) => ({ offer_id: offer.id, workspace_id: offer.workspaceId, position: i, name: r.name, email: r.email, phone: r.phone, contact_id: r.contactId, peer_user_id: r.peerUserId })))
    .select(RECIPIENT_COLUMNS)
  if (error) throw new Error(`time_offer_recipient insert failed: ${error.message}`)
  return ((data as RecipientRow[] | null) ?? []).map((r) => toRecipient(r, [])).sort((a, b) => a.position - b.position)
}

/** Each guest's link goes live: its token's hash stored. Throws on a failed write. */
export async function setRecipientTokens(supabase: SupabaseClient, hashes: ReadonlyArray<{ id: string; tokenHash: string }>): Promise<void> {
  for (const { id, tokenHash } of hashes) {
    const { error } = await supabase.from('time_offer_recipient').update({ token_hash: tokenHash, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) throw new Error(`time_offer_recipient update failed: ${error.message}`)
  }
}

/** Guests were reminded: each one's count and time. Best effort. */
export async function markNudged(supabase: SupabaseClient, recipients: readonly Pick<PollRecipient, 'id' | 'nudges'>[], atIso: string): Promise<void> {
  for (const r of recipients) {
    await supabase.from('time_offer_recipient').update({ nudges: Math.min(r.nudges + 1, 10), nudged_at: atIso, updated_at: atIso }).eq('id', r.id)
  }
}

/** A guest says they can't make the group meeting: off it, only while on it. The row as it is now, or null when it had changed. */
export async function markDeclined(supabase: SupabaseClient, recipientId: string, atIso: string): Promise<PollRecipient | null> {
  const { data, error } = await supabase
    .from('time_offer_recipient')
    .update({ attending: false, declined_at: atIso, updated_at: atIso })
    .eq('id', recipientId)
    .eq('attending', true)
    .select(RECIPIENT_COLUMNS)
  if (error) throw new Error(`time_offer_recipient update failed: ${error.message}`)
  const row = ((data as RecipientRow[] | null) ?? [])[0]
  return row ? toRecipient(row, []) : null
}

/** Put a guest back on the meeting (the calendar refused to take them off). Best effort. */
export async function unmarkDeclined(supabase: SupabaseClient, recipientId: string): Promise<void> {
  await supabase.from('time_offer_recipient').update({ attending: true, declined_at: null, updated_at: new Date().toISOString() }).eq('id', recipientId)
}

/** Open polls with a guest at this phone in a workspace, unexpired (a guest who texts the business). */
export async function openPollsForPhone(supabase: SupabaseClient, workspaceId: string, phone: string, nowIso: string): Promise<Array<{ poll: TimeOfferPoll; recipient: PollRecipient }>> {
  const { data, error } = await supabase.from('time_offer_recipient').select('id, offer_id').eq('workspace_id', workspaceId).eq('phone', phone).not('token_hash', 'is', null).limit(10)
  if (error) throw new Error(`time_offer_recipient read failed: ${error.message}`)
  const rows = (data as Array<{ id: string; offer_id: string }> | null) ?? []
  if (!rows.length) return []
  const { data: offers, error: offerError } = await supabase.from('time_offer').select('id').in('id', rows.map((r) => r.offer_id)).eq('state', 'open').gt('expires_at', nowIso).limit(3)
  if (offerError) throw new Error(`time_offer read failed: ${offerError.message}`)
  const out: Array<{ poll: TimeOfferPoll; recipient: PollRecipient }> = []
  for (const { id } of (offers as Array<{ id: string }> | null) ?? []) {
    const poll = await getPoll(supabase, id, workspaceId)
    const recipient = poll?.recipients.find((r) => rows.some((row) => row.id === r.id))
    if (poll && recipient) out.push({ poll, recipient })
  }
  return out
}

/** Open polls whose every guest answered but which aren't booked: the sweep's to try again. */
export async function answeredOpenPolls(supabase: SupabaseClient, nowIso: string, limit = 50): Promise<string[]> {
  const { data, error } = await supabase.from('time_offer').select('id').eq('mode', 'poll').eq('state', 'open').gt('expires_at', nowIso).limit(limit * 4)
  if (error) throw new Error(`time_offer read failed: ${error.message}`)
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id)
  if (!ids.length) return []
  const { data: waiting, error: waitingError } = await supabase.from('time_offer_recipient').select('offer_id').in('offer_id', ids).is('answered_at', null)
  if (waitingError) throw new Error(`time_offer_recipient read failed: ${waitingError.message}`)
  const open = new Set(((waiting as Array<{ offer_id: string }> | null) ?? []).map((r) => r.offer_id))
  return ids.filter((id) => !open.has(id)).slice(0, limit)
}

// ── The transactions ────────────────────────────────────────────────────────

export type AnswerOutcome =
  | { status: 'recorded'; waiting: number }
  | { status: 'booked'; bookingId: string | null }
  | { status: 'closed'; state: OfferState | null }
  | { status: 'limited' }
  | { status: 'invalid' }
  | { status: 'missing' }

/** One guest's whole answer (migration 583 answer_time_offer). `saveCap` for a page's saves; none for the agents'. Throws on a failed call. */
export async function answerPoll(
  supabase: SupabaseClient,
  args: { offerId: string; recipientId: string; works: readonly string[]; note: string | null; via: AnswerVia; saveCap: number | null },
): Promise<AnswerOutcome> {
  const { data, error } = await supabase.rpc('answer_time_offer', {
    p_offer_id: args.offerId,
    p_recipient_id: args.recipientId,
    p_works: [...args.works],
    p_note: args.note,
    p_via: args.via,
    p_save_cap: args.saveCap,
  })
  if (error) throw new Error(`answer_time_offer failed: ${error.message}`)
  const out = (data ?? {}) as { status?: string; waiting?: number; booking_id?: string | null; state?: OfferState | null }
  switch (out.status) {
    case 'recorded':
      return { status: 'recorded', waiting: typeof out.waiting === 'number' ? out.waiting : 0 }
    case 'booked':
      return { status: 'booked', bookingId: out.booking_id ?? null }
    case 'closed':
      return { status: 'closed', state: out.state ?? null }
    case 'limited':
      return { status: 'limited' }
    case 'invalid':
      return { status: 'invalid' }
    default:
      return { status: 'missing' }
  }
}

export type BookPollOutcome =
  | { status: 'booked'; bookingId: string }
  | { status: 'already'; bookingId: string | null; slotId: string | null }
  | { status: 'closed'; state: OfferState | null }
  | { status: 'taken' }
  | { status: 'changed' }
  | { status: 'invalid' }
  | { status: 'missing' }

/** The poll's booking (migration 583 book_time_offer_poll). Throws on a failed call. */
export async function bookPollSlot(
  supabase: SupabaseClient,
  args: {
    offerId: string
    slotId: string
    bookingId: string
    manageTokenHash: string
    calendarAccountId: string | null
    guestName: string
    attendees: readonly string[]
    /** Each attending guest's own manage link's hash, by their row's id. */
    manageHashes: Readonly<Record<string, string>>
    /** Only while every answer says this time works (the automatic booking); false for the host's book-anyway. */
    everyone: boolean
  },
): Promise<BookPollOutcome> {
  const { data, error } = await supabase.rpc('book_time_offer_poll', {
    p_offer_id: args.offerId,
    p_slot_id: args.slotId,
    p_booking_id: args.bookingId,
    p_manage_token_hash: args.manageTokenHash,
    p_calendar_account_id: args.calendarAccountId,
    p_guest_name: args.guestName,
    p_attendees: [...args.attendees],
    p_manage_hashes: args.manageHashes,
    p_everyone: args.everyone,
  })
  if (error) throw new Error(`book_time_offer_poll failed: ${error.message}`)
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
    case 'changed':
      return { status: 'changed' }
    case 'invalid':
      return { status: 'invalid' }
    default:
      return { status: 'missing' }
  }
}
