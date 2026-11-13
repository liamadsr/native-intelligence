/**
 * Migration 643: send later's table takes the owner-read grants. Pins the
 * file: everything revoked from anon and authenticated (TRUNCATE, which row
 * security does not check, included), SELECT back for authenticated alone,
 * service_role keeps all; nothing else changes; bounded, no backslash.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILE = '643_email_scheduled_send_grants.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)

describe('migration 643', () => {
  it('is the only 643, holds no backslash, and takes its locks with a timeout', () => {
    const numbers = readdirSync(join(process.cwd(), 'supabase/migrations')).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 643)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('revokes everything from anon and authenticated, then grants SELECT back to authenticated alone', () => {
    expect(STATEMENTS.slice(1)).toEqual([
      'revoke all on table public.email_scheduled_send from anon, authenticated',
      'grant select on table public.email_scheduled_send to authenticated',
      'grant all on table public.email_scheduled_send to service_role',
    ])
  })
})
