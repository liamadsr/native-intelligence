/**
 * Pure helpers for the Sequences UI. No React, no fetch — everything here is
 * unit-testable logic the components lean on:
 *
 *  - enroll-result toast summarizer (per-skip-reason counts),
 *  - launch-failure grouping (unresolved-token rows in Review & Launch),
 *  - next-send humanizer (wall-clock in the SEQUENCE's timezone, not the
 *    viewer's — the send window is defined there),
 *  - client-side step preview renderer whose unresolved semantics MIRROR the
 *    engine's buildStepEmail (template precedence override > step, NULL
 *    subject on step 2+ = same-thread "Re:", missing subject on a new-thread
 *    step blocks). Review & Launch must block on exactly what the launch
 *    route would 400 on, or the two disagree in front of the user.
 */

import { buildTemplateVars, renderTemplate, type SequenceContactVars } from './template'
import type { EnrollmentOverrides, EnrollmentStatus } from './types'

// ── Merge-token vocabulary shown in the builder's helper row ─────────────

export const MERGE_TOKENS = [
  '{{first_name}}',
  '{{last_name}}',
  '{{company}}',
  '{{sender_first_name}}',
] as const

/** Plain-text opt-out line every new step body ends with (CAN-SPAM-satisfying
 *  without a marketing footer — locked plan decision). */
export const DEFAULT_OPT_OUT_LINE =
  "If you'd rather not hear from me, just reply and I'll stop."

/** Default body for a freshly added step. */
export function defaultStepBody(): string {
  return `Hi {{first_name|there}},\n\n\n\n${DEFAULT_OPT_OUT_LINE}`
}

/** Sample vars for the builder's per-step preview (no real contact yet). */
export const SAMPLE_PREVIEW_CONTACT: SequenceContactVars = {
  first_name: 'Alex',
  last_name: 'Rivera',
  full_name: 'Alex Rivera',
  company: 'Acme Inc',
  email: 'alex@acme.com',
}

// ── Enroll-result toast ──────────────────────────────────────────────────

export interface EnrollSkipEntry {
  contact_id: string
  reason: string
}

export interface EnrollResult {
  enrolled: string[]
  skipped: EnrollSkipEntry[]
}

const SKIP_REASON_LABELS: Record<string, string> = {
  already_active: 'already in a sequence',
  no_email: 'no email',
  suppressed: 'on the do-not-email list',
  not_found: 'not found',
}

/**
 * '14 enrolled, 2 skipped (already in a sequence), 1 skipped (no email)'.
 * Unknown reasons pass through verbatim so a new server reason still reads.
 *
 * `requiresLaunch`: enrolling into an ALREADY-LAUNCHED (active/paused)
 * sequence stages the contacts inert (next_send_at NULL) — the dispatcher
 * never picks them up until Review & launch is run again. A bare "N enrolled"
 * there reads as "they're in the wave", so the summary says "staged" and
 * spells out the required follow-through instead.
 */
export function summarizeEnrollResult(
  result: EnrollResult,
  opts?: { requiresLaunch?: boolean },
): string {
  const requiresLaunch = opts?.requiresLaunch ?? false
  const parts = [
    `${result.enrolled.length} ${requiresLaunch ? 'staged' : 'enrolled'}`,
  ]
  // Insertion-ordered counts so the message order is stable per response.
  const byReason = new Map<string, number>()
  for (const s of result.skipped) {
    byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1)
  }
  for (const [reason, count] of byReason) {
    parts.push(`${count} skipped (${SKIP_REASON_LABELS[reason] ?? reason})`)
  }
  const summary = parts.join(', ')
  return requiresLaunch && result.enrolled.length > 0
    ? `${summary} — run Review & launch to schedule them`
    : summary
}

// ── Launch failures → per-enrollment rows ────────────────────────────────

export interface LaunchFailure {
  enrollment_id: string
  step_order: number
  tokens: string[]
}

export interface EnrollmentFailureSummary {
  /** Unique step orders with problems, ascending. */
  steps: number[]
  /** Unique unresolved tokens across all failing steps. */
  tokens: string[]
}

/**
 * Group the launch route's 400 payload (`details.failures`) back onto
 * enrollment rows: enrollment_id → which steps and which tokens.
 */
export function groupLaunchFailures(
  failures: LaunchFailure[],
): Map<string, EnrollmentFailureSummary> {
  const out = new Map<string, EnrollmentFailureSummary>()
  for (const f of failures) {
    const entry = out.get(f.enrollment_id) ?? { steps: [], tokens: [] }
    if (!entry.steps.includes(f.step_order)) entry.steps.push(f.step_order)
    for (const t of f.tokens) {
      if (!entry.tokens.includes(t)) entry.tokens.push(t)
    }
    out.set(f.enrollment_id, entry)
  }
  for (const entry of out.values()) entry.steps.sort((a, b) => a - b)
  return out
}

/** Human form of an unresolved entry: 'first_name' → '{{first_name}}',
 *  'missing:subject' → 'missing subject', 'malformed:{{x y}}' → '{{x y}}'. */
export function unresolvedTokenLabel(token: string): string {
  if (token === 'missing:subject') return 'missing subject'
  if (token.startsWith('malformed:')) return token.slice('malformed:'.length)
  return `{{${token}}}`
}

// ── Next-send humanizer ──────────────────────────────────────────────────

/**
 * Humanize an enrollment's next_send_at in the SEQUENCE's IANA zone:
 * 'Today 9:42 AM', 'Tomorrow 10:05 AM', 'Thu 9:42 AM' (within the week),
 * else 'Aug 17, 9:05 AM'. Invalid zone degrades to UTC; missing/invalid
 * timestamps render '—'.
 */
export function humanizeSendTime(
  iso: string | null | undefined,
  timezone: string,
  now: Date = new Date(),
): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'

  let tz = timezone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    tz = 'UTC'
  }

  const dayKey = (x: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(x)
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)

  const key = dayKey(d)
  if (key === dayKey(now)) return `Today ${time}`
  if (key === dayKey(new Date(now.getTime() + 86_400_000))) return `Tomorrow ${time}`

  const deltaMs = d.getTime() - now.getTime()
  if (deltaMs > 0 && deltaMs < 6 * 86_400_000) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
    return `${weekday} ${time}`
  }
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
  }).format(d)
  return `${date}, ${time}`
}

/**
 * Short display label for an IANA zone — 'EDT' for 'America/New_York', 'GMT'
 * for 'Europe/London'. Zones without a usable short name (or invalid zones)
 * fall back to the IANA name with underscores spaced. Used to LABEL rendered
 * send times: humanizeSendTime formats in the sequence's zone, and without a
 * marker a viewer in another zone reads them as local.
 */
export function timezoneAbbreviation(timezone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    }).formatToParts(at)
    const name = parts.find((p) => p.type === 'timeZoneName')?.value
    if (name) return name
  } catch {
    /* invalid zone — fall through */
  }
  return timezone.replace(/_/g, ' ')
}

/** ISO weekday (1=Mon..7=Sun) → short label. */
const ISO_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

/**
 * Human form of a send window: 'Mon–Fri, 9 AM–4 PM'. Contiguous day runs
 * collapse to ranges; gaps read as lists ('Mon, Wed, Fri'). Malformed input
 * degrades to '' rather than throwing (send_window is untyped jsonb).
 */
export function describeSendWindow(window: {
  days: number[]
  start_hour: number
  end_hour: number
}): string {
  const days = [...new Set(window.days)]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    .sort((a, b) => a - b)
  if (days.length === 0) return ''
  const runs: string[] = []
  let runStart = days[0]
  let prev = days[0]
  for (const d of days.slice(1).concat(NaN)) {
    if (d === prev + 1) {
      prev = d
      continue
    }
    runs.push(
      runStart === prev
        ? ISO_DAY_LABELS[runStart - 1]
        : `${ISO_DAY_LABELS[runStart - 1]}–${ISO_DAY_LABELS[prev - 1]}`,
    )
    runStart = d
    prev = d
  }
  return `${runs.join(', ')}, ${hourLabel(window.start_hour)}–${hourLabel(window.end_hour)}`
}

// ── Enrollment progress ("Step 2 of 3") ──────────────────────────────────

/**
 * current_step_order is the last COMPLETED step (0 = nothing sent yet; the
 * engine advances it after each send — see sequence-functions.ts finalize).
 */
export function describeEnrollmentProgress(
  currentStepOrder: number,
  totalSteps: number,
  status: EnrollmentStatus,
): string {
  if (totalSteps <= 0) return '—'
  if (status === 'exited') {
    if (currentStepOrder >= totalSteps) return `All ${totalSteps} sent`
    if (currentStepOrder <= 0) return 'Before step 1'
    return `After step ${currentStepOrder}`
  }
  const next = Math.min(currentStepOrder + 1, totalSteps)
  return `Step ${next} of ${totalSteps}`
}

// ── Client-side step preview (Review & Launch + builder) ─────────────────

export interface PreviewStep {
  step_order: number
  subject: string | null
  body: string
}

export interface StepPreview {
  step_order: number
  /** Rendered subject ('Re: <step 1 subject>' for same-thread follow-ups). */
  subject: string
  /** Rendered plain-text body (unescaped — the preview shows text, not HTML). */
  body: string
  /** This step threads under step 1 instead of starting a new thread. */
  sameThread: boolean
  /** Unresolved tokens/malformed entries — non-empty blocks launch. */
  unresolved: string[]
}

/**
 * Render every step for one contact, with overrides applied — the client-side
 * twin of the launch route's render pass. Semantics intentionally mirror
 * buildStepEmail (src/lib/sequences/engine-logic.ts):
 *
 *  - template precedence: overrides[String(step_order)] beats the step,
 *  - step_order > 1 with a NULL effective subject ⇒ same thread; the preview
 *    subject is 'Re: ' + the RENDERED effective step-1 subject (at send time
 *    the engine uses the thread_subject snapshot, which is exactly that),
 *  - a new-thread step with an empty/blank subject ⇒ 'missing:subject',
 *  - any unresolved body/subject token (incl. malformed:<raw>) is reported.
 */
export function renderSequencePreview(
  steps: PreviewStep[],
  overrides: EnrollmentOverrides,
  contact: SequenceContactVars,
  sender: { name?: string | null; email?: string | null },
): StepPreview[] {
  const vars = buildTemplateVars(contact, sender)
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order)

  // Effective step-1 subject, rendered — the thread anchor for follow-ups.
  const first = ordered[0]
  let threadSubject = ''
  if (first) {
    const firstOverride = overrides[String(first.step_order)]
    const firstSubjectTemplate = firstOverride?.subject ?? first.subject
    if (firstSubjectTemplate != null && firstSubjectTemplate.trim() !== '') {
      threadSubject = renderTemplate(firstSubjectTemplate, vars, { escape: false }).text
    }
  }

  return ordered.map((step) => {
    const override = overrides[String(step.step_order)]
    const subjectTemplate = override?.subject ?? step.subject
    const bodyTemplate = override?.body ?? step.body

    const bodyRender = renderTemplate(bodyTemplate, vars, { escape: false })
    const unresolved: string[] = [...bodyRender.unresolved]

    const sameThread = step.step_order > 1 && subjectTemplate == null
    let subject: string
    if (sameThread) {
      subject = `Re: ${threadSubject}`
    } else if (subjectTemplate == null || subjectTemplate.trim() === '') {
      unresolved.push('missing:subject')
      subject = ''
    } else {
      const subjectRender = renderTemplate(subjectTemplate, vars, { escape: false })
      unresolved.push(...subjectRender.unresolved)
      subject = subjectRender.text
    }

    return {
      step_order: step.step_order,
      subject,
      body: bodyRender.text,
      sameThread,
      unresolved: [...new Set(unresolved)],
    }
  })
}

// ── Board drag transition copy ────────────────────────────────────────────

/**
 * Why a board drag between two sequence status columns is not allowed —
 * shown as the toast when a drop violates SEQUENCE_ALLOWED_TRANSITIONS
 * (types.ts). Mirrors the 400 messages of /api/account/sequences/[id] but
 * phrased as guidance, so the user learns the real path (Review & Launch)
 * instead of reading a generic "failed to move" error.
 */
export function sequenceMoveBlockedMessage(from: string, to: string): string {
  if (from === 'draft' && to === 'active') {
    return 'Draft sequences are armed via Review & Launch, not by moving the card'
  }
  if (to === 'paused') return 'Only active sequences can be paused'
  if (from === 'archived') return 'Archived sequences cannot be reactivated'
  return `Sequences cannot move from ${from} to ${to}`
}

// ── Status chip styling (shared across list/detail) ──────────────────────

export const SEQUENCE_STATUS_META: Record<
  string,
  { label: string; className: string }
> = {
  draft: {
    label: 'Draft',
    className: 'bg-muted text-muted-foreground border-border',
  },
  active: {
    label: 'Active',
    className:
      'bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400',
  },
  paused: {
    label: 'Paused',
    className:
      'bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400',
  },
  archived: {
    label: 'Archived',
    className: 'bg-muted text-muted-foreground/70 border-border',
  },
}

export const EXIT_REASON_META: Record<string, { label: string; className: string }> = {
  replied: {
    label: 'Replied',
    className:
      'bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400',
  },
  completed: {
    label: 'Completed',
    className: 'bg-blue-500/10 text-blue-700 border-blue-500/30 dark:text-blue-400',
  },
  removed: {
    label: 'Removed',
    className: 'bg-muted text-muted-foreground border-border',
  },
  opted_out: {
    label: 'Opted out',
    className:
      'bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-500/10 text-red-700 border-red-500/30 dark:text-red-400',
  },
}

/** Reply rate as a display string ('23%', '—' when nothing enrolled). */
export function replyRate(replied: number, total: number): string {
  if (total <= 0) return '—'
  return `${Math.round((replied / total) * 100)}%`
}
