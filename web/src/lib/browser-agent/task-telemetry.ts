import { browserTaskDiagnosticsSchema } from './task-diagnostics'

/** Selected from the row returned by the successful owner-scoped settlement. */
export interface SettledBrowserTaskRow {
  id: string
  command: string
  workspace_id: string
  session_id: string | null
  status: string
  created_at: string
  claimed_at: string | null
  finished_at: string | null
}

// Reasons can otherwise contain arbitrary native/provider messages. Unknown
// reasons stay unknown; never send the original string to analytics.
const reasons = new Set([
  'goal_and_predicates_satisfied', 'site_blocked', 'stopped_or_deadline',
  'completion_changed', 'planner_review_required',
  'wait_budget', 'invalid_target', 'invalid_evidence', 'unsupported_destination', 'approval_declined', 'approval_requested',
  'taken_over', 'needs_your_mac', 'never_automate',
  'no_progress', 'write_outcome_unknown', 'step_budget', 'user_stopped',
  'browser_observation_unavailable',
  'observation_unavailable_after_settle', 'transport_or_write_outcome_unknown',
  'stale_observation', 'caller_cancelled',
  'invalid_input', 'incomplete_evidence', 'question_budget', 'temporarily_unavailable',
  'not_authorized', 'budget_unavailable', 'deadline_exceeded', 'accounting_unavailable',
  'uncertain', 'unavailable', 'generation_unavailable', 'text_unresolved', 'text_not_supplied', 'text_unchanged', 'text_replan_budget',
  'deadline', 'reading_limit', 'restricted_frame', 'unsupported',
])
const statuses = new Set(['verified', 'escalate', 'cancelled'])
const terminalStatuses = new Set(['completed', 'failed', 'denied'])
const MAX_REPORTED_MS = 86_400_000

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function boundedNumber(value: unknown, max: number, integer = false): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max &&
    (!integer || Number.isInteger(value)) ? value : undefined
}

function timestamp(value: string | null): number | undefined {
  const parsed = value === null ? NaN : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function duration(start: number | undefined, end: number | undefined): number | undefined {
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined
}

/** Analytics is a projection, never a copy of task/result/trace JSON. Queue
 * timestamps are server-owned. All executor outcomes, counters and spans remain
 * explicitly client-reported, including a reported `verified` result. A zero
 * trace count says nothing about parent-model usage or total LLM cost. */
export function browserTaskFinishedProperties(
  row: SettledBrowserTaskRow,
  rawResult: unknown,
  buildSha?: string,
): Record<string, string | number | undefined> | null {
  if (row.command !== 'run_task' || !terminalStatuses.has(row.status)) return null
  const result = record(rawResult)
  const timings = record(result.timings)
  const telemetry = record(result.telemetry)
  const diagnostics = browserTaskDiagnosticsSchema.safeParse(result.diagnostics)
  const created = timestamp(row.created_at)
  const claimed = timestamp(row.claimed_at)
  const finished = timestamp(row.finished_at)
  const properties: Record<string, string | number | undefined> = {
    schema_version: 1,
    browser_command_id: row.id,
    eve_session_id: row.session_id ?? undefined,
    queue_status: row.status,
    queue_created_at: created === undefined ? undefined : new Date(created).toISOString(),
    queue_claimed_at: claimed === undefined ? undefined : new Date(claimed).toISOString(),
    queue_finished_at: finished === undefined ? undefined : new Date(finished).toISOString(),
    queue_wait_ms: duration(created, claimed),
    queue_execution_ms: duration(claimed, finished),
    queue_total_ms: duration(created, finished),
    outcome_source: 'client_reported',
    reported_status: typeof result.status === 'string' && statuses.has(result.status) ? result.status : 'unknown',
    reported_reason: typeof result.reason === 'string' && reasons.has(result.reason) ? result.reason : 'unknown',
    reported_steps: boundedNumber(result.steps, 10000, true),
    reported_elapsed_ms: boundedNumber(result.elapsedMs, MAX_REPORTED_MS),
    reported_snapshot_ms: boundedNumber(timings.snapshotMs, MAX_REPORTED_MS),
    reported_settling_ms: boundedNumber(timings.settlingMs, MAX_REPORTED_MS),
    reported_navigation_ms: boundedNumber(timings.navigationMs, MAX_REPORTED_MS),
    reported_setup_ms: telemetry.version === 1 ? boundedNumber(telemetry.setupMs, MAX_REPORTED_MS) : undefined,
    reported_trace_count: Array.isArray(result.trace) ? boundedNumber(result.trace.length, 10000, true) : undefined,
    build_sha: buildSha && /^[a-f0-9]{40}$/i.test(buildSha) ? buildSha : undefined,
  }
  if (diagnostics.success) {
    properties.reported_snapshot_attempts = diagnostics.data.snapshotAttempts
    properties.reported_startup_retries = diagnostics.data.startupRetries
    properties.reported_snapshot_failure_phase = diagnostics.data.lastSnapshotFailure?.phase
    properties.reported_snapshot_failure_code = diagnostics.data.lastSnapshotFailure?.code
  }
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined))
}
