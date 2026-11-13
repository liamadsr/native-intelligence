/**
 * Migration 640: the owner's event triggers. Pins the file to the app: the
 * widened check keeps every earlier trigger type (458's list) and adds the
 * three new ones, every trigger the app builds is allowed, it is the newest
 * definition of the check, it is bounded and re-runnable, and holds no
 * backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { FLOW_TOOL_TRIGGER_TYPES } from '@/lib/ai/tools/flows'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/640_flow_event_triggers.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

const EARLIER = ['entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received']
const ADDED = ['email_received', 'chat_message', 'document_created']

function checkedTypes(body: string): string[] {
  const m = /add constraint flow_trigger_type_check check \(trigger_type in \(([^)]*)\)\)/.exec(body)
  expect(m, 'the check is added').not.toBeNull()
  return m![1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
}

describe('migration 640', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("keeps every earlier trigger type and adds the owner's three event triggers", () => {
    expect(checkedTypes(BODY)).toEqual([...EARLIER, ...ADDED])
  })

  it('allows every trigger type the app builds', () => {
    const allowed = new Set(checkedTypes(BODY))
    for (const t of FLOW_TOOL_TRIGGER_TYPES) expect(allowed.has(t), t).toBe(true)
  })

  it('is the newest definition of flow_trigger_type_check', () => {
    const defining = migrationsInOrder().filter((m) => /add constraint flow_trigger_type_check/i.test(m.sql))
    expect(defining[defining.length - 1].file).toBe('640_flow_event_triggers.sql')
  })

  it('is bounded and re-runnable', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).toContain('alter table public.flow drop constraint if exists flow_trigger_type_check;')
    expect(BODY.indexOf('drop constraint if exists flow_trigger_type_check')).toBeLessThan(BODY.indexOf('add constraint flow_trigger_type_check'))
    expect(BODY).not.toMatch(/create table|add column|create (unique )?index/i)
  })
})
