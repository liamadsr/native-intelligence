/**
 * 704: the import journal. supabase/tests/704_work_imports.sql runs the SQL as
 * several people on a local Postgres; this pins the file's text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IMPORT_SOURCES, IMPORT_STATUSES, ITEM_KINDS } from '../types'

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/704_work_imports.sql'), 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

const listOf = (constraint: string) =>
  new RegExp(`${constraint} check \\((\\w+) in \\(([^)]*)\\)\\)`).exec(code)![2].match(/'([a-z_]+)'/g)!.map((v) => v.slice(1, -1))

describe('migration 704', () => {
  it('is its own transaction, re-runnable, with no backslash', () => {
    expect(code.trim().startsWith('begin;')).toBe(true)
    expect(code).toMatch(/commit;\s*notify pgrst, 'reload schema';\s*$/)
    expect(sql).not.toContain('\\')
    expect(code).not.toMatch(/create table (?!if not exists)/i)
    for (const [, name, table] of code.matchAll(/create policy (\w+) on public\.(\w+)/g)) expect(code).toContain(`drop policy if exists ${name} on public.${table};`)
    for (const [, name, table] of code.matchAll(/create trigger (\w+)\s+before insert or update on public\.(\w+)/g)) expect(code).toContain(`drop trigger if exists ${name} on public.${table};`)
  })

  it('keeps its lists in step with the app’s', () => {
    expect(listOf('work_import_source_check')).toEqual([...IMPORT_SOURCES])
    expect(listOf('work_import_status_check')).toEqual([...IMPORT_STATUSES])
    expect(listOf('work_import_item_kind_check')).toEqual([...ITEM_KINDS])
  })

  it('turns row security on and gives a client reads only, its own', () => {
    expect(code).toContain('alter table public.work_import enable row level security;')
    expect(code).toContain('alter table public.work_import_item enable row level security;')
    expect(code.match(/create policy/g)).toHaveLength(2)
    expect(code).toMatch(/create policy work_import_select_own on public\.work_import\s+for select to authenticated\s+using \(user_id = auth\.uid\(\) and public\.work_import_is_mine\(id\)\);/)
    expect(code).toMatch(/create policy work_import_item_select_own on public\.work_import_item\s+for select to authenticated\s+using \(public\.work_import_is_mine\(import_id\)\);/)
    expect(code).toContain('revoke insert, update, delete, truncate on public.work_import from anon, authenticated;')
    expect(code).toContain('revoke insert, update, delete, truncate on public.work_import_item from anon, authenticated;')
  })

  it('guards client writes in a trigger that is not a definer', () => {
    for (const fn of ['work_import_before_write', 'work_import_item_before_write']) {
      const body = new RegExp(`create or replace function public\\.${fn}\\(\\)([\\s\\S]*?)\\$\\$;`).exec(code)![1]
      expect(body).not.toMatch(/security definer/)
      expect(body).toMatch(/current_user in \('authenticated', 'anon'\)/)
      expect(body).toMatch(/tg_op = 'INSERT'/)
    }
    expect(code).toMatch(/new\.record is distinct from old\.record/)
    expect(code).toMatch(/new\.user_id is distinct from old\.user_id/)
  })
})
