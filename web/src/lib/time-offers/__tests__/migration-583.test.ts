/**
 * Migration 583: polls. Pins the file to the app and its intent: the
 * columns the poll store reads; the modes and ways in the app writes; a
 * poll open with no token of its own (its guests have theirs) while a pick
 * still needs one; the answer and the booking each under the offer's lock,
 * the booking re-checking every answer and writing through the one booking
 * path; RLS (members read, only the service role writes); FKs and lookups
 * indexed; re-runnable; no backslash; the number outside 555–579. (The SQL
 * itself was run on a throwaway in-memory database: see the phase report.)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ANSWER_VIA, OFFER_MODES } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/583_time_offer_polls.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const STORE = readFileSync(join(process.cwd(), 'src/lib/time-offers/poll-store.ts'), 'utf8')
const OFFER_STORE = readFileSync(join(process.cwd(), 'src/lib/time-offers/store.ts'), 'utf8')
const fn = (name: string) => BODY.slice(BODY.indexOf(`create or replace function public.${name}(`), BODY.indexOf(`comment on function public.${name}(`))
const table = (name: string) => BODY.slice(BODY.indexOf(`create table if not exists public.${name} (`), BODY.indexOf(`comment on table public.${name} is`))
const columns = (list: string) => list.split(',').map((c) => c.trim())

describe('migration 583', () => {
  it('is numbered once, outside 555–579, holds no backslash, and takes its locks with a timeout', () => {
    const numbers = readdirSync(join(process.cwd(), 'supabase/migrations')).map((f) => Number(f.split('_')[0])).filter(Number.isFinite)
    expect(numbers.filter((n) => n === 583)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('every column the stores read is one the tables have', () => {
    const recipient = table('time_offer_recipient')
    for (const c of columns(/export const RECIPIENT_COLUMNS =\s*'([^']+)'/.exec(STORE)![1])) expect(recipient, c).toMatch(new RegExp(`[( ,]${c} `))
    for (const c of ['recipient_id', 'slot_id', 'offer_id', 'works', 'answered_at']) expect(table('time_offer_response'), c).toMatch(new RegExp(`[( ,]${c} `))
    const offerColumns = columns(/const OFFER_COLUMNS =\s*'([^']+)'/.exec(OFFER_STORE)![1])
    for (const c of ['mode', 'co_host_ids']) {
      expect(offerColumns).toContain(c)
      expect(BODY).toContain(`alter table public.time_offer add column if not exists ${c} `)
    }
  })

  it('checks exactly the modes and ways in the app writes; a pick still needs its token, a poll never does', () => {
    expect(BODY).toContain(`time_offer_mode_check check (mode in (${OFFER_MODES.map((m) => `'${m}'`).join(', ')}))`)
    expect(BODY).toContain(`time_offer_recipient_via_check check (answered_via is null or answered_via in (${ANSWER_VIA.map((v) => `'${v}'`).join(', ')}))`)
    expect(BODY).toContain("time_offer_open_has_token check (mode = 'poll' or state not in ('open', 'booked') or token_hash is not null)")
    expect(fn('answer_time_offer')).toContain(`p_via not in (${ANSWER_VIA.map((v) => `'${v}'`).join(', ')})`)
  })

  it("an answer: under the offer's lock, only the poll's own open times, replaced whole, a page's saves capped", () => {
    const answer = fn('answer_time_offer')
    expect(answer).toContain('security definer')
    expect(answer).toContain("set search_path = ''")
    expect(answer).toContain('select * into v_offer from public.time_offer where id = p_offer_id for update;')
    expect(answer).toContain("s.offer_id = p_offer_id and s.state = 'open'")
    expect(answer).toContain('delete from public.time_offer_response where recipient_id = p_recipient_id;')
    expect(answer).toContain('p_save_cap is not null')
    expect(answer).toContain("'waiting', v_waiting")
  })

  it('the booking: the same lock, every answer re-read, the attendees only the poll\'s, the one booking path, nothing left on a collision', () => {
    const book = fn('book_time_offer_poll')
    expect(book).toContain('select * into v_offer from public.time_offer where id = p_offer_id for update;')
    expect(book).toContain("if v_offer.state = 'booked' then return jsonb_build_object( 'status', 'already'")
    expect(book).toContain('if p_everyone and exists (')
    expect(book).toContain('x.slot_id = p_slot_id and x.works')
    expect(book).toContain('where not exists (select 1 from public.time_offer_recipient r where r.id = a.id and r.offer_id = p_offer_id)')
    expect(book).toContain("delete from public.host_time_claim where offer_id = p_offer_id and kind = 'hold';")
    expect(book).toContain('perform public.write_meeting_booking(')
    expect(book).toContain("'source', 'poll'")
    expect(book).toContain('v_hosts := array_prepend(v_offer.host_user_id,')
    expect(book).toContain("exception when exclusion_violation then return jsonb_build_object('status', 'taken');")
  })

  it('the store calls each function with exactly its arguments', () => {
    for (const [name, args] of [
      ['answer_time_offer', ['p_offer_id', 'p_recipient_id', 'p_works', 'p_note', 'p_via', 'p_save_cap']],
      ['book_time_offer_poll', ['p_offer_id', 'p_slot_id', 'p_booking_id', 'p_manage_token_hash', 'p_calendar_account_id', 'p_guest_name', 'p_attendees', 'p_manage_hashes', 'p_everyone']],
    ] as const) {
      for (const arg of args) {
        expect(fn(name), arg).toContain(arg)
        expect(STORE, arg).toContain(`${arg}:`)
      }
      expect(BODY).toContain(`revoke execute on function public.${name}(`)
      expect(BODY).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`))
    }
  })

  it('RLS on both tables: members of the workspace read, only the service role writes', () => {
    for (const t of ['time_offer_recipient', 'time_offer_response']) {
      expect(BODY).toContain(`alter table public.${t} enable row level security;`)
      expect(BODY).toContain(`create policy ${t}_select_member on public.${t} for select to authenticated using (`)
      expect(BODY).toContain(`revoke all on table public.${t} from anon, authenticated;`)
      expect(BODY).toContain(`grant select on table public.${t} to authenticated;`)
      expect(BODY).toContain(`grant all on table public.${t} to service_role;`)
    }
  })

  it('every lookup and FK is indexed; the links are unique', () => {
    for (const index of [
      'time_offer_recipient_position_key on public.time_offer_recipient (offer_id, position)',
      'time_offer_recipient_token_hash_key on public.time_offer_recipient (token_hash) where token_hash is not null',
      'time_offer_recipient_manage_hash_key on public.time_offer_recipient (manage_token_hash) where manage_token_hash is not null',
      'time_offer_recipient_workspace_idx on public.time_offer_recipient (workspace_id)',
      'time_offer_recipient_phone_idx on public.time_offer_recipient (workspace_id, phone) where phone is not null',
      'time_offer_recipient_contact_idx on public.time_offer_recipient (contact_id) where contact_id is not null',
      'time_offer_recipient_peer_idx on public.time_offer_recipient (peer_user_id) where peer_user_id is not null',
      'time_offer_response_slot_idx on public.time_offer_response (slot_id)',
      'time_offer_response_offer_idx on public.time_offer_response (offer_id)',
    ]) {
      expect(BODY).toContain(index)
    }
    expect(table('time_offer_response')).toContain('primary key (recipient_id, slot_id)')
  })

  it('re-runnable: every table and index if not exists, every constraint and policy dropped first', () => {
    const creates = BODY.match(/create (unique )?index (?!if not exists)/g) ?? []
    expect(creates).toEqual([])
    expect(BODY.match(/create table (?!if not exists)/g) ?? []).toEqual([])
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    for (const m of BODY.matchAll(/create policy (\w+)/g)) expect(BODY).toContain(`drop policy if exists ${m[1]} `)
  })
})
