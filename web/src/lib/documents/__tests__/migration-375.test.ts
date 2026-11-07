/**
 * Migration 375: personal canon keys are unique per person, workspace keys
 * per workspace; a member may set a personal key on a document they created;
 * every other rule of 366's guard is unchanged (no delete, no archive of a
 * system document, for every caller).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/375_canon_personal_keys.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()
const GUARD = (() => {
  const start = BODY.indexOf('create or replace function public.document_system_guard(')
  return BODY.slice(start, BODY.indexOf('$$;', start) + 3)
})()

describe('migration 375', () => {
  it('has no backslash and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).toContain('drop index if exists public.document_workspace_canon_key_idx;')
    expect(BODY).toContain('drop trigger if exists document_system_guard on public.document;')
  })

  it('workspace keys are unique per workspace, personal keys per creator', () => {
    expect(BODY).toContain(
      "create unique index if not exists document_workspace_canon_key_shared_idx on public.document (workspace_id, canon_key) where canon_key is not null and canon_key !~ '^(person|content-brief):';",
    )
    expect(BODY).toContain(
      "create unique index if not exists document_workspace_canon_key_personal_idx on public.document (workspace_id, created_by, canon_key) where canon_key ~ '^(person|content-brief):';",
    )
    // No creator CHECK: created_by is SET NULL when a member is removed (025).
    expect(BODY).not.toContain('add constraint document_personal_canon_creator')
    expect(BODY).toContain('alter table public.document drop constraint if exists document_personal_canon_creator;')
  })

  it("a removed member's personal canon becomes ordinary documents, before the FK nulls the creator", () => {
    const start = BODY.indexOf('create or replace function public.member_release_personal_canon(')
    const f = BODY.slice(start, BODY.indexOf('$$;', start) + 3)
    expect(f).toContain('security definer')
    expect(f).toContain("update public.document set canon_key = null where workspace_id = old.workspace_id and created_by = old.id and canon_key ~ '^(person|content-brief):';")
    expect(f).not.toMatch(/delete from public\.document/)
    expect(BODY).toContain('before delete on public.member for each row execute function public.member_release_personal_canon();')
    expect(BODY).toContain('revoke execute on function public.member_release_personal_canon() from public, anon, authenticated;')
  })

  it('the guard still refuses delete and archive for every caller, before the client check', () => {
    const g = GUARD
    expect(g.match(/errcode = 'p0013'/g)?.length).toBe(2)
    const client = g.indexOf("current_user in ('authenticated', 'anon')")
    expect(g.indexOf("if tg_op = 'delete' then")).toBeGreaterThan(0)
    expect(client).toBeGreaterThan(g.indexOf("new.status = 'archived'"))
    expect(g.slice(0, client)).not.toContain('current_user')
  })

  it('a member sets only a personal key, only on their own document, and never clears one', () => {
    const g = GUARD
    expect(g).toContain("coalesce(public.get_member_role(new.workspace_id), '') not in ('owner', 'admin')")
    expect(g).toContain("new.canon_key is not null and new.canon_key ~ '^(person|content-brief):'")
    expect(g).toContain("(tg_op = 'insert' or old.canon_key is null)")
    expect(g).toContain('new.created_by = public.current_member_id(new.workspace_id)')
  })
})
