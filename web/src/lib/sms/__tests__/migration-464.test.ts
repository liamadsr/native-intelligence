/**
 * Migration 464: one phone, two separate accounts. Pins the file to the app:
 * user_phone.line with exactly the lines the app writes (existing rows
 * 'dial8'), one Dial8-line holder per phone with any number of business lines
 * (411's key replaced, the new one made before the old one goes), still one
 * phone per person, release_signup_number keeping only a Dial8-line holder's
 * auth phone (and still service-only), the newest word on that function,
 * idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import type { PhoneLine } from '../store'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/464_one_phone_two_accounts.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 464', () => {
  it('has no backslash, waits at most 5 s for its locks, and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).toContain('add column if not exists line')
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/drop index (?!if exists)/)
    for (const [, name] of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${name};`)
    expect(BODY).toContain('create or replace function public.release_signup_number(p_phone text)')
    expect(BODY).not.toMatch(/drop function/)
  })

  it("user_phone.line: exactly the app's lines, every existing row on the Dial8 line", () => {
    const lines: Record<PhoneLine, true> = { dial8: true, business: true }
    expect(BODY).toContain("alter table public.user_phone add column if not exists line text not null default 'dial8';")
    const listed = [...(/add constraint user_phone_line_check check \(line in \(([^)]*)\)\)/.exec(BODY)?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
    expect(listed.sort()).toEqual(Object.keys(lines).sort())
  })

  it('one Dial8-line holder per phone, any number of business lines, still one phone per person', () => {
    const key = 'create unique index if not exists user_phone_dial8_phone_key on public.user_phone (phone_e164) where verified_at is not null and line = \'dial8\';'
    const drop = 'drop index if exists public.user_phone_verified_phone_key;'
    expect(BODY).toContain(key)
    expect(BODY).toContain(drop)
    // Never a moment without the guard: the new key exists before the old one goes.
    expect(BODY.indexOf(key)).toBeLessThan(BODY.indexOf(drop))
    // 411's one-phone-per-person key is kept.
    expect(BODY).not.toContain('user_phone_user_key')
    expect(BODY).toContain('create index if not exists user_phone_phone_idx on public.user_phone (phone_e164);')
  })

  it('release_signup_number keeps only a Dial8-line holder\'s auth phone, and stays service-only', () => {
    expect(BODY).toContain('security definer')
    expect(BODY).toContain("set search_path = ''")
    expect(BODY).toMatch(/not exists \( select 1 from public\.user_phone p where p\.user_id = u\.id and p\.phone_e164 = '\+' \|\| v_bare and p\.verified_at is not null and p\.line = 'dial8' \)/)
    expect(BODY).toContain("and i.provider = 'phone'")
    expect(BODY).toContain('returns uuid[]')
    expect(BODY).toContain('revoke execute on function public.release_signup_number(text) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.release_signup_number(text) to service_role;')
  })

  it('is the newest word on release_signup_number and on the Dial8-line key', () => {
    const files = [...migrationsInOrder()].reverse()
    expect(files.find((m) => /create or replace function public\.release_signup_number\(/i.test(m.sql))!.file).toBe('464_one_phone_two_accounts.sql')
    expect(files.find((m) => /user_phone_verified_phone_key|user_phone_dial8_phone_key/.test(m.sql))!.file).toBe('464_one_phone_two_accounts.sql')
  })
})
