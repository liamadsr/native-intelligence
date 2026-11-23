import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SNIPPET_BODY_MAX, SNIPPET_NAME_MAX, SNIPPET_SHORTCUT_RE } from '@/lib/snippets/types'

// 699: snippets (docs/plans/snippets.md). supabase/tests/699_snippets.sql runs
// the SQL on a database (rehearsed on local Postgres with several people);
// this pins the file's text: RLS, the four policies, the guard, and the way a
// member's leaving is handled.
const ROOT = process.cwd()
const raw = readFileSync(join(ROOT, 'supabase/migrations/699_snippets.sql'), 'utf8')
const sql = raw.replace(/--[^\n]*/g, '')

function fn(name: string): { head: string; body: string } {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  expect(start, `699 defines ${name}`).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('as $$', start)
  const close = sql.indexOf('$$;', open + 5)
  return { head: sql.slice(start, open), body: sql.slice(open + 5, close) }
}

describe('migration 699 (snippets)', () => {
  it('has no begin/commit of its own (applied with --single-transaction), and says so', () => {
    expect(sql).not.toMatch(/^\s*(begin|commit)\s*;/im)
    expect(raw).toMatch(/--single-transaction/)
  })

  it('turns on row-level security, with a policy for each command, to authenticated only', () => {
    expect(sql).toMatch(/alter table public\.snippet enable row level security/)
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toMatch(new RegExp(`create policy snippet_${cmd} on public\\.snippet\\s+for ${cmd} to authenticated`))
    }
    expect(sql).toMatch(/revoke all on table public\.snippet from anon/)
  })

  it('reads: a member, and shared or their own (no owner or admin arm)', () => {
    const select = sql.slice(sql.indexOf('create policy snippet_select'), sql.indexOf('create policy snippet_insert'))
    expect(select).toMatch(/is_workspace_member\(workspace_id\)/)
    expect(select).toMatch(/visibility = 'workspace' or created_by = public\.current_member_id\(workspace_id\)/)
    expect(select).not.toMatch(/get_member_role/)
  })

  it('a shared one is changed by an owner or admin too; a personal one by its maker only', () => {
    for (const cmd of ['update', 'delete']) {
      const at = sql.indexOf(`create policy snippet_${cmd}`)
      const policy = sql.slice(at, sql.indexOf(';', at))
      expect(policy).toMatch(/visibility = 'workspace' and public\.get_member_role\(workspace_id\) in \('owner', 'admin'\)/)
    }
  })

  it('the guard holds clients only, is no definer, and never rewrites created_by (a member can always be removed)', () => {
    const guard = fn('snippet_before_write')
    expect(guard.head).not.toMatch(/security definer/i)
    expect(guard.body).toMatch(/current_user in \('authenticated', 'anon'\)/)
    expect(guard.body).not.toMatch(/new\.created_by\s*:=/)
    expect(guard.body).toMatch(/new\.workspace_id := old\.workspace_id/)
    expect(sql).toMatch(/before insert or update on public\.snippet/)
  })

  it("a member's leaving: set null, then their personal snippets go", () => {
    expect(sql).toMatch(/created_by uuid references public\.member\(id\) on delete set null/)
    const drop = fn('snippet_drop_orphan')
    expect(drop.head).toMatch(/security definer/i)
    expect(drop.head).toMatch(/set search_path = public, pg_temp/)
    expect(drop.body).toMatch(/created_by is null\s+and visibility = 'personal'/)
    expect(sql).toMatch(/revoke all on function public\.snippet_drop_orphan\(\) from public, anon, authenticated/)
  })

  it("its checks match the app's", () => {
    expect(sql).toContain(`'${SNIPPET_SHORTCUT_RE.source}'`)
    expect(sql).toContain(`between 1 and ${SNIPPET_NAME_MAX}`)
    expect(sql).toContain(`between 1 and ${SNIPPET_BODY_MAX}`)
    expect(sql).toMatch(/snippet_shared_shortcut_key\s+on public\.snippet \(workspace_id, shortcut\) where visibility = 'workspace'/)
    expect(sql).toMatch(/snippet_personal_shortcut_key\s+on public\.snippet \(workspace_id, created_by, shortcut\) where visibility = 'personal'/)
  })
})
