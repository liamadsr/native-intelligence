/**
 * 693: a grant never moves a record into, between or out of Drive folders.
 * supabase/tests/693_drive_folder_grant_fence.sql runs the SQL as several
 * people; this pins the file's text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const FILE = '693_drive_folder_grant_fence.sql'
const sql = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('migration 693', () => {
  it('adds one restrictive policy each for insert, update and delete, asking entity_grant_only of the filed record', () => {
    expect(code).toMatch(/create policy drive_folder_item_insert_not_by_grant on public\.drive_folder_item\s+as restrictive for insert to public\s+with check \(not public\.entity_grant_only\(item_type, item_id\)\);/)
    expect(code).toMatch(/create policy drive_folder_item_update_not_by_grant on public\.drive_folder_item\s+as restrictive for update to public\s+using \(not public\.entity_grant_only\(item_type, item_id\)\);/)
    expect(code).toMatch(/create policy drive_folder_item_delete_not_by_grant on public\.drive_folder_item\s+as restrictive for delete to public\s+using \(not public\.entity_grant_only\(item_type, item_id\)\);/)
    // Reading where a record is filed is not touched.
    expect(code).not.toMatch(/for select/i)
    expect(code.match(/create policy/g)).toHaveLength(3)
  })

  it('every kind a folder files is a kind entity_grant_only is asked about by the same word', () => {
    const f690 = migrationsInOrder().find((m) => m.file.startsWith('690_'))!.sql
    const kinds = /drive_folder_item_type_check check \(item_type in \(([^)]*)\)\)/.exec(f690)![1].match(/'([a-z_]+)'/g)!.map((k) => k.slice(1, -1))
    expect(kinds).toEqual(['document', 'data_table', 'spreadsheet', 'canvas'])
    // The newest entity_grant_only knows each by that word (520 the first two
    // kinds' arms; 688, when applied, the other two; without them it answers false).
    const newest = [...migrationsInOrder()].reverse().find((m) => /create or replace function public\.entity_grant_only\(p_type text, p_id uuid\)/.test(m.sql))!.sql
    for (const k of ['document', 'data_table']) expect(newest).toContain(`when '${k}' then exists`)
  })

  it('runs after 690, redefines no function, and is re-runnable with no transaction or backslash of its own', () => {
    const files = migrationsInOrder().map((m) => m.file)
    expect(files.indexOf(FILE)).toBeGreaterThan(files.findIndex((f) => f.startsWith('690_')))
    expect(code).not.toMatch(/create (or replace )?function/i)
    for (const [, name] of code.matchAll(/create policy (\w+)/g)) expect(code).toContain(`drop policy if exists ${name} on public.drive_folder_item;`)
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im)
    expect(code.trim().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true)
    expect(sql.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
    expect(sql).not.toContain('\\')
  })
})
