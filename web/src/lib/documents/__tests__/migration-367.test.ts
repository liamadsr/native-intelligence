/**
 * Migration 367: document.kind (doc / report / prep), derived from what the
 * writers already stamp, so every row is classified and no writer changes.
 * Pins: no backslash; idempotent; a stored generated column (never written
 * by the app); prep wins over report; `type` is untouched (it feeds the edit
 * rule, 359, and a report must not become member-editable by being
 * classified); the list index.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/367_document_kind.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

describe('migration 367', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('kind is a stored generated column: prep, then report, else doc', () => {
    expect(BODY).toContain(
      "add column if not exists kind text generated always as ( case when frontmatter ? 'meeting_prep' then 'prep' when frontmatter ? 'skill_id' then 'report' else 'doc' end ) stored;",
    )
  })

  it('waits at most 5 seconds for the table lock its rewrite needs, before the rewrite', () => {
    expect(BODY.indexOf("set local lock_timeout = '5s';")).toBeGreaterThanOrEqual(0)
    expect(BODY.indexOf("set local lock_timeout = '5s';")).toBeLessThan(BODY.indexOf('alter table public.document'))
  })

  it('leaves type alone, and indexes the lists', () => {
    expect(BODY).not.toMatch(/document_type_check|alter column type|set type/)
    expect(BODY).toContain("create index if not exists idx_document_workspace_kind on public.document (workspace_id, kind, updated_at desc) where status <> 'archived';")
  })
})
