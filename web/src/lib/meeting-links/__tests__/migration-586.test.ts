/**
 * Migration 586 (where a scheduled meeting link's calendar event was
 * written): one transaction whatever applies it, a lock timeout, the API
 * schema reloaded; two nullable columns only (additive, no rewrite, nothing
 * dropped); server only (never in 573's column grant to members); the newest
 * file, after 585.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '586_meeting_calendar_event.sql'), 'utf8')
const body = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('migration 586', () => {
  it('one transaction, a lock timeout, the schema reloaded; no backslash', () => {
    expect(body).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
    expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect((body.match(/^(begin|commit);$/gm) ?? []).length).toBe(2)
    expect(SQL).not.toContain('\\')
  })

  it('two nullable columns on meeting, additive, server only', () => {
    expect(body).toContain('alter table public.meeting add column if not exists calendar_event_id text;')
    expect(body).toContain('alter table public.meeting add column if not exists calendar_account_id uuid references public.connected_account(id) on delete set null;')
    expect(body).not.toMatch(/drop |delete from|truncate|grant |not null/i)
    const grant = readFileSync(join(DIR, '573_meeting_links.sql'), 'utf8')
    expect(grant).not.toMatch(/grant select \([^)]*calendar_/)
  })

  it('numbered after 585', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0])).filter(Number.isFinite)
    expect(Math.max(...numbers)).toBe(586)
  })
})
