/**
 * Migration 667: a meeting guest's go to notes holds for the whole call.
 *
 * Two parts. The text checks always run: one transaction with a lock
 * timeout, no backslash, the five functions redefined with their owners'
 * pattern (definer, pinned search_path, the service role's alone), and the
 * newest definition of each is this file's. The engine checks run the file
 * (twice: it is re-runnable) on PGlite over small stand-ins for the tables
 * it reads, and play a call through: a guest who said go once is not held
 * and stays heard when the notes go off and on again; one who never did is
 * held; a go to a recording alone is not a go to notes; a recording still
 * asks for itself; a new call asks again.
 *
 * PGlite is not a dependency of this repository: the engine checks run only
 * where it resolves (`PGLITE_MODULE=/path/to/node_modules/@electric-sql/pglite/dist/index.js`
 * for a scratch install), and are skipped otherwise.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const FILE = '667_guest_notes_go_for_the_call.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')
const FUNCTIONS = ['meeting_guest_needs_notice', 'meeting_guest_ack', 'meeting_guest_egress_claim', 'capture_feed_hearable_guests', 'capture_feed_append']

function definition(name: string): string {
  const start = SQL.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  expect(start, name).toBeGreaterThanOrEqual(0)
  const open = SQL.indexOf('$$', start)
  const close = SQL.indexOf('$$;', open + 2)
  return SQL.slice(start, close + 3)
}

describe('migration 667 (the text)', () => {
  it('is the only 667, one transaction with a lock timeout, reloads the API schema, holds no backslash', () => {
    expect(migrationsInOrder().filter((m) => m.num === 667)).toHaveLength(1)
    const body = bodyOf(SQL)
    expect(SQL).not.toContain('\\')
    expect(body).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
    expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(body).not.toMatch(/concurrently|vacuum|drop |truncate|alter table|to anon|to authenticated/i)
  })

  it('redefines the five functions, each a definer with its search_path pinned, the service role’s alone; each is the newest definition', () => {
    const f = flat(SQL)
    for (const name of FUNCTIONS) {
      const def = flat(definition(name))
      expect(def, name).toContain('security definer set search_path = public, pg_temp')
      expect(f, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`))
      const newest = migrationsInOrder().filter((m) => m.sql.toLowerCase().includes(`create or replace function public.${name}(`)).at(-1)
      expect(newest?.file, name).toBe(FILE)
    }
    for (const grant of f.match(/grant execute on function [^;]+;/g) ?? []) expect(grant).toMatch(/ to service_role;$/)
  })

  it('no comparison with the call’s round is left: a go once in the call is enough', () => {
    const body = bodyOf(SQL)
    expect(body).not.toMatch(/notes_ack_round\s*(<|>=)\s*[cs]\.(notes_)?round/)
    expect(flat(definition('meeting_guest_needs_notice'))).toContain('(c.notes and g.notes_ack_round < 1)')
    expect(flat(definition('meeting_guest_needs_notice'))).toContain('g.recording_ack_at < c.recording_started_at')
    expect(flat(definition('meeting_guest_ack'))).toContain('set notes_ack_round = case when c.notes then greatest(x.notes_ack_round, c.notes_round, 1) else x.notes_ack_round end')
    expect(flat(definition('meeting_guest_egress_claim'))).toContain('and g.notes_ack_round > 0')
    expect(flat(definition('capture_feed_hearable_guests'))).toContain('and g.notes_ack_round > 0')
    expect(flat(definition('capture_feed_append'))).toContain('g.id = sp.guest_id and g.notes_ack_round > 0')
  })

  it('capture_feed_append is 588’s word for word but for the guest’s rule', () => {
    const before = readFileSync(join(process.cwd(), 'supabase/migrations/588_capture_feed_functions.sql'), 'utf8')
    const start = before.search(/create or replace function public\.capture_feed_append\(/)
    const old = before.slice(start, before.indexOf('$$;', before.indexOf('$$', start) + 2) + 3)
    expect(flat(definition('capture_feed_append'))).toBe(flat(old).replace('g.notes_ack_round >= s.round', 'g.notes_ack_round > 0'))
  })
})

// ── The engine ─────────────────────────────────────────────────────────────

interface Db {
  exec(sql: string): Promise<unknown>
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

async function loadPglite(): Promise<(new () => Db) | null> {
  const spec = process.env.PGLITE_MODULE || '@electric-sql/pglite'
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { PGlite: new () => Db }
    return mod.PGlite
  } catch {
    return null
  }
}

const PGlite = await loadPglite()

/** What 667 reads, as small as it can be (the real tables are 565-588's). */
const STAND_INS = `
create role anon; create role authenticated; create role service_role;
create table public.meeting (id uuid primary key, token_hash text not null);
create table public.team_call (
  id uuid primary key, workspace_id uuid not null, channel_id uuid not null, room text not null, status text not null,
  notes boolean not null default false, notes_round integer not null default 0,
  recording text not null default 'off', recording_started_at timestamptz
);
create table public.meeting_guest (
  id uuid primary key, meeting_id uuid not null references public.meeting(id), channel_id uuid not null, state text not null,
  call_id uuid, notes_ack_round integer not null default 0 check (notes_ack_round >= 0), recording_ack_at timestamptz
);
create table public.team_call_egress (
  id uuid primary key, call_id uuid not null, workspace_id uuid not null, channel_id uuid not null, kind text not null,
  member_id uuid, guest_id uuid, track_sid text not null, round integer not null, file_path text not null
);
create unique index on public.team_call_egress (call_id, track_sid, round) where kind = 'notes';
create table public.captures (id uuid primary key, workspace_id uuid not null, ended_at timestamptz, is_transcript_locked boolean not null default false, transcript text);
create table public.capture_feed_session (
  id uuid primary key, source_kind text not null, source_ref uuid not null, round integer not null, producer_id text,
  capture_id uuid not null, started_at timestamptz not null, ended_at timestamptz, segments integer not null default 0, updated_at timestamptz
);
create table public.capture_feed_speaker (capture_id uuid not null, speaker_key text not null, label text not null, guest_id uuid, primary key (capture_id, speaker_key));
create table public.capture_feed_segment (
  session_id uuid not null, capture_id uuid not null, key text not null, speaker_key text not null,
  start_ms bigint not null, end_ms bigint not null, said_at timestamptz not null, text text not null, primary key (session_id, key)
);
create function public.append_capture_transcript(cap uuid, ws uuid, more text, expected integer)
returns table (status text, server_length integer) language plpgsql as $$
begin
  update public.captures set transcript = coalesce(transcript, '') || more where id = cap;
  return query select 'applied'::text, (select char_length(transcript) from public.captures where id = cap);
end;
$$;
`

const WS = '00000000-0000-4000-8000-000000000001'
const CHANNEL = '00000000-0000-4000-8000-000000000002'
const MEETING = '00000000-0000-4000-8000-000000000003'
const CALL = '00000000-0000-4000-8000-000000000004'
const NEXT_CALL = '00000000-0000-4000-8000-000000000005'
const CAPTURE = '00000000-0000-4000-8000-000000000006'
const DANA = '00000000-0000-4000-8000-0000000000a1' // says go in round 1
const LEE = '00000000-0000-4000-8000-0000000000a2' // never says go
const RIO = '00000000-0000-4000-8000-0000000000a3' // says go to a recording while the notes are off
const SAM = '00000000-0000-4000-8000-0000000000a4' // agreed on the entry page (the app wrote 1 at join)
const DANA_AGAIN = '00000000-0000-4000-8000-0000000000a5' // Dana, in a later call on the same link
const DIGEST = 'digest-of-the-link'

describe.skipIf(!PGlite)('migration 667 (run on PGlite)', () => {
  let db: Db
  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  const needsNotice = async (guest: string, call = CALL) =>
    (
      await one<{ v: boolean }>(
        'select public.meeting_guest_needs_notice(g, c) as v from public.meeting_guest g, public.team_call c where g.id = $1 and c.id = $2',
        [guest, call],
      )
    ).v
  const ack = (guest: string) => db.query<{ call_id: string }>('select * from public.meeting_guest_ack($1, $2)', [guest, DIGEST])
  const hearable = async (round: number) =>
    (await one<{ v: string[] }>(`select public.capture_feed_hearable_guests(s) as v from public.capture_feed_session s where s.round = $1`, [round])).v
  const claim = async (guest: string, track: string) => (await db.query('select * from public.meeting_guest_egress_claim($1, $2, $3)', [CALL, guest, track])).rows.length
  const notes = async (on: boolean) =>
    db.query(`update public.team_call set notes = $1, notes_round = notes_round + case when $1 then 1 else 0 end where id = $2`, [on, CALL])
  const appendFor = async (session: string, speaker: string, key: string) =>
    one<{ accepted: number; dropped: number }>('select accepted, dropped from public.capture_feed_append($1, $2, $3::jsonb)', [
      session,
      'rec-1',
      JSON.stringify([{ key, speaker, text: 'Hello there', start_ms: 1000, end_ms: 2000 }]),
    ])

  beforeAll(async () => {
    db = new PGlite!()
    await db.exec(STAND_INS)
    // Twice: the file is re-runnable.
    await db.exec(SQL)
    await db.exec(SQL)
    await db.exec(`
      insert into public.meeting values ('${MEETING}', '${DIGEST}');
      insert into public.team_call (id, workspace_id, channel_id, room, status) values ('${CALL}', '${WS}', '${CHANNEL}', 'room-1', 'live');
      insert into public.meeting_guest (id, meeting_id, channel_id, state, call_id, notes_ack_round) values
        ('${DANA}', '${MEETING}', '${CHANNEL}', 'admitted', '${CALL}', 0),
        ('${LEE}', '${MEETING}', '${CHANNEL}', 'admitted', '${CALL}', 0),
        ('${RIO}', '${MEETING}', '${CHANNEL}', 'admitted', '${CALL}', 0),
        ('${SAM}', '${MEETING}', '${CHANNEL}', 'admitted', '${CALL}', 1);
      insert into public.captures (id, workspace_id) values ('${CAPTURE}', '${WS}');
      insert into public.capture_feed_speaker values ('${CAPTURE}', 'guest-dana', 'Dana Okafor', '${DANA}'), ('${CAPTURE}', 'guest-lee', 'Lee Park', '${LEE}');
    `)
  }, 60_000)

  it('the functions stay the service role’s alone, definers with their search_path pinned', async () => {
    for (const name of FUNCTIONS) {
      const row = await one<{ definer: boolean; config: string[]; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
           from pg_proc p where p.proname = $1`,
        [name],
      )
      expect(row.definer, name).toBe(true)
      expect(row.config, name).toContain('search_path=public, pg_temp')
      expect(row.anon || row.auth || row.pub, name).toBe(false)
      if (name !== 'meeting_guest_needs_notice' && name !== 'capture_feed_hearable_guests') expect(row.svc, name).toBe(true)
    }
  })

  it('a recording said go to while the notes are off is not a go to the notes', async () => {
    await db.query(`update public.team_call set recording = 'on', recording_started_at = now() - interval '1 minute' where id = $1`, [CALL])
    expect(await needsNotice(RIO)).toBe(true)
    await ack(RIO)
    expect(await needsNotice(RIO)).toBe(false)
    expect((await one<{ n: number }>('select notes_ack_round as n from public.meeting_guest where id = $1', [RIO])).n).toBe(0)
    await db.query(`update public.team_call set recording = 'saved' where id = $1`, [CALL])
  })

  it('notes on (round 1): who never said go is held, heard by nobody, kept out of the notes; who agreed on the entry page is not', async () => {
    await notes(true)
    await db.query(`insert into public.capture_feed_session (id, source_kind, source_ref, round, producer_id, capture_id, started_at)
                    values ('00000000-0000-4000-8000-0000000000b1', 'team_call', $1, 1, 'rec-1', $2, now())`, [CALL, CAPTURE])
    expect(await needsNotice(DANA)).toBe(true)
    expect(await needsNotice(LEE)).toBe(true)
    expect(await needsNotice(RIO)).toBe(true)
    expect(await needsNotice(SAM)).toBe(false)
    expect(await hearable(1)).toEqual([SAM])
    expect(await claim(DANA, 'TR_dana_1')).toBe(0)
    expect(await appendFor('00000000-0000-4000-8000-0000000000b1', 'guest-dana', 'k1')).toMatchObject({ accepted: 0, dropped: 1 })
  })

  it('Dana says go: heard, her notes file made, her words kept', async () => {
    expect((await ack(DANA)).rows).toEqual([{ call_id: CALL, room: 'room-1' }])
    expect((await one<{ n: number }>('select notes_ack_round as n from public.meeting_guest where id = $1', [DANA])).n).toBe(1)
    expect(await needsNotice(DANA)).toBe(false)
    expect(await hearable(1)).toEqual([DANA, SAM])
    expect(await claim(DANA, 'TR_dana_1')).toBe(1)
    expect(await appendFor('00000000-0000-4000-8000-0000000000b1', 'guest-dana', 'k2')).toMatchObject({ accepted: 1, dropped: 0 })
  })

  it('notes off and on again (round 2): Dana and Sam are not held and stay heard; Lee and Rio are still asked', async () => {
    await notes(false)
    await db.query(`update public.capture_feed_session set ended_at = now() where round = 1`)
    await notes(true)
    expect((await one<{ r: number }>('select notes_round as r from public.team_call where id = $1', [CALL])).r).toBe(2)
    await db.query(`insert into public.capture_feed_session (id, source_kind, source_ref, round, producer_id, capture_id, started_at)
                    values ('00000000-0000-4000-8000-0000000000b2', 'team_call', $1, 2, 'rec-1', $2, now())`, [CALL, CAPTURE])
    expect(await needsNotice(DANA)).toBe(false)
    expect(await needsNotice(SAM)).toBe(false)
    expect(await needsNotice(LEE)).toBe(true)
    expect(await needsNotice(RIO)).toBe(true)
    expect(await hearable(2)).toEqual([DANA, SAM])
    expect(await claim(DANA, 'TR_dana_2')).toBe(1)
    expect(await claim(LEE, 'TR_lee_2')).toBe(0)
    expect(await appendFor('00000000-0000-4000-8000-0000000000b2', 'guest-dana', 'k3')).toMatchObject({ accepted: 1, dropped: 0 })
    expect(await appendFor('00000000-0000-4000-8000-0000000000b2', 'guest-lee', 'k4')).toMatchObject({ accepted: 0, dropped: 1 })
    // A later go keeps the count above 0 (never lowers it).
    await ack(DANA)
    expect((await one<{ n: number }>('select notes_ack_round as n from public.meeting_guest where id = $1', [DANA])).n).toBe(2)
  })

  it('a recording that starts later still asks Dana for itself', async () => {
    await db.query(`update public.team_call set recording = 'starting', recording_started_at = now() + interval '1 second' where id = $1`, [CALL])
    expect(await needsNotice(DANA)).toBe(true)
    await db.query(`update public.team_call set recording = 'saved' where id = $1`, [CALL])
    expect(await needsNotice(DANA)).toBe(false)
  })

  it('a new call on the same link asks again: her new stay starts at 0', async () => {
    await db.exec(`
      update public.team_call set status = 'ended', notes = false where id = '${CALL}';
      update public.meeting_guest set state = 'left' where call_id = '${CALL}';
      insert into public.team_call (id, workspace_id, channel_id, room, status, notes, notes_round) values ('${NEXT_CALL}', '${WS}', '${CHANNEL}', 'room-2', 'live', true, 1);
      insert into public.meeting_guest (id, meeting_id, channel_id, state, call_id) values ('${DANA_AGAIN}', '${MEETING}', '${CHANNEL}', 'admitted', '${NEXT_CALL}');
    `)
    expect(await needsNotice(DANA_AGAIN, NEXT_CALL)).toBe(true)
  })
})
