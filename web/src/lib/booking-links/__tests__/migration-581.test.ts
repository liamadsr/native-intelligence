/**
 * Migration 581: booking links, and customer bookings on the one booking
 * model. Pins the file to the app and its intent: the tables and the
 * columns the stores read; the one atomic path (a booking and a claim per
 * host in one block, lapsed claims cleared first, a collision leaving
 * nothing; the offer's pick written through it too); the move of a booking
 * with its claims; the fold (customer bookings carried over by id,
 * idempotently, the live ones with their claims; each business's booking
 * rules as its job link, its slug as the workspace's handle) with the old
 * table and columns kept as the undo; the states and checks the app writes;
 * RLS (members read, only the service role writes); FKs and lookups
 * indexed; re-runnable; no backslash; the number outside 555–579.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEETING_BOOKING_STATES } from '@/lib/time-offers/types'
import { BOOKING_SOURCES } from '@/lib/customers/types'
import { HOST_MODES, LINK_PURPOSES } from '../types'

const FILE = '581_booking_links.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const LINK_STORE = read('src/lib/booking-links/store.ts')
const OFFER_STORE = read('src/lib/time-offers/store.ts')
const CUSTOMER_STORE = read('src/lib/customers/store.ts')
const fn = (name: string) => BODY.slice(BODY.indexOf(`create or replace function public.${name}(`), BODY.indexOf(`comment on function public.${name}(`))
const table = (name: string) => BODY.slice(BODY.indexOf(`create table if not exists public.${name} (`), BODY.indexOf(`comment on table public.${name} is`))
const added = [...BODY.matchAll(/alter table public\.meeting_booking add column if not exists (\w+) /g)].map((m) => m[1])
const MEETING_554 = read('supabase/migrations/554_time_offers.sql').replace(/\s+/g, ' ')
const meetingTable = MEETING_554.slice(MEETING_554.indexOf('create table if not exists public.meeting_booking ('), MEETING_554.indexOf('comment on table public.meeting_booking is'))
const columns = (list: string) => list.split(',').map((c) => c.trim())
const constant = (src: string, name: string) => new RegExp(`const ${name} =\\s*'([^']+)'`).exec(src)![1]

describe('migration 581', () => {
  it('is numbered after 580 and outside 555–579, holds no backslash, and takes its locks with a timeout', () => {
    const numbers = readdirSync(join(process.cwd(), 'supabase/migrations')).map((f) => Number(f.split('_')[0])).filter(Number.isFinite)
    expect(numbers.filter((n) => n === 581)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('every column the stores read is one the tables have', () => {
    const link = table('booking_link')
    for (const c of columns(constant(LINK_STORE, 'LINK_COLUMNS'))) expect(link, c).toMatch(new RegExp(`[( ,]${c} `))
    for (const c of columns(constant(LINK_STORE, 'PROFILE_COLUMNS'))) expect(table('booking_profile'), c).toMatch(new RegExp(`[( ,]${c} `))
    for (const c of columns(constant(LINK_STORE, 'HOST_COLUMNS'))) expect(table('booking_link_host'), c).toMatch(new RegExp(`[( ,]${c} `))
    const offerColumns = /export const BOOKING_COLUMNS =\s*'([^']+)'/.exec(OFFER_STORE)![1]
    const customerColumns = /export const BOOKING_SELECT =\s*'([^']+)'/.exec(CUSTOMER_STORE)![1]
    for (const c of [...columns(offerColumns), ...columns(customerColumns)]) {
      expect(added.includes(c) || new RegExp(`[( ,]${c} `).test(meetingTable), c).toBe(true)
    }
  })

  it('checks exactly the states, sources, modes and channels the app writes', () => {
    expect(BODY).toContain(`meeting_booking_state_check check (state in (${MEETING_BOOKING_STATES.map((s) => `'${s}'`).join(', ')}))`)
    expect(BODY).toContain(`meeting_booking_channel_check check (channel is null or channel in (${BOOKING_SOURCES.map((s) => `'${s}'`).join(', ')}))`)
    expect(BODY).toContain(`booking_link_host_mode_check check (host_mode in (${HOST_MODES.map((s) => `'${s}'`).join(', ')}))`)
    expect(BODY).toContain(`booking_link_purpose_check check (purpose in (${LINK_PURPOSES.map((s) => `'${s}'`).join(', ')}))`)
    // The ranges input.ts and links.ts keep.
    expect(BODY).toContain('duration_minutes between 5 and 480 and buffer_before_minutes between 0 and 240 and buffer_after_minutes between 0 and 240 and notice_minutes between 0 and 20160 and window_days between 1 and 180')
  })

  it('a handle is unique across everyone, one per workspace and one per person in it; a slug once per handle; one job link per workspace', () => {
    expect(BODY).toContain('create unique index if not exists booking_profile_handle_key on public.booking_profile (handle);')
    expect(BODY).toContain('create unique index if not exists booking_profile_workspace_key on public.booking_profile (workspace_id) where user_id is null;')
    expect(BODY).toContain('create unique index if not exists booking_profile_person_key on public.booking_profile (workspace_id, user_id) where user_id is not null;')
    expect(BODY).toContain('create unique index if not exists booking_link_profile_slug_key on public.booking_link (profile_id, slug) where profile_id is not null;')
    expect(BODY).toContain("create unique index if not exists booking_link_job_key on public.booking_link (workspace_id) where purpose = 'job';")
  })

  it('one atomic path: the booking and a claim for each host in one block, lapsed claims cleared first, a collision leaving nothing', () => {
    const write = fn('write_meeting_booking')
    expect(write).toContain('security definer')
    expect(write).toContain("set search_path = ''")
    expect(write).toContain('insert into public.meeting_booking (')
    expect(write).toContain("select (p_booking->>'workspace_id')::uuid, h, v_starts, v_ends, 'booking', v_id, v_id, p_claim_expires_at from unnest(p_hosts) as h;")
    expect(write).not.toContain('exception')
    const book = fn('book_meeting')
    expect(book).toContain("if coalesce(array_length(p_hosts, 1), 0) = 0 or not ((p_booking->>'host_user_id')::uuid = any(p_hosts)) then return jsonb_build_object('status', 'invalid');")
    const lapsed = book.indexOf('delete from public.host_time_claim where host_user_id = any(p_hosts) and expires_at is not null and expires_at <= now() returning booking_id')
    const expire = book.indexOf("set state = 'expired', decided_at = now(), updated_at = now() where id in (select booking_id from gone where booking_id is not null) and state = 'requested';")
    const block = book.indexOf('begin perform public.write_meeting_booking(p_booking, p_hosts, p_claim_expires_at);')
    const taken = book.indexOf("exception when exclusion_violation then return jsonb_build_object('status', 'taken');")
    expect([lapsed, expire, block, taken].every((at) => at > -1)).toBe(true)
    expect([lapsed, expire, block, taken]).toEqual([lapsed, expire, block, taken].sort((a, b) => a - b))
    expect(book).toContain("when unique_violation then return jsonb_build_object('status', 'exists', 'booking_id', p_booking->>'id');")
    // The store calls it with exactly these arguments, the organizer first among the hosts.
    for (const arg of ['p_booking', 'p_hosts', 'p_claim_expires_at']) expect(OFFER_STORE, arg).toContain(`${arg}:`)
    for (const name of ['write_meeting_booking(jsonb, uuid[], timestamptz)', 'book_meeting(jsonb, uuid[], timestamptz)']) {
      expect(BODY).toContain(`revoke execute on function public.${name} from public, anon, authenticated;`)
      expect(BODY).toContain(`grant execute on function public.${name} to service_role;`)
    }
  })

  it("the offer's pick (554's) writes its booking through the same path, in the same block, its holds undone with it", () => {
    const pick = fn('book_time_offer_slot')
    // The block opens with the holds' delete, then the write: a collision undoes both.
    const block = pick.indexOf("begin delete from public.host_time_claim where offer_id = p_offer_id and kind = 'hold'; perform public.write_meeting_booking(")
    const handler = pick.indexOf("exception when exclusion_violation then return jsonb_build_object('status', 'taken'); end;")
    expect(pick).toContain('select * into v_offer from public.time_offer where id = p_offer_id for update;')
    expect(pick).toContain("'host_time_zone', v_offer.time_zone")
    expect(pick).toContain('array[v_offer.host_user_id], null')
    expect(block).toBeGreaterThan(-1)
    expect(handler).toBeGreaterThan(block)
    expect(pick).not.toContain('insert into public.meeting_booking')
    expect(BODY).toContain('grant execute on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) to service_role;')
  })

  it('a move takes the booking and every claim of its together, fenced on where it was', () => {
    const move = fn('move_meeting_booking')
    expect(move).toContain('select * into v_booking from public.meeting_booking where id = p_booking_id for update;')
    expect(move).toContain("if not found or v_booking.state <> 'confirmed' or v_booking.starts_at <> p_from_start then return jsonb_build_object('status', 'changed');")
    expect(move).toContain('update public.host_time_claim set starts_at = p_starts_at, ends_at = p_ends_at where booking_id = p_booking_id;')
    expect(move).toContain("exception when exclusion_violation then return jsonb_build_object('status', 'taken');")
    for (const arg of ['p_booking_id', 'p_from_start', 'p_starts_at', 'p_ends_at', 'p_customer_confirmed_at']) expect(OFFER_STORE, arg).toContain(`${arg}:`)
  })

  it('folds customer bookings in by id, idempotently, the live ones with their claims; the old table stays as the undo', () => {
    expect(BODY).toContain("'customer', cb.source, case when cb.source = 'link' then jl.id end, cb.customer_name, cb.customer_phone, cb.note,")
    expect(BODY).toContain("'none:' || cb.id::text")
    expect(BODY).toContain('from public.customer_booking cb')
    expect(BODY).toContain('on conflict (id) do nothing;')
    expect(BODY).toContain("and (mb.state = 'confirmed' or (mb.state = 'requested' and mb.created_at > now() - interval '24 hours'))")
    expect(BODY).toContain('and not exists (select 1 from public.host_time_claim c where c.booking_id = mb.id)')
    expect(BODY).toContain("exception when exclusion_violation then raise notice 'customer booking % overlaps another claim: carried over without one', r.id;")
    expect(BODY).not.toMatch(/drop table|drop column|delete from public\.customer_booking|truncate/i)
    expect(BODY).toContain("comment on table public.customer_booking is 'A job slot a customer asked for (458). Moved onto meeting_booking (source customer, the same ids) by 581, and no longer written: kept as the undo.';")
  })

  it("each business's booking rules become its job link, its slug the workspace handle", () => {
    expect(BODY).toContain('insert into public.booking_profile (workspace_id, user_id, handle) select bp.workspace_id, null, bp.booking_slug from public.business_profile bp where bp.booking_slug is not null on conflict do nothing;')
    expect(BODY).toContain("where not exists (select 1 from public.booking_link l where l.workspace_id = bp.workspace_id and l.purpose = 'job');")
    expect(BODY).toContain("then jsonb_build_array(jsonb_build_object('start', bp.booking_start, 'end', bp.booking_end))")
    expect(BODY).toContain('least(bp.lead_hours * 60, 20160)')
    expect(BODY).toContain("insert into public.booking_link_host (link_id, user_id, workspace_id, position) select l.id, l.owner_user_id, l.workspace_id, 0 from public.booking_link l where l.purpose = 'job' on conflict do nothing;")
  })

  it('RLS on every new table: members read (not the attempts), only the service role writes', () => {
    for (const t of ['booking_profile', 'booking_link', 'booking_link_host', 'booking_link_attempt']) {
      expect(BODY, t).toContain(`alter table public.${t} enable row level security;`)
      expect(BODY, t).toContain(`revoke all on table public.${t} from anon, authenticated;`)
      expect(BODY, t).toContain(`grant all on table public.${t} to service_role;`)
      expect(BODY).not.toMatch(new RegExp(`grant (insert|update|delete|all) on table public\\.${t} to (anon|authenticated)`))
    }
    for (const t of ['booking_profile', 'booking_link', 'booking_link_host']) {
      expect(BODY).toContain(`create policy ${t}_select_member on public.${t} for select to authenticated using (public.is_workspace_member(workspace_id));`)
    }
    expect(BODY).not.toMatch(/create policy \w+ on public\.booking_link_attempt/)
  })

  it("indexes every new foreign key and the lookups the app makes", () => {
    for (const index of [
      'booking_profile_user_idx on public.booking_profile (user_id)',
      'booking_link_owner_idx on public.booking_link (owner_user_id)',
      'booking_link_profile_idx on public.booking_link (profile_id)',
      'booking_link_host_user_idx on public.booking_link_host (user_id)',
      'booking_link_host_workspace_idx on public.booking_link_host (workspace_id)',
      'booking_link_attempt_link_idx on public.booking_link_attempt (link_id, created_at)',
      'meeting_booking_link_idx on public.meeting_booking (link_id, starts_at)',
      'meeting_booking_quote_idx on public.meeting_booking (quote_id)',
      'meeting_booking_guest_idx on public.meeting_booking (guest_id)',
      'meeting_booking_approval_idx on public.meeting_booking (approval_id)',
      'meeting_booking_contact_idx on public.meeting_booking (contact_id)',
      'meeting_booking_guest_phone_idx on public.meeting_booking (workspace_id, guest_phone)',
    ]) {
      expect(BODY, index).toContain(`create index if not exists ${index}`)
    }
  })

  it('re-runnable: every create and add guarded, every constraint and policy dropped first', () => {
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    expect(BODY).not.toMatch(/create function /)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]}`)
    for (const m of BODY.matchAll(/create policy (\w+) on (public\.\w+)/g)) expect(BODY).toContain(`drop policy if exists ${m[1]} on ${m[2]};`)
  })
})
