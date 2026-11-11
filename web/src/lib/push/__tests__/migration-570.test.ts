/**
 * Migrations 570-571 (a team call's ring reaches the phone as a call). 570:
 * an install's VoIP token beside its alert token, registered through 562's
 * function with a kind, capped per kind, nothing new for anon. 571: which
 * rings were pushed, no client's to read (RLS on, the service role only),
 * claimed by two definers only the service role runs. Run on DEV by
 * supabase/tests/570_push_voip_calls.sql (inside a rolled-back block); this
 * pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const VOIP = read('570_push_voip_tokens.sql')
const RINGS = read('571_team_call_ring_push.sql')

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf('$$;', start))
}

describe('migrations 570-571', () => {
  it('each is one transaction, safe for a live database and the hand-applying transport, and reloads the API schema', () => {
    for (const [name, sql] of Object.entries({ VOIP, RINGS })) {
      const body = bodyOf(sql)
      expect(sql, name).not.toContain('\\')
      expect(body, name).not.toMatch(/drop table|truncate|drop column/i)
      expect(body, name).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
      expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;"), name).toBe(true)
      // Nothing new for anon (562's push_token_forget stays the one).
      expect(body, name).not.toMatch(/to anon/)
      expect(body, name).not.toMatch(/create (unique )?index (?!if not exists)/)
      expect(body, name).not.toMatch(/create table (?!if not exists)/)
    }
    // 570 replaces only the register function it widens; 571 drops nothing.
    expect(flat(VOIP).match(/drop function [^;]+;/g)).toEqual(['drop function if exists public.push_token_register(text, text, text, text);'])
    expect(bodyOf(RINGS)).not.toMatch(/drop function|drop index|alter table public\.(?!team_call_ring_push)/i)
  })

  it('570: a kind on each token, alert by default, checked, and the sender’s read by person and kind', () => {
    const body = flat(VOIP)
    expect(body).toContain("alter table public.push_token add column if not exists kind text not null default 'alert';")
    expect(body).toContain("add constraint push_token_kind check (kind in ('alert', 'voip')) not valid;")
    expect(body).toContain('validate constraint push_token_kind;')
    expect(body).toContain('create index if not exists push_token_user_kind_live_idx on public.push_token (user_id, kind) where disabled_at is null;')
  })

  it('570: register is a definer with a pinned search path, the caller’s own, capped at 10 per kind, for authenticated only', () => {
    const register = flat(fn(VOIP, 'push_token_register'))
    expect(register).toContain("token_kind text default 'alert'")
    expect(register).toContain('security definer')
    expect(register).toContain('set search_path = public, pg_temp')
    expect(register).toContain('me uuid := auth.uid();')
    expect(register).toContain("raise exception 'push: sign in first' using errcode = '42501';")
    expect(register).toContain("if k not in ('alert', 'voip') then")
    expect(register).toContain('kind = excluded.kind,')
    expect(register).toContain('and kind = k and disabled_at is null')
    expect(register).toContain('where t.user_id = me and t.kind = k and t.disabled_at is null order by t.last_seen_at desc, t.created_at desc limit 10')
    expect(flat(VOIP)).toContain('revoke all on function public.push_token_register(text, text, text, text, text) from public, anon;')
    expect(flat(VOIP)).toContain('grant execute on function public.push_token_register(text, text, text, text, text) to authenticated;')
  })

  it('571: the push rows are no client’s (RLS on, revoked, the service role only), and not in Realtime', () => {
    const body = flat(RINGS)
    expect(body).toContain('alter table public.team_call_ring_push enable row level security;')
    expect(body).toContain('revoke all on table public.team_call_ring_push from public, anon, authenticated;')
    expect(body).toContain('grant select, insert, update, delete on table public.team_call_ring_push to service_role;')
    expect(body).not.toMatch(/create policy|supabase_realtime/)
  })

  it('571: the claims are definers with a pinned search path, for the service role only', () => {
    for (const [name, args] of [
      ['team_call_ring_push_claim', 'uuid'],
      ['team_call_ring_push_cancel', 'uuid[], uuid, uuid'],
    ]) {
      const def = flat(fn(RINGS, name))
      expect(def, name).toContain('security definer')
      expect(def, name).toContain('set search_path = public, pg_temp')
      expect(flat(RINGS), name).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`)
      expect(flat(RINGS), name).toContain(`grant execute on function public.${name}(${args}) to service_role;`)
    }
  })

  it('571: a ring is pushed once, only while it rings and its time is not up', () => {
    const claim = flat(fn(RINGS, 'team_call_ring_push_claim'))
    expect(claim).toContain("if not found or r.state <> 'ringing' or r.expires_at <= now() then return;")
    expect(claim).toContain('on conflict do nothing')
  })

  it('571: a cancel goes once, only for a ring pushed and settled before its time', () => {
    const cancel = flat(fn(RINGS, 'team_call_ring_push_cancel'))
    expect(cancel).toContain('set cancelled_at = now()')
    expect(cancel).toContain('and p.cancelled_at is null')
    expect(cancel).toContain("and r.state not in ('ringing', 'busy')")
    expect(cancel).toContain('and r.expires_at > now()')
    expect(cancel).toContain('if target_rings is null and for_call is null then return;')
  })
})
