/**
 * Helpers for recording a flow_run from a runFlow() result.
 *
 * A flow_run is one row per FLOW fire. The authoritative per-action detail
 * lives in the action_results jsonb. We ALSO mirror a "legacy snapshot" onto
 * the top-level flow_run columns (request_summary / response_status_code /
 * response_body_preview / error_message / duration_ms) so the existing
 * run-list UI — which predates per-action results — keeps rendering a sensible
 * one-line summary without needing to expand every run.
 *
 * Mirroring rules:
 *   - request_summary / response_status_code / response_body_preview: from the
 *     FIRST executed (non-skipped) action.
 *   - error_message: from the FIRST executed action that failed (so the
 *     summary surfaces a failure even if a later action succeeded).
 *   - duration_ms: sum of all executed actions' durations.
 *
 * A fire with only skipped actions (or no actions) yields a null snapshot.
 *
 * run_skill (SKILL) results ride the same shape: request_summary is
 * { method: 'SKILL', url: 'skill://<id>', ... }, response_status_code is the
 * executor's 200/500 mapping, and the preview is the truncated skill output —
 * nothing here is http_post-specific.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ActionResult, RequestSummary } from './types'

/** The namespace for fire run ids (a fixed, random v4 uuid; never change it). */
const FIRE_RUN_NAMESPACE = '6f1c2b9e-3d4a-4e8b-9a71-0c5d2e8f4b13'

/**
 * A fire's flow_run id, derived (RFC 4122 v5) from the fire (the Inngest event
 * id) and the flow, plus any extra parts: the same on every retry of the step
 * that runs it (F4 review S3). A retried run then reuses its own held call
 * (createToolApproval reuses a pending one within the same run), so a retry
 * never raises a second card for the same post, and its flow_run insert can't
 * land twice. No fire id (a person's Test): a fresh one.
 */
export function fireRunId(fireId: string | null | undefined, ...parts: string[]): string {
  if (!fireId) return randomUUID()
  const ns = new Uint8Array(Buffer.from(FIRE_RUN_NAMESPACE.replace(/-/g, ''), 'hex'))
  const bytes = createHash('sha1').update(ns).update([fireId, ...parts].join(':')).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface LegacySnapshot {
  request_summary: RequestSummary | null
  response_status_code: number | null
  response_body_preview: string | null
  error_message: string | null
  duration_ms: number | null
}

export function legacySnapshotFromResults(results: ActionResult[]): LegacySnapshot {
  const executed = results.filter((r) => !r.skipped)
  if (executed.length === 0) {
    return {
      request_summary: null,
      response_status_code: null,
      response_body_preview: null,
      error_message: null,
      duration_ms: null,
    }
  }
  const first = executed[0]
  const firstFailed = executed.find((r) => r.status === 'failed')
  const totalDuration = executed.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0)
  return {
    request_summary: first.request_summary,
    response_status_code: first.response_status_code,
    response_body_preview: first.response_body_preview,
    error_message: firstFailed?.error_message ?? null,
    duration_ms: totalDuration,
  }
}
