/**
 * Migration 727: meeting_attendance_series (roadmap #12 phase 2). Text checks
 * of the SQL file, against the code's own names (src/lib/meeting-agent/series.ts).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEETING_SERIES_TABLE, SERIES_COLUMNS } from '@/lib/meeting-agent/series'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '727_meeting_attendance_series.sql'), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)

describe('migration 727 (text checks of the SQL file)', () => {
  it('is the only 727, holds no backslash, is its own transaction with a lock timeout, and reloads the API', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 727)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe('begin')
    expect(STATEMENTS[1]).toBe("SET LOCAL lock_timeout = '5s'")
    expect(STATEMENTS.at(-1)).toBe('commit')
    expect(STATEMENTS).toContain("notify pgrst, 'reload schema'")
  })

  it('creates the table the code names, with every column the code reads, one per person per series', () => {
    expect(MEETING_SERIES_TABLE).toBe('meeting_attendance_series')
    expect(SQL).toContain('create table if not exists public.meeting_attendance_series (')
    for (const column of SERIES_COLUMNS.split(',').map((c) => c.trim())) expect(SQL, column).toMatch(new RegExp(`\\n  ${column} `))
    expect(SQL).toContain('constraint meeting_attendance_series_key unique (workspace_id, user_id, series_id)')
    expect(SQL).toContain('brief_approved_at timestamptz not null')
  })

  it("adds series_ref to 723's table, additively, set null when a series goes", () => {
    expect(SQL).toContain('alter table public.meeting_attendance add column if not exists series_ref uuid references public.meeting_attendance_series(id) on delete set null')
  })

  it('is private to the person, and a merge never stops on it', () => {
    expect(SQL).toContain('alter table public.meeting_attendance_series enable row level security')
    for (const verb of ['select', 'insert', 'update', 'delete']) expect(SQL).toContain(`create policy "meeting_attendance_series_${verb}"`)
    expect(SQL.match(/user_id = \(select auth\.uid\(\)\) and public\.is_workspace_member\(workspace_id\)/g)?.length).toBe(5)
    expect(SQL).toContain('revoke all on table public.meeting_attendance_series from anon, authenticated')
    expect(SQL).toContain("new.series_id := left(new.series_id, 280) || '-merged-' || left(replace(old.id::text, '-', ''), 8)")
    expect(SQL).toContain('before update of workspace_id on public.meeting_attendance_series')
  })

  it('says how to apply it, in what order, and where its number came from', () => {
    expect(SQL).toContain('HOW TO APPLY:')
    expect(SQL).toContain('WITHOUT --single-transaction')
    expect(SQL).toContain('⛔ PROD ORDER: after 723')
    expect(SQL).toContain('NUMBER: 727 was assigned by the managing session')
  })
})
