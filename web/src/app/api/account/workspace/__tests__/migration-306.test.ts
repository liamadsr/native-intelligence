/**
 * Migration 306 (member_role_guard) pins who may write public.member: the
 * server alone adds members; from a client a row's identity never moves and a
 * role changes only under the app's rules (the owner sets anyone else's role,
 * an admin moves non-owners among admin/member/guest, your own role only goes
 * down and only the owner's while another owner remains). The SQL was run on
 * DEV by supabase/tests/306_member_role_guard.sql (42 probes, inside
 * rolled-back blocks, before and after applying); this pins the file so a
 * later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(resolve(__dirname, '../../../../../../supabase/migrations/306_member_role_guard.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const FN = BODY.slice(BODY.indexOf('create or replace function public.member_guard_update()'), BODY.indexOf('$$;') + 3)

describe('migration 306', () => {
  it('takes away every client insert: no insert policy is left on member', () => {
    expect(BODY).toContain('drop policy if exists "member_insert" on public.member;')
    expect(BODY).toContain('drop policy if exists "Authenticated users can insert members" on public.member;')
    expect(BODY).not.toMatch(/create policy [^;]* on public\.member for (insert|all)\b/)
  })

  it('gives member_update a WITH CHECK: the same rows, and only the owner leaves a row saying owner', () => {
    expect(BODY).toContain('drop policy if exists "member_update" on public.member;')
    const using = "user_id = (select auth.uid()) or public.get_member_role(workspace_id) in ('owner', 'admin')"
    expect(BODY).toContain(
      `create policy "member_update" on public.member for update to authenticated using ( ${using} ) with check ( ( ${using} ) and (role <> 'owner' or public.get_member_role(workspace_id) = 'owner') );`,
    )
  })

  it('leaves the select and delete policies alone', () => {
    expect(BODY).not.toMatch(/on public\.member for (select|delete)\b/)
    expect(BODY).not.toContain('member_delete')
  })

  it('trusts only the service role or no request at all, never a missing uid alone', () => {
    expect(FN).toContain("returns trigger language plpgsql security definer set search_path = '' as $$")
    expect(FN).toContain("if coalesce(auth.role(), '') in ('', 'service_role') then return new; end if;")
    expect(BODY).not.toContain('auth.uid() is null')
    // search_path is empty, so every table it reads is schema-qualified.
    expect(FN.match(/(?<!distinct )\bfrom \S+/g)).toEqual(['from public.member', 'from public.member'])
  })

  it('never lets a client move a row to another user or workspace', () => {
    expect(FN).toContain(
      'if new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.workspace_id is distinct from old.workspace_id then raise exception',
    )
  })

  it('changes a role only under the app’s rules', () => {
    // Unchanged roles pass straight through (onboarding and profile self-updates).
    expect(FN).toContain('if new.role is not distinct from old.role then return new; end if;')
    expect(FN).toContain('from public.member m where m.workspace_id = old.workspace_id and m.user_id = v_uid;')
    expect(FN).toContain('if v_uid is null or v_caller_role is null then raise exception')
    // Your own row: only the owner steps down, and only while another owner remains.
    const self = FN.indexOf('if old.user_id = v_uid then')
    expect(self).toBeGreaterThan(-1)
    expect(FN).toContain("if old.role <> 'owner' then raise exception 'You cannot change your own role'")
    expect(FN).toContain("from public.member o where o.workspace_id = old.workspace_id and o.role = 'owner' and o.id <> old.id")
    // Then the owner sets anyone else's role; an admin only between non-owner roles.
    const owner = FN.indexOf("if v_caller_role = 'owner' then return new; end if;")
    const admin = FN.indexOf("if v_caller_role = 'admin' and old.role <> 'owner' and new.role <> 'owner' then return new; end if;")
    expect(self).toBeLessThan(owner)
    expect(owner).toBeLessThan(admin)
    // Everything else is refused, every refusal with the same SQLSTATE (42501, a 403 from PostgREST).
    expect(FN.trimEnd().endsWith("using errcode = 'insufficient_privilege'; end; $$;")).toBe(true)
    expect((FN.match(/using errcode = 'insufficient_privilege'/g) ?? []).length).toBe(5)
    expect(FN).not.toMatch(/raise exception [^;]*using errcode = '(?!insufficient_privilege)/)
  })

  it('fires before every update of member, replaced idempotently, and is never called directly', () => {
    const drop = BODY.indexOf('drop trigger if exists member_guard_update on public.member;')
    const create = BODY.indexOf(
      'create trigger member_guard_update before update on public.member for each row execute function public.member_guard_update();',
    )
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(create)
    expect(BODY).toContain('revoke execute on function public.member_guard_update() from public, anon, authenticated;')
  })
})
