/**
 * Migration 554: time offers. Pins the file to the app and its intent: the
 * exclusion constraint that makes double booking impossible (two claims of
 * one host whose times overlap never both exist, unless one booking's move),
 * btree_gist for it, the generated range it runs on; the tokens stored only
 * hashed; the pick's one transaction (the offer row locked, expired holds
 * deleted first, the hold turned into the booking's claim, a collision
 * undoing it all); the states and sources the app writes; the columns the
 * store reads; RLS (members read, only the service role writes); re-runnable;
 * no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OFFER_STATES, SEND_BY, SLOT_STATES } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/554_time_offers.sql'), 'utf8')
// 581 widens meeting_booking for booking links and customers' jobs (its own test pins it).
const SQL_581 = readFileSync(join(process.cwd(), 'supabase/migrations/581_booking_links.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const STORE = readFileSync(join(process.cwd(), 'src/lib/time-offers/store.ts'), 'utf8')
const CLAIMS = readFileSync(join(process.cwd(), 'src/lib/availability/claims.ts'), 'utf8')
const FN = BODY.slice(BODY.indexOf('create or replace function public.book_time_offer_slot'), BODY.indexOf('comment on function public.book_time_offer_slot'))

const TABLES = ['time_offer', 'time_offer_slot', 'meeting_booking', 'host_time_claim', 'time_offer_failure']

describe('migration 554', () => {
  it('holds no backslash and takes its locks with a timeout', () => {
    expect(SQL).not.toContain('\\')
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('makes overlapping claims of one host impossible: an exclusion constraint on a generated range, btree_gist for the equality', () => {
    expect(BODY).toContain('create extension if not exists btree_gist;')
    expect(BODY).toContain("during tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,")
    expect(BODY).toContain('add constraint host_time_claim_no_overlap exclude using gist (host_user_id with =, during with &&, claim_key with <>);')
    // Holds and bookings alike, keyed by whose claim it is: a hold's offer, a booking's own id.
    expect(BODY).toContain("(kind = 'hold' and offer_id is not null and slot_id is not null and expires_at is not null and claim_key = offer_id) or (kind = 'booking' and booking_id is not null and claim_key = booking_id)")
    // The app writes the ends, never the range; it reads the ends.
    expect(STORE).not.toMatch(/during:/)
    expect(STORE).toContain("kind: 'hold',\n      claim_key: offer.id,")
    expect(CLAIMS).toContain(".select('id, starts_at, ends_at, kind, offer_id, booking_id, expires_at')")
  })

  it('stores only token hashes, each unique', () => {
    expect(BODY).toContain('token_hash text null,')
    expect(BODY).toContain('create unique index if not exists time_offer_token_hash_key on public.time_offer (token_hash) where token_hash is not null;')
    expect(BODY).toContain('manage_token_hash text not null,')
    expect(BODY).toContain('create unique index if not exists meeting_booking_manage_token_key on public.meeting_booking (manage_token_hash);')
    expect(BODY).not.toMatch(/\btoken text\b|manage_token text/)
    expect(BODY).toContain("add constraint time_offer_open_has_token check (state not in ('open', 'booked') or token_hash is not null);")
  })

  it("checks exactly the states, sources and ways of sending the app writes", () => {
    expect(BODY).toContain(`check (state in (${OFFER_STATES.map((s) => `'${s}'`).join(', ')}))`)
    expect(BODY).toContain(`check (state in (${SLOT_STATES.map((s) => `'${s}'`).join(', ')}))`)
    // 554's own four; 581 adds requested, declined and expired (migration-581.test.ts).
    expect(BODY).toContain("meeting_booking_state_check check (state in ('booking', 'confirmed', 'cancelled', 'failed'))")
    expect(BODY).toContain(`check (sent_via is null or sent_via in (${SEND_BY.map((s) => `'${s}'`).join(', ')}))`)
    expect(BODY).toContain("check (source in ('offer', 'link', 'customer', 'poll'))")
    expect(BODY).toContain('check (attempts >= 0 and reschedule_count between 0 and 3)')
  })

  it('the pick is one transaction: the offer locked, expired holds gone first, the hold becomes the claim, a collision undoes it all', () => {
    expect(FN).toContain('security definer')
    expect(FN).toContain("set search_path = ''")
    expect(FN).toContain('select * into v_offer from public.time_offer where id = p_offer_id for update;')
    expect(FN).toContain("if v_offer.state = 'booked' then return jsonb_build_object( 'status', 'already',")
    expect(FN).toContain("if v_offer.state <> 'open' or v_offer.expires_at <= now() then")
    expect(FN).toContain("if not found or v_slot.state <> 'open' or v_slot.starts_at <= now() then return jsonb_build_object('status', 'taken');")
    const expired = FN.indexOf("delete from public.host_time_claim where host_user_id = v_offer.host_user_id and kind = 'hold' and expires_at <= now();")
    const block = FN.indexOf("begin delete from public.host_time_claim where offer_id = p_offer_id and kind = 'hold';")
    const holds = FN.indexOf("delete from public.host_time_claim where offer_id = p_offer_id and kind = 'hold';")
    const booking = FN.indexOf('insert into public.meeting_booking (')
    const claim = FN.indexOf("insert into public.host_time_claim (workspace_id, host_user_id, starts_at, ends_at, kind, claim_key, booking_id) values (v_offer.workspace_id, v_offer.host_user_id, v_slot.starts_at, v_slot.ends_at, 'booking', p_booking_id, p_booking_id);")
    const handler = FN.indexOf("exception when exclusion_violation then return jsonb_build_object('status', 'taken'); end;")
    for (const at of [expired, block, holds, booking, claim, handler]) expect(at).toBeGreaterThan(-1)
    // The block opens with the holds' delete: everything from there to the handler is undone together.
    expect(holds).toBe(block + 'begin '.length)
    expect([expired, block, booking, claim, handler]).toEqual([...[expired, block, booking, claim, handler]].sort((a, b) => a - b))
    expect(SQL).toContain("exception when exclusion_violation then\n    -- Someone else's claim took the time once its hold was gone: nothing of this pick stays.")
    expect(FN).toContain("set state = case when id = p_slot_id then 'booked' else 'released' end where offer_id = p_offer_id and state = 'open';")
    expect(FN).toContain("set state = 'booked', booking_id = p_booking_id, updated_at = now() where id = p_offer_id;")
    expect(FN).toContain("'booking', v_offer.video")
    expect(BODY).toContain('revoke execute on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) to service_role;')
    // The store calls it with exactly these arguments.
    for (const arg of ['p_offer_id', 'p_slot_id', 'p_booking_id', 'p_guest', 'p_manage_token_hash', 'p_calendar_account_id', 'p_contact_id']) {
      expect(FN, arg).toContain(arg)
      expect(STORE, arg).toContain(`${arg}:`)
    }
  })

  it('every column the store selects is one the tables have', () => {
    const columns = (list: string) => list.split(',').map((c) => c.trim())
    const offer = /const OFFER_COLUMNS =\s*'([^']+)'/.exec(STORE)![1]
    const booking = /export const BOOKING_COLUMNS =\s*'([^']+)'/.exec(STORE)![1]
    const offerTable = BODY.slice(BODY.indexOf('create table if not exists public.time_offer ('), BODY.indexOf('comment on table public.time_offer is'))
    const bookingTable = BODY.slice(BODY.indexOf('create table if not exists public.meeting_booking ('), BODY.indexOf('comment on table public.meeting_booking is'))
    for (const c of columns(offer)) expect(offerTable, c).toMatch(new RegExp(`[( ,]${c} `))
    const added = [...SQL_581.matchAll(/alter table public\.meeting_booking add column if not exists (\w+) /g)].map((m) => m[1])
    for (const c of columns(booking)) {
      if (added.includes(c)) continue
      expect(bookingTable, c).toMatch(new RegExp(`[( ,]${c} `))
    }
  })

  it('RLS on every table: members of the workspace read, only the service role writes', () => {
    for (const table of TABLES) {
      expect(BODY, table).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY, table).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY, table).toContain(`grant all on table public.${table} to service_role;`)
      expect(BODY).not.toMatch(new RegExp(`grant (insert|update|delete|all) on table public\\.${table} to (anon|authenticated)`))
    }
    for (const table of ['time_offer', 'meeting_booking', 'host_time_claim']) {
      expect(BODY).toContain(`create policy ${table}_select_member on public.${table} for select to authenticated using (public.is_workspace_member(workspace_id));`)
    }
    expect(BODY).toContain('exists (select 1 from public.time_offer o where o.id = offer_id and public.is_workspace_member(o.workspace_id))')
    expect(BODY).not.toMatch(/create policy \w+ on public\.time_offer_failure/)
    expect(BODY).not.toMatch(/for (insert|update|delete|all) to (anon|authenticated)/)
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
