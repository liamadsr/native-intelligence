/**
 * Migration 666: presence knows when its person is in a meeting. Two columns
 * on user_presence, read by the router (src/lib/reach/route.ts) through
 * src/lib/presence/presence.ts inMeeting and lastMeetingAt. Pins: the only
 * 666, no backslash, a lock timeout first, safe to run twice, no rewrite of
 * the table (a constant default, a nullable time), nothing granted (the
 * table stays the service role's, 454), and the API told to reload its
 * schema (without that the store falls back and holds nothing).
 *
 * The SQL was also applied twice on PGlite (a real Postgres engine) after a
 * stand-in for 454's table holding a row, with both columns' types, defaults
 * and the old row's values asserted there.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '666_presence_meeting.sql'), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)

describe('migration 666', () => {
  it('is the only 666, holds no backslash, and takes its lock with a timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 666)).toHaveLength(1)
    expect(numbers.filter((n) => n === 454)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('adds two columns re-runnably, neither a rewrite, and nothing else', () => {
    expect(STATEMENTS.slice(1, 3)).toEqual([
      'alter table public.user_presence add column if not exists in_meeting boolean not null default false',
      'alter table public.user_presence add column if not exists meeting_at timestamptz null',
    ])
    expect(STATEMENTS.slice(3, 5).every((s) => /^comment on column public\.user_presence\.(in_meeting|meeting_at) is '/.test(s))).toBe(true)
    expect(STATEMENTS).toHaveLength(6)
    expect(STATEMENTS.join(' ')).not.toMatch(/\b(grant|create policy|create index|drop)\b/i)
  })

  it('tells the API to reload its schema, last', () => {
    expect(STATEMENTS.at(-1)).toBe("notify pgrst, 'reload schema'")
  })
})
