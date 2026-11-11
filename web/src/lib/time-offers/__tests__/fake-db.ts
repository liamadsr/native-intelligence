/**
 * The time offers' tables in memory (src/test/memory-db.ts), with what the
 * database itself adds: the exclusion constraint on host_time_claim (two
 * claims of one host whose times overlap never both exist unless they share
 * a claim_key), the unique keys, and book_time_offer_slot (migration 554) as
 * the same steps in one synchronous block, so two picks at once run one
 * after the other as the row lock makes them; and a poll's two (migration
 * 583): answer_time_offer and book_time_offer_poll, each one synchronous
 * block under the same rule. Made-up people only.
 */
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

type Row = Record<string, unknown>

export const WS = 'ws-fernhill'
export const HOST = 'user-ava'
export const HOST_NAME = 'Ava Lin'
export const ZONE = 'America/New_York'

const t = (v: unknown) => Date.parse(String(v))
const overlaps = (a: Row, b: Row) => t(a.starts_at) < t(b.ends_at) && t(b.starts_at) < t(a.ends_at)

/** The exclusion constraint's rule (migration 554 host_time_claim_no_overlap). */
export function claimsCollide(a: Row, b: Row): boolean {
  return a.host_user_id === b.host_user_id && a.claim_key !== b.claim_key && overlaps(a, b)
}

export function offerDb(seed: Record<string, Row[]> = {}): { db: SupabaseClient; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = {
    time_offer: [],
    time_offer_slot: [],
    meeting_booking: [],
    host_time_claim: [],
    time_offer_failure: [],
    time_offer_recipient: [],
    time_offer_response: [],
    member: [{ workspace_id: WS, user_id: HOST, display_name: HOST_NAME, role: 'owner' }],
    workspace: [{ id: WS, name: 'Fernhill Studio' }],
    ...seed,
  }
  const db = memoryDb(tables, {
    host_time_claim: claimsCollide,
    time_offer: (a, b) => !!a.token_hash && a.token_hash === b.token_hash,
    meeting_booking: (a, b) => a.manage_token_hash === b.manage_token_hash,
    time_offer_slot: (a, b) => a.offer_id === b.offer_id && a.starts_at === b.starts_at,
    time_offer_recipient: (a, b) => (a.offer_id === b.offer_id && a.position === b.position) || (!!a.token_hash && a.token_hash === b.token_hash) || (!!a.manage_token_hash && a.manage_token_hash === b.manage_token_hash),
  })

  const DAY = 24 * 60 * 60_000
  // migration 583 answer_time_offer
  const answer = (args: Record<string, unknown>) => {
    const now = Date.now()
    const offer = tables.time_offer.find((o) => o.id === args.p_offer_id)
    if (!offer) return { status: 'missing' }
    const rec = tables.time_offer_recipient.find((r) => r.id === args.p_recipient_id && r.offer_id === offer.id)
    if (!rec || offer.mode !== 'poll') return { status: 'missing' }
    if (offer.state === 'booked') return { status: 'booked', booking_id: offer.booking_id }
    if (offer.state !== 'open' || t(offer.expires_at) <= now) return { status: 'closed', state: offer.state }
    if (!['link', 'host', 'text', 'calendar'].includes(String(args.p_via))) return { status: 'invalid' }
    const open = tables.time_offer_slot.filter((s) => s.offer_id === offer.id && s.state === 'open')
    const works = (args.p_works as string[] | null) ?? []
    if (works.some((w) => !open.some((s) => s.id === w))) return { status: 'invalid' }
    const recent = rec.saves_since != null && t(rec.saves_since) > now - DAY
    if (args.p_save_cap != null && recent && Number(rec.saves ?? 0) >= Number(args.p_save_cap)) return { status: 'limited' }
    const nowIso = new Date(now).toISOString()
    tables.time_offer_response = [
      ...tables.time_offer_response.filter((x) => x.recipient_id !== rec.id),
      ...open.map((s) => ({ recipient_id: rec.id, slot_id: s.id, offer_id: offer.id, works: works.includes(String(s.id)), answered_at: nowIso })),
    ]
    const note = typeof args.p_note === 'string' && args.p_note.trim() ? args.p_note.trim() : null
    Object.assign(rec, { answered_at: nowIso, answered_via: args.p_via, note, saves: recent ? Number(rec.saves ?? 0) + 1 : 1, saves_since: recent ? rec.saves_since : nowIso, updated_at: nowIso })
    return { status: 'recorded', waiting: tables.time_offer_recipient.filter((r) => r.offer_id === offer.id && r.answered_at == null).length }
  }

  // migration 583 book_time_offer_poll
  const bookPoll = (args: Record<string, unknown>) => {
    const now = Date.now()
    const offer = tables.time_offer.find((o) => o.id === args.p_offer_id)
    if (!offer || offer.mode !== 'poll') return { status: 'missing' }
    const slots = tables.time_offer_slot.filter((s) => s.offer_id === offer.id)
    if (offer.state === 'booked') return { status: 'already', booking_id: offer.booking_id, slot_id: slots.find((s) => s.state === 'booked')?.id ?? null }
    if (offer.state !== 'open' || t(offer.expires_at) <= now) return { status: 'closed', state: offer.state }
    const slot = slots.find((s) => s.id === args.p_slot_id)
    if (!slot || slot.state !== 'open' || t(slot.starts_at) <= now) return { status: 'taken' }
    const recipients = tables.time_offer_recipient.filter((r) => r.offer_id === offer.id)
    const attendees = (args.p_attendees as string[] | null) ?? []
    if (!attendees.length || attendees.some((a) => !recipients.some((r) => r.id === a))) return { status: 'invalid' }
    if (args.p_everyone && recipients.some((r) => !tables.time_offer_response.some((x) => x.recipient_id === r.id && x.slot_id === slot.id && x.works))) return { status: 'changed' }
    const hosts = [offer.host_user_id, ...(((offer.co_host_ids as string[] | undefined) ?? []).filter((h) => h !== offer.host_user_id))]
    tables.host_time_claim = tables.host_time_claim.filter((c) => !(hosts.includes(c.host_user_id) && c.expires_at != null && t(c.expires_at) <= now))
    const without = tables.host_time_claim.filter((c) => !(c.offer_id === offer.id && c.kind === 'hold'))
    const bookingId = String(args.p_booking_id)
    const nowIso = new Date(now).toISOString()
    const claims = hosts.map((h) => ({ id: randomUUID(), created_at: nowIso, workspace_id: offer.workspace_id, host_user_id: h, starts_at: slot.starts_at, ends_at: slot.ends_at, kind: 'booking', claim_key: bookingId, booking_id: bookingId, offer_id: null, slot_id: null, expires_at: null }))
    if (claims.some((c) => without.some((o) => claimsCollide(o, c)))) return { status: 'taken' }
    tables.host_time_claim = [...without, ...claims]
    tables.meeting_booking.push({
      id: bookingId, created_at: nowIso, updated_at: nowIso, workspace_id: offer.workspace_id, host_user_id: offer.host_user_id, host_name: offer.host_name,
      source: 'poll', offer_id: offer.id, link_id: null, guest_name: args.p_guest_name, guest_email: null, guest_phone: null, guest_time_zone: null, guest_note: null,
      contact_id: null, title: offer.title, starts_at: slot.starts_at, ends_at: slot.ends_at, state: 'booking', video: offer.video, location: offer.location ?? null,
      calendar_account_id: args.p_calendar_account_id ?? null, calendar_id: null, calendar_event_id: null, conference_url: null, manage_token_hash: args.p_manage_token_hash,
      attempts: 0, reschedule_count: 0, last_error: null, cancelled_by: null, answers: [], other_host_ids: hosts.slice(1), host_time_zone: offer.time_zone,
    })
    for (const s of slots) if (s.state === 'open') s.state = s.id === slot.id ? 'booked' : 'released'
    offer.state = 'booked'
    offer.booking_id = bookingId
    const hashes = (args.p_manage_hashes ?? {}) as Record<string, string>
    for (const r of recipients) Object.assign(r, { attending: attendees.includes(String(r.id)), manage_token_hash: attendees.includes(String(r.id)) ? (hashes[String(r.id)] ?? null) : null, updated_at: nowIso })
    return { status: 'booked', booking_id: bookingId }
  }

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'answer_time_offer') return { data: answer(args), error: null }
    if (fn === 'book_time_offer_poll') return { data: bookPoll(args), error: null }
    if (fn !== 'book_time_offer_slot') return { data: null, error: { message: `no function ${fn}` } }
    const now = Date.now()
    const offer = tables.time_offer.find((o) => o.id === args.p_offer_id)
    if (!offer) return { data: { status: 'missing' }, error: null }
    const slots = tables.time_offer_slot.filter((s) => s.offer_id === offer.id)
    if (offer.state === 'booked') return { data: { status: 'already', booking_id: offer.booking_id, slot_id: slots.find((s) => s.state === 'booked')?.id ?? null }, error: null }
    if (offer.state !== 'open' || t(offer.expires_at) <= now) return { data: { status: 'closed', state: offer.state }, error: null }
    const slot = slots.find((s) => s.id === args.p_slot_id)
    if (!slot || slot.state !== 'open' || t(slot.starts_at) <= now) return { data: { status: 'taken' }, error: null }
    tables.host_time_claim = tables.host_time_claim.filter((c) => !(c.host_user_id === offer.host_user_id && c.kind === 'hold' && t(c.expires_at) <= now))
    // The block: the offer's holds go, the booking's claim comes; a collision undoes it all.
    const without = tables.host_time_claim.filter((c) => !(c.offer_id === offer.id && c.kind === 'hold'))
    const bookingId = String(args.p_booking_id)
    const claim = { id: randomUUID(), created_at: new Date().toISOString(), workspace_id: offer.workspace_id, host_user_id: offer.host_user_id, starts_at: slot.starts_at, ends_at: slot.ends_at, kind: 'booking', claim_key: bookingId, booking_id: bookingId, offer_id: null, slot_id: null, expires_at: null }
    if (without.some((c) => claimsCollide(c, claim))) return { data: { status: 'taken' }, error: null }
    const guest = (args.p_guest ?? {}) as Record<string, string>
    const nowIso = new Date().toISOString()
    tables.host_time_claim = [...without, claim]
    tables.meeting_booking.push({
      id: bookingId,
      created_at: nowIso,
      updated_at: nowIso,
      workspace_id: offer.workspace_id,
      host_user_id: offer.host_user_id,
      host_name: offer.host_name,
      source: 'offer',
      offer_id: offer.id,
      guest_name: guest.name,
      guest_email: guest.email || null,
      guest_phone: guest.phone || null,
      guest_time_zone: guest.time_zone || null,
      guest_note: guest.note || null,
      contact_id: args.p_contact_id ?? offer.contact_id ?? null,
      title: offer.title,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      state: 'booking',
      video: offer.video,
      location: offer.location ?? null,
      calendar_account_id: args.p_calendar_account_id ?? null,
      calendar_id: null,
      calendar_event_id: null,
      conference_url: null,
      manage_token_hash: args.p_manage_token_hash,
      attempts: 0,
      reschedule_count: 0,
      last_error: null,
      cancelled_by: null,
    })
    for (const s of slots) if (s.state === 'open') s.state = s.id === slot.id ? 'booked' : 'released'
    offer.state = 'booked'
    offer.booking_id = bookingId
    return { data: { status: 'booked', booking_id: bookingId }, error: null }
  }
  return { db: Object.assign(db, { rpc }) as unknown as SupabaseClient, tables }
}

/** The calendar and contact seams every test passes: the host's calendar free, one Google account, no contact. */
export function freeCalendar() {
  return {
    timeZone: async () => ZONE,
    checkFree: vi.fn(async (input: { spans: readonly unknown[] }) => ({ known: true as const, busy: input.spans.map(() => false) })),
    calendarAccount: vi.fn(async () => ({ id: 'acct-google', provider: 'google' as const })),
    findContact: vi.fn(async () => null),
  }
}

/** The booking seams: the provider writes the event, the host is told. */
export function bookingSeams() {
  return {
    secret: 'test-secret',
    origin: 'https://app.example',
    createEvent: vi.fn(async (_userId: string, event: { title: string; start: string; end: string }, accountId?: string) => ({
      id: 'evt-1',
      title: event.title,
      start: event.start,
      end: event.end,
      conferenceUrl: 'https://meet.example/abc-defg-hij',
      calendarId: 'primary',
      accountId,
    })),
    deleteEvent: vi.fn(async () => {}),
    tellHost: vi.fn(async () => true),
  }
}

/** On the hour, `hours` from now: a time to offer. */
export function hoursFromNow(hours: number, now: number = Date.now()): string {
  return new Date(Math.ceil(now / 3_600_000) * 3_600_000 + hours * 3_600_000).toISOString()
}
