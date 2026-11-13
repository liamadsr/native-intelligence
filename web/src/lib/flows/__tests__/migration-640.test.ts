/**
 * Migration 640: the owner's event triggers. Pins the file to the app: the
 * widened check keeps every earlier trigger type (458's list) and adds the
 * three new ones, every trigger the app builds is allowed, it is the newest
 * definition of the check, it is bounded and re-runnable, and holds no
 * backslash. And the flow_run read fence: a nullable private_to stamp on
 * each run, and 107's policy restated as the newest definition, still a
 * workspace-member read, now with a stamped run readable only by its user.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { FLOW_TOOL_TRIGGER_TYPES } from '@/lib/ai/tools/flows'
import { OWNER_EVENT_TRIGGER_TYPES, canReadFlowRun, flowRunPrivateTo } from '@/lib/flows/types'

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
    expect(BODY).not.toMatch(/create table|create (unique )?index/i)
    // One column, nullable, no default, no foreign key (a removed user's runs stay private, never public).
    expect(BODY.match(/add column/gi)).toHaveLength(1)
    expect(BODY).toContain('alter table public.flow_run add column if not exists private_to uuid;')
  })

  describe('the flow_run read policy', () => {
    const POLICY = /create policy "members read workspace flow runs" on public\.flow_run for select using \((.*)\);/

    it('is dropped then created again (re-runnable)', () => {
      const drop = BODY.indexOf('drop policy if exists "members read workspace flow runs" on public.flow_run;')
      expect(drop).toBeGreaterThan(-1)
      expect(drop).toBeLessThan(BODY.indexOf('create policy "members read workspace flow runs"'))
    })

    it('is the newest definition of the policy', () => {
      const defining = migrationsInOrder().filter((m) => /create policy "members read workspace flow runs"/i.test(m.sql))
      expect(defining.map((m) => m.file)).toEqual(['107_flows.sql', '640_flow_event_triggers.sql'])
    })

    it("keeps 107's member read and adds the run's own stamp, never the loop's current trigger or owner", () => {
      const m = POLICY.exec(BODY)
      expect(m, 'the policy is created').not.toBeNull()
      const using = m![1]
      expect(using).toContain('select 1 from public.flow f where f.id = flow_run.flow_id and public.is_workspace_member(f.workspace_id)')
      expect(using).toContain('and (flow_run.private_to is null or flow_run.private_to = auth.uid())')
      expect(using).not.toMatch(/trigger_type|created_by/)
    })

    it("keepRunState's table (step outputs, parked runs) stays server-only: no migration grants it a policy", () => {
      const touching = migrationsInOrder().filter((m) => /on public\.flow_run_state/i.test(m.sql))
      for (const m of touching) expect(m.sql, m.file).not.toMatch(/create policy[^;]*on public\.flow_run_state/i)
      const defining = migrationsInOrder().find((m) => /create table if not exists public\.flow_run_state/i.test(m.sql))
      expect(defining?.sql).toMatch(/alter table public\.flow_run_state enable row level security;\s*revoke all on public\.flow_run_state from anon, authenticated;/)
    })

    it('the stamp: the run-as user for exactly the owner event triggers; canReadFlowRun, the code twin, agrees', () => {
      for (const t of OWNER_EVENT_TRIGGER_TYPES) {
        expect(flowRunPrivateTo(t, 'u-owner')).toBe('u-owner')
        expect(flowRunPrivateTo(t, null)).toBeNull()
      }
      for (const t of EARLIER) expect(flowRunPrivateTo(t, 'u-owner')).toBeNull()
      expect(canReadFlowRun({ private_to: 'u-owner' }, 'u-owner')).toBe(true)
      expect(canReadFlowRun({ private_to: 'u-owner' }, 'u-teammate')).toBe(false)
      expect(canReadFlowRun({ private_to: 'u-owner' }, null)).toBe(false)
      expect(canReadFlowRun({ private_to: null }, 'u-teammate')).toBe(true)
      expect(canReadFlowRun({}, 'u-teammate')).toBe(true)
      expect(canReadFlowRun(null, 'u-owner')).toBe(false)
    })
  })
})
