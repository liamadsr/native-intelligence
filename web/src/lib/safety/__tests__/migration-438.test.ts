/**
 * Migration 438: a held call may be an internal write (a guest's Needs
 * approval tool that only changes Dial8). Pins: the check keeps every
 * earlier class, is safe to run twice, and the file has no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/438_tool_approval_internal_write.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 438', () => {
  it('widens tool_approval.side_effect with internal-write, keeping every earlier class, idempotently', () => {
    const drop = BODY.indexOf('alter table public.tool_approval drop constraint if exists tool_approval_side_effect_check;')
    const add = BODY.indexOf('add constraint tool_approval_side_effect_check')
    expect(drop).toBeGreaterThanOrEqual(0)
    expect(add).toBeGreaterThan(drop)
    expect(BODY).toContain("check (side_effect in ('external-write', 'delete', 'automation-write', 'unclassified', 'internal-write'))")
  })

  it('has no backslash anywhere', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
  })
})
