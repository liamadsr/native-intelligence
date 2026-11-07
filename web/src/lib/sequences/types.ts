/**
 * Shared row types for the Sequences engine, mirroring migration
 * 227_sequences.sql — the source of truth for enums and columns. Keep the
 * unions in lockstep with the CHECK constraints there.
 */

export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived'

/**
 * Status transitions a bare `{ status }` PATCH may perform, mirroring the
 * rules enforced in /api/account/sequences/[id]:
 *   - draft→active only ever happens through /launch (Review & Launch) —
 *     never via a status edit;
 *   - only an active sequence can pause; only a paused one can resume;
 *   - anything can archive (which exits every active enrollment);
 *   - archived is terminal.
 * Client surfaces that move status generically (the board's drag-and-drop)
 * consult this BEFORE issuing a request, so an illegal drop gets a specific
 * explanation instead of an opaque 400. Keep in lockstep with the route.
 */
export const SEQUENCE_ALLOWED_TRANSITIONS: Record<SequenceStatus, SequenceStatus[]> = {
  draft: ['archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
}
export type SequenceDelayUnit = 'business' | 'calendar'
export type SequenceStepType = 'auto_email'
export type EnrollmentStatus = 'active' | 'exited'
export type EnrollmentExitReason =
  | 'replied'
  | 'completed'
  | 'removed'
  | 'opted_out'
  | 'failed'
export type SequenceSendStatus = 'claimed' | 'sending' | 'sent' | 'failed'
/** Matches outreach_suppression.reason — 'opted_out', not 'opt_out'. */
export type SuppressionReason = 'opted_out' | 'manual'

export interface SequenceRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  status: SequenceStatus
  created_by: string | null
  sending_account_id: string | null
  /** IANA zone name, snapshotted at creation. */
  timezone: string
  /** jsonb {"days":[1..5],"start_hour":9,"end_hour":16} — parse via normalizeWindow. */
  send_window: unknown
  delay_unit: SequenceDelayUnit
  auto_send: boolean
  created_at: string
  updated_at: string
}

export interface SequenceStepRow {
  id: string
  sequence_id: string
  step_order: number
  step_type: SequenceStepType
  /** NULL ⇒ thread as a reply under step 1 ("Re: <thread_subject>"). */
  subject: string | null
  body: string
  delay_days: number
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Per-contact Review & Launch edits, keyed by step_order: {"1": {...}}. */
export interface StepOverride {
  subject?: string | null
  body?: string | null
}
export type EnrollmentOverrides = Record<string, StepOverride>

export interface SequenceEnrollmentRow {
  id: string
  workspace_id: string
  sequence_id: string
  contact_id: string | null
  contact_email: string
  enrolled_by: string | null
  status: EnrollmentStatus
  exit_reason: EnrollmentExitReason | null
  current_step_order: number
  next_send_at: string | null
  dispatch_attempts: number
  provider_thread_id: string | null
  thread_subject: string | null
  expected_message_count: number
  overrides: EnrollmentOverrides
  created_at: string
  updated_at: string
}

export interface SequenceSendRow {
  id: string
  workspace_id: string
  enrollment_id: string
  step_id: string
  status: SequenceSendStatus
  scheduled_at: string | null
  sent_at: string | null
  provider_message_id: string | null
  provider_thread_id: string | null
  rfc_message_id: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface OutreachSuppressionRow {
  id: string
  workspace_id: string
  email: string
  reason: SuppressionReason
  created_by: string | null
  created_at: string
}

/** Payload of the `sequence/step.due` Inngest event emitted by the dispatcher. */
export interface SequenceStepDueEvent {
  enrollmentId: string
  /** Fencing token: the enrollment's current_step_order at claim time. */
  stepOrder: number
  workspaceId: string
  /** The sequence's sending account (null when unset — the claim guard pauses). */
  accountId: string | null
  /**
   * Serialization key for Inngest concurrency: the sending account when set
   * (one send at a time per mailbox), otherwise the enrollment id.
   */
  concurrencyKey: string
}
