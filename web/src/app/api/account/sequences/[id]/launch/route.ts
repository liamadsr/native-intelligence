/**
 * POST /api/account/sequences/[id]/launch — Review & Launch's arming endpoint.
 *
 * Launching IS the human act that sanctions automated sending (locked decision
 * 3): after this, steps send with no further review until reply/stop. So the
 * route validates EVERYTHING up front and refuses to arm on any doubt:
 *
 *   1. Optional per-enrollment { overrides } are strictly VALIDATED (shape,
 *      string types, length caps, no header-injection chars in subjects) but
 *      persisted only AFTER the render pass below succeeds — a malformed or
 *      unrenderable override must never land in the DB.
 *   2. ≥1 active step.
 *   3. A sending mailbox owned by the LAUNCHER: the sequence's pinned account
 *      if it belongs to the caller, else the caller's connected email account
 *      (enabled, primary preferred) is auto-adopted. None → 400
 *      'no_email_account'. Arming also reassigns created_by to the launcher so
 *      the engine's send identity (sendEmail gates the account on user_id)
 *      always matches the pinned account's owner — launching is the sanctioned
 *      human act, so the launcher is the correct "sends as" identity. The DB
 *      trigger additionally enforces workspace-reachability of the pinned
 *      account; its raise surfaces as 400.
 *   4. EVERY active step × EVERY active enrollment must render with zero
 *      unresolved tokens (incl. malformed:<raw>) — one bad render blocks the
 *      whole launch, listing { enrollment_id, step_order, tokens }. The render
 *      uses the just-validated in-memory overrides, so what was reviewed is
 *      exactly what will send.
 *
 * A PAUSED sequence first has its past-due enrollments snapped forward through
 * the window (resumePastDueEnrollments, as a status resume does), so arming it
 * never bursts the backlog that went overdue while paused.
 *
 * Arming: status 'active' + auto_send true + sending_account_id + created_by,
 * then every staged enrollment (current_step_order 0, next_send_at NULL) gets
 * a window-snapped, jittered next_send_at from now (delay 0 — step 1 goes out
 * in the next open window).
 *
 * The checks and the arming live in src/lib/sequences/launch.ts, shared with
 * the agent's launch cards (a launch the person approves by text is this
 * launch); only the overrides are this screen's own.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { containsHeaderInjectionChars } from '@/lib/sequences/engine-logic'
import {
  armLaunch,
  loadLaunchPlan,
  loadSequenceForLaunch,
  renderFailures,
  type LaunchError,
} from '@/lib/sequences/launch'
import type { EnrollmentOverrides, StepOverride } from '@/lib/sequences/types'

/** RFC 5322 caps a header line at 998 chars. */
const MAX_OVERRIDE_SUBJECT_LENGTH = 998
/** Generous but bounded — overrides are review-time edits, not attachments. */
const MAX_OVERRIDE_BODY_LENGTH = 100_000

/**
 * Strictly validate the caller-supplied overrides payload: every entry must be
 * an object of { subject?, body? } strings (or null), within length caps, with
 * no header-injection characters in subjects. Unknown keys are dropped. The
 * engine renders these verbatim (renderTemplate calls .matchAll on them), so a
 * non-string here would otherwise crash the launch — or, persisted, burn the
 * send step's retries at dispatch time.
 */
function parseOverridesPayload(
  raw: unknown,
):
  | { ok: true; byEnrollment: Record<string, EnrollmentOverrides> }
  | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, byEnrollment: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'overrides must be an object keyed by enrollment id' }
  }
  const byEnrollment: Record<string, EnrollmentOverrides> = {}
  for (const [enrollmentId, perStep] of Object.entries(raw as Record<string, unknown>)) {
    if (!perStep || typeof perStep !== 'object' || Array.isArray(perStep)) {
      return {
        ok: false,
        message: `overrides for enrollment ${enrollmentId} must be an object keyed by step order`,
      }
    }
    const clean: EnrollmentOverrides = {}
    for (const [stepKey, value] of Object.entries(perStep as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
          ok: false,
          message: `override ${enrollmentId}.${stepKey} must be an object with subject/body`,
        }
      }
      const { subject, body } = value as { subject?: unknown; body?: unknown }
      const entry: StepOverride = {}
      if (subject !== undefined) {
        if (subject !== null && typeof subject !== 'string') {
          return {
            ok: false,
            message: `override ${enrollmentId}.${stepKey}.subject must be a string`,
          }
        }
        if (typeof subject === 'string') {
          if (subject.length > MAX_OVERRIDE_SUBJECT_LENGTH) {
            return {
              ok: false,
              message: `override ${enrollmentId}.${stepKey}.subject exceeds ${MAX_OVERRIDE_SUBJECT_LENGTH} characters`,
            }
          }
          if (containsHeaderInjectionChars(subject)) {
            return {
              ok: false,
              message: `override ${enrollmentId}.${stepKey}.subject must not contain control characters`,
            }
          }
        }
        entry.subject = subject
      }
      if (body !== undefined) {
        if (body !== null && typeof body !== 'string') {
          return {
            ok: false,
            message: `override ${enrollmentId}.${stepKey}.body must be a string`,
          }
        }
        if (typeof body === 'string' && body.length > MAX_OVERRIDE_BODY_LENGTH) {
          return {
            ok: false,
            message: `override ${enrollmentId}.${stepKey}.body exceeds ${MAX_OVERRIDE_BODY_LENGTH} characters`,
          }
        }
        entry.body = body
      }
      // Entries with nothing recognized are dropped, not stored.
      if (Object.keys(entry).length > 0) clean[stepKey] = entry
    }
    if (Object.keys(clean).length > 0) byEnrollment[enrollmentId] = clean
  }
  return { ok: true, byEnrollment }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    if (text.trim() !== '') body = JSON.parse(text)
  } catch {
    return badRequest('Invalid JSON body')
  }

  const loaded = await loadSequenceForLaunch(supabase, { workspaceId, sequenceId: id })
  if (!loaded.ok) return launchErrorResponse(loaded)

  // ── 1. Validate reviewed overrides (persisted after the render pass) ──
  const parsedOverrides = parseOverridesPayload(body.overrides)
  if (!parsedOverrides.ok) {
    return badRequest(parsedOverrides.message, { code: 'invalid_overrides' })
  }
  const overridesByEnrollment = parsedOverrides.byEnrollment

  // ── 2–3. Steps, the sending account, the enrollments ───────────────
  const planned = await loadLaunchPlan(supabase, {
    workspaceId,
    sequence: loaded.sequence,
    launcherUserId: user.id,
    requireEnrollments: true,
  })
  if (!planned.ok) return launchErrorResponse(planned)
  const { plan } = planned

  // ── 4. Render everything ───────────────────────────────────────────
  // With the just-validated in-memory overrides, so what was reviewed is
  // exactly what will send.
  const failures = renderFailures(plan, plan.enrollments, overridesByEnrollment)
  if (failures.length > 0) {
    return badRequest('Unresolved template tokens block this launch', {
      code: 'unresolved_tokens',
      failures,
    })
  }

  // ── Persist the validated, render-checked overrides ────────────────
  for (const [enrollmentId, overrides] of Object.entries(overridesByEnrollment)) {
    const { error: overrideError } = await supabase
      .from('sequence_enrollment')
      .update({ overrides })
      .eq('id', enrollmentId)
      .eq('sequence_id', id)
      .eq('workspace_id', workspaceId)
    if (overrideError) {
      console.error('[sequences] override persist failed:', overrideError.message)
      return serverError()
    }
  }

  // ── Resume guard, arm, seed ────────────────────────────────────────
  const armed = await armLaunch(supabase, { workspaceId, plan, launcherUserId: user.id })
  if (!armed.ok) return launchErrorResponse(armed)

  return NextResponse.json({
    launched: true,
    sending_account_id: plan.account.id,
    armed_enrollments: armed.armed,
  })
}

/** A shared launch refusal as this route's response (src/lib/api-errors shapes). */
function launchErrorResponse(err: LaunchError) {
  if (err.status === 404) return notFound(err.message)
  if (err.status === 500) return serverError()
  return badRequest(err.message, err.extras)
}
