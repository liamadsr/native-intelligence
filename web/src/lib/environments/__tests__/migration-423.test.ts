/**
 * Migration 423 (docs/plans/environments.md §8 E5): the old cloud_environment
 * table and projects.cloud_env_id go. It pins that the two functions that
 * still named the column are redefined first, each exactly as its latest
 * earlier definition minus that one assignment; then the column and the table
 * are dropped; and that nothing in the app still reads or writes either name.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
const SQL = read('423_environments_drop_cloud_environment.sql')
/** The file without comments, one space for every run of whitespace. */
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

/**
 * A function's body: what sits between its dollar quotes, whitespace collapsed.
 * Case-insensitive on the CREATE (420 writes it in lower case; 423 is
 * pg_get_functiondef's upper case). Exactly one definition per file.
 */
function bodyOf(sql: string, name: string): string {
  const needle = `create or replace function public.${name}(`
  const lower = sql.toLowerCase()
  const start = lower.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(lower.indexOf(needle, start + needle.length)).toBe(-1)
  const open = sql.indexOf('$$', start)
  return sql.slice(open + 2, sql.indexOf('$$', open + 2)).replace(/\s+/g, ' ').trim()
}

describe('migration 423: the old cloud_environment table goes', () => {
  it('redefines move_project exactly as 369 has it, minus the cloud_env_id reset', () => {
    const before = bodyOf(read('369_document_visibility.sql'), 'move_project')
    expect(before).toContain('cloud_env_id = NULL, ')
    expect(bodyOf(SQL, 'move_project')).toBe(before.replace('cloud_env_id = NULL, ', ''))
  })

  it('redefines _wsmerge_environments exactly as 420 has it, minus the cloud_env_id reset', () => {
    const before = bodyOf(read('420_environments.sql'), '_wsmerge_environments')
    expect(before).toContain(', cloud_env_id = null')
    expect(bodyOf(SQL, '_wsmerge_environments')).toBe(before.replace(', cloud_env_id = null', ''))
  })

  it('drops the column and then the table, after the functions', () => {
    const lastFn = BODY.lastIndexOf('$$')
    const col = BODY.indexOf('alter table public.projects drop column if exists cloud_env_id;')
    const table = BODY.indexOf('drop table if exists public.cloud_environment;')
    expect(col).toBeGreaterThan(lastFn)
    expect(table).toBeGreaterThan(col)
  })

  it('never names cloud_env_id outside its drop', () => {
    expect(BODY.split('cloud_env_id').length - 1).toBe(1)
  })

  it('leaves nothing in the app reading or writing the old names', () => {
    const OLD = /cloud_env_id|cloud-environments|public\.cloud_environment\b|from\(.cloud_environment.\)/
    const SKIP = new Set(['migration-420.test.ts', 'migration-423.test.ts'])
    const hits: string[] = []
    const walk = (dir: string) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|mts|js|mjs|sh)$/.test(e.name) && !SKIP.has(e.name) && OLD.test(readFileSync(p, 'utf8'))) hits.push(p)
      }
    }
    for (const d of ['src', 'agents', 'scripts', 'supabase/functions', 'packages', 'evals']) walk(join(process.cwd(), d))
    expect(hits).toEqual([])
  })
})
