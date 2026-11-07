/**
 * Completion detection — decides whether a status change represents a
 * *transition into* a completed state (the moment worth celebrating).
 *
 * Different entities encode "completed" differently:
 *  - actions: a workflow_state whose `category === 'completed'` (resolved from
 *    a status_id via the per-team workflow states)
 *  - project / initiative / milestone: a string `status === 'completed'`
 *  - cycle: completed via its own endpoint (handled separately, not here)
 *
 * We only celebrate the *edge* (not-completed → completed) so re-saving an
 * already-done item, or toggling it back open, never pops confetti.
 */

import type { ViewEntityType } from '@/lib/views/types'
import type { WorkflowStateOption } from '@/components/views/properties/types'

const COMPLETED_STATUS = 'completed'

/** Entity types whose `status` is a plain string with a 'completed' value. */
const STRING_STATUS_ENTITIES = new Set<string>(['project', 'initiative', 'milestone'])

/** Resolve a workflow_state id → its category, given the per-team state lists. */
export function categoryForStatusId(
  statusId: string | null | undefined,
  workflowStatesByTeam: Record<string, WorkflowStateOption[]>,
): string | undefined {
  if (!statusId) return undefined
  for (const states of Object.values(workflowStatesByTeam)) {
    const match = states.find((s) => s.id === statusId)
    if (match) return match.category
  }
  return undefined
}

/** True if a workflow_state id maps to the 'completed' category. */
export function isCompletedStatusId(
  statusId: string | null | undefined,
  workflowStatesByTeam: Record<string, WorkflowStateOption[]>,
): boolean {
  return categoryForStatusId(statusId, workflowStatesByTeam) === COMPLETED_STATUS
}

interface CompletionInput {
  entityType: ViewEntityType | string
  /** The fields being PATCHed (e.g. { status_id } or { status }). */
  fields: Record<string, unknown>
  /** The item's values before the patch (for edge detection). */
  prior?: Record<string, unknown>
  /** Per-team workflow states, needed to resolve action status_id → category. */
  workflowStatesByTeam?: Record<string, WorkflowStateOption[]>
}

/**
 * Returns true when `fields` moves the item from a non-completed state into a
 * completed one. Returns false for no-op completions, un-completions, and
 * changes that don't touch status.
 */
export function patchCompletesItem({
  entityType,
  fields,
  prior,
  workflowStatesByTeam = {},
}: CompletionInput): boolean {
  // ── Actions: status_id → workflow_state.category, or toggle_complete. ──
  if (entityType === 'action') {
    if (fields.toggle_complete === true) {
      // Server resolves the completed state; prior was, by definition, not it.
      return prior ? priorActionCategory(prior, workflowStatesByTeam) !== COMPLETED_STATUS : true
    }
    if ('status_id' in fields) {
      const nowCompleted = isCompletedStatusId(
        fields.status_id as string | null | undefined,
        workflowStatesByTeam,
      )
      if (!nowCompleted) return false
      if (!prior) return true
      return priorActionCategory(prior, workflowStatesByTeam) !== COMPLETED_STATUS
    }
    return false
  }

  // ── String-status entities: project / initiative / milestone. ──
  if (STRING_STATUS_ENTITIES.has(entityType)) {
    if (!('status' in fields)) return false
    if (fields.status !== COMPLETED_STATUS) return false
    if (!prior) return true
    return prior.status !== COMPLETED_STATUS
  }

  return false
}

/** Best-effort read of an action's prior completion category from its row. */
function priorActionCategory(
  prior: Record<string, unknown>,
  workflowStatesByTeam: Record<string, WorkflowStateOption[]>,
): string | undefined {
  // Flattened rows carry status_category directly.
  const flat = prior.status_category as string | undefined
  if (flat) return flat
  // Nested view rows carry workflow_state.category.
  const ws = prior.workflow_state as { category?: string; id?: string } | undefined
  if (ws?.category) return ws.category
  // Fall back to resolving the prior status_id.
  return categoryForStatusId(
    (prior.status_id as string | undefined) ?? ws?.id,
    workflowStatesByTeam,
  )
}
