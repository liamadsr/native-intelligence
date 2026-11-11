/**
 * Migration 552: availability phase 2. Pins the file to the app: the column
 * the store reads and writes (../sharing.ts, ../people.ts) with the values
 * the app knows and busy_only the default, the guard that keeps the column
 * the row's own user's (an admin's client update can't change it; the
 * server skips the guard as 306's does), idempotence, a lock timeout and no
 * backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AVAILABILITY_SHARING } from '../sharing'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/552_availability_sharing.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const SHARING = readFileSync(join(process.cwd(), 'src/lib/availability/sharing.ts'), 'utf8')
const PEOPLE = readFileSync(join(process.cwd(), 'src/lib/availability/people.ts'), 'utf8')

describe('migration 552', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('adds member.availability_sharing, not null, busy_only by default', () => {
    expect(BODY).toContain("alter table public.member add column if not exists availability_sharing text not null default 'busy_only';")
  })

  it("checks exactly the values the app knows", () => {
    const m = /check \(availability_sharing in \(([^)]*)\)\)/.exec(BODY)
    expect(m).not.toBeNull()
    const values = m![1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
    expect(values).toEqual([...AVAILABILITY_SHARING])
  })

  it('the store reads and writes the column it adds', () => {
    expect(SHARING).toContain(".from('member').select('availability_sharing').eq('workspace_id', person.workspaceId).eq('user_id', person.userId)")
    expect(SHARING).toContain('.update({ availability_sharing: sharing })')
    expect(PEOPLE).toContain(".select('id, user_id, display_name, role, availability_sharing')")
  })

  it("keeps the column the row's own user's: the server skips the guard, a client changing someone else's is refused", () => {
    expect(BODY).toContain('create or replace function public.member_guard_availability_sharing() returns trigger language plpgsql security definer')
    expect(BODY).toContain("set search_path = ''")
    expect(BODY).toContain("if coalesce(auth.role(), '') in ('', 'service_role') then return new; end if;")
    expect(BODY).toContain('if new.availability_sharing is distinct from old.availability_sharing and old.user_id is distinct from auth.uid() then raise exception')
    expect(BODY).toContain("using errcode = 'insufficient_privilege'")
    expect(BODY).toContain('before update of availability_sharing on public.member for each row execute function public.member_guard_availability_sharing();')
    expect(BODY).toContain('revoke all on function public.member_guard_availability_sharing() from public, anon, authenticated;')
  })

  it('re-runnable: every add guarded, every constraint and trigger dropped first, the function replaced', () => {
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]}`)
    for (const m of BODY.matchAll(/create trigger (\w+) /g)) expect(BODY).toContain(`drop trigger if exists ${m[1]} on public.member;`)
    expect(BODY).not.toMatch(/create function/)
  })

  it('takes its locks with a timeout, and touches no data', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).not.toMatch(/\b(update public\.member set|insert into|delete from|truncate)\b/i)
  })
})
