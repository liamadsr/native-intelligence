/**
 * Migrations 587-588 (the capture feed: one recorder per call, phase 1). Each
 * is one transaction whatever applies it, with a lock timeout, and reloads
 * the API schema; no backslash anywhere; numbered once each, after 586. The
 * feed's tables have RLS on and no client grant; every function is the
 * service role's alone, a definer with a pinned search_path (the three pure
 * helpers are not definers and touch no table); none redefines a function an
 * earlier migration made (566-575's and 568's readers stay as they are: a
 * call's capture keeps 566's fences). A roster's participant row is the
 * server's (587's guard); a call's capture may exist while its notes are
 * captured. Run on DEV in transactions that were rolled back (the PR's
 * proof); this pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const TABLES = read('587_capture_feed.sql')
const FUNCTIONS = read('588_capture_feed_functions.sql')

function functionNames(sql: string): string[] {
  return [...sql.matchAll(/create or replace function public\.([a-z_]+)\(/gi)].map((m) => m[1].toLowerCase())
}

/** One function's text, from its create through its closing dollar quote. */
function definition(sql: string, name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  expect(start, name).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('$$', start)
  const close = sql.indexOf('$$;', open + 2)
  return sql.slice(start, close + 3)
}

describe('migrations 587-588', () => {
  it('each is one transaction with a lock timeout, reloads the API schema, and holds no backslash', () => {
    for (const [name, sql] of Object.entries({ TABLES, FUNCTIONS })) {
      const body = bodyOf(sql)
      expect(sql, name).not.toContain('\\')
      expect(body, name).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
      expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;"), name).toBe(true)
      expect((body.match(/^(begin|commit);$/gm) ?? []).length, name).toBe(2)
      expect(body, name).not.toMatch(/concurrently|vacuum/i)
      expect(body, name).not.toMatch(/drop table|truncate|drop column|drop function/i)
      expect(body, name).not.toMatch(/to anon|to authenticated/)
    }
  })

  it('numbered once each, after 586', () => {
    const numbers = migrationsInOrder().map((m) => m.num)
    expect(numbers.filter((n) => n === 587)).toHaveLength(1)
    expect(numbers.filter((n) => n === 588)).toHaveLength(1)
    expect(numbers).toContain(586)
  })

  it('the feed’s tables: RLS on, no client grant, the service role’s; one session per source and round; source kinds named for the next one', () => {
    const t = flat(TABLES)
    for (const table of ['capture_feed_session', 'capture_feed_segment', 'capture_feed_speaker']) {
      expect(t).toContain(`alter table public.${table} enable row level security;`)
      expect(t).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(t).toContain(`grant select, insert, update, delete on table public.${table} to service_role;`)
    }
    expect(t).toContain('create unique index if not exists capture_feed_session_one_per_round on public.capture_feed_session (source_kind, source_ref, round);')
    expect(t).toContain("add constraint capture_feed_session_source_kind check (source_kind in ('team_call')) not valid;")
    expect(t).toContain('primary key (session_id, key)')
    expect(t).not.toMatch(/alter publication/)
  })

  it('a call’s capture exists while its notes are captured; 566’s other rules stay', () => {
    const t = flat(TABLES)
    expect(t).toContain("and (capture_id is null or notes_state in ('capturing', 'transcribing', 'ready'))")
    expect(t).toContain("and ((notes and status = 'live' and notes_on_since is not null) or (not notes and notes_on_since is null))")
    expect(t).toContain("and (not notes or notes_state = 'capturing')")
  })

  it('a roster’s participant row is the server’s: no signed-in person writes one or changes who or what it is', () => {
    const t = flat(TABLES)
    expect(t).toContain("check (source in ('calendar_event', 'manual', 'voice_id', 'call_roster'))")
    expect(t).toContain('add column if not exists source text default')
    const guard = flat(definition(TABLES, 'capture_participant_roster_guard'))
    expect(guard).toContain('security definer set search_path = public, pg_temp')
    expect(guard).toContain('if auth.uid() is null then return new;')
    expect(guard).toContain("if new.source = 'call_roster' then raise exception")
    for (const col of ['source', 'member_id', 'speaker_label', 'self_binding', 'is_self', 'capture_id']) expect(guard).toContain(`new.${col} is distinct from old.${col}`)
    expect(t).toContain('before insert or update on public.capture_participant for each row execute function public.capture_participant_roster_guard();')
    expect(t).toContain("create unique index if not exists capture_participant_roster_label on public.capture_participant (capture_id, lower(speaker_label)) where source = 'call_roster' and speaker_label is not null;")
  })

  it('every function is new, the service role’s alone; the definers pin their search_path', () => {
    const earlier = new Set(migrationsInOrder().filter((m) => m.num < 587).flatMap((m) => functionNames(m.sql)))
    const names = [...new Set(functionNames(FUNCTIONS))]
    expect(names.length).toBeGreaterThan(10)
    const f = flat(FUNCTIONS)
    for (const name of names) {
      expect(earlier.has(name), `${name} is redefined`).toBe(false)
      const def = flat(definition(FUNCTIONS, name))
      expect(def, name).toContain('set search_path = public, pg_temp')
      if (['capture_feed_label_base', 'capture_feed_close_gap', 'capture_feed_norm'].includes(name)) {
        // Pure: no table, no definer.
        expect(def, name).not.toContain('security definer')
        expect(def, name).not.toMatch(/ from public\./)
      } else {
        expect(def, name).toContain('security definer')
      }
      expect(f, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`))
    }
    for (const grant of f.match(/grant execute on function [^;]+;/g) ?? []) expect(grant).toMatch(/ to service_role;$/)
  })

  it('a segment said after its round ended never reaches the capture; a guest only once they said go to this round', () => {
    const append = flat(definition(FUNCTIONS, 'capture_feed_append'))
    expect(append).toContain('if s.ended_at is not null and said >= s.ended_at then')
    expect(append).toContain('g.notes_ack_round >= s.round')
    expect(append).toContain('on conflict (session_id, key) do nothing')
    expect(append).toContain('public.append_capture_transcript(')
    const follow = flat(definition(FUNCTIONS, 'capture_feed_follow_call'))
    expect(follow).toContain('x.round = old.notes_round')
    expect(flat(FUNCTIONS)).toContain("after update of notes, status on public.team_call for each row when ((old.notes and not new.notes) or (old.status = 'live' and new.status = 'ended'))")
  })

  it('a producer is named so its LiveKit identity fits; it says when it has delivered everything', () => {
    const t = flat(TABLES)
    expect(t).toContain("producer_id text not null check (producer_id ~ '^[A-Za-z0-9._-]{1,40}$')")
    expect(t).toContain('delivered_at timestamptz')
    const end = flat(definition(FUNCTIONS, 'capture_feed_end'))
    expect(end).toContain('set delivered_at = now()')
    expect(end).toContain('x.producer_id = p_producer_id')
  })

  it('nothing keeps hearing a call that has no notes: every way a session ends or goes quiet puts its producer on the eject outbox', () => {
    const eject = flat(definition(FUNCTIONS, 'capture_feed_eject_producer'))
    expect(eject).toContain("insert into public.team_call_eject (call_id, room, identity, reason, feed_session) select t.id, t.room, left('notes-recorder-' || s.producer_id, 64), 'access', s.id")
    expect(flat(definition(FUNCTIONS, 'capture_feed_follow_call'))).toContain("left('notes-recorder-' || x.producer_id, 64), 'access'")
    expect(flat(definition(FUNCTIONS, 'capture_feed_mark_lost'))).toContain('perform public.capture_feed_eject_producer(r);')
    const beat = flat(definition(FUNCTIONS, 'capture_feed_heartbeat'))
    expect(beat).toContain('perform public.capture_feed_eject_producer(s);')
    expect(beat).toContain("why := 'capture_closed';")
    const fence = flat(definition(FUNCTIONS, 'capture_feed_fence_producers'))
    expect(fence).toContain('and not public.capture_feed_producer_wanted(t.id, x.producer_id)')
    // The drain settles a producer's entry first: one the call wants again (notes off, then on) stays in the room.
    const wanted = flat(definition(FUNCTIONS, 'capture_feed_producer_wanted'))
    expect(wanted).toContain("y.round = t.notes_round where t.id = call_ref and t.status = 'live' and t.notes and y.producer_id = p_producer_id and y.status = 'live' and not public.capture_feed_capture_closed(y.capture_id)")
    const settle = flat(definition(FUNCTIONS, 'capture_feed_settle_ejects'))
    expect(settle).toContain("and e.identity like 'notes-recorder-%'")
    expect(settle).toContain('public.capture_feed_producer_wanted(e.call_id, substr(e.identity, 16))')
    expect(flat(TABLES)).toContain('alter table public.team_call_eject add column if not exists feed_session uuid references public.capture_feed_session(id) on delete set null;')
    // A producer that hands back a session still wanted opens a gap; a closed capture is unwanted.
    const end = flat(definition(FUNCTIONS, 'capture_feed_end'))
    expect(end).toContain("why := 'capture_closed';")
    expect(end).toContain("x.gaps || jsonb_build_array(jsonb_build_object('from', now()))")
    expect(flat(definition(FUNCTIONS, 'capture_feed_recorder_state'))).toContain('and not c.is_transcript_locked')
  })

  it('a guest is heard only once they said go to this round: the producer is told whom, at its start and every heartbeat', () => {
    const guests = flat(definition(FUNCTIONS, 'capture_feed_hearable_guests'))
    expect(guests).toContain("g.state = 'admitted'")
    expect(guests).toContain('g.notes_ack_round >= s.round')
    expect(flat(definition(FUNCTIONS, 'capture_feed_start'))).toContain('public.capture_feed_hearable_guests(')
    expect(flat(definition(FUNCTIONS, 'capture_feed_heartbeat'))).toContain('return query select sid, true, null::text, public.capture_feed_hearable_guests(s);')
  })

  it('a closed capture is wanted by no producer: not offered, not started', () => {
    expect(flat(definition(FUNCTIONS, 'team_call_recorder_work'))).toContain('(x.id is null or not public.capture_feed_capture_closed(x.capture_id))')
    // Notes on again after the capture was ended by hand: a new capture for the new round.
    expect(flat(definition(FUNCTIONS, 'team_call_capture_ensure'))).toContain('if c.capture_id is not null and not public.capture_feed_capture_closed(c.capture_id) then')
    expect(flat(definition(FUNCTIONS, 'capture_feed_capture_closed'))).toContain('c.ended_at is not null or c.is_transcript_locked')
  })

  it('the lock writes every segment in the order said, read in the database (no page cap); a quote names its speaker rows', () => {
    const lock = flat(definition(FUNCTIONS, 'team_call_capture_lock'))
    expect(lock).toContain("select string_agg('[' || l.label || '] ' || l.text, chr(10) order by l.line_no) into ordered from public.capture_feed_lines(cap.id) l;")
    expect(lock).toContain("update public.team_call t set notes_state = 'ready', updated_at = now() where t.id = c.id and t.notes_state <> 'ready';")
    const lines = flat(definition(FUNCTIONS, 'capture_feed_lines'))
    expect(lines).toContain("o.said_at - o.prev_end > interval '1.5 seconds'")
    expect(lines).not.toMatch(/ limit /)
    const quote = flat(definition(FUNCTIONS, 'capture_feed_quote_speakers'))
    expect(quote).toContain("(array_length(regexp_split_to_array(q.t, ' '), 1) >= 5 or char_length(q.t) >= 20)")
    expect(quote).toContain("position(' ' || q.t || ' ' in ' ' || public.capture_feed_norm(l.text) || ' ') > 0")
    expect(flat(definition(FUNCTIONS, 'capture_feed_norm'))).toContain("translate(lower(coalesce(raw, '')), '''' || chr(8217), '')")
    // Every capture a call produced is on record; one closed by hand is finished then; a silent
    // last round links the call back to an earlier capture that holds words.
    const t587 = flat(TABLES)
    expect(t587).toContain('create table if not exists public.team_call_capture (')
    expect(t587).toContain('alter table public.team_call_capture enable row level security;')
    expect(t587).toContain('revoke all on table public.team_call_capture from anon, authenticated;')
    expect(flat(definition(FUNCTIONS, 'team_call_capture_ensure'))).toContain('insert into public.team_call_capture (call_id, capture_id, workspace_id) values (c.id, made, c.workspace_id)')
    expect(lock).toContain("update public.team_call t set capture_id = earlier, notes_state = 'ready', updated_at = now() where t.id = c.id;")
    expect(lock).toContain("return query select 'done'::text")
    const finish = flat(definition(FUNCTIONS, 'team_call_capture_finish'))
    expect(finish).toContain("jsonb_build_object('notes_recorder', 'done')")
    expect(finish).toContain('update public.team_call_capture x set finished_at = now()')
    // Lock order as everywhere: the call, then the capture's sessions, then the capture (append: session, then capture).
    const callAt = finish.indexOf('from public.team_call t where t.id = r.call_id for update')
    const sessionsAt = finish.indexOf('update public.capture_feed_session x')
    const captureAt = finish.indexOf('from public.captures x where x.id = target_capture for update')
    expect(callAt).toBeGreaterThan(0)
    expect(sessionsAt).toBeGreaterThan(callAt)
    expect(captureAt).toBeGreaterThan(sessionsAt)
    expect(finish.match(/from public\.captures x where x\.id = target_capture for update/g)).toHaveLength(1)
    const lockFn = flat(definition(FUNCTIONS, 'team_call_capture_lock'))
    expect(lockFn.indexOf('update public.capture_feed_session x')).toBeLessThan(lockFn.indexOf('from public.captures x where x.id = c.capture_id for update'))
    // Ended and pass done are apart: the sweeper asks again for a pass not done, a bounded number of times.
    expect(t587).toContain('pass_done_at timestamptz, pass_attempts integer not null default 0 check (pass_attempts >= 0), pass_asked_at timestamptz, pass_given_up_at timestamptz,')
    expect(finish).toContain("if r.pass_done_at is not null then return query select 'done'::text")
    const sweep = flat(definition(FUNCTIONS, 'team_call_closed_captures'))
    expect(sweep).toContain('set pass_attempts = r.pass_attempts + 1, pass_asked_at = now()')
    expect(sweep).toContain('set pass_given_up_at = now()')
    expect(flat(definition(FUNCTIONS, 'team_call_capture_pass_done'))).toContain('update public.team_call_capture r set pass_done_at = now()')
    // Leaving an empty room, or a join that failed: handed back without a gap.
    expect(flat(definition(FUNCTIONS, 'capture_feed_end'))).toContain("if p_reason in ('alone', 'failed') then")
    // A transcript its owner locked is never written at the lock.
    expect(lock).toContain('if coalesce(rebuild, true) and n > 0 and not cap.is_transcript_locked then')
    expect(quote).toContain('left join public.capture_participant p on p.id = l.participant_id')
  })

  it('the owner: a meeting’s host, else the call’s starter, else who turned notes on; access through the conversation only', () => {
    const owner = flat(definition(FUNCTIONS, 'team_call_notes_owner'))
    expect(owner).toContain('(1, (select mt.host_member_id from public.meeting mt where mt.channel_id = c.channel_id)), (2, c.started_by), (3, c.notes_by)')
    const ensure = flat(definition(FUNCTIONS, 'team_call_capture_ensure'))
    expect(ensure).toContain("'private'")
    expect(ensure).toContain('notes_channel_id')
    expect(ensure).toContain("values (c.workspace_id, 'capture', made, 'channel', c.channel_id, 'view', owner_member, 'team_call')")
    const roster = flat(definition(FUNCTIONS, 'capture_feed_roster'))
    expect(roster).toContain('public.team_chat_member_can_read(c.channel_id, person_member)')
    expect(roster).toContain('g.channel_id = c.channel_id')
  })
})
