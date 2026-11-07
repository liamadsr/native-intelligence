/**
 * Migration 393: a coding run's review trail (P10 F6). Pins: the column is
 * added idempotently, empty by default (the loop's count starts at zero for
 * every run), a lock timeout, nothing else changed, no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/393_coding_run_review_trail.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 393', () => {
  it('adds the trail, empty by default, idempotently', () => {
    expect(BODY).toContain("alter table public.agent_run add column if not exists review_trail jsonb not null default '[]'::jsonb;")
  })

  it('sets a lock timeout and changes nothing else', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).not.toMatch(/\b(drop|delete|truncate|update)\b/i)
  })

  it('has no backslash (the MCP apply decodes escapes)', () => {
    expect(SQL.includes('\\')).toBe(false)
  })
})
