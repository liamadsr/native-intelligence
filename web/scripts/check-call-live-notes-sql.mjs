/** Isolated check of migrations 655-657 (the live agent on a call's capture, its calendar
 * link, a guest's view of the call's words) on a real Postgres engine. No network, no
 * application database. Requires @electric-sql/pglite in the executing directory: install it
 * in a temporary directory and run this file there with `node --input-type=module < file`,
 * with CALL_LIVE_NOTES_MIGRATIONS set to the absolute path of web/supabase/migrations.
 *
 * What the migrations lean on is stubbed below (the tables with the columns they read), but
 * three functions are the repo's own, read from their migrations: 588's
 * capture_feed_capture_closed, 572's team_chat_can_read (the conversation's readers), and
 * 566's restrictive read policy on captures (a call's notes are read only by who may read its
 * conversation). Each new migration is applied twice (it must be re-runnable), then the
 * catalogue rules and the functions with real rows.
 *
 * PGlite runs one PostgreSQL connection: two callers competing for a lease are two calls in
 * turn here, which is what the row lock serializes them into on a server; the lock itself is
 * not exercised under real concurrency. PostgREST's rpc shapes are not covered.
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const DIR = process.env.CALL_LIVE_NOTES_MIGRATIONS
if (!DIR) throw new Error('set CALL_LIVE_NOTES_MIGRATIONS to web/supabase/migrations')
const files = await readdir(DIR)
const read = async (prefix) => readFile(join(DIR, files.find((f) => f.startsWith(prefix))), 'utf8')

/** One function's text from a migration, its create through its closing dollar quote. */
function fnText(sql, name) {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  assert.ok(start >= 0, `${name} not found`)
  const as = sql.slice(start).search(/\bas\s+(\$[a-z_]*\$)/i)
  const tag = sql.slice(start + as).match(/\bas\s+(\$[a-z_]*\$)/i)[1]
  const open = sql.indexOf(tag, start + as)
  const close = sql.indexOf(tag, open + tag.length)
  return sql.slice(start, close + tag.length) + ';'
}
function policyText(sql, name) {
  const start = sql.indexOf(`create policy ${name}`)
  assert.ok(start >= 0, `${name} not found`)
  return sql.slice(start, sql.indexOf(';', start) + 1)
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const WS = id(1)
const OWNER_USER = id(2), OWNER = id(3)
const ROSA_USER = id(4), ROSA = id(5)
const OUTSIDER_USER = id(6), OUTSIDER = id(7)
const CHANNEL = id(10), CALL = id(11), CAPTURE = id(12)
const MEETING = id(13), ACCOUNT = id(14), GUEST = id(15), OTHER_GUEST = id(16)
const ROSA_ACCOUNT = id(17)

const db = new PGlite()
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++ }
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const claim = (capture = CAPTURE) => one(`select * from team_call_live_turn_claim($1, 20, 60, 600, 30, 300, 600)`, [capture])
const begin = (lease, capture = CAPTURE) => one(`select * from team_call_live_turn_begin($1, $2, 300, 300)`, [capture, lease])
const release = (lease, outcome, sentTo, capture = CAPTURE) =>
  one(`select team_call_live_turn_release($1, $2, $3, $4, null, 3) as s`, [capture, lease, outcome, sentTo])
/** Queue a turn and start its run at once (no queue in between). */
const turn = async (capture = CAPTURE) => {
  const q = await claim(capture)
  if (q.outcome !== 'queued') return q
  const b = await begin(q.lease, capture)
  return { ...b, lease: q.lease }
}
const agent = () => one(`select * from team_call_live_agent where capture_id = $1`, [CAPTURE])
const say = (text) => db.query(`update captures set transcript = coalesce(transcript, '') || $2 where id = $1`, [CAPTURE, text])
const line = (who, n) => `[${who}] ${'word '.repeat(n).trim()}\n`
const ago = (seconds) => db.query(`update team_call_live_agent set last_turn_at = now() - make_interval(secs => $2) where capture_id = $1`, [CAPTURE, seconds])

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to authenticated, service_role;
    create table workspace (id uuid primary key);
    create table member (id uuid primary key, workspace_id uuid references workspace(id), user_id uuid, display_name text);
    create function public.is_workspace_member(ws uuid) returns boolean language sql stable security definer as $$ select exists (select 1 from public.member m where m.workspace_id = ws and m.user_id = auth.uid()) $$;
    create function public.is_team_member(t uuid) returns boolean language sql stable as $$ select false $$;
    create function public.current_member_id(ws uuid) returns uuid language sql stable security definer as $$ select m.id from public.member m where m.workspace_id = ws and m.user_id = auth.uid() $$;
    create table team_chat_channel (id uuid primary key, workspace_id uuid, kind text, team_id uuid, name text);
    create table team_chat_member (channel_id uuid, member_id uuid);
    create table captures (
      id uuid primary key default gen_random_uuid(), workspace_id uuid references workspace(id), user_id uuid, title text,
      transcript text, ai_summary text, ended_at timestamptz, is_transcript_locked boolean default false,
      notes_owner_out boolean not null default false, notes_channel_id uuid, visibility text default 'private',
      status text default 'active', metadata jsonb, calendar_event_id text, calendar_provider text,
      scheduled_start timestamptz, scheduled_end timestamptz, occurrence_start timestamptz, organizer_email text);
    create unique index uidx_captures_live_event_per_user on captures (workspace_id, user_id, calendar_event_id)
      where ended_at is null and status <> 'archived' and calendar_event_id is not null;
    create table team_call (id uuid primary key, workspace_id uuid, channel_id uuid, status text, notes boolean, capture_id uuid);
    create table team_call_capture (call_id uuid, capture_id uuid, workspace_id uuid, created_at timestamptz default now(), primary key (call_id, capture_id));
    create table connected_account (id uuid primary key, user_id uuid, workspace_id uuid, provider text, capability text, account_email text);
    create table meeting_booking (id uuid primary key, calendar_event_id text, calendar_account_id uuid, starts_at timestamptz, ends_at timestamptz, state text);
    create table meeting (id uuid primary key, workspace_id uuid, channel_id uuid unique, host_member_id uuid, title text, token_hash text,
      starts_at timestamptz, ends_at timestamptz, revoked_at timestamptz, booking_id uuid, calendar_event_id text,
      calendar_account_id uuid, calendar_event_kind text);
    create table meeting_guest (id uuid primary key, meeting_id uuid, workspace_id uuid, channel_id uuid, name text, state text,
      call_id uuid, in_call boolean default false, first_joined_at timestamptz, left_at timestamptz, decided_at timestamptz, requested_at timestamptz default now());
    create table capture_feed_segment (session_id uuid, capture_id uuid, key text, speaker_key text, said_at timestamptz, text text, primary key (session_id, key));
    create table capture_feed_speaker (capture_id uuid, speaker_key text, label text, primary key (capture_id, speaker_key));
    create table entity_access (entity_type text, entity_id uuid, grantee_kind text, grantee_channel_id uuid, level text);
  `)
  // The repo's own functions and fence these build on.
  await db.exec(fnText(await read('588_'), 'capture_feed_capture_closed'))
  await db.exec(fnText(await read('572_'), 'team_chat_can_read'))
  await db.exec(`
    alter table captures enable row level security;
    grant select on captures, entity_access to authenticated;
    -- The base read (a stub of the workspace's: own, workspace-wide, or shared by a view grant).
    create policy captures_read on captures for select to authenticated using (
      public.is_workspace_member(workspace_id) and (visibility = 'workspace' or user_id = auth.uid()
        or exists (select 1 from entity_access e where e.entity_type = 'capture' and e.entity_id = captures.id
                    and e.grantee_kind = 'channel' and public.team_chat_can_read(e.grantee_channel_id))));
  `)
  await db.exec(policyText(await read('566_'), 'captures_team_call_notes_fence'))

  for (const n of ['655_', '656_', '657_']) {
    const sql = await read(n)
    await db.exec(sql)
    await db.exec(sql) // re-runnable
  }

  // ── The catalogue's rules ──────────────────────────────────────────────────
  for (const table of ['team_call_live_agent', 'team_call_live_notes']) {
    const rls = await one(`select relrowsecurity from pg_class where relname = $1`, [table])
    ok(rls.relrowsecurity === true, `RLS on ${table}`)
    ok(!!(await one(`select 1 as x from information_schema.columns where table_name = $1 and column_name = 'workspace_id'`, [table])), `workspace_id on ${table}`)
    const anon = await db.query(`select privilege_type from information_schema.role_table_grants where table_name = $1 and grantee = 'anon'`, [table])
    eq(anon.rows.length, 0, `anon has no grant on ${table}`)
    const auth = (await db.query(`select privilege_type from information_schema.role_table_grants where table_name = $1 and grantee = 'authenticated'`, [table])).rows.map((r) => r.privilege_type)
    eq(auth, table === 'team_call_live_notes' ? ['SELECT'] : [], `authenticated: ${table === 'team_call_live_notes' ? 'SELECT at most' : 'nothing'} on ${table}`)
    const uniques = await db.query(`select indexdef from pg_indexes where tablename = $1 and indexdef ilike '%unique%' and indexdef ilike '%workspace_id%'`, [table])
    eq(uniques.rows.length, 0, `no unique index carries workspace_id on ${table}`)
    const policies = (await db.query(`select cmd from pg_policies where tablename = $1`, [table])).rows.map((r) => r.cmd)
    ok(policies.every((c) => c === 'SELECT'), `every policy on ${table} is a SELECT policy`)
  }
  const fns = [
    'team_call_live_notes_stamp', 'team_call_live_notes_summary_sync', 'team_call_live_turn_stop', 'team_call_live_turn_unwanted',
    'team_call_live_turn_claim', 'team_call_live_turn_begin', 'team_call_live_turn_unqueue', 'team_call_live_turn_tail',
    'team_call_live_turn_window', 'team_call_live_turn_release', 'team_call_live_turn_busy', 'team_call_capture_link_event', 'team_call_guest_notes',
  ]
  for (const f of fns) {
    const p = await one(`select p.oid, p.prosecdef, p.proconfig from pg_proc p where p.proname = $1`, [f])
    ok(p.prosecdef === true, `${f} is a definer`)
    ok((p.proconfig ?? []).some((c) => c.startsWith('search_path=')), `${f} pins search_path`)
    for (const role of ['anon', 'authenticated', 'public']) {
      const r = role === 'public' ? null : role
      const can = r
        ? await one(`select has_function_privilege($1, $2::oid, 'execute') as can`, [r, p.oid])
        : await one(`select exists (select 1 from aclexplode((select proacl from pg_proc where oid = $1)) a where a.grantee = 0) as can`, [p.oid])
      ok(can.can === false, `${f}: ${role} may not run it`)
    }
    ok((await one(`select has_function_privilege('service_role', $1::oid, 'execute') as can`, [p.oid])).can === true, `${f}: service_role may`)
  }

  // ── A meeting's call, its capture, its people ──────────────────────────────
  await db.exec(`
    insert into workspace values ('${WS}');
    insert into member values ('${OWNER}', '${WS}', '${OWNER_USER}', 'Dana Ortiz'), ('${ROSA}', '${WS}', '${ROSA_USER}', 'Rosa Lind'), ('${OUTSIDER}', '${WS}', '${OUTSIDER_USER}', 'Theo Marsh');
    insert into team_chat_channel values ('${CHANNEL}', '${WS}', 'meeting', null, 'Pilot review');
    insert into team_chat_member values ('${CHANNEL}', '${OWNER}'), ('${CHANNEL}', '${ROSA}');
    insert into captures (id, workspace_id, user_id, title, transcript, notes_channel_id, metadata)
      values ('${CAPTURE}', '${WS}', '${OWNER_USER}', 'Pilot review', '', '${CHANNEL}', '{"source":"team_call","notes_recorder":"live"}');
    insert into entity_access values ('capture', '${CAPTURE}', 'channel', '${CHANNEL}', 'view');
    insert into team_call values ('${CALL}', '${WS}', '${CHANNEL}', 'live', true, '${CAPTURE}');
    insert into team_call_capture (call_id, capture_id, workspace_id) values ('${CALL}', '${CAPTURE}', '${WS}');
  `)
  const notesRow = () => one(`select * from team_call_live_notes where capture_id = $1`, [CAPTURE])

  // ── The throttle ───────────────────────────────────────────────────────────
  eq((await claim()).outcome, 'too_few_words', 'nothing said: no turn')
  await say(line('Dana Ortiz', 14))
  eq((await claim()).outcome, 'waiting', 'a few words, just now: wait for more')
  await say(line('Rosa Lind', 120)) // past ready_chars
  const queued = await claim()
  eq(queued.outcome, 'queued', 'enough words: a turn is queued')
  eq((await agent()).turns, 0, 'a queued turn is not counted')
  ok((await one(`select team_call_live_turn_busy($1) as b`, [CAPTURE])).b === false, 'a queued turn is not running: the finish does not wait for it')
  eq((await claim()).outcome, 'busy', 'nothing more is queued while one waits')
  const first = await begin(queued.lease)
  eq(first.outcome, 'running', 'its run starts: now it is the running turn')
  eq(first.turn_no, 1, 'and the first turn, counted now')
  eq((await begin(queued.lease)).outcome, 'stale', 'a run that starts twice sends once')
  eq((await agent()).turns, 1, 'and counts once')
  eq((await agent()).state, 'working', 'working while it runs')
  const working = await notesRow()
  eq(working.state, 'working', 'readers see it working')
  ok(new Date(working.until).getTime() > Date.now() + 200_000, 'until the running turn’s lease runs out (a dead process never shows working for ever)')

  // ── Single flight: a second caller while the turn runs ────────────────────
  const second = await claim()
  eq(second.outcome, 'busy', 'a second caller is refused while a turn runs')
  ok(second.lease === null, 'and gets no lease')
  ok((await one(`select team_call_live_turn_busy($1) as b`, [CAPTURE])).b === true, 'busy while running')

  // The window: everything since the last turn, at most max_chars, cut at a line's end.
  const win = await one(`select * from team_call_live_turn_window($1, $2, 100000, 2000)`, [CAPTURE, queued.lease])
  eq(win.from_offset, 0, 'the window starts where no turn has read')
  ok(win.words.includes('[Dana Ortiz]') && win.words.includes('[Rosa Lind]'), 'and holds every new line')
  const capped = await one(`select * from team_call_live_turn_window($1, $2, 100, 2000)`, [CAPTURE, queued.lease])
  ok(capped.words.endsWith('\n') && capped.words.split('\n').filter(Boolean).length === 1, 'a capped window ends at a whole line')
  const stranger = await db.query(`select * from team_call_live_turn_window($1, $2, 100000, 2000)`, [CAPTURE, id(99)])
  eq(stranger.rows.length, 0, 'no window for a lease that is not the turn’s')

  eq((await release(queued.lease, 'ok', win.to_offset)).s, 'ready', 'the turn went through')
  eq((await agent()).done_offset, win.to_offset, 'its words are read')
  eq((await notesRow()).state, 'ready', 'readers see it ready')
  ok((await one(`select team_call_live_turn_busy($1) as b`, [CAPTURE])).b === false, 'not busy once released')

  await say(line('Dana Ortiz', 150))
  eq((await claim()).outcome, 'too_soon', 'a turn at most every min_interval seconds, from the last one’s start')
  await ago(25)
  const third = await turn()
  eq(third.outcome, 'running', 'past the interval with enough words: a turn')

  // ── A running turn's lease that ran out: another takes over; the late one changes nothing ──
  await db.query(`update team_call_live_agent set lease_until = now() - interval '1 second' where capture_id = $1`, [CAPTURE])
  await ago(25)
  const taker = await turn()
  eq(taker.outcome, 'running', 'a lease that ran out is taken again')
  eq((await release(third.lease, 'ok', 999999)).s, 'stale', 'the late turn is stale')
  eq((await agent()).done_offset, win.to_offset, 'a stale release moves nothing')

  // ── A failing turn: skipped, its words kept for the next ───────────────────
  eq((await release(taker.lease, 'failed', 999999)).s, 'failed', 'a failed turn')
  eq((await agent()).done_offset, win.to_offset, 'a failed turn reads nothing')
  eq((await notesRow()).state, 'failed', 'readers see it failed')
  await ago(25)
  const retry = await turn()
  eq(retry.outcome, 'running', 'the next turn')
  const retryWin = await one(`select * from team_call_live_turn_window($1, $2, 100000, 2000)`, [CAPTURE, retry.lease])
  eq(retryWin.from_offset, win.to_offset, 'starts where the last good turn stopped: the failed turn’s words go with it')
  ok(retryWin.context.length > 0 && retryWin.context.length <= 2000, 'with the lines before it as context')

  // ── An answer that never came back: the words are sent once, the lease held to its end ──
  eq((await release(retry.lease, 'unknown', retryWin.to_offset)).s, 'ready', 'a turn whose answer never came')
  eq((await agent()).done_offset, retryWin.to_offset, 'its words count as sent: never sent twice')
  ok((await one(`select team_call_live_turn_busy($1) as b`, [CAPTURE])).b === true, 'and its lease is kept, so the finish still waits for it')
  eq((await agent()).failures_in_row, 0, 'not a failure')
  await db.query(`update team_call_live_agent set lease_id = null, lease_until = null where capture_id = $1`, [CAPTURE])

  // Three failed turns that ran stop the agent for the call.
  for (let n = 1; n <= 3; n++) {
    await say(line('Rosa Lind', 130))
    await ago(25)
    const t = await turn()
    eq(t.outcome, 'running', `failing turn ${n} runs`)
    eq((await release(t.lease, 'failed', 0)).s, n < 3 ? 'failed' : 'stopped', n < 3 ? `failure ${n}` : 'three in a row stop the agent for the call')
  }
  eq((await agent()).stop_reason, 'failing', 'and say why')
  eq((await claim()).outcome, 'stopped', 'no more turns once stopped')

  // ── A queued turn that waited too long: stale, never a failure, never a turn ──
  const reset = () => db.query(`update team_call_live_agent set state = 'ready', stop_reason = null, turns = 1, failures_in_row = 0, last_turn_at = now() - interval '1 hour', lease_id = null, lease_until = null, queued_id = null, queued_until = null where capture_id = $1`, [CAPTURE])
  await reset()
  const late = await claim()
  eq(late.outcome, 'queued', 'queued')
  // Past the running lease's 300 s: still its mark, so it runs (the queue's own bound is longer).
  await db.query(`update team_call_live_agent set queued_until = now() + interval '5 minutes' where capture_id = $1`, [CAPTURE])
  eq((await begin(late.lease)).outcome, 'running', 'a turn queued past 300 s still runs and counts')
  await release(late.lease, 'ok', 0)
  await ago(25)
  const tooLate = await claim()
  await db.query(`update team_call_live_agent set queued_until = now() - interval '1 second' where capture_id = $1`, [CAPTURE])
  const turnsBefore = (await agent()).turns
  eq((await begin(tooLate.lease)).outcome, 'stale', 'a turn that waited past the queue’s bound is stale when it starts')
  const afterStale = await agent()
  eq(afterStale.turns, turnsBefore, 'not counted')
  eq(afterStale.failures_in_row, 0, 'not a failure')
  ok(afterStale.queued_id === null, 'and its mark is gone')
  eq((await claim()).outcome, 'queued', 'the next claim queues a fresh one with the same words')
  // A turn that was never handed over: taken back, nothing counted.
  const notSent = (await agent()).queued_id
  ok((await one(`select team_call_live_turn_unqueue($1, $2) as b`, [CAPTURE, notSent])).b === true, 'a send that failed takes its mark back')
  eq((await agent()).failures_in_row, 0, 'not a failure')

  // ── The bound per call: turns that ran ─────────────────────────────────────
  await db.query(`update team_call_live_agent set turns = 300, last_turn_at = now() - interval '1 hour' where capture_id = $1`, [CAPTURE])
  eq((await claim()).outcome, 'stopped', 'at the bound: no turn')
  eq((await agent()).stop_reason, 'bound', 'stopped by the bound')
  eq((await notesRow()).reason, 'bound', 'readers are told')

  // ── No dependence on anyone in the call; the owner's own standing counts ───
  await reset()
  // The stubs hold no call participant at all: who is in the call now is never read.
  ok(!(await one(`select to_regclass('public.team_call_participant') as t`)).t, 'no participant table exists here')
  const ownerGone = await turn()
  eq(ownerGone.outcome, 'running', 'turns run whoever is in the call (the owner having left it included)')
  await release(ownerGone.lease, 'ok', 0)
  await reset()
  await db.query(`update captures set notes_owner_out = true where id = $1`, [CAPTURE])
  eq((await claim()).outcome, 'stopped', 'an owner who may no longer read the conversation writes nothing more')
  eq((await agent()).stop_reason, 'owner_out', 'owner_out')
  await db.query(`update captures set notes_owner_out = false where id = $1`, [CAPTURE])
  await reset()

  // Notes off for a while: no turn, not stopped.
  await db.query(`update team_call set notes = false where id = $1`, [CALL])
  eq((await claim()).outcome, 'notes_off', 'notes off: no turn')
  eq((await agent()).state, 'ready', 'and not stopped')
  await db.query(`update team_call set notes = true where id = $1`, [CALL])

  // ── A transcript rewritten under the turns: a fresh window, never the middle of a line ──
  const goodTurn = await turn()
  const goodWin = await one(`select * from team_call_live_turn_window($1, $2, 100000, 2000)`, [CAPTURE, goodTurn.lease])
  await release(goodTurn.lease, 'ok', goodWin.to_offset)
  await db.query(`update captures set transcript = $2 where id = $1`, [CAPTURE, line('Dana Ortiz', 30) + line('Rosa Lind', 40)])
  await ago(25)
  const afterEdit = await turn()
  const editWin = await one(`select * from team_call_live_turn_window($1, $2, 100000, 2000)`, [CAPTURE, afterEdit.lease])
  ok(editWin.words.startsWith('[Dana Ortiz]') || editWin.words.startsWith('[Rosa Lind]'), 'a rewritten transcript starts a fresh window at a whole line')
  await release(afterEdit.lease, 'ok', editWin.to_offset)

  // ── The call's end stops it, and a turn still running gets no words ───────
  await say(line('Dana Ortiz', 150))
  await ago(25)
  const lastTurn = await turn()
  eq(lastTurn.outcome, 'running', 'a turn during the call')
  await db.query(`update team_call set status = 'ended' where id = $1`, [CALL])
  eq((await db.query(`select * from team_call_live_turn_window($1, $2, 100000, 2000)`, [CAPTURE, lastTurn.lease])).rows.length, 0, 'once the call ended a running turn reads nothing')
  eq((await agent()).stop_reason, 'call_ended', 'and the agent is stopped then')
  eq((await release(lastTurn.lease, 'failed', 0)).s, 'stale', 'the running turn’s release changes nothing')
  eq((await claim()).outcome, 'stopped', 'and no turn starts')
  // A call that ends with a turn still queued: its run starts and stops.
  await db.query(`update team_call_live_agent set state = 'ready', stop_reason = null, queued_id = $2, queued_until = now() + interval '5 minutes' where capture_id = $1`, [CAPTURE, id(98)])
  eq((await begin(id(98))).outcome, 'stopped', 'a queued turn whose call ended does not run')
  eq((await agent()).stop_reason, 'call_ended', 'call_ended')
  await db.query(`update team_call set status = 'live' where id = $1`, [CALL])

  // ── The shared notes reach the conversation and no one else ────────────────
  await db.query(`update captures set ai_summary = '## Summary' || chr(10) || 'The pilot starts Monday.' where id = $1`, [CAPTURE])
  eq((await notesRow()).summary, '## Summary\nThe pilot starts Monday.', 'the summary the agent wrote is copied to the narrow row')
  const asUser = async (userId, fn) => {
    await db.exec(`set role authenticated`)
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId])
    try { return await fn() } finally { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claim.sub', '', false)`) }
  }
  const readAs = (u) => asUser(u, () => db.query(`select summary, state from team_call_live_notes where capture_id = $1`, [CAPTURE]))
  const readCaptureAs = (u) => asUser(u, () => db.query(`select ai_summary from captures where id = $1`, [CAPTURE]))
  const rosaRead = await readAs(ROSA_USER)
  eq(rosaRead.rows.length, 1, 'a member of the conversation who is not the owner reads the notes')
  ok(rosaRead.rows[0].summary.includes('pilot'), 'the summary')
  eq(rosaRead.rows[0].state, 'stopped', 'and the agent’s state')
  eq((await readCaptureAs(ROSA_USER)).rows.length, 1, 'as they read the capture itself')
  eq((await readAs(OUTSIDER_USER)).rows.length, 0, 'a workspace member outside the conversation reads nothing')
  eq((await readCaptureAs(OUTSIDER_USER)).rows.length, 0, 'nor the capture')
  await db.query(`delete from team_chat_member where member_id = $1`, [ROSA])
  eq((await readAs(ROSA_USER)).rows.length, 0, 'taken out of the conversation: nothing')
  await db.query(`insert into team_chat_member values ($1, $2)`, [CHANNEL, ROSA])
  // Another capture's summary never reaches a notes row.
  await db.query(`insert into captures (id, workspace_id, user_id, title, ai_summary) values ($1, $2, $3, 'Mine', 'private')`, [id(50), WS, OWNER_USER])
  await db.query(`update captures set ai_summary = 'still private' where id = $1`, [id(50)])
  eq((await one(`select count(*)::int as n from team_call_live_notes`)).n, 1, 'only a call capture with live notes has a notes row')

  // ── What a reader's screen receives on each change: the capture's row against the narrow one ──
  const hour = Array.from({ length: 900 }, (_, i) => line(i % 2 ? 'Rosa Lind' : 'Dana Ortiz', 9)).join('') // ~ an hour of talk, 4 s batches
  await db.query(`update captures set transcript = $2 where id = $1`, [CAPTURE, hour])
  const sizes = await one(`
    select (select octet_length(row_to_json(c)::text) from captures c where c.id = $1) as capture_row,
           (select octet_length(row_to_json(n)::text) from team_call_live_notes n where n.capture_id = $1) as notes_row`, [CAPTURE])
  ok(sizes.notes_row < sizes.capture_row / 20, `the narrow row is a small fraction of the capture's (${sizes.notes_row} vs ${sizes.capture_row} bytes)`)
  console.log(`payload per change after about an hour of talk: capture row ${sizes.capture_row} bytes, live notes row ${sizes.notes_row} bytes`)

  // ── 656: the meeting's calendar event ──────────────────────────────────────
  const link = async () => (await one(`select team_call_capture_link_event($1) as r`, [CAPTURE])).r
  eq(await link(), 'no_meeting', 'a call that is not a meeting’s: no link')
  await db.exec(`
    insert into connected_account values ('${ACCOUNT}', '${OWNER_USER}', '${WS}', 'google', 'calendar', 'dana@example.com'),
                                         ('${ROSA_ACCOUNT}', '${ROSA_USER}', '${WS}', 'google', 'calendar', 'rosa@example.com');
    insert into meeting (id, workspace_id, channel_id, host_member_id, title, token_hash, starts_at, ends_at)
      values ('${MEETING}', '${WS}', '${CHANNEL}', '${OWNER}', 'Pilot review', 'digest-of-the-link', '2026-11-20T15:00:00Z', '2026-11-20T15:30:00Z');
  `)
  eq(await link(), 'no_event', 'a meeting with no calendar event: no link, nothing guessed')
  await db.query(`update meeting set calendar_event_id = 'evt-pilot', calendar_account_id = $2, calendar_event_kind = 'meeting' where id = $1`, [MEETING, ROSA_ACCOUNT])
  eq(await link(), 'no_event', 'an event on someone else’s account: no link')
  await db.query(`update meeting set calendar_account_id = null where id = $1`, [MEETING])
  eq(await link(), 'no_event', 'an account disconnected since: no link')
  await db.query(`update meeting set calendar_account_id = $2, host_member_id = $3 where id = $1`, [MEETING, ACCOUNT, ROSA])
  eq(await link(), 'not_host', 'a capture whose owner is not the host: no link')
  await db.query(`update meeting set host_member_id = $2 where id = $1`, [MEETING, OWNER])
  // The owner already captures the event themselves (their own device): theirs keeps it.
  await db.query(`insert into captures (id, workspace_id, user_id, title, calendar_event_id) values ($1, $2, $3, 'Pilot review', 'evt-pilot')`, [id(30), WS, OWNER_USER])
  eq(await link(), 'taken', 'the owner’s own open capture of the event keeps it')
  await db.query(`update captures set ended_at = now() where id = $1`, [id(30)])
  eq(await link(), 'linked', 'the host’s meeting event on their own calendar: linked')
  const linked = await one(`select calendar_event_id, calendar_provider, scheduled_start, scheduled_end, occurrence_start, organizer_email, metadata from captures where id = $1`, [CAPTURE])
  eq(linked.calendar_event_id, 'evt-pilot', 'the event id')
  eq(linked.calendar_provider, 'google', 'the account’s provider')
  eq(new Date(linked.scheduled_start).toISOString(), '2026-11-20T15:00:00.000Z', 'its start')
  eq(new Date(linked.occurrence_start).toISOString(), '2026-11-20T15:00:00.000Z', 'the occurrence, as from-event derives it')
  eq(linked.organizer_email, 'dana@example.com', 'the host as its organizer')
  eq(linked.metadata.linked_event_title, 'Pilot review', 'the event’s title for the panel')
  eq(linked.metadata.source, 'team_call', 'the rest of the metadata kept')
  eq(await link(), 'already', 'never over a link the capture has')
  // A booked meeting: its booking's confirmed event.
  await db.query(`update captures set calendar_event_id = null where id = $1`, [CAPTURE])
  await db.query(`insert into meeting_booking values ($1, 'evt-booked', $2, '2026-11-21T10:00:00Z', '2026-11-21T10:30:00Z', 'booking')`, [id(31), ACCOUNT])
  await db.query(`update meeting set booking_id = $2 where id = $1`, [MEETING, id(31)])
  eq(await link(), 'no_event', 'a booking not yet confirmed: no link')
  await db.query(`update meeting_booking set state = 'confirmed' where id = $1`, [id(31)])
  eq(await link(), 'linked', 'a confirmed booking’s event: linked')
  eq((await one(`select calendar_event_id from captures where id = $1`, [CAPTURE])).calendar_event_id, 'evt-booked', 'the booking’s event')

  // ── 657: a guest reads the call's own words while they are in it ───────────
  await db.exec(`
    insert into capture_feed_speaker values ('${CAPTURE}', 'm-dana', 'Dana Ortiz'), ('${CAPTURE}', 'g-sam', 'Sam Ruiz');
    insert into capture_feed_segment values
      ('${id(40)}', '${CAPTURE}', 'k1', 'm-dana', now() - interval '10 minutes', 'Before anyone else came in.'),
      ('${id(40)}', '${CAPTURE}', 'k2', 'm-dana', now() - interval '2 minutes', 'Welcome, Sam.'),
      ('${id(40)}', '${CAPTURE}', 'k3', 'g-sam', now() - interval '1 minute', 'Thanks for having me.');
    insert into meeting_guest (id, meeting_id, workspace_id, channel_id, name, state, call_id, in_call, first_joined_at)
      values ('${GUEST}', '${MEETING}', '${WS}', '${CHANNEL}', 'Sam Ruiz', 'admitted', '${CALL}', true, now() - interval '3 minutes'),
             ('${OTHER_GUEST}', '${MEETING}', '${WS}', '${CHANNEL}', 'Kim Park', 'waiting', null, false, null);
  `)
  const guest = async (g = GUEST, digest = 'digest-of-the-link') => (await one(`select team_call_guest_notes($1, $2, 200) as r`, [g, digest])).r
  const seen = await guest()
  eq(seen.allowed, true, 'a guest let into the live call may read')
  eq(seen.lines.map((l) => l.text), ['Welcome, Sam.', 'Thanks for having me.'], 'only what was said since they were let in, in order')
  eq(seen.lines.map((l) => l.speaker), ['Dana Ortiz', 'Sam Ruiz'], 'each under the speaker’s label')
  for (const l of seen.lines) eq(Object.keys(l).sort(), ['at', 'speaker', 'text'], 'a line carries its time, speaker and words, nothing else')
  ok(!JSON.stringify(seen).includes('pilot starts Monday'), 'never the agent’s summary')
  eq((await guest(GUEST, 'another-link')).allowed, false, 'another link’s token: refused')
  eq((await guest(OTHER_GUEST)).allowed, false, 'a guest still waiting: refused')
  await db.query(`update meeting_guest set state = 'removed', in_call = false where id = $1`, [GUEST])
  const removed = await guest()
  eq(removed.allowed, false, 'removed: refused')
  eq(removed.lines.length, 0, 'and nothing')
  await db.query(`update meeting_guest set state = 'left', in_call = false where id = $1`, [GUEST])
  eq((await guest()).allowed, false, 'left: refused')
  // Dropped off or closed the tab: LiveKit's leave (574) sets in_call false and left_at, the state stays 'admitted'.
  await db.query(`update meeting_guest set state = 'admitted', in_call = false, left_at = now() - interval '1 minute' where id = $1`, [GUEST])
  const dropped = await guest()
  eq(dropped.allowed, false, 'admitted but out of the room for a minute (dropped off, tab closed): refused')
  eq(dropped.lines.length, 0, 'and nothing')
  await db.query(`update meeting_guest set left_at = now() - interval '10 seconds' where id = $1`, [GUEST])
  eq((await guest()).allowed, true, 'out of the room for a few seconds (a reconnect): still reads')
  await db.query(`update meeting_guest set left_at = null where id = $1`, [GUEST])
  eq((await guest()).allowed, false, 'let in but never in the room: refused')
  await db.query(`update meeting_guest set state = 'admitted', in_call = true where id = $1`, [GUEST])
  await db.query(`update team_call set status = 'ended' where id = $1`, [CALL])
  eq((await guest()).allowed, false, 'the call ended: refused')
  await db.query(`update team_call set status = 'live' where id = $1`, [CALL])
  await db.query(`update captures set ended_at = now() where id = $1`, [CAPTURE])
  eq((await guest()).allowed, false, 'the capture closed: refused')
  await db.query(`update captures set ended_at = null where id = $1`, [CAPTURE])
  await db.query(`update meeting set revoked_at = now() where id = $1`, [MEETING])
  eq((await guest()).allowed, false, 'the link revoked: refused')

  // ── More calls than turns may run at once: the notes get slower, never stop ──
  // The real claim, begin, window and release, against a modelled queue: Inngest runs at most
  // LIMIT turns at once and one per capture (team-call-live-turns.ts's concurrency), each turn's
  // route takes RUN_TICKS ticks, and the clock moves TICK virtual seconds a tick (every timestamp
  // the functions read is moved back by as much). Each call talks without a pause.
  {
    const CALLS = 12, LIMIT = 5, TICK = 20, RUN_TICKS = 8, TICKS = 90
    const caps = []
    for (let i = 0; i < CALLS; i++) {
      const cap = id(1000 + i), call = id(2000 + i)
      caps.push(cap)
      await db.query(`insert into captures (id, workspace_id, user_id, title, transcript, notes_channel_id) values ($1, $2, $3, 'Busy call', '', $4)`, [cap, WS, OWNER_USER, CHANNEL])
      await db.query(`insert into team_call values ($1, $2, $3, 'live', true, $4)`, [call, WS, CHANNEL, cap])
      await db.query(`insert into team_call_capture (call_id, capture_id, workspace_id) values ($1, $2, $3)`, [call, cap, WS])
    }
    const queue = [], running = []
    let started = 0, stale = 0, maxWaitTicks = 0
    for (let t = 0; t < TICKS; t++) {
      for (const cap of caps) {
        await db.query(`update captures set transcript = transcript || $2 where id = $1`, [cap, line('Rosa Lind', 50)])
        const q = await claim(cap)
        if (q.outcome === 'queued') queue.push({ cap, lease: q.lease, at: t })
      }
      while (running.length < LIMIT) {
        const i = queue.findIndex((e) => !running.some((r) => r.cap === e.cap))
        if (i < 0) break
        const [e] = queue.splice(i, 1)
        maxWaitTicks = Math.max(maxWaitTicks, t - e.at)
        const b = await begin(e.lease, e.cap)
        if (b.outcome !== 'running') {
          stale++
          continue
        }
        started++
        const w = await one(`select * from team_call_live_turn_window($1, $2, 16000, 2400)`, [e.cap, e.lease])
        running.push({ cap: e.cap, lease: e.lease, to: w.to_offset, left: RUN_TICKS })
      }
      for (const r of [...running]) {
        if (--r.left > 0) continue
        await release(r.lease, 'ok', r.to, r.cap)
        running.splice(running.indexOf(r), 1)
      }
      await db.query(
        `update team_call_live_agent set created_at = created_at - make_interval(secs => $1), last_turn_at = last_turn_at - make_interval(secs => $1),
                queued_until = queued_until - make_interval(secs => $1), lease_until = lease_until - make_interval(secs => $1)
          where capture_id = any($2::uuid[])`,
        [TICK, caps],
      )
    }
    const rows = (await db.query(`select * from team_call_live_agent where capture_id = any($1::uuid[])`, [caps])).rows
    ok(maxWaitTicks * TICK > 300, `turns waited in the queue past the old 300 s lease (${maxWaitTicks * TICK} s at most)`)
    eq(rows.filter((r) => r.state === 'stopped').length, 0, 'no call’s notes stopped')
    eq(rows.reduce((n, r) => n + r.failures, 0), 0, 'no failure was counted')
    eq(rows.reduce((n, r) => n + r.turns, 0), started, 'only turns that ran were counted')
    ok(rows.every((r) => r.turns >= 3 && r.done_offset > 0), `every call’s notes kept moving (fewest turns: ${Math.min(...rows.map((r) => r.turns))})`)
    console.log(`backlog: ${CALLS} calls, ${LIMIT} at once, ${TICKS * TICK / 60} virtual minutes: ${started} turns ran, ${stale} stale starts skipped, longest wait ${maxWaitTicks * TICK} s, turns per call ${Math.min(...rows.map((r) => r.turns))}-${Math.max(...rows.map((r) => r.turns))}`)
  }

  console.log(`migrations 655-657: ${checks} checks passed`)
} finally {
  await db.close()
}
