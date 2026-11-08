/**
 * Migration 472: reminders and confirmations (issue #11). Pins the file to
 * the app: the values the app writes, one reminder per subject and phone,
 * the two new columns (reminders on by default), RLS on the new table,
 * idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMINDER_ANSWERS, REMINDER_STATUSES, REMINDER_SUBJECTS } from '../reminder-store'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/472_customer_reminders.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

describe('migration 472', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('checks the subject types, statuses and answers the app writes', () => {
    expect(BODY).toContain(`check (subject_type in (${list(REMINDER_SUBJECTS)}))`)
    expect(BODY).toContain(`check (status in (${list(REMINDER_STATUSES)}))`)
    expect(BODY).toContain(`check (answer is null or answer in (${list(REMINDER_ANSWERS)}))`)
  })

  it('one reminder per subject and phone: never twice for one booking', () => {
    expect(BODY).toContain('create unique index if not exists customer_reminder_subject_key on public.customer_reminder (workspace_id, subject_type, subject_id, phone_e164);')
  })

  it("the customer's yes on a booking, and reminders on unless the owner turns them off", () => {
    expect(BODY).toContain('alter table public.customer_booking add column if not exists customer_confirmed_at timestamptz null;')
    expect(BODY).toContain('alter table public.business_profile add column if not exists reminders boolean not null default true;')
  })

  it('RLS on: members read their workspace’s reminders, only the service role writes', () => {
    expect(BODY).toContain('alter table public.customer_reminder enable row level security;')
    expect(BODY).toContain('for select to authenticated using (public.is_workspace_member(workspace_id));')
    expect(BODY).toContain('revoke all on table public.customer_reminder from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.customer_reminder to authenticated;')
    expect(BODY).not.toMatch(/grant (insert|update|delete|all) on table public\.customer_reminder to authenticated/)
  })

  it('re-runnable: every create and add guarded, every constraint dropped first', () => {
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]}`)
  })
})
