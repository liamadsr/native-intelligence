import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

/**
 * Migration 675 as text (vitest cannot run it; it was applied to the DEV
 * project and exercised through the app). What is pinned here is what the
 * app relies on and what the work was told to keep to: new objects only,
 * documents' read rule, a revision that only the trigger moves, a history
 * nobody but the trigger writes, and links that follow the read rule.
 */
const FILE = '675_spreadsheets.sql'
const sql = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8').replace(/--[^\n]*/g, '')

function policy(name: string, table: string): string {
  const start = sql.search(new RegExp(`create\\s+policy\\s+${name}\\s+on\\s+public\\.${table}`, 'i'))
  expect(start, `${name} is created`).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf(';', start)).replace(/\s+/g, ' ')
}

describe('migration 675: spreadsheets', () => {
  it('carries no transaction of its own and no backslash', () => {
    expect(sql).not.toMatch(/^\s*(begin|commit)\s*;/im)
    expect(readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')).not.toContain('\\')
  })

  it('every function body is dollar-quoted on both ends (a lone dollar sign does not parse, and psql stops the whole file)', () => {
    const raw = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8').split('\n')
    const DOLLAR = String.fromCharCode(36)
    const OPEN = `as ${DOLLAR}${DOLLAR}`
    const CLOSE = `${DOLLAR}${DOLLAR};`
    const functions = raw.filter((line) => line.startsWith('create or replace function ')).length
    expect(functions).toBe(4)
    // Each body opens, then closes, one function after the other.
    const marks = raw.flatMap((line) => (line === OPEN ? ['open'] : line === CLOSE ? ['close'] : []))
    expect(marks).toEqual(Array.from({ length: functions }, () => ['open', 'close']).flat())
    // Nothing else in the statements carries a dollar sign: no half-quoted body, no other tag.
    const stray = raw.filter((line) => line.includes(DOLLAR) && line !== OPEN && line !== CLOSE && !line.trimStart().startsWith('--'))
    expect(stray).toEqual([])
  })

  it('is safe to run twice', () => {
    expect(sql.match(/create table (?!if not exists)/gi)).toBeNull()
    expect(sql.match(/create index (?!if not exists)/gi)).toBeNull()
    expect(sql.match(/create function/gi)).toBeNull()
    for (const [, name, table] of sql.matchAll(/create policy (\w+)\s+on public\.(\w+)/gi)) {
      expect(sql, `${name} is dropped first`).toMatch(new RegExp(`drop policy if exists ${name} on public\\.${table}`, 'i'))
    }
    for (const [, name, table] of sql.matchAll(/create trigger (\w+)\s+(?:before|after)[^;]*? on public\.(\w+)/gi)) {
      expect(sql, `${name} is dropped first`).toMatch(new RegExp(`drop trigger if exists ${name} on public\\.${table}`, 'i'))
    }
  })

  it('adds beside what exists: every table, function and policy it makes is its own', () => {
    const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1])
    expect(tables).toEqual(['spreadsheet', 'spreadsheet_revision', 'spreadsheet_comment'])
    const functions = [...sql.matchAll(/create or replace function public\.(\w+)/gi)].map((m) => m[1])
    expect(functions).toEqual(['spreadsheet_before_write', 'spreadsheet_track_change', 'spreadsheet_comment_guard', 'spreadsheet_entity_visible_to'])
    // No earlier migration defines these names, so "create or replace" replaces nothing.
    const earlier = migrationsInOrder().filter((m) => m.file !== FILE)
    for (const fn of functions) {
      expect(earlier.filter((m) => new RegExp(`function\\s+(public\\.)?"?${fn}"?\\s*\\(`, 'i').test(m.sql)).map((m) => m.file)).toEqual([])
    }
    const policies = [...sql.matchAll(/create policy (\w+)\s+on public\.(\w+)/gi)].map((m) => `${m[2]}.${m[1]}`)
    expect(policies.filter((p) => !p.startsWith('spreadsheet'))).toEqual([
      'entity_link.entity_link_spreadsheet_select',
      'entity_link.entity_link_spreadsheet_insert',
      'entity_link.entity_link_spreadsheet_update',
      'entity_link.entity_link_spreadsheet_delete',
    ])
    expect(sql).not.toMatch(/alter\s+type|alter\s+table\s+public\.(?!spreadsheet)|drop\s+(table|function)/i)
    expect(sql).not.toMatch(/on\s+public\.comment\b/i)
  })

  it('a member reads a workspace spreadsheet and only its maker a private one', () => {
    const read = policy('spreadsheet_select', 'spreadsheet')
    expect(read).toContain('for select to authenticated')
    expect(read).toContain("public.is_workspace_member(workspace_id) and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id))")
    const update = policy('spreadsheet_update', 'spreadsheet')
    expect(update.match(/visibility = 'workspace' or created_by = public\.current_member_id\(workspace_id\)/g)).toHaveLength(2)
    expect(policy('spreadsheet_insert', 'spreadsheet')).toContain('created_by is not distinct from public.current_member_id(workspace_id) and created_by is not null')
    expect(sql).toMatch(/constraint spreadsheet_visibility_check check \(visibility in \('workspace', 'private'\)\)/)
  })

  it('all three tables have row security on, and nothing is granted to anon', () => {
    for (const t of ['spreadsheet', 'spreadsheet_revision', 'spreadsheet_comment']) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${t} enable row level security`))
    }
    expect(sql).toMatch(/revoke all on table public\.spreadsheet, public\.spreadsheet_revision, public\.spreadsheet_comment from anon/)
    expect(sql).not.toMatch(/grant[^;]*to[^;]*\banon\b/i)
  })

  it('the revision is the trigger’s: it moves on a change of workbook, extras or title, and a writer cannot set it', () => {
    const start = sql.indexOf('function public.spreadsheet_before_write')
    const body = sql.slice(start, sql.indexOf('$$;', start)).replace(/\s+/g, ' ')
    expect(body).toContain('new.revision := old.revision;')
    expect(body).toContain('new.workbook is distinct from old.workbook or new.extras is distinct from old.extras or new.title is distinct from old.title')
    expect(body).toContain('new.revision := old.revision + 1;')
    expect(body).toContain('new.workspace_id := old.workspace_id;')
  })

  it('a member cannot take a spreadsheet over: for a client, who made it never changes and only its maker changes who sees it', () => {
    const start = sql.indexOf('function public.spreadsheet_before_write')
    const header = sql.slice(start, sql.indexOf('$$', start))
    // current_user must be the caller's role, so the guard is not a definer.
    expect(header).not.toMatch(/security definer/i)
    const body = sql.slice(start, sql.indexOf('$$;', start)).replace(/\s+/g, ' ')
    const guard = body.slice(body.indexOf("if current_user in ('authenticated', 'anon') then"))
    expect(guard.length).toBeGreaterThan(100)
    expect(guard).toMatch(/if new\.created_by is distinct from old\.created_by then raise exception '[^']+' using errcode = '42501';/)
    expect(guard).toMatch(/if new\.visibility is distinct from old\.visibility and old\.created_by is distinct from public\.current_member_id\(old\.workspace_id\) then raise exception '[^']+' using errcode = '42501';/)
    expect(guard).toContain('new.last_edited_by := public.current_member_id(old.workspace_id);')
    // It runs on every update of the table.
    expect(sql).toMatch(/create trigger spreadsheet_before_write\s+before insert or update on public\.spreadsheet\s+for each row/)
  })

  it('a reader cannot rewrite another person’s comment: its place and author never change, its words are its author’s, a resolve is signed as oneself', () => {
    const start = sql.indexOf('function public.spreadsheet_comment_guard')
    expect(start).toBeGreaterThan(0)
    const header = sql.slice(start, sql.indexOf('$$', start))
    expect(header).not.toMatch(/security definer/i)
    const body = sql.slice(start, sql.indexOf('$$;', start)).replace(/\s+/g, ' ')
    expect(body).toContain("if current_user not in ('authenticated', 'anon') then return new; end if;")
    for (const column of ['spreadsheet_id', 'workspace_id', 'author_id', 'parent_id', 'created_at']) {
      expect(body, column).toContain(`new.${column} is distinct from old.${column}`)
    }
    expect(body).toContain('v_me := public.current_member_id(old.workspace_id);')
    expect(body).toMatch(/\(new\.body is distinct from old\.body or new\.mentions is distinct from old\.mentions\) and old\.author_id is distinct from v_me then raise exception '[^']+' using errcode = '42501';/)
    expect(body).toMatch(/new\.resolved_by is distinct from old\.resolved_by and new\.resolved_by is not null and new\.resolved_by is distinct from v_me then raise exception '[^']+' using errcode = '42501';/)
    expect(body.match(/errcode = '42501'/g)).toHaveLength(3)
    // Resolving and moving the anchor are not among the refusals.
    expect(body).not.toMatch(/new\.(anchor|sheet_id|resolved_at) is distinct/)
    expect(sql).toMatch(/drop trigger if exists spreadsheet_comment_guard on public\.spreadsheet_comment;\s+create trigger spreadsheet_comment_guard\s+before update on public\.spreadsheet_comment\s+for each row execute function public\.spreadsheet_comment_guard\(\)/)
  })

  it('the history is written by the trigger alone, and read by whoever reads the spreadsheet', () => {
    expect(sql).toMatch(/revoke all on table public\.spreadsheet_revision from authenticated/)
    expect(sql).toMatch(/grant select on table public\.spreadsheet_revision to authenticated/)
    const policies = [...sql.matchAll(/create policy (\w+)\s+on public\.spreadsheet_revision\s+for (\w+)/gi)].map((m) => m[2])
    expect(policies).toEqual(['select'])
    const start = sql.indexOf('function public.spreadsheet_track_change')
    const header = sql.slice(start, sql.indexOf('$$', start))
    expect(header).toMatch(/security definer/)
    expect(header).toMatch(/set search_path = public, pg_temp/)
    expect(sql).toMatch(/revoke all on function public\.spreadsheet_track_change\(\) from public, anon, authenticated/)
    expect(sql.slice(start)).toMatch(/interval '10 minutes'/)
  })

  it('a link with a spreadsheet at either end follows the spreadsheet’s read rule, restrictively', () => {
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      const text = policy(`entity_link_spreadsheet_${verb}`, 'entity_link')
      expect(text).toContain('as restrictive')
      expect(text).toContain("source_type <> 'spreadsheet' or public.spreadsheet_entity_visible_to(source_id, workspace_id, (select auth.uid()))")
      expect(text).toContain("target_type <> 'spreadsheet' or public.spreadsheet_entity_visible_to(target_id, workspace_id, (select auth.uid()))")
    }
    const start = sql.indexOf('function public.spreadsheet_entity_visible_to')
    const body = sql.slice(start, sql.indexOf('$$;', start)).replace(/\s+/g, ' ')
    expect(body).toContain('if p_id is null or p_user is null then return false; end if;')
    expect(body).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(body).toContain("return v_visibility = 'workspace' or v_creator = v_member;")
  })

  it('a comment is written as the caller’s own member, on a spreadsheet of the same workspace', () => {
    const text = policy('spreadsheet_comment_insert', 'spreadsheet_comment')
    expect(text).toContain('author_id = public.current_member_id(workspace_id)')
    expect(text).toContain('s.workspace_id = spreadsheet_comment.workspace_id')
  })

  it('does not publish the workbook to realtime', () => {
    expect(sql).not.toMatch(/supabase_realtime|replica identity/i)
  })
})
