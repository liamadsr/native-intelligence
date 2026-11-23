/**
 * Migration 705 (booking insights): pins the file to the app. Every column
 * the new reads name is one it adds; attendance takes exactly the app's
 * words and only on a confirmed booking; a form row books once (its unique
 * index, and write_meeting_booking writing it, its body otherwise 581's);
 * the rule's ops are the app's own list; a link's form is its own
 * workspace's; nothing is granted to anon or authenticated; its own
 * begin/commit and a lock timeout; re-runnable. The SQL itself runs in
 * supabase/tests/705_booking_insights.sql (on a local Postgres, 29 checks).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTENDANCE, LINK_BOOKING_COLUMNS } from '../bookings'
import { FORM_REFUSAL_MAX, FORM_RULE_CONDITIONS_MAX, FORM_RULE_OPS } from '../types'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const SQL = read('supabase/migrations/705_booking_insights.sql')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const added = (table: string) => [...BODY.matchAll(new RegExp(`alter table public\\.${table} add column if not exists (\\w+) `, 'g'))].map((m) => m[1])
const fnBody = (sql: string, name: string) => {
  const flat = sql.replace(/\s+/g, ' ')
  const at = flat.lastIndexOf(`create or replace function public.${name}(`)
  return flat.slice(at, flat.indexOf('$$;', flat.indexOf('$$', at) + 2))
}

describe('migration 705', () => {
  it('has its own transaction and a lock timeout, and holds no backslash', () => {
    expect(BODY.trim().startsWith('begin;')).toBe(true)
    expect(BODY.trim().endsWith('commit;')).toBe(true)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(SQL).toContain('WITHOUT --single-transaction')
    expect(SQL).not.toContain('\\')
  })

  it('adds every column the new reads name', () => {
    const booking = added('meeting_booking')
    for (const c of ['attendance', 'attendance_marked_at', 'attendance_marked_by', 'form_row_id']) expect(booking, c).toContain(c)
    for (const c of ['attendance', 'attendance_marked_at']) expect(LINK_BOOKING_COLUMNS).toContain(c)
    const link = added('booking_link')
    for (const c of ['date_overrides', 'form_id', 'form_rule', 'form_refusal']) expect(link, c).toContain(c)
    const store = read('src/lib/booking-links/store.ts')
    for (const c of link) expect(store, c).toContain(c)
  })

  it('attendance takes exactly the app’s words, only on a confirmed booking, with its stamp', () => {
    expect(BODY).toContain(`attendance in (${ATTENDANCE.map((a) => `'${a}'`).join(', ')}) and attendance_marked_at is not null and state = 'confirmed'`)
    expect(BODY).toContain("new.attendance is not null and new.starts_at > now() then raise exception 'attendance is marked once a booking has started'")
  })

  it('a form row books once: a unique index, written in the booking’s own insert', () => {
    expect(BODY).toContain('create unique index if not exists meeting_booking_form_row_key on public.meeting_booking (form_row_id) where form_row_id is not null;')
    const now = fnBody(SQL, 'write_meeting_booking')
    expect(now).toContain("nullif(p_booking->>'form_row_id', '')::uuid")
    // The rest is 581's, word for word: only the form row is new.
    const before = fnBody(read('supabase/migrations/581_booking_links.sql'), 'write_meeting_booking')
    expect(now.replace(', form_row_id', '').replace(", nullif(p_booking->>'form_row_id', '')::uuid", '')).toBe(before)
    expect(BODY).toContain('revoke execute on function public.write_meeting_booking(jsonb, uuid[], timestamptz) from public, anon, authenticated;')
    expect(read('src/lib/time-offers/store.ts')).toContain('form_row_id?: string | null')
  })

  it('a rule holds the app’s ops and limits; a link’s form is its own workspace’s; only a meeting link has one', () => {
    for (const op of FORM_RULE_OPS) expect(BODY, op).toContain(`@.op == "${op}"`)
    expect([...BODY.matchAll(/@\.op == "(\w+)"/g)].map((m) => m[1]).sort()).toEqual([...FORM_RULE_OPS].sort())
    expect(BODY).toContain(`jsonb_array_length(form_rule->'all') <= ${FORM_RULE_CONDITIONS_MAX}`)
    expect(BODY).toContain(`char_length(form_refusal) <= ${FORM_REFUSAL_MAX}`)
    expect(BODY).toContain("form_id is null or purpose = 'meeting'")
    expect(BODY).toContain('f.id = new.form_id and f.workspace_id = new.workspace_id')
    expect(BODY).toContain('references public.data_form(id) on delete set null')
  })

  it('grants nothing to anon or authenticated, and is re-runnable', () => {
    expect(BODY).not.toMatch(/grant [^;]* to (anon|authenticated)/)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY, m[1]).toContain(`drop constraint if exists ${m[1]}`)
    for (const m of BODY.matchAll(/create trigger (\w+)/g)) expect(BODY, m[1]).toContain(`drop trigger if exists ${m[1]}`)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
  })
})
