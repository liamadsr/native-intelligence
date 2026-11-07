/**
 * Pure decision logic for the sequence send engine. Every branch the Inngest
 * function takes lives here so it can be unit-tested without a database or a
 * step mock — the Inngest fn (src/lib/inngest/sequence-functions.ts) is a thin
 * shell that loads rows, calls these, and writes the outcome.
 *
 * NOTHING in this module may touch the network, the database, Date.now(), or
 * randomness — callers pass time in.
 */
import { renderTemplate, buildTemplateVars, type SequenceContactVars } from './template'
import type { SequenceSendStatus } from './types'

/**
 * How long a 'claimed'/'sending' ledger row may sit before it is considered a
 * zombie (crashed mid-send). Shared by the ledger-conflict branch and the
 * cron reaper — the two must agree or a row could be double-judged.
 */
export const INFLIGHT_STALE_MS = 15 * 60_000

/** How far the dispatcher lease-forwards next_send_at when claiming a row. */
export const DISPATCH_LEASE_MS = 10 * 60_000

/** Enrollments past this many dispatch attempts are reaped to exit 'failed'. */
export const MAX_DISPATCH_ATTEMPTS = 5

/** True when an in-flight ledger row has been stuck longer than the stale wall. */
export function isStaleInFlight(updatedAt: string, nowMs: number): boolean {
  const t = Date.parse(updatedAt)
  if (Number.isNaN(t)) return true // unparseable timestamp — treat as dead
  return nowMs - t > INFLIGHT_STALE_MS
}

export type LedgerConflictDecision = 'finalize-only' | 'stale-failed' | 'abort'

/**
 * Branch on an EXISTING sequence_send row hit via the UNIQUE(enrollment_id,
 * step_id) at-most-once guard:
 *
 *   'sent'                      → the send happened; a crash ate the finalize.
 *                                 Run the idempotent finalize only — NEVER
 *                                 resend.
 *   stale 'claimed'/'sending'   → a previous attempt died mid-flight. At-most-
 *                                 once bias: mark it failed and exit the
 *                                 enrollment; never auto-resend (the provider
 *                                 may have delivered before the crash).
 *   fresh 'claimed'/'sending'   → a concurrent invocation owns it. Abort
 *                                 silently.
 *   'failed'                    → terminal; the enrollment was already exited
 *                                 (or the reaper will). Abort.
 */
export function ledgerConflictDecision(
  existing: { status: SequenceSendStatus; updated_at: string },
  nowMs: number,
): LedgerConflictDecision {
  if (existing.status === 'sent') return 'finalize-only'
  if (existing.status === 'claimed' || existing.status === 'sending') {
    return isStaleInFlight(existing.updated_at, nowMs) ? 'stale-failed' : 'abort'
  }
  return 'abort'
}

/**
 * The arithmetic reply predicate: the engine knows exactly how many messages
 * IT put in the thread (expected_message_count); the synced index showing MORE
 * means a human (either side) touched the thread → exit 'replied'.
 *
 * A missing thread row is NOT a reply: the index lags sync and a same-provider
 * hiccup must never exit a live enrollment. Fewer messages than expected
 * likewise (a lagging index counts UP toward reality, never past it).
 */
export function shouldExitAsReplied(
  enrollment: { provider_thread_id: string | null; expected_message_count: number },
  threadRow: { message_count: number | null } | null | undefined,
): boolean {
  if (!enrollment.provider_thread_id) return false
  if (!threadRow) return false
  return (threadRow.message_count ?? 0) > enrollment.expected_message_count
}

/**
 * The step an enrollment at `currentStepOrder` will receive NEXT: the first
 * ACTIVE step strictly past what has been completed, by ascending step_order
 * (input need not be sorted; entries with is_active === false are skipped —
 * callers that pre-filter to active steps may omit the flag).
 *
 * This is the engine's contract with the graduated edit rules: an editor may
 * deactivate the literal current_step_order+1 row while enrollments are
 * mid-flight, so the claim must SKIP FORWARD to the next active step rather
 * than load-by-exact-order — and a null return means "no active step remains":
 * the caller exits the enrollment 'completed'.
 */
export function selectNextActiveStep<T extends { step_order: number; is_active?: boolean }>(
  steps: T[],
  currentStepOrder: number,
): T | null {
  let next: T | null = null
  for (const s of steps) {
    if (s.is_active === false) continue
    if (s.step_order <= currentStepOrder) continue
    if (!next || s.step_order < next.step_order) next = s
  }
  return next
}

/**
 * Convert a rendered plain-text body into email HTML: a double newline starts
 * a new paragraph, a single newline is a <br />. The input's substituted
 * values were already HTML-escaped by renderTemplate({escape:true}); the raw
 * template text is the author's own content and passes through as-is.
 */
export function bodyTextToHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
    .join('\n')
}

/**
 * Escape LIKE/ILIKE pattern metacharacters so an email address (underscores
 * are common) matches literally in case-insensitive PostgREST lookups.
 */
export function escapeIlikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

/**
 * True when a value contains characters that must never reach an RFC 822
 * header: CR/LF terminate the header and let the remainder be parsed as
 * injected headers (Bcc exfiltration, spoofed Reply-To); other control chars
 * have no business in a subject either. Used to REJECT subjects at every
 * sequence write boundary (create/edit steps, launch overrides) so a bad
 * value never lands in the DB — buildRawEmail additionally neutralizes
 * defensively at send time.
 */
export function containsHeaderInjectionChars(value: string): boolean {
  return /[\r\n\x00-\x1f\x7f]/.test(value)
}

export interface BuildStepEmailEnrollment {
  /** jsonb overrides, keyed by String(step_order). */
  overrides: unknown
  thread_subject: string | null
  provider_thread_id: string | null
}

export interface BuildStepEmailStep {
  step_order: number
  subject: string | null
  body: string
}

export interface BuildStepEmailLedgerRow {
  status: string
  provider_message_id: string | null
  rfc_message_id: string | null
  sent_at: string | null
  created_at: string
}

export type BuildStepEmailResult =
  | { blocked: string[] }
  | {
      blocked?: undefined
      subject: string
      bodyHtml: string
      /** Provider thread id to send into (null ⇒ new thread). */
      threadId: string | null
      /** Provider message id of the parent (latest 'sent' ledger row). */
      inReplyTo: string | null
      /** RFC Message-ID chain, oldest-first, non-null entries only. */
      references: string[]
    }

interface StepOverrideShape {
  subject?: string | null
  body?: string | null
}

/**
 * Assemble the outgoing email for one enrollment × step.
 *
 * Template precedence: enrollment.overrides[String(step_order)] beats the
 * step's own subject/body. Subject renders with escape:false (a header, not
 * HTML); body with escape:true, then text→HTML via bodyTextToHtml.
 *
 * Threading: step_order > 1 with a NULL effective subject template continues
 * the thread — subject 'Re: <thread_subject>' (the RENDERED step-1 subject
 * snapshot, never re-rendered), parent = the latest 'sent' ledger row's
 * provider_message_id, references = every 'sent' row's rfc_message_id
 * oldest-first, thread_id = the enrollment's provider_thread_id. A non-null
 * subject on step N>1 (own or override) deliberately starts a new thread.
 *
 * ANY non-empty unresolved list from renderTemplate — including
 * 'malformed:<raw>' entries — blocks the send: `{ blocked }` is returned and
 * the caller must fail the ledger row, never mail brace residue.
 *
 * `_sequence` is accepted for signature stability (callers pass the loaded
 * sequence row); nothing in the assembly currently depends on it.
 */
export function buildStepEmail(
  enrollment: BuildStepEmailEnrollment,
  step: BuildStepEmailStep,
  _sequence: unknown,
  sentLedgerRows: BuildStepEmailLedgerRow[],
  contact: SequenceContactVars,
  sender: { name?: string | null; email?: string | null },
): BuildStepEmailResult {
  const overrides = (enrollment.overrides ?? {}) as Record<string, StepOverrideShape>
  const override = overrides[String(step.step_order)] ?? {}
  const subjectTemplate = override.subject ?? step.subject
  const bodyTemplate = override.body ?? step.body

  const vars = buildTemplateVars(contact, sender)
  const bodyRender = renderTemplate(bodyTemplate, vars, { escape: true })
  const unresolved: string[] = [...bodyRender.unresolved]

  const sameThread = step.step_order > 1 && subjectTemplate == null

  let subject: string
  let threadId: string | null = null
  let inReplyTo: string | null = null
  let references: string[] = []

  if (sameThread) {
    subject = `Re: ${enrollment.thread_subject ?? ''}`
    const sent = sentLedgerRows
      .filter((r) => r.status === 'sent')
      .sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at))
    inReplyTo = sent.length > 0 ? sent[sent.length - 1].provider_message_id : null
    references = sent
      .map((r) => r.rfc_message_id)
      .filter((id): id is string => id != null && id !== '')
    threadId = enrollment.provider_thread_id
  } else {
    // A new-thread step with no subject at all (step 1 misconfigured, or an
    // override blanking it) must block, not send an empty Subject header.
    if (subjectTemplate == null || subjectTemplate.trim() === '') {
      unresolved.push('missing:subject')
      subject = ''
    } else {
      const subjectRender = renderTemplate(subjectTemplate, vars, { escape: false })
      unresolved.push(...subjectRender.unresolved)
      subject = subjectRender.text
    }
  }

  if (unresolved.length > 0) return { blocked: [...new Set(unresolved)] }

  return {
    subject,
    bodyHtml: bodyTextToHtml(bodyRender.text),
    threadId,
    inReplyTo,
    references,
  }
}
