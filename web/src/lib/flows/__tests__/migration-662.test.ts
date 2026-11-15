/**
 * Migration 662: the contact_created trigger. Pins the file to the app: the
 * widened check keeps every earlier trigger type (660's list) and adds
 * contact_created, it is the newest definition of the check and allows every
 * trigger the app builds, it is added without a scan and validated on its
 * own, it is bounded and re-runnable, and it holds no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { FLOW_TOOL_TRIGGER_TYPES } from '@/lib/ai/tools/flows'
import { OWNER_EVENT_TRIGGER_TYPES } from '@/lib/flows/types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/662_contact_created_trigger.sql'), 'utf8')
const flatten = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
const BODY = flatten(SQL)

function checkedTypes(body: string): string[] {
  const m = /add constraint flow_trigger_type_check check \(trigger_type in \(([^)]*)\)\)/.exec(body)
  expect(m, 'the check is added').not.toBeNull()
  return m![1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
}

describe('migration 662', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("keeps every value of 660's check and adds contact_created", () => {
    const earlier = checkedTypes(flatten(readFileSync(join(process.cwd(), 'supabase/migrations/660_data_forms.sql'), 'utf8')))
    expect(checkedTypes(BODY)).toEqual([...earlier, 'contact_created'])
  })

  it('is the newest definition of the check, and allows every trigger the app builds', () => {
    const defining = migrationsInOrder().filter((m) => /add constraint flow_trigger_type_check/i.test(m.sql))
    expect(defining[defining.length - 1].file).toBe('662_contact_created_trigger.sql')
    const allowed = checkedTypes(BODY)
    for (const t of FLOW_TOOL_TRIGGER_TYPES) expect(allowed.includes(t), t).toBe(true)
    for (const t of OWNER_EVENT_TRIGGER_TYPES) expect(allowed.includes(t), t).toBe(true)
  })

  it('is bounded and re-runnable: dropped if there, added without a scan, then validated', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    const drop = BODY.indexOf('alter table public.flow drop constraint if exists flow_trigger_type_check;')
    const add = BODY.indexOf('add constraint flow_trigger_type_check')
    const validate = BODY.indexOf('alter table public.flow validate constraint flow_trigger_type_check;')
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(add)
    expect(BODY).toMatch(/'contact_created'\)\) not valid;/)
    expect(add).toBeLessThan(validate)
    expect(BODY.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
    // Nothing else: no table, index, column or policy.
    expect(BODY).not.toMatch(/create table|create (unique )?index|add column|create policy/i)
  })
})
