/**
 * Migrations 566-567 (call notes and recordings). Each is one transaction
 * whatever applies it, safe on a live database, and reloads the API schema;
 * the egress table has RLS on and no client grant; the bucket is private
 * with a read policy built on who may read the conversation and no client
 * write; the fences keep a call's notes no wider than its conversation;
 * every function is a definer with a pinned search_path, revoked from public
 * and anon, granted to one role; and no function of 565 is redefined (its
 * calls agent owns them). Run on DEV by supabase/tests/566_team_call_notes.sql
 * (rolled back); this pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const SCHEMA = read('566_team_call_notes.sql')
const FUNCTIONS = read('567_team_call_notes_functions.sql')
const FILES = { schema: SCHEMA, functions: FUNCTIONS }
const CALLS = read('565_team_call_functions.sql')

describe('migrations 566-567', () => {
  it('each is one transaction whatever applies it, safe for a live database, and reloads the API schema', () => {
    for (const [name, sql] of Object.entries(FILES)) {
      const body = bodyOf(sql)
      expect(sql, name).not.toContain('\\')
      expect(body, name).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
      expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;"), name).toBe(true)
      expect((body.match(/^(begin|commit);$/gm) ?? []).length, name).toBe(2)
      expect(body, name).not.toMatch(/concurrently|vacuum/i)
      expect(body, name).not.toMatch(/drop table|delete from|truncate|drop column|drop function/i)
      expect(body, name).not.toMatch(/to anon/)
      expect(body, name).not.toMatch(/create (unique )?index (?!if not exists)/)
      expect(body, name).not.toMatch(/add column (?!if not exists)/)
      expect(body, name).not.toMatch(/create table (?!if not exists)/)
      for (const [, c] of body.matchAll(/add constraint (\w+)/g)) {
        expect(body, c).toContain(`drop constraint if exists ${c};`)
        expect(body, c).toMatch(new RegExp(`add constraint ${c} [\\s\\S]*? not valid;`))
        expect(body, c).toContain(`validate constraint ${c};`)
      }
    }
  })

  it('redefines no function of 565', () => {
    const theirs = [...CALLS.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1])
    expect(theirs.length).toBeGreaterThan(5)
    for (const [name, sql] of Object.entries(FILES)) {
      for (const fn of theirs) expect(bodyOf(sql), `${name}: ${fn}`).not.toContain(`function public.${fn}(`)
    }
  })

  it('the egress table: RLS on, the service role only', () => {
    const body = flat(SCHEMA)
    expect(body).toContain('alter table public.team_call_egress enable row level security;')
    expect(body).toContain('revoke all on table public.team_call_egress from anon, authenticated;')
    expect(body).toContain('grant select, insert, update on table public.team_call_egress to service_role;')
    expect(body).not.toMatch(/grant [a-z, ]+ on table public\.team_call_egress to authenticated/)
    expect(body).not.toMatch(/alter publication supabase_realtime add table public\.team_call_egress/)
  })

  it('the bucket: private, read by the conversation\'s readers, never written by a client', () => {
    const body = flat(SCHEMA)
    expect(body).toMatch(/insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\) values \( 'team-call-recordings', 'team-call-recordings', false,/)
    expect(body).toContain('set public = false,')
    expect(body).toContain("bucket_id = 'team-call-recordings' and split_part(name, '/', 3) = 'recording' and public.team_chat_can_read(public.team_chat_file_channel(name))")
    const policies = [...body.matchAll(/create policy "([^"]+)" on storage\.objects for (\w+)/g)].map((m) => [m[1], m[2]])
    expect(policies).toEqual([['team call recordings read', 'select']])
  })

  it('the fences: notes stay private, shared with their conversation only, read only while it is', () => {
    const body = flat(SCHEMA)
    expect(body).toContain("raise exception 'captures: a call''s notes are shared with its conversation only'")
    expect(body).toContain('before insert or update of entity_type, entity_id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id on public.entity_access')
    expect(body).toContain("call_channel is not null and (new.grantee_kind <> 'channel' or new.grantee_channel_id is distinct from call_channel)")
    expect(body).toContain("check (source in ('manual', 'mention', 'channel_share', 'team_call')) not valid;")
    expect(body).toContain('create policy captures_team_call_notes_fence on public.captures as restrictive for select to authenticated using (notes_channel_id is null or public.team_chat_can_read(notes_channel_id));')
    expect(body).toContain('alter table public.captures add column if not exists notes_channel_id uuid;')
    expect(body).toContain('before insert or update of visibility, notes_channel_id on public.captures')
    expect(body).toContain("and split_part(name, '/', 3) = 'recording'")
  })

  it('every function: a definer with a pinned search_path, revoked from public and anon, granted to one role', () => {
    const all = `${flat(SCHEMA)} ${flat(FUNCTIONS)}`
    const fns = [...all.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1])
    expect(fns).toEqual(
      expect.arrayContaining([
        'team_call_set_notes',
        'team_call_notes_stop',
        'team_call_egress_claim',
        'team_call_recording_begin',
        'team_call_egress_event',
        'team_call_notes_on_end',
        'team_call_attach_notes',
        'team_call_notes_settle',
        'team_call_notes_capture_guard',
        'team_call_notes_grant_guard',
      ]),
    )
    for (const fn of fns) {
      const start = all.indexOf(`create or replace function public.${fn}(`)
      const head = all.slice(start, all.indexOf('$$', start))
      expect(head, fn).toContain('security definer')
      expect(head, fn).toContain('set search_path = public, pg_temp')
      expect(all, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon`))
    }
    expect(all).toContain('grant execute on function public.team_call_set_notes(uuid, boolean) to authenticated;')
    for (const fn of ['team_call_notes_stop', 'team_call_egress_claim', 'team_call_recording_begin', 'team_call_egress_event', 'team_call_attach_notes', 'team_call_notes_settle']) {
      expect(all, fn).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`))
      expect(all, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`))
    }
  })

  it('a call that ends settles its notes by a trigger, whatever ended it', () => {
    const body = flat(FUNCTIONS)
    expect(body).toContain("before update of status on public.team_call for each row when (old.status = 'live' and new.status = 'ended') execute function public.team_call_notes_on_end();")
    expect(body).toContain("if new.notes_state = 'capturing' then new.notes_state := 'transcribing';")
  })

  it('the recording cap is one transaction lock for every claim, and egress events are ordered by LiveKit\'s nanoseconds', () => {
    const body = flat(FUNCTIONS)
    expect(body).toContain('perform pg_advisory_xact_lock(566001);')
    expect(body).toContain("select count(*)::integer into running from public.team_call t where t.recording in ('starting', 'on');")
    expect(body).toContain('if stamp < e.status_at_ns')
    expect(flat(SCHEMA)).toContain("create unique index if not exists team_call_egress_one_recording on public.team_call_egress (call_id) where kind = 'recording' and status in ('starting', 'active', 'ending');")
  })
})
