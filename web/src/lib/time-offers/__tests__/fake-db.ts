/**
 * The time offers' tables in memory (src/test/memory-db.ts), with what the
 * database itself adds: the exclusion constraint on host_time_claim (two
 * claims of one host whose times overlap never both exist unless they share
 * a claim_key), the unique keys, and book_time_offer_slot (migration 554) as
 * the same steps in one synchronous block, so two picks at once run one
 * after the other as the row lock makes them. Made-up people only.
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
    member: [{ workspace_id: WS, user_id: HOST, display_name: HOST_NAME, role: 'owner' }],
    workspace: [{ id: WS, name: 'Fernhill Studio' }],
    ...seed,
  }
  const db = memoryDb(tables, {
    host_time_claim: claimsCollide,
    time_offer: (a, b) => !!a.token_hash && a.token_hash === b.token_hash,
    meeting_booking: (a, b) => a.manage_token_hash === b.manage_token_hash,
    time_offer_slot: (a, b) => a.offer_id === b.offer_id && a.starts_at === b.starts_at,
  })

  const rpc = async (fn: string, args: Record<string, unknown>) => {
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
