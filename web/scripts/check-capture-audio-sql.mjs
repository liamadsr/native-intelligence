/** Isolated check of migrations 650-651 (a call's audio files; every bucket without a limit of its
 * own gets today's 50 MB) on a real Postgres engine. No network, no application database.
 * Requires @electric-sql/pglite in the executing directory: install it in a temporary directory
 * and run this file there with `node --input-type=module < file`, with CAPTURE_AUDIO_MIGRATIONS set
 * to the absolute path of web/supabase/migrations.
 *
 * What 650 leans on is stubbed (the tables with the columns it reads; Storage's two tables; a
 * captures read policy that lets a capture's owner read it, standing in for the real ones). Each
 * file is applied twice (it must be re-runnable), then the catalogue rules, then the functions
 * with real rows, then the read policy as a signed-in person.
 *
 * PGlite runs one PostgreSQL connection: the row lock the grant takes is not exercised under real
 * concurrency. PostgREST's rpc shapes are not covered.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const DIR = process.env.CAPTURE_AUDIO_MIGRATIONS
if (!DIR) throw new Error('set CAPTURE_AUDIO_MIGRATIONS to web/supabase/migrations')

const db = new PGlite()
let checks = 0
const ok = (cond, msg, detail) => {
  assert.ok(cond, `${msg}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
  checks++
}
const q = async (sql, params) => (await db.query(sql, params)).rows

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon, service_role;
grant usage on schema storage to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
create table public.workspace (id uuid primary key);
create table public.captures (id uuid primary key, workspace_id uuid not null references public.workspace(id), user_id uuid not null);
alter table public.captures enable row level security;
create policy "own" on public.captures for select to authenticated using (user_id = auth.uid());
grant select on public.captures to authenticated;
create table public.team_call (id uuid primary key, channel_id uuid not null);
create table public.capture_feed_session (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspace(id) on delete cascade,
  capture_id uuid not null references public.captures(id) on delete cascade, source_kind text not null, source_ref uuid not null,
  round integer not null, producer_kind text not null, producer_id text not null, status text not null default 'live',
  started_at timestamptz not null default now());
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
grant select on storage.objects to authenticated;
insert into storage.buckets (id, name, file_size_limit) values ('attachments', 'attachments', null), ('team-chat-files', 'team-chat-files', 10485760), ('workspace-merges', 'workspace-merges', 52428800), ('team-call-recordings', 'team-call-recordings', 2147483648), ('studio', 'studio', 2147483648);
`)

for (const f of ['650_capture_feed_audio.sql', '651_storage_bucket_limits.sql']) {
  const sql = await readFile(join(DIR, f), 'utf8')
  await db.exec(sql)
  await db.exec(sql)
  ok(true, `${f} applies twice`)
}

// ── Catalogue rules ──
ok((await q(`select relrowsecurity from pg_class where oid = 'public.capture_audio'::regclass`))[0].relrowsecurity === true, 'RLS on capture_audio')
ok((await q(`select grantee from information_schema.role_table_grants where table_schema='public' and table_name='capture_audio' and grantee in ('anon','authenticated')`)).length === 0, 'anon and authenticated hold nothing on capture_audio')
for (const r of await q(`select indexdef from pg_indexes where tablename='capture_audio' and indexdef ilike '%unique%'`)) ok(!/workspace_id/.test(r.indexdef), 'no unique index has workspace_id (402 re-stamps it)', r.indexdef)
const fns = await q(`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_x, has_function_privilege('authenticated', p.oid, 'execute') as auth_x, has_function_privilege('service_role', p.oid, 'execute') as svc_x
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and (p.proname like 'capture_audio%' or p.proname like 'capture_feed_audio%')`)
ok(fns.length === 6, 'six functions', fns.map((f) => f.proname))
for (const f of fns) {
  ok(f.prosecdef && (f.proconfig ?? []).some((c) => c.startsWith('search_path=')), `${f.proname}: security definer, search_path pinned`)
  ok(f.svc_x && !f.anon_x, `${f.proname}: the service role runs it, anon does not`)
  ok(f.auth_x === (f.proname === 'capture_audio_capture_of'), `${f.proname}: a signed-in person only for the policy's helper`)
}
const pols = await q(`select policyname, cmd, roles::text from pg_policies where schemaname='storage' and tablename='objects'`)
ok(pols.length === 1 && pols[0].cmd === 'SELECT' && /authenticated/.test(pols[0].roles), 'one storage policy, a SELECT for authenticated', pols)

// ── 651 ──
const buckets = Object.fromEntries((await q(`select id, file_size_limit from storage.buckets`)).map((b) => [b.id, Number(b.file_size_limit)]))
ok(buckets.attachments === 52428800 && buckets['team-chat-files'] === 10485760 && buckets['workspace-merges'] === 52428800 && buckets['team-call-recordings'] === 2147483648 && buckets.studio === 2147483648, '651: the bucket with none gets 50 MB, the others as they were', buckets)
ok((await q(`select count(*)::int as n from storage.buckets where file_size_limit is null`))[0].n === 0, '651: no bucket without a limit')

// ── The functions ──
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), OWNER = id(2), OTHER = id(3), CAP = id(4), CALL = id(5), CH = id(6)
await db.exec(`insert into public.workspace values ('${W}'); insert into public.captures values ('${CAP}', '${W}', '${OWNER}'); insert into public.team_call values ('${CALL}', '${CH}');`)
const session = async (over = {}) =>
  (await q(`insert into public.capture_feed_session (workspace_id, capture_id, source_kind, source_ref, round, producer_kind, producer_id, started_at) values ($1, $2, $3, $4, $5, 'livekit_recorder', $6, now() - $7::interval) returning id`, [W, CAP, over.kind ?? 'team_call', over.ref ?? CALL, over.round ?? 1, over.producer ?? 'recorder', over.age ?? '2 hours']))[0].id
const S = await session()
const grant = async (take, over = {}) => (await q(`select * from public.capture_feed_audio_grant($1, $2, $3, $4, $5, $6, $7)`, [over.session ?? S, over.producer ?? 'recorder', take, over.offset ?? 0, over.duration ?? 600000, over.bytes ?? 2400000, over.type ?? 'audio/mp4']))[0]
const stored = async (take, s = S, producer = 'recorder') => (await q(`select * from public.capture_feed_audio_stored($1, $2, $3)`, [s, producer, take]))[0]
const put = (path, size, mimetype = 'audio/mp4', age = '0 seconds') =>
  db.query(`insert into storage.objects (bucket_id, name, metadata, created_at) values ('team-call-recordings', $1, jsonb_build_object('size', $2::bigint, 'mimetype', $3::text), now() - $4::interval)`, [path, size, mimetype, age])

const g1 = await grant('p1.1')
ok(g1.outcome === 'granted' && g1.path === `${CH}/${CALL}/audio/${g1.audio_id}.m4a`, 'grant: a path in the call’s folder under audio/', g1)
const row = (await q(`select * from public.capture_audio where id = $1`, [g1.audio_id]))[0]
ok(row.state === 'pending' && row.part === 0 && row.capture_id === CAP && row.workspace_id === W && row.grants === 1, 'grant: pending, part 0, the session’s capture, one link', row)
ok(Math.abs(new Date(row.expires_at) - (Date.now() - 2 * 3600e3 + 30 * 864e5)) < 60e3, 'grant: kept 30 days from the session’s start')
const again = await grant('p1.1', { type: 'audio/ogg', offset: 999 })
ok(again.outcome === 'granted' && again.audio_id === g1.audio_id && again.path === g1.path, 'the same take again: the same row and path')
const after = (await q(`select grants, content_type, offset_ms from public.capture_audio where id = $1`, [g1.audio_id]))[0]
ok(after.grants === 2 && after.content_type === 'audio/mp4' && Number(after.offset_ms) === 0, 'a retry counts a link; its type and place stay the first grant’s', after)
ok((await grant('x', { producer: 'other' })).outcome === 'taken', 'another producer’s session: taken')
ok((await grant('x', { session: id(99) })).outcome === 'unknown', 'an unknown session: unknown')
ok((await grant('x', { bytes: 3 * 1024 ** 3 })).outcome === 'too_large', 'over 2 GB: too_large')
ok((await grant('a/b')).outcome === 'invalid', 'a bad take key: invalid')
ok((await grant('t', { type: 'video/mp4' })).outcome === 'invalid', 'a type not allowed: invalid')

ok((await stored('p1.1')).outcome === 'missing', 'stored before the object is there: missing')
await put(g1.path, 2412345, 'video/mp4')
ok((await stored('p1.1')).outcome === 'invalid', 'stored with an object of another type: invalid (never kept)')
await db.query(`update storage.objects set metadata = jsonb_build_object('size', 2412345, 'mimetype', 'audio/mp4') where name = $1`, [g1.path])
const st1 = await stored('p1.1')
ok(st1.outcome === 'stored' && Number(st1.bytes) === 2412345, 'stored once the object is there with its type: stored, its size from Storage', st1)
ok((await stored('p1.1')).outcome === 'stored', 'stored again: a repeat')
ok((await stored('p1.1', S, 'other')).outcome === 'taken', 'stored by another producer: taken')
ok((await grant('p1.1')).outcome === 'stored', 'grant for a stored take: stored, no link')

const g2 = await grant('p2.1', { offset: 900000 })
ok(g2.outcome === 'granted' && g2.audio_id !== g1.audio_id, 'a second take: its own row')
ok((await q(`select part from public.capture_audio where id = $1`, [g2.audio_id]))[0].part === 1, '… part 1')

// Bounds: a take's links, a session's takes.
await db.query(`update public.capture_audio set grants = 200 where id = $1`, [g2.audio_id])
ok((await grant('p2.1')).outcome === 'too_many', 'a take past 200 links: too_many')
const S5 = await session({ round: 5 })
for (let i = 0; i < 10; i++) ok((await grant(`many.${i}`, { session: S5 })).outcome === 'granted', `take ${i + 1} of a session`)
ok((await grant('many.10', { session: S5 })).outcome === 'too_many', 'an eleventh take of a session: too_many')

// ── The read policy, as a signed-in person ──
const asUser = async (uid, fn) => {
  await db.exec(`set role authenticated; select set_config('request.uid', '${uid}', false);`)
  try {
    return await fn()
  } finally {
    await db.exec(`reset role; select set_config('request.uid', '', false);`)
  }
}
const seen = async (uid) => (await asUser(uid, () => q(`select name from storage.objects where bucket_id = 'team-call-recordings'`))).map((r) => r.name)
ok((await seen(OWNER)).includes(g1.path), 'the capture’s reader sees the stored file')
ok((await seen(OTHER)).length === 0, 'someone who may not read the capture sees nothing')
await put(g2.path, 10)
ok(!(await seen(OWNER)).includes(g2.path), 'a pending take’s file is not readable')
let refused = false
try {
  await asUser(OWNER, () => q(`select * from public.capture_audio`))
} catch {
  refused = true
}
ok(refused, 'a signed-in person cannot read capture_audio')
const helper = async (uid, name) => (await asUser(uid, () => q(`select public.capture_audio_capture_of($1) as c`, [name])))[0].c
ok((await helper(OTHER, `${CH}/${CALL}/audio/${id(77)}.m4a`)) === null, 'the policy’s helper: nothing for a path that is not a kept file')
ok((await helper(OTHER, g2.path)) === null, 'the policy’s helper: nothing for a pending one')
await db.query(`update public.capture_audio set expires_at = now() - interval '1 minute' where id = $1`, [g1.audio_id])
ok(!(await seen(OWNER)).includes(g1.path), 'past its 30 days, not readable even before the sweep')
await db.query(`update public.capture_audio set expires_at = now() + interval '1 day' where id = $1`, [g1.audio_id])

// ── The sweep ──
await db.query(`update public.capture_audio set created_at = now() - interval '2 hours' where id = $1`, [g2.audio_id])
await db.query(`update storage.objects set metadata = jsonb_build_object('size', 10, 'mimetype', 'audio/mp4') where name = $1`, [g2.path])
const settle = async () => q(`select * from public.capture_audio_settle(10)`)
// A take whose upload landed with another type (a holder of the feed's secret): never kept by the sweep either.
const bad = await grant('bad.1', { session: S5 })
ok(bad.outcome === 'too_many', 'S5 is full: a take for the wrong-type case goes on another session')
const S6 = await session({ round: 6 })
const gBad = await grant('bad.1', { session: S6 })
await put(gBad.path, 99, 'video/mp4')
await db.query(`update public.capture_audio set created_at = now() - interval '2 hours' where id = $1`, [gBad.audio_id])
const settled = await settle()
const byId = Object.fromEntries(settled.map((r) => [r.id, r]))
ok(byId[g2.audio_id]?.outcome === 'stored', 'settle: a pending take whose file landed an hour ago with its type is stored', settled)
ok(byId[gBad.audio_id]?.outcome === 'invalid' && byId[gBad.audio_id].path === gBad.path, 'settle: one of another type is answered invalid, with its path for the sweep', settled)
ok((await q(`select state from public.capture_audio where id = $1`, [gBad.audio_id]))[0].state === 'pending', '… and is not kept')
ok(!(await seen(OWNER)).includes(gBad.path), '… nor readable by the capture’s reader')
await db.query(`update storage.objects set metadata = jsonb_build_object('size', 3000000000, 'mimetype', 'audio/mp4') where name = $1`, [gBad.path])
ok((await settle()).find((r) => r.id === gBad.audio_id)?.outcome === 'invalid', 'settle: one over 2 GB is answered invalid too')
ok((await stored('bad.1', S6)).outcome === 'invalid', 'stored: one over 2 GB is invalid')
await db.query(`update public.capture_audio set state = 'deleted', deleted_at = now() where id = $1`, [gBad.audio_id])
ok((await settle()).length === 0, 'settle again: nothing')
ok((await q(`select * from public.capture_audio_due(10)`)).length === 0, 'due: nothing before its time')
await db.query(`update public.capture_audio set expires_at = now() - interval '1 minute' where id = $1`, [g1.audio_id])
const due = await q(`select * from public.capture_audio_due(10)`)
ok(due.length === 1 && due[0].path === g1.path, 'due: the expired take', due)
await db.query(`update public.capture_audio set state = 'deleted', deleted_at = now() where id = $1`, [g1.audio_id])
let shape = false
try {
  await db.query(`update public.capture_audio set state = 'deleted' where id = $1`, [g2.audio_id])
} catch {
  shape = true
}
ok(shape, 'deleted needs its day')
ok((await grant('p1.1')).outcome === 'not_wanted', 'grant for a deleted take: not_wanted')
await put(`${CH}/${CALL}/audio/stray.m4a`, 5, 'audio/mp4', '2 hours')
await put(`${CH}/${CALL}/audio/fresh.m4a`, 5)
await put(`${CH}/${CALL}/recording/r.mp4`, 5, 'video/mp4', '2 hours')
await db.query(`update storage.objects set created_at = now() - interval '2 hours' where name not like '%fresh.m4a'`)
const orphans = (await q(`select * from public.capture_audio_orphans(100)`)).map((r) => r.name)
ok(orphans.includes(g1.path) && orphans.includes(`${CH}/${CALL}/audio/stray.m4a`) && !orphans.includes(g2.path) && !orphans.some((n) => n.includes('fresh') || n.includes('recording')), 'orphans: the deleted take’s and the stray file; never a kept take, a fresh one, or a recording', orphans)
await db.query(`delete from public.captures where id = $1`, [CAP])
ok((await q(`select count(*)::int as n from public.capture_audio`))[0].n === 0, 'a deleted capture takes its rows')
ok((await q(`select * from public.capture_audio_orphans(100)`)).map((r) => r.name).includes(g2.path), '… and its kept file is an orphan')

// ── Sources with no place for audio ──
await db.exec(`insert into public.captures values ('${CAP}', '${W}', '${OWNER}')`)
ok((await grant('t', { session: await session({ kind: 'other_kind', round: 1 }) })).outcome === 'not_wanted', 'a source kind with no place for audio: not_wanted')
ok((await grant('t', { session: await session({ round: 2, age: '31 days' }) })).outcome === 'not_wanted', 'a session over 30 days old: not_wanted')
ok((await grant('t', { session: await session({ round: 3, ref: id(88) }) })).outcome === 'not_wanted', 'a session whose call is gone: not_wanted')

console.log(`capture audio SQL: ${checks} checks passed`)
