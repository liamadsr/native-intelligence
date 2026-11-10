/**
 * The vocabularies that used to be hand-written lists and now derive from the
 * entity registry. Each expectation is the list as it stood before the
 * derivation (2026-11-09), so the move changed no behaviour.
 */
import { describe, it, expect } from 'vitest'
import { TABLES } from '@/hooks/use-realtime-entities'
import { ENTITY_CONFIG } from '@/lib/views/entity-siblings'

describe('realtime bindings derived from the registry', () => {
  it('bind exactly the tables the hand-written map bound, with the same filtering', () => {
    const before = ([
      ['actions', 'action', true],
      ['projects', 'project', true],
      ['initiative', 'initiative', true],
      ['captures', 'capture', true],
      ['document', 'document', true],
      ['contact', 'contact', true],
      ['company', 'company', true],
      ['deal', 'deal', true],
      ['claim', 'claim', true],
      ['entity_link', 'entity_link', true],
      ['comment', 'comment', false],
      ['decision', 'decision', false],
      ['cycle', 'cycle', false],
      ['milestone', 'milestone', false],
      ['workflow_state', 'workflow_state', false],
      ['label', 'label', true],
      ['team', 'team', true],
      ['team_member', 'team', false],
      ['member', 'member', true],
      ['recipe', 'recipe', true],
      ['flow', 'flow', true],
      ['flow_run', 'flow_run', false],
      ['email_draft', 'email_draft', true],
      ['contact_interaction', 'contact_interaction', true],
      ['local_calendar_event', 'calendar_event', true],
      ['agent_run', 'agent_run', true],
      ['capture_participant', 'capture_participant', false],
      ['sequence', 'sequence', true],
      ['sequence_enrollment', 'sequence_enrollment', true],
      ['eval_suite', 'eval_suite', true],
      ['eval_case', 'eval_case', true],
      ['eval_run', 'eval_run', true],
      // Tables (520): the table only, one event per write batch.
      ['data_table', 'data_table', true],
    ] as const).map(([table, entityType, filtered]) => ({ table, entityType, filtered }))

    const byTable = (rows: readonly { table: string }[]) => [...rows].sort((a, b) => a.table.localeCompare(b.table))
    expect(byTable(TABLES)).toEqual(byTable(before))
  })

  it('binds each table once', () => {
    const tables = TABLES.map((t) => t.table)
    expect(new Set(tables).size).toBe(tables.length)
  })
})

describe('detail-page siblings read table and title from the registry', () => {
  it('keep the tables and title columns the hand-written config had', () => {
    const picked = Object.fromEntries(
      Object.entries(ENTITY_CONFIG).map(([type, c]) => [type, [c.table, c.titleColumn]]),
    )
    expect(picked).toEqual({
      action: ['actions', 'title'],
      capture: ['captures', 'title'],
      document: ['document', 'title'],
      contact: ['contact', 'full_name'],
      company: ['company', 'name'],
      project: ['projects', 'name'],
      initiative: ['initiative', 'name'],
    })
  })

  it('keep the list filters', () => {
    expect(ENTITY_CONFIG.action.requireNull).toEqual(['parent_id'])
    expect(ENTITY_CONFIG.contact.requireNull).toEqual(['merged_into_contact_id'])
    expect(ENTITY_CONFIG.project.exclude).toEqual([['name', '__default__']])
  })
})
