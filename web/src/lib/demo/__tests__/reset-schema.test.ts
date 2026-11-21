/**
 * The demo reset's wipe list against the schema the database is built from
 * (the baseline dump and every migration after its cut).
 *
 * reset.test.ts runs the reset on a double that answers any column it is
 * asked for. That is how seven steps that filtered on a `workspace_id` their
 * tables do not have (comment, decision, profile_fact, sms_message, flow_run,
 * milestone, cycle) passed every test and failed on production every night.
 * Each step's fence is checked here instead.
 */
import { describe, expect, it } from 'vitest'
import { relationNames, schemaSources } from '@/test/table-schema'
import { tableColumns } from '@/test/member-schema'
import { COMMENTABLE, WIPE } from '../reset'

const columns = (table: string) => tableColumns(table, schemaSources())

/** The values of an enum type: CREATE TYPE ... AS ENUM (...), plus every ALTER TYPE ... ADD VALUE. */
function enumValues(type: string): Set<string> {
  const name = String.raw`(?:"?public"?\.)?"?${type}"?`
  const values = new Set<string>()
  for (const { sql } of schemaSources()) {
    const text = sql.replace(/--[^\n]*/g, ' ')
    for (const m of text.matchAll(new RegExp(String.raw`create\s+type\s+${name}\s+as\s+enum\s*\(([^)]*)\)`, 'gi'))) {
      for (const v of m[1].matchAll(/'([^']+)'/g)) values.add(v[1])
    }
    for (const m of text.matchAll(new RegExp(String.raw`alter\s+type\s+${name}\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'`, 'gi'))) {
      values.add(m[1])
    }
  }
  return values
}

describe('the wipe list, against the schema', () => {
  it('names only tables that exist', () => {
    const relations = relationNames()
    const missing = WIPE.map((s) => s.table).filter((t) => !relations.has(t))
    expect(missing).toEqual([])
  })

  it.each(WIPE.map((s) => [s.table, s] as const))('%s: the fence reaches the workspace', (table, step) => {
    const own = columns(table)
    if (step.commentable) {
      expect(own).toContain('commentable_type')
      expect(own).toContain('commentable_id')
      for (const parent of Object.values(COMMENTABLE)) expect(columns(parent), parent).toContain('workspace_id')
    } else if (step.through) {
      expect(own).toContain(step.through.column)
      expect(columns(step.through.parent), step.through.parent).toContain('workspace_id')
    } else {
      expect(own).toContain(step.column ?? 'workspace_id')
    }
    if (step.keep === 'member_contacts') expect(own).toContain('member_id')
    if (step.keep === 'default_pipeline') expect(own).toContain('is_default')
  })

  it('knows every kind of thing a comment can be on', () => {
    // A new commentable type would leave its comments behind on every reset.
    expect([...enumValues('commentable_type')].sort()).toEqual(Object.keys(COMMENTABLE).sort())
  })

  it('clears a step through its parent before the parent itself', () => {
    const at = (t: string) => WIPE.findIndex((s) => s.table === t)
    for (const step of WIPE) {
      if (step.through && at(step.through.parent) >= 0) expect(at(step.table), step.table).toBeLessThan(at(step.through.parent))
      if (step.commentable) {
        for (const parent of Object.values(COMMENTABLE)) expect(at(step.table), parent).toBeLessThan(at(parent))
      }
    }
  })
})
