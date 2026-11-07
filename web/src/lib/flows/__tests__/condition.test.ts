/**
 * Truth-table tests for the per-action condition evaluator. Pure + fail-closed.
 */
import { describe, it, expect } from 'vitest'
import { evaluateCondition } from '../condition'
import type { RunnerActionData, RunnerProjectData } from '../runner'
import type { ConditionGroup, TriggerContext } from '../types'

const trigger: TriggerContext = {
  type: 'entity_status_change',
  entity_type: 'action',
  from_status_id: 's-from',
  to_status_id: 's-to',
  fired_at: '2026-06-15T00:00:00.000Z',
}

function action(over: Partial<RunnerActionData> = {}): RunnerActionData {
  return {
    kind: 'action',
    id: 'a-1',
    identifier: 'ENG-1',
    title: 'T',
    status_id: 's-to',
    status_name: 'To Do',
    status_category: 'unstarted',
    priority: 2,
    assignees: [],
    assignee_ids: ['m-1', 'm-2'],
    label_ids: ['bug', 'urgent'],
    labels: [
      { id: 'bug', name: 'bug' },
      { id: 'urgent', name: 'urgent' },
    ],
    project_id: 'proj-1',
    team_id: 'team-1',
    workspace_id: 'w-1',
    ...over,
  }
}

const G = (match: 'all' | 'any', rules: ConditionGroup['rules']): ConditionGroup => ({ match, rules })

describe('evaluateCondition — no-gate', () => {
  it('null group is always met', () => {
    expect(evaluateCondition(null, action(), trigger)).toBe(true)
  })
  it('empty rules is always met', () => {
    expect(evaluateCondition(G('all', []), action(), trigger)).toBe(true)
  })
})

describe('evaluateCondition — all (AND) / any (OR)', () => {
  const ruleTrue = { field: 'label' as const, op: 'is' as const, value: 'bug' }
  const ruleFalse = { field: 'label' as const, op: 'is' as const, value: 'nope' }

  it('all passes only when every rule passes', () => {
    expect(evaluateCondition(G('all', [ruleTrue, ruleTrue]), action(), trigger)).toBe(true)
    expect(evaluateCondition(G('all', [ruleTrue, ruleFalse]), action(), trigger)).toBe(false)
  })
  it('any passes when at least one rule passes', () => {
    expect(evaluateCondition(G('any', [ruleTrue, ruleFalse]), action(), trigger)).toBe(true)
    expect(evaluateCondition(G('any', [ruleFalse, ruleFalse]), action(), trigger)).toBe(false)
  })
})

describe('evaluateCondition — label (multi-valued)', () => {
  const t = (op: string, value: unknown) =>
    evaluateCondition(G('all', [{ field: 'label', op: op as never, value: value as never }]), action(), trigger)
  it('is / is_not (contains)', () => {
    expect(t('is', 'bug')).toBe(true)
    expect(t('is', 'qa')).toBe(false)
    expect(t('is_not', 'bug')).toBe(false)
    expect(t('is_not', 'qa')).toBe(true)
  })
  it('in / not_in (intersect / disjoint)', () => {
    expect(t('in', ['bug', 'p0'])).toBe(true)
    expect(t('in', ['p0', 'p1'])).toBe(false)
    expect(t('not_in', ['qa', 'p0'])).toBe(true)
    expect(t('not_in', ['bug', 'p0'])).toBe(false)
  })
  it('is_set / is_not_set', () => {
    expect(t('is_set', null)).toBe(true)
    expect(t('is_not_set', null)).toBe(false)
    const none = action({ label_ids: [] })
    expect(evaluateCondition(G('all', [{ field: 'label', op: 'is_set', value: null }]), none, trigger)).toBe(false)
    expect(evaluateCondition(G('all', [{ field: 'label', op: 'is_not_set', value: null }]), none, trigger)).toBe(true)
  })
})

describe('evaluateCondition — assignee (multi-valued)', () => {
  it('intersect / disjoint / set', () => {
    const inIt = G('all', [{ field: 'assignee', op: 'in', value: ['m-2', 'm-9'] }])
    expect(evaluateCondition(inIt, action(), trigger)).toBe(true)
    const noneIt = G('all', [{ field: 'assignee', op: 'not_in', value: ['m-1'] }])
    expect(evaluateCondition(noneIt, action(), trigger)).toBe(false)
    const unassigned = action({ assignee_ids: [] })
    expect(evaluateCondition(G('all', [{ field: 'assignee', op: 'is_not_set', value: null }]), unassigned, trigger)).toBe(true)
  })
})

describe('evaluateCondition — priority', () => {
  const t = (op: string, value: unknown, pr: number | null = 2) =>
    evaluateCondition(G('all', [{ field: 'priority', op: op as never, value: value as never }]), action({ priority: pr }), trigger)
  it('is / in / set', () => {
    expect(t('is', '2')).toBe(true)
    expect(t('is', '3')).toBe(false)
    expect(t('in', ['1', '2'])).toBe(true)
    expect(t('is_set', null)).toBe(true)
    expect(t('is_set', null, null)).toBe(false)
    expect(t('is_not_set', null, null)).toBe(true)
  })
  it('is always unmet for a non-action entity (no priority)', () => {
    const project: RunnerProjectData = {
      kind: 'project',
      id: 'p',
      name: 'P',
      description: null,
      status_value: 'active',
      workspace_id: 'w-1',
    }
    expect(evaluateCondition(G('all', [{ field: 'priority', op: 'is', value: '2' }]), project, trigger)).toBe(false)
    expect(evaluateCondition(G('all', [{ field: 'priority', op: 'is_not_set', value: null }]), project, trigger)).toBe(true)
  })
})

describe('evaluateCondition — single-valued id fields', () => {
  it('project: is / is_not / set', () => {
    expect(evaluateCondition(G('all', [{ field: 'project', op: 'is', value: 'proj-1' }]), action(), trigger)).toBe(true)
    expect(evaluateCondition(G('all', [{ field: 'project', op: 'is', value: 'proj-9' }]), action(), trigger)).toBe(false)
    const noProj = action({ project_id: null })
    expect(evaluateCondition(G('all', [{ field: 'project', op: 'is_not_set', value: null }]), noProj, trigger)).toBe(true)
  })
  it('team: membership', () => {
    expect(evaluateCondition(G('all', [{ field: 'team', op: 'in', value: ['team-1', 'team-2'] }]), action(), trigger)).toBe(true)
  })
})

describe('evaluateCondition — from_status (from the trigger, not the entity)', () => {
  it('uses trigger.from_status_id', () => {
    expect(evaluateCondition(G('all', [{ field: 'from_status', op: 'is', value: 's-from' }]), action(), trigger)).toBe(true)
    expect(evaluateCondition(G('all', [{ field: 'from_status', op: 'is', value: 's-other' }]), action(), trigger)).toBe(false)
  })
  it('null from (any source) is an empty set', () => {
    const anyFrom: TriggerContext = { ...trigger, from_status_id: null }
    expect(evaluateCondition(G('all', [{ field: 'from_status', op: 'is_not_set', value: null }]), action(), anyFrom)).toBe(true)
    expect(evaluateCondition(G('all', [{ field: 'from_status', op: 'is', value: 's-from' }]), action(), anyFrom)).toBe(false)
  })
})

describe('evaluateCondition — fail-closed', () => {
  it('returns false (never throws) when value shape mismatches the op', () => {
    // `in` with a non-array value
    expect(evaluateCondition(G('all', [{ field: 'label', op: 'in', value: 'bug' as never }]), action(), trigger)).toBe(false)
    // `is` with a null value
    expect(evaluateCondition(G('all', [{ field: 'label', op: 'is', value: null }]), action(), trigger)).toBe(false)
    // empty `in` list
    expect(evaluateCondition(G('all', [{ field: 'label', op: 'in', value: [] }]), action(), trigger)).toBe(false)
  })
})

describe('evaluateCondition — null entity (workspace-scoped fires)', () => {
  const wsTrigger: TriggerContext = {
    type: 'schedule',
    entity_type: null,
    from_status_id: null,
    to_status_id: null,
    fired_at: '2026-06-15T00:00:00.000Z',
  }

  it('null group is still always met', () => {
    expect(evaluateCondition(null, null, wsTrigger)).toBe(true)
  })

  it('every entity field behaves as an empty set (is/in unmet, negations met)', () => {
    for (const field of ['label', 'assignee', 'priority', 'project', 'team'] as const) {
      expect(evaluateCondition(G('all', [{ field, op: 'is', value: 'x' }]), null, wsTrigger), `${field} is`).toBe(false)
      expect(evaluateCondition(G('all', [{ field, op: 'in', value: ['x'] }]), null, wsTrigger), `${field} in`).toBe(false)
      expect(evaluateCondition(G('all', [{ field, op: 'is_set', value: null }]), null, wsTrigger), `${field} is_set`).toBe(false)
      expect(evaluateCondition(G('all', [{ field, op: 'is_not', value: 'x' }]), null, wsTrigger), `${field} is_not`).toBe(true)
      expect(evaluateCondition(G('all', [{ field, op: 'is_not_set', value: null }]), null, wsTrigger), `${field} is_not_set`).toBe(true)
    }
  })

  it('from_status still reads the trigger, not the (absent) entity', () => {
    const withFrom: TriggerContext = { ...wsTrigger, from_status_id: 's-from' }
    expect(evaluateCondition(G('all', [{ field: 'from_status', op: 'is', value: 's-from' }]), null, withFrom)).toBe(true)
    expect(evaluateCondition(G('all', [{ field: 'from_status', op: 'is_not_set', value: null }]), null, wsTrigger)).toBe(true)
  })
})
