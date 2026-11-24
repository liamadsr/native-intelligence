/**
 * Every view kind a person can save a view of has its value in the database's
 * `view_entity_type` enum (docs/plans/views-everywhere.md, migration 717).
 * A kind missing from the enum still lists, but its saved views 500 (GET
 * /api/account/views filters the `view` table on the enum) and saving one fails.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FILTERABLE_FIELDS } from '@/lib/views/types'

const MIGRATIONS = path.resolve(__dirname, '../../../../supabase/migrations')

/** Kinds no saved view is ever made of: Reviews' pull requests are GitHub's (canSaveViews={false}). */
const NEVER_SAVED = new Set(['github_pr'])

function enumValues(): Set<string> {
  const values = new Set<string>()
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
    const created = /CREATE TYPE public\.view_entity_type AS ENUM \(([^)]*)\)/i.exec(sql)
    if (created) for (const m of created[1].matchAll(/'([a-z_]+)'/g)) values.add(m[1])
    for (const m of sql.matchAll(/alter type public\.view_entity_type add value if not exists '([a-z_]+)'/gi)) values.add(m[1])
  }
  return values
}

describe('view_entity_type covers every saved view kind', () => {
  const values = enumValues()

  it('reads the enum from the migrations', () => {
    expect(values.has('document')).toBe(true)
    expect(values.has('data_row')).toBe(true)
  })

  it.each(Object.keys(FILTERABLE_FIELDS).filter((k) => !NEVER_SAVED.has(k)))('%s is a value of the enum', (kind) => {
    expect(values.has(kind)).toBe(true)
  })

  it('717 adds the Drive kinds, outside a transaction, and reloads the schema', () => {
    const sql = readFileSync(path.join(MIGRATIONS, '717_views_everywhere_kinds.sql'), 'utf8')
    const code = sql
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('--'))
      .join('\n')
    for (const kind of ['canvas', 'spreadsheet', 'data_table', 'drive_item', 'campaign', 'team']) {
      expect(code).toContain(`alter type public.view_entity_type add value if not exists '${kind}';`)
    }
    expect(code).not.toMatch(/\bbegin\b|\bcommit\b/i)
    expect(code.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })
})
