/**
 * The one booking model in memory (migrations 554 and 581), for the customer
 * flow's tests and the booking links': src/test/memory-db.ts with what the
 * database itself adds:
 *
 *   - host_time_claim's exclusion constraint (two claims of one host whose
 *     times overlap never both exist unless they share a claim_key),
 *     answered as a unique key's 23505;
 *   - book_meeting (a booking and a claim per host in one block, lapsed
 *     claims cleared first, `taken` leaving nothing) and
 *     move_meeting_booking (a confirmed booking and its claims together,
 *     fenced on its start), as the same steps in one synchronous block.
 *
 * And the customer flow's words for a row: {@link customerBooking} makes a
 * meeting_booking row (source customer) from a customer booking's fields as
 * 458 named them, {@link seedBookings} adds rows with the claims the live
 * ones hold, and {@link asCustomer} reads a row back in those names. Made-up
 * people only.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

type Row = Record<string, unknown>

const t = (v: unknown) => Date.parse(String(v))
const overlaps = (a: Row, b: Row) => t(a.starts_at) < t(b.ends_at) && t(b.starts_at) < t(a.ends_at)

/** The exclusion constraint's rule (migration 554 host_time_claim_no_overlap). */
export function claimsCollide(a: Row, b: Row): boolean {
  return a.host_user_id === b.host_user_id && a.claim_key !== b.claim_key && overlaps(a, b)
}

/** A customer booking's fields as migration 458 named them. */
export interface CustomerBookingSeed {
  id?: string
  workspace_id: string
  owner_user_id?: string
  quote_id?: string | null
  contact_id?: string | null
  guest_id?: string | null
  /** The way in: sms, link, phone, owner. */
  source?: string
  kind?: string
  starts_at: string
  ends_at?: string
  customer_name?: string
  customer_phone?: string | null
  address?: string | null
  note?: string | null
  state: string
  approval_id?: string | null
  calendar_event_id?: string | null
  customer_confirmed_at?: string | null
  created_at?: string
  [key: string]: unknown
}

/** A meeting_booking row (source customer) from a customer booking's fields. Pure. */
export function customerBooking(seed: CustomerBookingSeed): Row {
  const id = seed.id ?? randomUUID()
  const kind = seed.kind ?? 'pickup'
  const name = seed.customer_name ?? 'A customer'
  const { owner_user_id, source, customer_name, customer_phone, note, ...rest } = seed
  return {
    quote_id: null,
    contact_id: null,
    guest_id: null,
    address: null,
    approval_id: null,
    calendar_event_id: null,
    calendar_account_id: null,
    customer_confirmed_at: null,
    link_id: null,
    other_host_ids: [],
    answers: [],
    video: false,
    location: null,
    host_name: 'The business',
    title: `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${name}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...rest,
    id,
    host_user_id: owner_user_id ?? 'user-owner',
    source: 'customer',
    channel: source ?? 'sms',
    kind,
    ends_at: seed.ends_at ?? new Date(t(seed.starts_at) + 60 * 60_000).toISOString(),
    guest_name: name,
    guest_phone: customer_phone ?? null,
    guest_note: note ?? null,
    manage_token_hash: `none:${id}`,
  }
}

/** The claim a live booking row holds on its host's time (and each other host's). Pure. */
export function claimsOf(row: Row, opts: { expiresAt?: string | null } = {}): Row[] {
  const hosts = [row.host_user_id, ...((row.other_host_ids as string[] | undefined) ?? [])]
  return hosts.map((host) => ({
    id: randomUUID(),
    created_at: new Date().toISOString(),
    workspace_id: row.workspace_id,
    host_user_id: host,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    kind: 'booking',
    claim_key: row.id,
    booking_id: row.id,
    offer_id: null,
    slot_id: null,
    expires_at: opts.expiresAt ?? null,
  }))
}

const LIVE = new Set(['requested', 'booking', 'confirmed'])

/** Seed customer bookings (458's names) as meeting_booking rows, the live ones with their claims. Their rows, in order. */
export function seedBookings(tables: Record<string, Row[]>, seeds: readonly CustomerBookingSeed[], opts: { claims?: boolean } = {}): Row[] {
  const rows = seeds.map(customerBooking)
  ;(tables.meeting_booking ??= []).push(...rows)
  if (opts.claims !== false) for (const row of rows) if (LIVE.has(String(row.state))) (tables.host_time_claim ??= []).push(...claimsOf(row))
  return rows
}

/** A meeting_booking row in the customer flow's names (458's), for a test's expectations. Pure. */
export function asCustomer(row: Row | undefined): Row | undefined {
  if (!row) return row
  const { host_user_id, channel, guest_name, guest_phone, guest_note, source: _source, ...rest } = row
  return { ...rest, owner_user_id: host_user_id, source: channel, customer_name: guest_name, customer_phone: guest_phone, note: guest_note }
}

/** The customer bookings among the rows, in 458's names. */
export function customerRows(tables: Record<string, Row[]>): Row[] {
  return (tables.meeting_booking ?? []).filter((r) => r.source === 'customer').map((r) => asCustomer(r) as Row)
}

export function bookingDb(tables: Record<string, Row[]>, unique: Record<string, (a: Row, b: Row) => boolean> = {}): SupabaseClient {
  tables.meeting_booking ??= []
  tables.host_time_claim ??= []
  const db = memoryDb(tables, {
    host_time_claim: claimsCollide,
    meeting_booking: (a, b) => a.id === b.id || a.manage_token_hash === b.manage_token_hash,
    ...unique,
  })

  // A lapsed claim that holds nothing up: an expired hold, or a booking's that is over. A lapsed request is the sweep's.
  const clearLapsed = (hosts: readonly unknown[]) => {
    const now = Date.now()
    const live = (c: Row) => tables.meeting_booking.some((b) => b.id === c.booking_id && ['requested', 'booking', 'confirmed'].includes(b.state as string))
    const gone = tables.host_time_claim.filter((c) => hosts.includes(c.host_user_id) && c.expires_at != null && t(c.expires_at) <= now && (c.kind === 'hold' || !live(c)))
    tables.host_time_claim = tables.host_time_claim.filter((c) => !gone.includes(c))
  }

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'book_meeting') {
      const p = { ...(args.p_booking as Row) }
      const hosts = (args.p_hosts as unknown[]) ?? []
      if (!hosts.length || !hosts.includes(p.host_user_id)) return { data: { status: 'invalid' }, error: null }
      clearLapsed(hosts)
      if (tables.meeting_booking.some((r) => r.id === p.id || r.manage_token_hash === p.manage_token_hash)) return { data: { status: 'exists', booking_id: p.id }, error: null }
      const nowIso = new Date().toISOString()
      const row: Row = {
        offer_id: null, link_id: null, channel: null, guest_email: null, guest_phone: null, guest_time_zone: null, guest_note: null, contact_id: null, quote_id: null, guest_id: null,
        kind: null, address: null, answers: [], video: false, location: null, calendar_account_id: null, calendar_id: null, calendar_event_id: null, conference_url: null,
        attempts: 0, reschedule_count: 0, last_error: null, cancelled_by: null, approval_id: null, customer_confirmed_at: null, decided_at: null, other_host_ids: [], host_time_zone: null,
        created_at: nowIso, updated_at: nowIso,
        ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === '' ? null : v])),
        state: p.state || 'booking',
      }
      const claims = claimsOf(row, { expiresAt: (args.p_claim_expires_at as string | null) ?? null }).map((c, i) => ({ ...c, host_user_id: hosts[i] }))
      if (claims.some((c) => tables.host_time_claim.some((o) => claimsCollide(o, c)))) return { data: { status: 'taken' }, error: null }
      tables.meeting_booking.push(row)
      tables.host_time_claim.push(...claims)
      return { data: { status: 'booked', booking_id: row.id }, error: null }
    }
    if (fn === 'move_meeting_booking') {
      const b = tables.meeting_booking.find((r) => r.id === args.p_booking_id)
      if (!b || b.state !== 'confirmed' || t(b.starts_at) !== t(args.p_from_start)) return { data: { status: 'changed' }, error: null }
      const hosts = [b.host_user_id, ...((b.other_host_ids as unknown[]) ?? [])]
      clearLapsed(hosts)
      const span = { starts_at: args.p_starts_at, ends_at: args.p_ends_at }
      let mine = tables.host_time_claim.filter((c) => c.booking_id === b.id)
      if (!mine.length) mine = claimsOf({ ...b, ...span })
      const moved = mine.map((c) => ({ ...c, ...span }))
      if (moved.some((c) => tables.host_time_claim.some((o) => o.booking_id !== b.id && claimsCollide(o, c)))) return { data: { status: 'taken' }, error: null }
      tables.host_time_claim = [...tables.host_time_claim.filter((c) => c.booking_id !== b.id), ...moved]
      Object.assign(b, { ...span, customer_confirmed_at: args.p_customer_confirmed_at ?? null, updated_at: new Date().toISOString() })
      return { data: { status: 'moved' }, error: null }
    }
    return { data: null, error: { message: `no function ${fn}` } }
  }
  return Object.assign(db, { rpc }) as unknown as SupabaseClient
}
