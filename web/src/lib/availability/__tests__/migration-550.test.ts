/**
 * Migration 550: availability phase 1. Pins the file to the app: the table
 * and columns the store reads and writes (../schedule.ts, ../busy.ts), one
 * row per person, the zone check the app's own check matches, RLS on (a
 * person reads their own hours, only the service role writes), idempotence,
 * and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isStorableTimeZone } from '@/lib/agent-events/member-time-zone'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/550_availability_schedule.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const SCHEDULE = readFileSync(join(process.cwd(), 'src/lib/availability/schedule.ts'), 'utf8')
const BUSY = readFileSync(join(process.cwd(), 'src/lib/availability/busy.ts'), 'utf8')

describe('migration 550', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('one row per person, keyed on the user, gone with them', () => {
    expect(BODY).toContain('create table if not exists public.availability_schedule ( user_id uuid primary key references auth.users(id) on delete cascade,')
    expect(BODY).toContain('time_zone text null,')
    expect(BODY).toContain('weekly jsonb not null,')
    expect(BODY).toContain("overrides jsonb not null default '{}'::jsonb,")
    expect(BODY).toContain('updated_at timestamptz not null default now()')
  })

  it('the columns the store reads and writes are the ones the table has', () => {
    expect(SCHEDULE).toContain(".from('availability_schedule').select('time_zone, weekly, overrides').eq('user_id', person.userId)")
    expect(SCHEDULE).toContain("{ user_id: person.userId, time_zone: timeZone, weekly, overrides, updated_at: new Date(now).toISOString() }, { onConflict: 'user_id' }")
    expect(BUSY).toContain(".from('calendar_sub_preference').select('account_id, provider_calendar_id, counts_as_busy')")
  })

  it('checks a seven-day week, an object of overrides, and the zone shape the app stores', () => {
    expect(BODY).toContain("check (jsonb_typeof(weekly) = 'array' and jsonb_array_length(weekly) = 7)")
    expect(BODY).toContain("check (jsonb_typeof(overrides) = 'object')")
    expect(BODY).toContain("check (time_zone is null or time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$')")
    // Every zone the app would store passes the column's check.
    const columnRe = /^[A-Za-z0-9_+/-]{1,64}$/
    for (const zone of ['America/New_York', 'Etc/GMT+5', 'America/Port-au-Prince', 'UTC']) {
      expect(isStorableTimeZone(zone), zone).toBe(true)
      expect(columnRe.test(zone), zone).toBe(true)
    }
  })

  it('counts_as_busy: a nullable choice, null keeping the default', () => {
    expect(BODY).toContain('alter table public.calendar_sub_preference add column if not exists counts_as_busy boolean null;')
    expect(BODY).not.toMatch(/counts_as_busy boolean (not null|null default)/)
  })

  it('RLS on: a person reads their own hours, only the service role writes', () => {
    expect(BODY).toContain('alter table public.availability_schedule enable row level security;')
    expect(BODY).toContain('for select to authenticated using (auth.uid() = user_id);')
    expect(BODY).toContain('revoke all on table public.availability_schedule from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.availability_schedule to authenticated;')
    expect(BODY).toContain('grant all on table public.availability_schedule to service_role;')
    expect(BODY).not.toMatch(/grant (insert|update|delete|all) on table public\.availability_schedule to (anon|authenticated)/)
    expect(BODY).not.toMatch(/for (insert|update|delete|all) to (anon|authenticated)/)
  })

  it('re-runnable: every create and add guarded, every constraint and policy dropped first', () => {
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]}`)
    for (const m of BODY.matchAll(/create policy (\w+) on (public\.\w+)/g)) expect(BODY).toContain(`drop policy if exists ${m[1]} on ${m[2]};`)
  })

  it('takes its locks with a timeout', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })
})
