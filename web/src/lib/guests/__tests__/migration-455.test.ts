/**
 * Migration 455: a guest's calendar addresses. Pins the file: one additive
 * column with an empty default, its cap the app's own (GUEST_CALENDAR_EMAILS_MAX)
 * under a named check, a comment, idempotence, no data change, no backslash,
 * and the guest reads select the column it adds.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { AGENT_GUEST_SELECT, GUEST_CALENDAR_EMAILS_MAX } from '../store'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/455_guest_calendar_emails.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase()

describe('migration 455', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('adds calendar_emails, empty by default, never null', () => {
    expect(BODY).toContain("alter table public.agent_guest add column if not exists calendar_emails text[] not null default '{}';")
    expect(BODY).toContain('comment on column public.agent_guest.calendar_emails is')
  })

  it('caps it at the app’s own limit, under a named check', () => {
    expect(GUEST_CALENDAR_EMAILS_MAX).toBe(5)
    expect(BODY).toContain(`add constraint agent_guest_calendar_emails_max check (cardinality(calendar_emails) <= ${GUEST_CALENDAR_EMAILS_MAX});`)
  })

  it('is idempotent and changes no data', () => {
    for (const m of BODY.matchAll(/add constraint ([a-z_]+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const word of ['create table', 'insert into', 'update public.', 'delete from', 'drop table', 'drop column']) expect(BODY).not.toContain(word)
  })

  it('is the newest word on its check, and the guest reads select the column', () => {
    const newest = [...migrationsInOrder()].reverse().find((m) => /add constraint agent_guest_calendar_emails_max/i.test(m.sql))
    expect(newest?.file).toBe('455_guest_calendar_emails.sql')
    expect(AGENT_GUEST_SELECT.split(', ')).toContain('calendar_emails')
  })
})
