/**
 * Exported for the guard test that keeps it in step with ACTION_VIEW_SELECT.
 *
 * These two selects feed the SAME row component. Tree children in an ungrouped
 * action list are fetched here (`?parent_id=`) while their parents come from the
 * view query engine, so the two populations sit on one screen — and a column one
 * select carries and the other doesn't shows up as two rows making opposite
 * claims about the same kind of fact.
 */
export const ACTION_LIST_SELECT = `
  id, identifier, title, description, status_id, team_id, confirmation, priority, due_at, all_day, assignee_id, assignee_ai_member_id, agent_run_status, parent_id, estimate, project_id, milestone_id, cycle_id, created_at,
  workflow_state:workflow_state!status_id(id, name, category, color),
  labels:action_label(label:label(id, name, color)),
  external_links:action_external_task(provider),
  assignee:member!assignee_id(id, display_name, avatar_url),
  assignees:action_assignee(member:member(id, display_name, avatar_url)),
  assignee_ai_member:ai_team_member!assignee_ai_member_id(id, name, avatar_url),
  project:projects!project_id(id, name),
  milestone:milestone!milestone_id(id, name),
  cycle:cycle!cycle_id(id, name, number)
`
