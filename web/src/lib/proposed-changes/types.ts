// Proposed changes: types for the universal staging system

export type ChangeType =
  | 'create'
  | 'update'
  | 'delete'
  | 'assign'
  | 'send_email'
  | 'mcp_call'

export type EntityType =
  | 'action'
  | 'project'
  | 'decision'
  | 'milestone'
  | 'initiative'
  | 'contact'
  | 'external'

/** 'expired': nobody acted before expires_at, or the change was made another
 *  way (expire_reason). Treated like 'dismissed' wherever it's shown. */
export type ProposedChangeStatus = 'pending' | 'applied' | 'dismissed' | 'expired'

export interface ProposedChange {
  id: string
  workspace_id: string
  capture_id: string

  change_type: ChangeType
  entity_type: EntityType
  entity_id: string | null

  display_text: string

  // Shared fields
  title: string | null
  description: string | null
  priority: string | null
  due_date: string | null
  status_from: string | null
  status_to: string | null

  // People
  assignee_name: string | null
  assignee_member_id: string | null
  assignee_contact_id: string | null
  /**
   * Assign the created action to an AI team member (agent) instead of a human.
   * Not a proposed_change column yet — carried in `extra.assignee_ai_member_id`
   * and hydrated onto this field when the row is loaded, so createAction can
   * stamp actions.assignee_ai_member_id. Mutually exclusive with assignee_member_id.
   */
  assignee_ai_member_id?: string | null

  // Entity linking
  team_id: string | null
  project_id: string | null
  labels: string[] | null

  // Email-specific
  email_to_name: string | null
  email_to_address: string | null
  email_subject: string | null
  email_context: string | null

  // Overflow
  extra: Record<string, unknown> | null

  // Text anchoring
  anchor_text: string | null
  sort_order: number

  // AI context
  confidence: number
  trigger_quote: string | null
  reasoning: string | null
  stakes: string | null
  open_questions: string[] | null

  // Status
  status: ProposedChangeStatus

  /**
   * True when this change was auto-accepted by the live-agent confidence policy.
   * It is BOTH a real proposed_change column (migration 117, so the capture UI
   * can badge applied proposals) AND threaded in-memory at apply time so
   * createAction/createDecision can stamp the created entity's own
   * auto_accepted flag in the same insert. Absent/false for manual applies.
   */
  auto_accepted?: boolean

  // Apply tracking
  applied_at: string | null
  applied_by: string | null
  result_entity_id: string | null
  error_message: string | null

  created_at: string
  updated_at: string
}

/** Summary counts returned alongside the list */
export interface ProposedChangeCounts {
  pending: number
  applied: number
  dismissed: number
  total: number
}
