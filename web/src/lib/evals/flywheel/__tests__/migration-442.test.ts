/**
 * Migration 442: a dismissed agent draft is an evals candidate (GEN-1165).
 * Pins: no backslash; safe to run twice; the source check holds exactly the
 * sources the app writes (EVAL_CANDIDATE_SOURCES), so a writer never names a
 * source the table refuses.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { EVAL_CANDIDATE_SOURCES } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/442_eval_candidate_draft_dismissed.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 442', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent: the check is dropped if it exists, then added', () => {
    expect(BODY).toContain('alter table public.eval_candidate drop constraint if exists eval_candidate_source_check;')
    expect(BODY).toContain('alter table public.eval_candidate add constraint eval_candidate_source_check check (')
  })

  it('the source check holds exactly the sources the app writes', () => {
    const listed = /source in \(([^)]*)\)/.exec(BODY)?.[1]
    const sources = (listed ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(sources.sort()).toEqual([...EVAL_CANDIDATE_SOURCES].sort())
  })
})
