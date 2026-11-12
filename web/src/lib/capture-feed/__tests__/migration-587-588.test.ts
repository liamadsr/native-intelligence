/**
 * Migrations 587-588 (the capture feed: one recorder per call, phase 1). Each
 * is one transaction whatever applies it, with a lock timeout, and reloads
 * the API schema; no backslash anywhere; numbered once each, after 586. The
 * feed's tables have RLS on and no client grant; every function is the
 * service role's alone, a definer with a pinned search_path (the two pure
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
      if (name === 'capture_feed_label_base' || name === 'capture_feed_close_gap') {
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
