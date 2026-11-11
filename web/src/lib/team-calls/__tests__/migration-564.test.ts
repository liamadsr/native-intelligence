/**
 * Migrations 564-565 (team calls). Each is one transaction whatever applies
 * it, safe on a live database, and reloads the API schema; every table has
 * RLS on and is fenced from anon, clients only read (and a person reads only
 * their own rings), the three tables the page listens to are published, and
 * nothing deletes from them; every function is a definer with a pinned
 * search_path, revoked from public and anon, granted to one role; the
 * message guard keeps every rule 555 gave it; and a call's message is never
 * a client's to insert. Run on DEV by supabase/tests/564_team_calls.sql
 * (rolled back); this pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const SCHEMA = read('564_team_calls.sql')
const FUNCTIONS = read('565_team_call_functions.sql')
const FILES = { schema: SCHEMA, functions: FUNCTIONS }
const OLD_GUARD = read('555_team_chat_message_columns.sql')
const OLD_POLICY = read('556_team_chat_threads.sql')

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf('$$;', start))
}

describe('migrations 564-565', () => {
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

  it('every table: RLS on, fenced from anon and the person, readable only as its policy says', () => {
    const body = flat(SCHEMA)
    for (const t of ['team_call', 'team_call_participant', 'team_call_ring', 'team_call_webhook_event']) {
      expect(body, t).toContain(`alter table public.${t} enable row level security;`)
      expect(body, t).toContain(`revoke all on table public.${t} from anon, authenticated;`)
    }
    for (const t of ['team_call', 'team_call_participant', 'team_call_ring']) expect(body, t).toContain(`grant select on table public.${t} to authenticated;`)
    // No insert, update or delete for a client, ever; the webhook ids are not even readable.
    expect(body).not.toMatch(/grant [^;]*(insert|update|delete)[^;]* to authenticated/)
    expect(body).not.toMatch(/grant [^;]* on table public\.team_call_webhook_event to authenticated/)
    expect(body).toContain('create policy team_call_select on public.team_call for select to authenticated using (public.team_chat_can_read(channel_id));')
    expect(body).toContain('create policy team_call_participant_select on public.team_call_participant for select to authenticated using (public.team_chat_can_read(channel_id));')
    // A person's rings are theirs alone.
    expect(body).toContain('create policy team_call_ring_select on public.team_call_ring for select to authenticated using (user_id = (select auth.uid()));')
    expect((body.match(/create policy /g) ?? []).length).toBe(4)
  })

  it('one live call per conversation, one open ring per call and person, one message per call', () => {
    const body = flat(SCHEMA)
    expect(body).toContain("create unique index if not exists team_call_one_live on public.team_call (channel_id) where status = 'live';")
    expect(body).toContain("create unique index if not exists team_call_ring_one_open on public.team_call_ring (call_id, member_id) where state in ('ringing', 'busy');")
    expect(body).toContain('create unique index if not exists team_chat_message_call_key on public.team_chat_message (call_id) where call_id is not null;')
  })

  it('Realtime publishes what the page listens to', () => {
    for (const t of ['team_call', 'team_call_participant', 'team_call_ring']) expect(SCHEMA).toContain(`alter publication supabase_realtime add table public.${t};`)
    expect(SCHEMA).not.toContain('add table public.team_call_webhook_event')
  })

  it('a member’s own insert is a plain message: 556’s policy, every rule kept, plus that', () => {
    const was = flat(OLD_POLICY.slice(OLD_POLICY.indexOf('create policy team_chat_message_insert'), OLD_POLICY.indexOf('-- ── The thread')))
    const now = flat(SCHEMA.slice(SCHEMA.indexOf('create policy team_chat_message_insert'), SCHEMA.indexOf('-- 555')))
    expect(now).toContain("and kind = 'message' and call_id is null")
    for (const rule of ['author_member_id = public.current_member_id(workspace_id)', 'agent_for_member_id is null', 'in_reply_to is null', 'edited_at is null', 'deleted_at is null', 'public.team_chat_can_post(channel_id)', 'r.thread_root_id is null']) {
      expect(was, rule).toContain(rule)
      expect(now, rule).toContain(rule)
    }
  })

  it('the message guard keeps every line of 555’s, plus kind, call_id and a call’s message', () => {
    const guard = fn(SCHEMA, 'team_chat_message_guard')
    for (const line of fn(OLD_GUARD, 'team_chat_message_guard').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('or new.') || l.startsWith('raise exception') || l.startsWith('new.'))) {
      // 555's last condition ended the list (`… then`); here the list goes on.
      expect(guard, line).toContain(line.replace(/ then$/, ''))
    }
    expect(guard).toContain('or new.kind is distinct from old.kind')
    expect(guard).toContain('or new.call_id is distinct from old.call_id then')
    expect(guard).toMatch(/if old\.kind = 'call' then\s+raise exception/)
  })

  it('every function is a definer with a pinned search_path, revoked from public and anon, granted to one role', () => {
    const fns: Array<[string, string]> = [
      ['team_call_start', 'authenticated'],
      ['team_call_ring_members', 'authenticated'],
      ['team_call_answer', 'authenticated'],
      ['team_call_participant_event', 'service_role'],
      ['team_call_end', 'service_role'],
      ['team_call_expire_rings', 'service_role'],
    ]
    const body = flat(FUNCTIONS)
    for (const [name, role] of fns) {
      const def = fn(FUNCTIONS, name)
      expect(def, name).toContain('security definer')
      expect(def, name).toContain('set search_path = public, pg_temp')
      expect(body, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon(, authenticated)?;`))
      const grants = [...body.matchAll(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to ([a-z_, ]+);`, 'g'))].map((m) => m[1])
      expect(grants, name).toEqual([role])
      if (role === 'service_role') expect(body, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`))
    }
    expect(fn(FUNCTIONS, 'team_call_summary')).toContain('set search_path = public, pg_temp')
  })

  it('the person’s functions check them first: post to start, read to ring, their own ring to answer', () => {
    expect(fn(FUNCTIONS, 'team_call_start')).toContain('if not public.team_chat_can_post(ch) then')
    expect(fn(FUNCTIONS, 'team_call_ring_members')).toContain('not public.team_chat_can_read(c.channel_id)')
    expect(fn(FUNCTIONS, 'team_call_ring_members')).toContain('if not public.team_chat_can_post(c.channel_id) then')
    expect(fn(FUNCTIONS, 'team_call_ring_members')).toContain('continue when not public.team_chat_member_can_read(c.channel_id, mem);')
    expect(fn(FUNCTIONS, 'team_call_answer')).toContain('where x.id = target_ring and x.user_id = auth.uid();')
  })

  it('one lock order everywhere: a call’s row before its rings and people (no two of these wait on each other)', () => {
    expect(fn(FUNCTIONS, 'team_call_participant_event')).toContain('where t.room = room_name for update;')
    expect(fn(FUNCTIONS, 'team_call_end')).toContain('where t.id = target_call for update;')
    expect(fn(FUNCTIONS, 'team_call_ring_members')).toContain('where t.id = target_call for update;')
    const answer = fn(FUNCTIONS, 'team_call_answer')
    expect(answer.indexOf('for update')).toBeGreaterThan(0)
    expect(answer.indexOf('for update')).toBeLessThan(answer.indexOf('update public.team_call_ring'))
    const expire = fn(FUNCTIONS, 'team_call_expire_rings')
    expect(expire.indexOf('for update')).toBeGreaterThan(0)
    expect(expire.indexOf('for update')).toBeLessThan(expire.indexOf('update public.team_call_ring'))
  })

  it('a member’s sessions are ordered by when they joined, never by when an event arrived', () => {
    const def = fn(FUNCTIONS, 'team_call_participant_event')
    expect(def).toContain('session_joined_at timestamptz')
    expect(def).toContain('elsif joined_time <= p.joined_at then')
    expect(def).toContain('elsif joined_time < p.joined_at then')
  })

  it('a ring past its time can’t be accepted', () => {
    expect(fn(FUNCTIONS, 'team_call_answer')).toContain('and x.expires_at > now()')
  })
})
