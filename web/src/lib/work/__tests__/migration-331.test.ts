/**
 * Migration 331: a job's plan in its own `tracked_job.plan` column. Pins: the
 * column is nullable jsonb with no backfill, the check keeps it a JSON object,
 * every statement is safe to run twice, and the file has no backslash (the
 * PROD apply path mangles them).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/331_job_plan.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 331', () => {
  it('adds a nullable jsonb plan column, idempotently, with no default and no backfill', () => {
    expect(BODY).toContain('alter table public.tracked_job add column if not exists plan jsonb;')
    expect(BODY).not.toMatch(/plan jsonb (not null|default)/)
    expect(BODY).not.toMatch(/\bupdate public\.tracked_job\b/)
  })

  it('checks the plan is null or a JSON object, dropping the check first so a re-run adds it again', () => {
    const drop = BODY.indexOf('drop constraint if exists tracked_job_plan_object_check;')
    const add = BODY.indexOf('add constraint tracked_job_plan_object_check')
    expect(drop).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(drop)
    expect(BODY).toContain("check (plan is null or jsonb_typeof(plan) = 'object');")
  })

  it('leaves progress, RLS and the realtime publication alone', () => {
    const statements = BODY.split(';').filter((s) => !s.trim().startsWith('comment on'))
    for (const s of statements) expect(s).not.toContain('progress')
    expect(BODY).not.toMatch(/policy|row level security|publication|replica identity/i)
  })

  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('every statement is idempotent (if not exists / drop if exists / comment)', () => {
    const statements = BODY.split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of statements) {
      expect(/if not exists|if exists|^comment on|^alter table public\.tracked_job add constraint/.test(s), s).toBe(true)
    }
  })
})
