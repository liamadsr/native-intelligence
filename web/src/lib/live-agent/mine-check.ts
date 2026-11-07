/**
 * Whether the live agent's auto-apply must verify an action proposal as
 * "mine" before applying it (live-agent/route.ts).
 *
 * Only assignable proposals (create:action / assign:action) carry ownership.
 * One delegated to an AGENT alone auto-creates, so the agent can be started
 * from the capture. But the person stays responsible beside a delegate
 * (decision 9): when a member assignee is ALSO named, that member must still
 * be verified as the current person, agent or not, or someone else's action
 * would be filed on their behalf. Pure.
 */
export function needsMineCheck(change: {
  change_type?: string | null
  entity_type?: string | null
  assignee_member_id?: string | null
  extra?: Record<string, unknown> | null
}): boolean {
  const key = `${change.change_type}:${change.entity_type}`
  const isAssignable = key === 'create:action' || key === 'assign:action'
  if (!isAssignable) return false
  const assignedToAgent = !!change.extra?.assignee_ai_member_id
  return !assignedToAgent || !!change.assignee_member_id
}
