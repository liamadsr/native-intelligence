/**
 * Client-side fetch layer for the Sequences UI — one place that knows the
 * route shapes (src/app/api/account/sequences/*) and the error envelope
 * ({ error, code, details } via src/lib/api-errors; route-specific codes ride
 * in details.code, e.g. 'step_guarded' — whose details.guard_errors lists
 * per-step { step_id, step_order, reason } — and 'unresolved_tokens').
 */

import type {
  EnrollmentOverrides,
  SequenceEnrollmentRow,
  SequenceRow,
  SequenceStepRow,
} from '@/lib/sequences/types'
import type { EnrollResult, LaunchFailure } from '@/lib/sequences/ui-helpers'

// ── Shapes returned by the routes ────────────────────────────────────────

export interface SequenceListItem extends SequenceRow {
  enrollment_counts: { total: number; active: number; replied: number }
}

export interface SequenceStepWithCounts extends SequenceStepRow {
  /** Ledger tallies: sent/failed outcomes plus in_flight ('claimed'/'sending')
   *  rows — all three count as send history for the edit guards. */
  counts: { sent: number; failed: number; in_flight: number }
}

export interface EnrollmentContact {
  id: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
}

export interface EnrollmentWithContact extends SequenceEnrollmentRow {
  contact: EnrollmentContact | null
}

export interface SequenceDetailPayload {
  sequence: SequenceRow
  steps: SequenceStepWithCounts[]
  enrollments: EnrollmentWithContact[]
}

export interface ContactEnrollment {
  id: string
  sequence_id: string
  status: 'active' | 'exited'
  exit_reason: string | null
  current_step_order: number
  next_send_at: string | null
  contact_email: string
  created_at: string
  updated_at: string
  step_count: number
  sequence: { id: string; name: string; status: string; timezone: string } | null
}

/** Parsed API error: message + the route-specific code from details.code. */
export interface SequencesApiError {
  message: string
  /** details.code when present ('step_guarded', 'unresolved_tokens', …),
   *  else the envelope code ('BAD_REQUEST', 'INTERNAL', …). */
  code: string
  details: Record<string, unknown> | null
}

async function parseError(res: Response): Promise<SequencesApiError> {
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const details =
    body.details && typeof body.details === 'object'
      ? (body.details as Record<string, unknown>)
      : null
  return {
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    code:
      (details && typeof details.code === 'string' ? details.code : null) ??
      (typeof body.code === 'string' ? body.code : 'UNKNOWN'),
    details,
  }
}

export class SequencesRequestError extends Error {
  apiError: SequencesApiError
  constructor(apiError: SequencesApiError) {
    super(apiError.message)
    this.name = 'SequencesRequestError'
    this.apiError = apiError
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new SequencesRequestError(await parseError(res))
  return (await res.json()) as T
}

// ── Calls ────────────────────────────────────────────────────────────────

export async function fetchSequences(): Promise<SequenceListItem[]> {
  const data = await jsonOrThrow<{ sequences: SequenceListItem[] }>(
    await fetch('/api/account/sequences'),
  )
  return data.sequences
}

export interface StepInput {
  /** Existing sequence_step id — the PATCH reconciles steps BY ID (update
   *  matched, insert new, delete missing). Omit for a new step. */
  id?: string
  subject: string | null
  body: string
  delay_days: number
  is_active?: boolean
}

export interface SequenceStructureInput {
  name: string
  description: string | null
  timezone: string
  send_window: { days: number[]; start_hour: number; end_hour: number }
  delay_unit: 'business' | 'calendar'
  /** Draft-only after creation — the From identity pins at launch. */
  sending_account_id?: string
  steps: StepInput[]
}

export async function createSequence(
  input: SequenceStructureInput,
): Promise<SequenceRow & { steps: SequenceStepRow[] }> {
  const data = await jsonOrThrow<{ sequence: SequenceRow & { steps: SequenceStepRow[] } }>(
    await fetch('/api/account/sequences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  return data.sequence
}

export async function fetchSequenceDetail(id: string): Promise<SequenceDetailPayload> {
  return jsonOrThrow<SequenceDetailPayload>(await fetch(`/api/account/sequences/${id}`))
}

export async function patchSequence(
  id: string,
  body: Partial<SequenceStructureInput> | { status: 'active' | 'paused' | 'archived' },
): Promise<SequenceRow> {
  const data = await jsonOrThrow<{ sequence: SequenceRow }>(
    await fetch(`/api/account/sequences/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return data.sequence
}

export async function enrollContacts(
  sequenceId: string,
  contactIds: string[],
): Promise<EnrollResult> {
  return jsonOrThrow<EnrollResult>(
    await fetch(`/api/account/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_ids: contactIds }),
    }),
  )
}

export interface LaunchSuccess {
  launched: true
  sending_account_id: string
  armed_enrollments: number
}

export async function launchSequence(
  sequenceId: string,
  overrides: Record<string, EnrollmentOverrides>,
): Promise<LaunchSuccess> {
  return jsonOrThrow<LaunchSuccess>(
    await fetch(`/api/account/sequences/${sequenceId}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides }),
    }),
  )
}

/** The launch 400's unresolved-token failures, when that's what it was. */
export function launchFailuresFromError(err: unknown): LaunchFailure[] | null {
  if (!(err instanceof SequencesRequestError)) return null
  if (err.apiError.code !== 'unresolved_tokens') return null
  const failures = err.apiError.details?.failures
  return Array.isArray(failures) ? (failures as LaunchFailure[]) : null
}

export async function removeEnrollment(
  sequenceId: string,
  enrollmentId: string,
): Promise<void> {
  await jsonOrThrow<{ removed: boolean }>(
    await fetch(`/api/account/sequences/${sequenceId}/enrollments/${enrollmentId}`, {
      method: 'DELETE',
    }),
  )
}

export async function optOutEnrollment(
  sequenceId: string,
  enrollmentId: string,
): Promise<void> {
  await jsonOrThrow<{ opted_out: boolean }>(
    await fetch(`/api/account/sequences/${sequenceId}/enrollments/${enrollmentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'opt_out' }),
    }),
  )
}

export async function fetchContactEnrollments(
  contactId: string,
): Promise<ContactEnrollment[]> {
  const data = await jsonOrThrow<{ enrollments: ContactEnrollment[] }>(
    await fetch(`/api/account/sequences/enrollments/by-contact/${contactId}`),
  )
  return data.enrollments
}

// ── Connected-mailbox probe (/api/oauth/status) ──────────────────────────

export interface EmailAccount {
  id: string
  provider: string
  account_email: string | null
  display_name: string | null
  is_enabled: boolean
  is_primary: boolean
}

/** The caller's enabled email accounts, primary first. */
export async function fetchEmailAccounts(): Promise<EmailAccount[]> {
  const res = await fetch('/api/oauth/status')
  if (!res.ok) return []
  const data = (await res.json()) as {
    accounts?: Array<EmailAccount & { capability: string }>
  }
  return (data.accounts ?? [])
    .filter((a) => a.capability === 'email' && a.is_enabled)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
}
