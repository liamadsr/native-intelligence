/**
 * Migration 723: meeting_attendance (roadmap #12). Text checks of the SQL
 * file, against the code's own names (src/lib/meeting-agent/store.ts).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTENDANCE_COLUMNS, ATTENDANCE_STATUSES, MEETING_ATTENDANCE_TABLE } from '@/lib/meeting-agent/store'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '723_meeting_attendance.sql'), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)

describe('migration 723 (text checks of the SQL file)', () => {
  it('is the only 723, holds no backslash, is its own transaction with a lock timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 723)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe('begin')
    expect(STATEMENTS[1]).toBe("SET LOCAL lock_timeout = '5s'")
    expect(STATEMENTS.at(-1)).toBe('commit')
    expect(STATEMENTS).toContain("notify pgrst, 'reload schema'")
  })

  it('creates the table the code names, with every column the code reads', () => {
    expect(MEETING_ATTENDANCE_TABLE).toBe('meeting_attendance')
    expect(SQL).toContain('create table if not exists public.meeting_attendance (')
    for (const column of ATTENDANCE_COLUMNS.split(',').map((c) => c.trim())) {
      expect(SQL, column).toMatch(new RegExp(`\\n  ${column} `))
    }
    for (const column of ['join_token_hash', 'status_at', 'dial_started_at', 'announced_at', 'objected_at']) expect(SQL).toMatch(new RegExp(`\\n  ${column} `))
  })

  it('allows exactly the statuses the code knows', () => {
    const list = ATTENDANCE_STATUSES.map((s) => `'${s}'`).join(', ')
    expect(SQL).toContain(`check (status in (${list}))`)
  })

  it('never lets a row dial without an approved brief and a number, and keys it by the meeting', () => {
    expect(SQL).toContain("check (status in ('draft', 'cancelled') or (brief_approved_at is not null and dial_in_number is not null))")
    expect(SQL).toContain('unique (workspace_id, user_id, calendar_event_id, starts_at)')
    expect(SQL).toContain('create unique index if not exists meeting_attendance_token_idx')
  })

  it('is private to the person: RLS on, owner-only policies, and the grants restated', () => {
    expect(SQL).toContain('alter table public.meeting_attendance enable row level security')
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(SQL).toContain(`create policy "meeting_attendance_${verb}"`)
    }
    expect(SQL.match(/user_id = \(select auth\.uid\(\)\) and public\.is_workspace_member\(workspace_id\)/g)?.length).toBe(5)
    expect(SQL).toContain('revoke all on table public.meeting_attendance from anon, authenticated')
  })

  it('says how to apply it, in what order, and where its number came from', () => {
    expect(SQL).toContain('HOW TO APPLY:')
    expect(SQL).toContain('WITHOUT --single-transaction')
    expect(SQL).toContain('⛔ PROD ORDER:')
    expect(SQL).toContain('NUMBER: 723 is the first free number after main')
  })
})
