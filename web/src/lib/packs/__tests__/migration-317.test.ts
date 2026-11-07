/**
 * Migration 317 (S2, what Dial8 has learned) and the app agree: the area
 * CHECKs are the registry's areas, the scopes, statuses and sources are the
 * app's, and who may do what is held in the database. The SQL was exercised
 * on DEV inside one rolled-back block (2026-10-08), as a member, the owner
 * and an outsider of one workspace: a member's own personal line, its edit
 * and a workspace proposal each passed; a personal line for someone else, a
 * member's active workspace line, a `learned` line, a line made in someone
 * else's name, a member accepting a proposal or deleting the owner's line, an
 * area change, active back to proposed, the owner reading the member's
 * personal line, an outsider reading the workspace's lines and any client
 * read of the run log were each refused; the owner's active workspace line,
 * the owner accepting a proposal and a member withdrawing their own proposal
 * passed. This pins the file so a later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AREA_KEYS } from '../registry'

/** The 16 page areas 317 knew; 384 widens both CHECKs with content and marketing (migration-384.test.ts). */
const PAGE_AREAS = AREA_KEYS.filter((a) => a !== 'content' && a !== 'marketing')
import { MEMORY_SCOPES, MEMORY_SOURCES, MEMORY_STATUSES, MEMORY_LINE_MAX_CHARS } from '../memory-types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/317_area_memory.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

/** A policy's body, alone. */
function policy(name: string): string {
  const m = new RegExp(`create policy "${name}" on public\\.area_memory for (\\w+) to authenticated (.*?);`).exec(BODY)
  expect(m, name).not.toBeNull()
  return `${m![1]} ${m![2]}`
}

const GUARD = /create or replace function public\.area_memory_guard\(\).*?\$\$(.*?)\$\$;/.exec(BODY)?.[1] ?? ''

function at(body: string, text: string): number {
  const index = body.indexOf(text)
  expect(index, text).toBeGreaterThan(-1)
  return index
}

describe('migration 317', () => {
  it('CHECKs both tables’ area against exactly the registry’s areas', () => {
    const checks = [...BODY.matchAll(/area in \(([^)]*)\)/g)]
    expect(checks).toHaveLength(2)
    for (const [, list] of checks) {
      expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...PAGE_AREAS])
    }
  })

  it('holds scope, status and source to the app’s values, a line to 300 characters, and a personal line to one user', () => {
    const list = (col: string) => [...(new RegExp(`${col} in \\(([^)]*)\\)`).exec(BODY)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(list('scope')).toEqual([...MEMORY_SCOPES])
    expect(list('status')).toEqual([...MEMORY_STATUSES])
    expect(list('source')).toEqual([...MEMORY_SOURCES])
    expect(BODY).toContain(`check (char_length(btrim(text)) between 1 and ${MEMORY_LINE_MAX_CHARS})`)
    expect(BODY).toContain("check ((scope = 'personal') = (user_id is not null))")
  })

  it('turns RLS on for both tables, and leaves the run log to the server alone', () => {
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(BODY).toContain('alter table public.area_memory enable row level security')
    expect(BODY).toContain('alter table public.area_memory_learning_run enable row level security')
    expect(BODY).not.toMatch(/on public\.area_memory_learning_run for/)
    expect(BODY).toContain('revoke all on table public.area_memory_learning_run from anon, authenticated')
    // One row per person, area and day: the pass's idempotency.
    expect(BODY).toContain('primary key (workspace_id, user_id, area, run_date)')
  })

  it('shows a personal line only to its user, and workspace lines to every member', () => {
    const select = policy('area_memory_select')
    expect(select).toContain("(scope = 'personal' and user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))")
    expect(select).toContain("(scope = 'workspace' and public.is_workspace_member(workspace_id))")
    expect(select).not.toContain('get_member_role')
  })

  it('lets any member propose a workspace line, and only an owner or admin add an active one', () => {
    const insert = policy('area_memory_insert')
    expect(insert).toContain("(scope = 'personal' and user_id = (select auth.uid()))")
    expect(insert).toContain("(status = 'proposed' or public.get_member_role(workspace_id) in ('owner', 'admin'))")
    expect(insert.indexOf('public.is_workspace_member(workspace_id) and')).toBeGreaterThan(-1)
  })

  it('lets only an owner or admin edit, accept or delete a workspace line, and a member withdraw their own proposal', () => {
    for (const name of ['area_memory_update', 'area_memory_delete']) {
      const body = policy(name)
      expect(body).toContain("(scope = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))")
      expect(body).toContain("(scope = 'personal' and user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))")
    }
    // Update judges the new row too.
    expect(policy('area_memory_update')).toContain('with check')
    // The proposal withdraw is the only member path to a workspace row, and only for delete.
    const del = policy('area_memory_delete')
    expect(del).toContain("scope = 'workspace' and status = 'proposed' and created_by = (select auth.uid())")
    expect(policy('area_memory_update')).not.toContain('created_by')
  })

  it('trusts only the service role and no request at all, never a request without a sign-in', () => {
    const trusted = at(GUARD, "if coalesce(auth.role(), '') in ('', 'service_role') then")
    expect(GUARD).not.toContain('auth.uid() is null')
    expect(GUARD).not.toMatch(/'anon'/)
    // Every rule comes after the trust check.
    expect(trusted).toBeLessThan(at(GUARD, "if tg_op = 'INSERT' then"))
    expect(BODY).toContain("create or replace function public.area_memory_guard() returns trigger language plpgsql security definer set search_path = ''")
    expect(BODY).toContain('before insert or update on public.area_memory for each row execute function public.area_memory_guard()')
    expect(BODY).toContain('revoke execute on function public.area_memory_guard() from public, anon, authenticated')
  })

  it('keeps a client’s new line in its own name and never learned, and a line’s identity fixed', () => {
    expect(GUARD).toContain("if new.created_by is distinct from auth.uid() or new.source = 'learned' then")
    for (const col of ['id', 'workspace_id', 'area', 'scope', 'user_id', 'created_by', 'created_at']) {
      expect(GUARD).toContain(`new.${col} is distinct from old.${col}`)
    }
    expect(GUARD).toContain("if old.status = 'active' and new.status = 'proposed' then")
    expect(GUARD).toContain("if new.source is distinct from old.source and new.source <> 'edited' then")
    expect(GUARD).toContain('new.updated_by := auth.uid();')
  })
})
