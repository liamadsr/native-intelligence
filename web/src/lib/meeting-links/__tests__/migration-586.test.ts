/**
 * Migration 586 (where a scheduled meeting link's calendar event is, and whose
 * event it is): one transaction whatever applies it, a lock timeout, the API
 * schema reloaded; three nullable columns (additive, no rewrite, nothing
 * dropped) and meeting_revoke_as (a definer with a pinned search_path, the
 * service role's alone, the host only); server only (never in 573's column
 * grant to members); numbered once, directly after 585 (one file each, no
 * number between them or taken twice).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '586_meeting_calendar_event.sql'), 'utf8')
const body = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const flat = body.replace(/\s+/g, ' ')

describe('migration 586', () => {
  it('one transaction, a lock timeout, the schema reloaded; no backslash', () => {
    expect(body).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
    expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect((body.match(/^(begin|commit);$/gm) ?? []).length).toBe(2)
    expect(SQL).not.toContain('\\')
  })

  it('three nullable columns on meeting, additive, server only; the event’s kind is the meeting’s own or the person’s', () => {
    expect(flat).toContain('alter table public.meeting add column if not exists calendar_event_id text;')
    expect(flat).toContain('alter table public.meeting add column if not exists calendar_account_id uuid references public.connected_account(id) on delete set null;')
    expect(flat).toContain("alter table public.meeting add column if not exists calendar_event_kind text check (calendar_event_kind is null or calendar_event_kind in ('meeting', 'person'));")
    expect(body).not.toMatch(/drop |delete from|truncate|not null default|to anon|to authenticated/i)
    const grant = readFileSync(join(DIR, '573_meeting_links.sql'), 'utf8')
    expect(grant).not.toMatch(/grant select \([^)]*calendar_/)
  })

  it('meeting_revoke_as: a definer with a pinned search_path, the host only, the service role’s alone', () => {
    const fn = flat.slice(flat.indexOf('create or replace function public.meeting_revoke_as('), flat.indexOf('$$;', flat.indexOf('create or replace function public.meeting_revoke_as(')))
    expect(fn).toContain('security definer set search_path = public, pg_temp')
    expect(fn).toContain('p.id = m.host_member_id and p.user_id = acting_user')
    expect(flat).toContain('revoke all on function public.meeting_revoke_as(uuid, uuid) from public, anon, authenticated;')
    expect(flat).toContain('grant execute on function public.meeting_revoke_as(uuid, uuid) to service_role;')
  })

  it('numbered after 585', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0])).filter(Number.isFinite)
    // 586 and 585 are one file each, and 586 is the very next number after 585: what "the newest,
    // after 585" proved when it was written, without needing it to stay the newest (587 and on follow).
    expect(numbers.filter((n) => n === 586)).toHaveLength(1)
    expect(numbers.filter((n) => n === 585)).toHaveLength(1)
    const ordered = [...new Set(numbers)].sort((a, b) => a - b)
    expect(ordered[ordered.indexOf(585) + 1]).toBe(586)
    expect(ordered.indexOf(586)).toBeGreaterThan(ordered.indexOf(585))
  })
})
