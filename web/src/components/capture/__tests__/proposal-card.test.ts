import { describe, it, expect } from 'vitest'
import { getMissingRequiredFields, canUndoChange, getOpenableEntity } from '../proposal-card'
import type { ProposedChange } from '@/lib/proposed-changes/types'

function makeChange(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    id: 'test-id',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'create',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Test change',
    title: null,
    description: null,
    priority: null,
    due_date: null,
    status_from: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    extra: null,
    anchor_text: null,
    sort_order: 0,
    confidence: 0.9,
    trigger_quote: null,
    reasoning: null,
    stakes: null,
    open_questions: null,
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('getMissingRequiredFields', () => {
  describe('assign:action', () => {
    it('requires assignee_member_id', () => {
      const change = makeChange({ change_type: 'assign', entity_type: 'action', entity_id: 'action-uuid' })
      const missing = getMissingRequiredFields(change)
      expect(missing.has('assignee')).toBe(true)
    })

    it('is satisfied when assignee_member_id is set, even without entity_id', () => {
      // entity_id is validated server-side at apply time; not blocking the button
      // prevents a permanently un-clickable state when the agent omits entity_id
      const change = makeChange({
        change_type: 'assign',
        entity_type: 'action',
        entity_id: null,
        assignee_member_id: 'member-uuid',
      })
      const missing = getMissingRequiredFields(change)
      expect(missing.size).toBe(0)
    })

    it('is fully satisfied when both entity_id and assignee_member_id are set', () => {
      const change = makeChange({
        change_type: 'assign',
        entity_type: 'action',
        entity_id: 'action-uuid',
        assignee_member_id: 'member-uuid',
      })
      expect(getMissingRequiredFields(change).size).toBe(0)
    })
  })

  describe('create:milestone', () => {
    it('requires project_id', () => {
      const change = makeChange({ change_type: 'create', entity_type: 'milestone' })
      const missing = getMissingRequiredFields(change)
      expect(missing.has('project')).toBe(true)
    })

    it('is satisfied when project_id is set', () => {
      const change = makeChange({ change_type: 'create', entity_type: 'milestone', project_id: 'proj-1' })
      expect(getMissingRequiredFields(change).size).toBe(0)
    })
  })

  describe('update:project', () => {
    it('requires entity_id that resolves to a known project', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'project', entity_id: null })
      const known = new Set(['proj-1'])
      expect(getMissingRequiredFields(change, known).has('project')).toBe(true)
    })

    it('requires entity_id in the known projects set', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'project', entity_id: 'unknown-id' })
      const known = new Set(['proj-1'])
      expect(getMissingRequiredFields(change, known).has('project')).toBe(true)
    })

    it('is satisfied when entity_id matches a known project', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'project', entity_id: 'proj-1' })
      const known = new Set(['proj-1'])
      expect(getMissingRequiredFields(change, known).size).toBe(0)
    })
  })

  describe('update:action', () => {
    it('requires entity_id', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: null })
      expect(getMissingRequiredFields(change).has('entity')).toBe(true)
    })

    it('is satisfied when entity_id is set', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: 'action-uuid' })
      expect(getMissingRequiredFields(change).size).toBe(0)
    })
  })

  describe('create:action (no requirements)', () => {
    it('has no required fields', () => {
      const change = makeChange({ change_type: 'create', entity_type: 'action' })
      expect(getMissingRequiredFields(change).size).toBe(0)
    })
  })
})

describe('canUndoChange', () => {
  it('allows undo for an applied create proposal (the auto-accept case)', () => {
    const change = makeChange({ change_type: 'create', entity_type: 'action', status: 'applied', auto_accepted: true })
    expect(canUndoChange(change)).toBe(true)
  })

  it('allows undo for a manually applied create proposal', () => {
    const change = makeChange({ change_type: 'create', entity_type: 'decision', status: 'applied' })
    expect(canUndoChange(change)).toBe(true)
  })

  it('does not allow undo while still pending', () => {
    const change = makeChange({ change_type: 'create', entity_type: 'action', status: 'pending' })
    expect(canUndoChange(change)).toBe(false)
  })

  it('does not allow undo for an applied update (pre-existing entity, not reversible)', () => {
    const change = makeChange({ change_type: 'update', entity_type: 'project', status: 'applied', entity_id: 'proj-1' })
    expect(canUndoChange(change)).toBe(false)
  })

  it('does not allow undo for an applied assign (pre-existing entity, not reversible)', () => {
    const change = makeChange({ change_type: 'assign', entity_type: 'action', status: 'applied', entity_id: 'act-1' })
    expect(canUndoChange(change)).toBe(false)
  })

  it('does not allow undo for a dismissed proposal', () => {
    const change = makeChange({ change_type: 'create', entity_type: 'action', status: 'dismissed' })
    expect(canUndoChange(change)).toBe(false)
  })
})

describe('getOpenableEntity', () => {
  it('returns the action entity for an applied action with a result id', () => {
    const change = makeChange({ entity_type: 'action', status: 'applied', result_entity_id: 'act-1' })
    expect(getOpenableEntity(change)).toEqual({ entityType: 'action', entityId: 'act-1' })
  })

  it('returns null while still pending (no entity exists yet)', () => {
    const change = makeChange({ entity_type: 'action', status: 'pending', result_entity_id: null })
    expect(getOpenableEntity(change)).toBeNull()
  })

  it('returns null for an applied item with no result_entity_id', () => {
    const change = makeChange({ entity_type: 'action', status: 'applied', result_entity_id: null })
    expect(getOpenableEntity(change)).toBeNull()
  })

  it('returns null for decisions (no standalone detail panel)', () => {
    const change = makeChange({ entity_type: 'decision', status: 'applied', result_entity_id: 'dec-1' })
    expect(getOpenableEntity(change)).toBeNull()
  })

  it('returns null for milestones (open inside their project)', () => {
    const change = makeChange({ entity_type: 'milestone', status: 'applied', result_entity_id: 'ms-1' })
    expect(getOpenableEntity(change)).toBeNull()
  })
})
