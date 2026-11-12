/**
 * Migration 589 (a call is heard only once two people were in it at once; a
 * call that ends closes its room): one transaction whatever applies it, a
 * lock timeout, the API schema reloaded, no backslash; numbered once, the
 * very next after 588. team_call_recorder_work is 588's body as merged with
 * exactly one line added (the peak filter, inside the function, before its
 * limit); team_call_people_seen only ever raises a live call's peak; the
 * close-on-end trigger puts one close per room on 564's outbox; the outbox's
 * reasons are 564's plus 'ended'. Run on DEV in a rolled-back transaction
 * (web/supabase/tests/587_capture_feed.sql); this pins the text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const SQL = read('589_call_heard_and_room_closed.sql')
const F588 = read('588_capture_feed_functions.sql')

function definition(sql: string, name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  expect(start, name).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('$$', start)
  const close = sql.indexOf('$$;', open + 2)
  return sql.slice(start, close + 3)
}

describe('migration 589', () => {
  it('one transaction with a lock timeout, the schema reloaded, no backslash, nothing dropped but the check it widens', () => {
    const body = bodyOf(SQL)
    expect(SQL).not.toContain('\\')
    expect(body).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
    expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(body).not.toMatch(/concurrently|vacuum|drop table|drop column|drop function|truncate/i)
    expect(body).not.toMatch(/to anon|to authenticated/)
  })

  it('numbered once, the very next after 588', () => {
    const numbers = migrationsInOrder().map((m) => m.num)
    expect(numbers.filter((n) => n === 589)).toHaveLength(1)
    const ordered = [...new Set(numbers)].sort((a, b) => a - b)
    expect(ordered[ordered.indexOf(588) + 1]).toBe(589)
  })

  it('the recorder’s work: 588’s body as merged, with only the peak filter added, inside the function before its limit', () => {
    const before = flat(definition(F588, 'team_call_recorder_work'))
    const after = flat(definition(SQL, 'team_call_recorder_work'))
    expect(after).toBe(before.replace(' and t.notes and not (t.id', ' and t.notes and t.peak_participants >= 2 and not (t.id'))
    expect(after.indexOf('t.peak_participants >= 2')).toBeLessThan(after.indexOf('limit greatest'))
    expect(flat(SQL)).toContain('grant execute on function public.team_call_recorder_work(text, uuid[], integer) to service_role;')
  })

  it('people seen only ever raise a live call’s peak, bounded; the service role’s alone', () => {
    const seen = flat(definition(SQL, 'team_call_people_seen'))
    expect(seen).toContain('security definer set search_path = public, pg_temp')
    expect(seen).toContain('set peak_participants = greatest(t.peak_participants, least(greatest(coalesce(people, 0), 0), 500))')
    expect(seen).toContain("and t.status = 'live' and t.peak_participants < least(greatest(coalesce(people, 0), 0), 500)")
    expect(flat(SQL)).toContain('revoke all on function public.team_call_people_seen(uuid, integer) from public, anon, authenticated;')
    expect(flat(SQL)).toContain('grant execute on function public.team_call_people_seen(uuid, integer) to service_role;')
  })

  it('a call that ends closes its room: one outbox entry per room, whatever ended it', () => {
    const t = flat(SQL)
    expect(t).toContain("add constraint team_call_eject_reason_check check (reason in ('access', 'archived', 'deleted', 'ended')) not valid;")
    expect(t).toContain('alter table public.team_call_eject validate constraint team_call_eject_reason_check;')
    const close = flat(definition(SQL, 'team_call_close_room_on_end'))
    expect(close).toContain("insert into public.team_call_eject (call_id, room, identity, reason) values (new.id, new.room, null, 'ended') on conflict do nothing;")
    expect(t).toContain("after update of status on public.team_call for each row when (old.status = 'live' and new.status = 'ended') execute function public.team_call_close_room_on_end();")
  })
})
