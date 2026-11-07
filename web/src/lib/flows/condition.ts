/**
 * Per-action condition evaluation for Flows.
 *
 * A flow action carries an optional ConditionGroup that gates whether it runs
 * when the flow's trigger fires. The group is evaluated against the triggering
 * entity (the action/project/... that changed status) plus the trigger context
 * (for `from_status`, which is a property of the transition, not the entity).
 *
 * Design notes:
 *   - PURE + FAIL-CLOSED. No DB, no throws. A malformed rule (wrong value
 *     shape for its op, unknown state) evaluates to UNMET — we never want a
 *     corrupt condition to silently fire an action against the user's intent,
 *     and we never want it to crash the dispatcher.
 *   - Multi-valued fields (label, assignee) treat the entity as holding a SET
 *     of ids; single-valued fields (priority, project, team, from_status) as
 *     holding 0 or 1 value. The op semantics adapt — see evaluateRule.
 *   - Non-action entities expose empty sets for action-only fields (label,
 *     assignee, priority, project, team), so a rule on those fields is UNMET
 *     for a project/initiative/milestone trigger.
 *   - Entity-less fires (schedule / capture_processed pass entity: null)
 *     behave like an entity with EMPTY sets for every field — the same op
 *     semantics non-action entities already get on action-only fields
 *     (is/in/is_set unmet; is_not/not_in/is_not_set met).
 */
import type {
  ConditionGroup,
  ConditionRule,
  TriggerContext,
} from './types'
import type { RunnerEntityData } from './runner'

/**
 * Evaluate a condition group against the triggering entity. A null/undefined
 * group, or a group with no rules, is always MET (the action always runs).
 */
export function evaluateCondition(
  group: ConditionGroup | null | undefined,
  entity: RunnerEntityData | null,
  trigger: TriggerContext,
): boolean {
  if (!group || !Array.isArray(group.rules) || group.rules.length === 0) {
    return true
  }
  const match = group.match === 'any' ? 'any' : 'all'
  if (match === 'all') {
    return group.rules.every((rule) => evaluateRule(rule, entity, trigger))
  }
  return group.rules.some((rule) => evaluateRule(rule, entity, trigger))
}

/**
 * The set of values the entity holds for a given field. Multi-valued fields
 * return their full set; single-valued fields return a 0- or 1-element set.
 * Action-only fields return an empty set for non-action entities.
 */
function fieldSet(
  field: ConditionRule['field'],
  entity: RunnerEntityData | null,
  trigger: TriggerContext,
): string[] {
  switch (field) {
    case 'from_status':
      // Property of the transition, not the entity row.
      return trigger.from_status_id ? [trigger.from_status_id] : []
    case 'label':
      return entity?.kind === 'action' ? entity.label_ids : []
    case 'assignee':
      return entity?.kind === 'action' ? entity.assignee_ids : []
    case 'priority':
      return entity?.kind === 'action' && entity.priority !== null
        ? [String(entity.priority)]
        : []
    case 'project':
      if (entity?.kind === 'action') return entity.project_id ? [entity.project_id] : []
      if (entity?.kind === 'milestone') return entity.project_id ? [entity.project_id] : []
      return []
    case 'team':
      return entity?.kind === 'action' && entity.team_id ? [entity.team_id] : []
    default:
      return []
  }
}

/** Normalize a rule's value into a comparison set (always string[]). */
function valueSet(value: ConditionRule['value']): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return [value]
  return []
}

/**
 * Evaluate one leaf rule. Fail-closed: a value shape that doesn't fit the op
 * (e.g. `in` with a non-array, `is` with null) returns false.
 */
function evaluateRule(
  rule: ConditionRule,
  entity: RunnerEntityData | null,
  trigger: TriggerContext,
): boolean {
  if (!rule || typeof rule !== 'object') return false
  const have = new Set(fieldSet(rule.field, entity, trigger))

  switch (rule.op) {
    case 'is_set':
      return have.size > 0
    case 'is_not_set':
      return have.size === 0
    case 'is': {
      // Requires a single scalar value; the entity set must CONTAIN it.
      if (typeof rule.value !== 'string' || !rule.value) return false
      return have.has(rule.value)
    }
    case 'is_not': {
      if (typeof rule.value !== 'string' || !rule.value) return false
      return !have.has(rule.value)
    }
    case 'in': {
      // Requires an array value; the entity set must INTERSECT it.
      if (!Array.isArray(rule.value)) return false
      const want = valueSet(rule.value)
      if (want.length === 0) return false
      return want.some((v) => have.has(v))
    }
    case 'not_in': {
      // Requires an array value; the entity set must be DISJOINT from it.
      if (!Array.isArray(rule.value)) return false
      const want = valueSet(rule.value)
      if (want.length === 0) return false
      return want.every((v) => !have.has(v))
    }
    default:
      return false
  }
}
