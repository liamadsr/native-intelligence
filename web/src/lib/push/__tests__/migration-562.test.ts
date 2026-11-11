/**
 * Migrations 562-563 (push for the iOS app). The token table is no client's
 * to read or write (RLS on, nothing granted but to the service role); the
 * two functions a person's app calls are definers with a pinned search path
 * that act on the caller's own rows only; the badge counts the caller's own
 * unread whoever they name. Run on DEV by supabase/tests/562_push_tokens.sql
 * (inside a rolled-back block); this pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const TOKENS = read('562_push_tokens.sql')
const BADGE = read('563_team_chat_badge.sql')

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf('$$;', start))
}

describe('migrations 562-563', () => {
  it('each is one transaction, safe for a live database and the hand-applying transport, and reloads the API schema', () => {
    for (const [name, sql] of Object.entries({ TOKENS, BADGE })) {
      const body = bodyOf(sql)
      expect(sql, name).not.toContain('\\')
      expect(body, name).not.toMatch(/drop table|truncate|drop column|drop function|alter table public\.(?!push_token)/i)
      // One transaction whatever applies it (production: plain psql < file).
      expect(body, name).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
      expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;"), name).toBe(true)
      // Nothing to anon, but the one function made for a phone whose session has ended (its header says why).
      expect(body.replace('grant execute on function public.push_token_forget(text) to anon, authenticated;', ''), name).not.toMatch(/to anon/)
      expect(body, name).not.toMatch(/create (unique )?index (?!if not exists)/)
      expect(body, name).not.toMatch(/create table (?!if not exists)/)
    }
  })

  it('the token table: RLS on, revoked from clients, the service role only', () => {
    const body = flat(TOKENS)
    expect(body).toContain('alter table public.push_token enable row level security;')
    expect(body).toContain('revoke all on table public.push_token from public, anon, authenticated;')
    expect(body).toContain('grant select, insert, update, delete on table public.push_token to service_role;')
    expect(body).not.toMatch(/grant [a-z, ]+ on table public\.push_token to authenticated/)
    expect(body).not.toMatch(/create policy/)
    // One install, one row.
    expect(body).toContain('create unique index if not exists push_token_token_key on public.push_token (token);')
  })

  it('each function is a definer with a pinned search path, revoked from public and anon, granted to whom it is for', () => {
    const fns: Array<[string, string, string, string]> = [
      [TOKENS, 'push_token_register', 'text, text, text, text', 'authenticated'],
      [TOKENS, 'push_token_remove', 'text', 'authenticated'],
      [BADGE, 'team_chat_badge', 'uuid', 'authenticated, service_role'],
    ]
    for (const [sql, name, args, to] of fns) {
      const def = flat(fn(sql, name))
      expect(def, name).toContain('security definer')
      expect(def, name).toContain('set search_path = public, pg_temp')
      expect(flat(sql), name).toContain(`revoke all on function public.${name}(${args}) from public, anon;`)
      expect(flat(sql), name).toContain(`grant execute on function public.${name}(${args}) to ${to};`)
    }
  })

  it('forget takes an install off by its token alone (the session is gone), and reads nothing back', () => {
    const forget = flat(fn(TOKENS, 'push_token_forget'))
    expect(forget).toContain('security definer')
    expect(forget).toContain('set search_path = public, pg_temp')
    expect(forget).toContain('returns boolean')
    expect(forget).toContain('delete from public.push_token where token = tok;')
    expect(flat(TOKENS)).toContain('revoke all on function public.push_token_forget(text) from public;')
    expect(flat(TOKENS)).toContain('grant execute on function public.push_token_forget(text) to anon, authenticated;')
  })

  it('register keeps at most 10 live installs a person, the ones seen longest ago disabled', () => {
    const register = flat(fn(TOKENS, 'push_token_register'))
    expect(register).toContain("set disabled_at = now(), disabled_reason = 'Superseded'")
    expect(register).toContain('order by t.last_seen_at desc, t.created_at desc limit 10')
  })

  it('register and remove act as the caller, on the caller’s own rows', () => {
    const register = flat(fn(TOKENS, 'push_token_register'))
    expect(register).toContain('me uuid := auth.uid();')
    expect(register).toContain("raise exception 'push: sign in first' using errcode = '42501';")
    expect(register).toContain('values (me, tok,')
    expect(register).toContain('on conflict (token) do update set user_id = excluded.user_id')
    const remove = flat(fn(TOKENS, 'push_token_remove'))
    expect(remove).toContain('and user_id = me;')
  })

  it('the badge: a signed-in caller is always themselves; the list’s rules (muted: mentions only; threads they are in)', () => {
    const badge = flat(fn(BADGE, 'team_chat_badge'))
    expect(badge).toContain('select coalesce(auth.uid(), for_user) as uid')
    expect(badge).toContain('public.team_chat_member_can_read(c.id, me.id)')
    expect(badge).toContain('c.archived_at is null')
    expect(badge).toContain('msg.thread_root_id is null')
    expect(badge).toContain("case when o.level = 'muted' then o.mentions + coalesce(t.mentions, 0) else o.unread + coalesce(t.unread, 0) end")
    expect(badge).toContain('public.team_chat_thread_member tm')
  })
})
