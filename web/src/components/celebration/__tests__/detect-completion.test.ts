import { describe, it, expect } from 'vitest'
import {
  patchCompletesItem,
  isCompletedStatusId,
  categoryForStatusId,
} from '../detect-completion'
import type { WorkflowStateOption } from '@/components/views/properties/types'

const STATES: Record<string, WorkflowStateOption[]> = {
  'team-1': [
    { id: 's-todo', name: 'Todo', category: 'unstarted', color: null, team_id: 'team-1' },
    { id: 's-prog', name: 'In Progress', category: 'started', color: null, team_id: 'team-1' },
    { id: 's-done', name: 'Done', category: 'completed', color: null, team_id: 'team-1' },
    { id: 's-cancel', name: 'Canceled', category: 'canceled', color: null, team_id: 'team-1' },
  ],
  'team-2': [
    { id: 's2-done', name: 'Shipped', category: 'completed', color: null, team_id: 'team-2' },
  ],
}

describe('categoryForStatusId / isCompletedStatusId', () => {
  it('resolves a status id to its category across teams', () => {
    expect(categoryForStatusId('s-prog', STATES)).toBe('started')
    expect(categoryForStatusId('s2-done', STATES)).toBe('completed')
    expect(categoryForStatusId('missing', STATES)).toBeUndefined()
    expect(categoryForStatusId(null, STATES)).toBeUndefined()
  })

  it('flags completed status ids', () => {
    expect(isCompletedStatusId('s-done', STATES)).toBe(true)
    expect(isCompletedStatusId('s2-done', STATES)).toBe(true)
    expect(isCompletedStatusId('s-prog', STATES)).toBe(false)
    expect(isCompletedStatusId('s-cancel', STATES)).toBe(false)
  })
})

describe('patchCompletesItem — actions', () => {
  it('celebrates moving from in-progress to done', () => {
    expect(patchCompletesItem({
      entityType: 'action',
      fields: { status_id: 's-done' },
      prior: { status_id: 's-prog', status_category: 'started' },
      workflowStatesByTeam: STATES,
    })).toBe(true)
  })

  it('does NOT celebrate re-saving an already-completed action', () => {
    expect(patchCompletesItem({
      entityType: 'action',
      fields: { status_id: 's-done' },
      prior: { status_id: 's-done', status_category: 'completed' },
      workflowStatesByTeam: STATES,
    })).toBe(false)
  })

  it('does NOT celebrate moving to a non-completed state', () => {
    expect(patchCompletesItem({
      entityType: 'action',
      fields: { status_id: 's-prog' },
      prior: { status_id: 's-todo', status_category: 'unstarted' },
      workflowStatesByTeam: STATES,
    })).toBe(false)
  })

  it('does NOT celebrate canceling an action', () => {
    expect(patchCompletesItem({
      entityType: 'action',
      fields: { status_id: 's-cancel' },
      prior: { status_id: 's-prog', status_category: 'started' },
      workflowStatesByTeam: STATES,
    })).toBe(false)
  })

  it('reads prior category from a nested workflow_state row', () => {
    expect(patchCompletesItem({
      entityType: 'action',
      fields: { status_id: 's-done' },
      prior: { workflow_state: { id: 's-prog', category: 'started' } },
      workflowStatesByTeam: STATES,
    })).toBe(true)
  })

  it('handles toggle_complete (no prior completed)', () => {
    expect(patchCompletesItem({
      entityType: 'action',
      fields: { toggle_complete: true },
      prior: { status_category: 'started' },
      workflowStatesByTeam: STATES,
    })).toBe(true)
  })

  it('ignores non-status field edits', () => {
    expect(patchCompletesItem({
      entityType: 'action',
      fields: { title: 'renamed' },
      prior: { status_id: 's-prog', status_category: 'started' },
      workflowStatesByTeam: STATES,
    })).toBe(false)
  })
})

describe('patchCompletesItem — string-status entities', () => {
  for (const entityType of ['project', 'initiative', 'milestone'] as const) {
    it(`celebrates ${entityType} entering completed`, () => {
      expect(patchCompletesItem({
        entityType,
        fields: { status: 'completed' },
        prior: { status: 'active' },
      })).toBe(true)
    })

    it(`does NOT re-celebrate an already-completed ${entityType}`, () => {
      expect(patchCompletesItem({
        entityType,
        fields: { status: 'completed' },
        prior: { status: 'completed' },
      })).toBe(false)
    })

    it(`does NOT celebrate ${entityType} moving to a non-completed status`, () => {
      expect(patchCompletesItem({
        entityType,
        fields: { status: 'active' },
        prior: { status: 'planned' },
      })).toBe(false)
    })
  }
})

describe('patchCompletesItem — unsupported entities', () => {
  it('never celebrates for contact/company/etc.', () => {
    expect(patchCompletesItem({
      entityType: 'contact',
      fields: { status: 'completed' },
      prior: { status: 'active' },
    })).toBe(false)
  })
})
