/**
 * Migration 457: signing up by text and single-use links (roadmap track A).
 * Pins the file: phone_signup_code and one_time_link with NO client access,
 * the sms_message kind check as 454's list plus the sign-up kinds (and the
 * newest word on it), the link purposes the app knows, release_signup_number
 * service-only and never touching a number still verified, idempotence, and
 * no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { ONE_TIME_LINK_PURPOSES } from '@/lib/links/one-time'
import type { SmsInboundKind, SmsOutboundKind } from '../store'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
const SQL = read('457_signup_by_text.sql')
const BODY = flat(SQL)
const smsKinds = (body: string) => [...(/add constraint sms_message_kind_check check \( kind in \(([^)]*)\) \)/.exec(body)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])

describe('migration 457', () => {
  it('has no backslash, waits at most 5 s for its locks, and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).toContain('create table if not exists public.phone_signup_code (')
    expect(BODY).toContain('create table if not exists public.one_time_link (')
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    for (const [, name] of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${name};`)
    expect(BODY).toContain('create or replace function public.release_signup_number(p_phone text)')
    expect(BODY).not.toMatch(/drop function/)
  })

  it('one pending sign-up code per number: two texts at once cannot both store one', () => {
    expect(BODY).toContain('create unique index if not exists phone_signup_code_one_pending_key on public.phone_signup_code (phone_e164) where consumed_at is null;')
  })

  it('phone_signup_code and one_time_link: RLS on, no client policy, no client grant', () => {
    for (const table of ['phone_signup_code', 'one_time_link']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY).toContain(`grant all on table public.${table} to service_role;`)
      expect(BODY).not.toMatch(new RegExp(`create policy [a-z_]+ on public\\.${table}`))
      expect(BODY).not.toMatch(new RegExp(`grant [a-z, ]+ on (table )?public\\.${table} to (anon|authenticated)`))
    }
  })

  it('stores only hashes, and a link is bound to one account and gone with it', () => {
    expect(BODY).toContain('code_hash text not null')
    expect(BODY).toContain('add constraint phone_signup_code_hash_length check (char_length(code_hash) = 64);')
    expect(BODY).toContain('token_hash text not null')
    expect(BODY).toContain('create unique index if not exists one_time_link_token_hash_key on public.one_time_link (token_hash);')
    expect(BODY).toContain('user_id uuid not null references auth.users(id) on delete cascade')
    expect(BODY).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(BODY).not.toMatch(/\btoken text\b/)
  })

  it("one_time_link.purpose is exactly the app's purposes", () => {
    const listed = [...(/add constraint one_time_link_purpose_check check \(purpose in \(([^)]*)\)\)/.exec(BODY)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(listed).toEqual([...ONE_TIME_LINK_PURPOSES])
  })

  it("sms_message.kind is 454's list plus the sign-up kinds: every kind the app writes", () => {
    const listed = smsKinds(BODY)
    expect([...listed].sort()).toEqual([...smsKinds(flat(read('454_presence_and_reach_route.sql'))), 'signup_code_miss', 'signup_code', 'connected'].sort())
    const inbound: Record<SmsInboundKind, true> = {
      text: true, stop: true, start: true, help: true, unknown: true, limited: true, approval: true, code_miss: true,
      guest_text: true, guest_invite: true, guest_join: true, signup_code_miss: true,
    }
    const outbound: Record<SmsOutboundKind, true> = {
      verification: true, welcome: true, reply: true, notice: true, unknown_reply: true, auto_reply: true, needs_you: true, approval_result: true, away: true,
      guest_reply: true, guest_welcome: true, guest_notice: true, signup_code: true, connected: true,
    }
    expect([...listed].sort()).toEqual([...Object.keys(inbound), ...Object.keys(outbound)].sort())
  })

  it('is the newest word on the sms_message kind check', () => {
    const newest = [...migrationsInOrder()].reverse().find((m) => /add constraint sms_message_kind_check/i.test(m.sql))!.file
    expect(newest).toBe('457_signup_by_text.sql')
  })

  it('release_signup_number: service role only, and never frees a number still verified on its account', () => {
    expect(BODY).toContain('security definer')
    expect(BODY).toContain("set search_path = ''")
    expect(BODY).toContain('revoke execute on function public.release_signup_number(text) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.release_signup_number(text) to service_role;')
    expect(BODY).toContain("and p.verified_at is not null")
    expect(BODY).toMatch(/not exists \( select 1 from public\.user_phone p where p\.user_id = u\.id/)
    expect(BODY).toContain("and i.provider = 'phone'")
    // It returns the released accounts, so the app can switch their connections off.
    expect(BODY).toContain('returns uuid[]')
  })
})
