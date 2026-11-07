'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

/**
 * One run, as a full page: what it tested, what it cost, and one row per trial.
 * A row expands into the flush log as an interleaved timeline (chunk text →
 * tool calls → nudges) and every check grouped by dimension, with its rationale
 * and its evidence quote.
 *
 * SHAPE. A run's name is NOT editable, so the header is the house breadcrumb
 * `ViewHeader` shape (`prospecting/list-detail.tsx`) rather than
 * `EntityDetailHeader`: a back crumb to the suite, the mode + absolute start
 * time, and the outcome chip. The body is the sequence-detail two-column shape:
 * a centered main column beside a width-driven Properties sidebar.
 *
 * THE POLL IS THE PROSPECTING CONTRACT: a self-re-arming 3s `setTimeout`, gated
 * on the server-authored `run.is_live`, never a client guess at liveness and
 * never an interval (a slow tick must not stack behind the next). Progress
 * lives durably in `eval_run.progress`, so a reload mid-run rehydrates and a
 * run that finished with the tab closed shows its full result.
 *
 * TRACES ARE NOT IN THE POLL PAYLOAD. `GET /runs/[id]` returns trials through
 * `TRIAL_LIST_FIELDS` — deliberately without `trace`, because a twenty-case
 * run's traces together are megabytes and this endpoint is hit every three
 * seconds. So the flush log loads when a row is opened, from a per-trial
 * endpoint. That endpoint does not exist yet: until it does, `fetchTrialTrace`
 * 404s, the timeline renders its own "not available" line, and every check on
 * the expanded row still works, because checks DO come down with the poll.
 *
 * THE JUDGE THUMBS ARE NOT RENDERED. `PATCH /api/account/evals/checks/[id]` is
 * likewise unbuilt, and nothing else in the app ships a dead control. The
 * fetcher, the optimistic write and the rollback all stay wired behind
 * {@link CHECKS_ROUTE_READY} — flipping that one boolean brings the buttons
 * back when the route lands.
 */

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { PropertyGroup } from '@/components/views/property-group'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { PageTitle } from '@/components/views/page-title'
import type {
  CheckOutcome,
  EvalCheckRow,
  EvalDimension,
  EvalHumanOverride,
  EvalTrace,
  FlushRecord,
} from '@/lib/evals/types'
import { STEP_CEILING_GRADER } from '@/lib/evals/types'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  MessageSquare,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { truncateBreadcrumbTitle } from '../views/detail-breadcrumb-header'
import { ViewHeader } from '../views/view-header'
import {
  cancelRun,
  errorCode,
  errorMessage,
  fetchRun,
  startRun,
  type RunDetailPayload,
  type TrialWithChecks,
} from './api'
import { OutcomeChip } from './outcome-chip'
import { EvalRunRail } from './run-rail'
import {
  MODE_LABELS,
  SPEED_LABELS,
  dimensionLabel,
  formatCost,
  formatDuration,
} from './ui-helpers'

/**
 * Flip when `PATCH /api/account/evals/checks/[id]` exists. Everything the
 * thumbs need is already wired — the fetcher, the optimistic write, the
 * rollback — so this is one boolean and not a rewrite.
 */
export const CHECKS_ROUTE_READY = false

const POLL_INTERVAL_MS = 3000

// ============================================================
// Fetchers
//
// Everything the shared `./api` layer already covers is imported from there —
// `fetchRun`, `startRun`, `cancelRun` and the error envelope. The two below are
// the calls only this screen makes, and both hit routes that do not exist yet.
// ============================================================

/**
 * One trial's trace. NOT BUILT YET — this screen is the only caller of a
 * per-trial trace endpoint, and the API contract did not cover it. It throws
 * until the route lands, which the timeline renders as a line rather than an
 * error banner.
 */
export async function fetchTrialTrace(trialId: string): Promise<EvalTrace> {
  const res = await fetch(`/api/account/evals/trials/${trialId}`)
  // A 404 here is ambiguous in a way that matters: it is either a trial that
  // is genuinely gone, or the route itself not existing yet. Both read to a
  // user as "the flush log is missing", and neither is worth showing them the
  // word "Not found" for — the checks below it are the substance of the row.
  if (!res.ok) throw new Error('Could not load the flush log')
  const body = (await res.json()) as { trial: { trace: EvalTrace } }
  return body.trial.trace
}

/** Record agreement or disagreement with one judge check. Also unbuilt — see
 *  {@link CHECKS_ROUTE_READY}. */
export async function setCheckOverride(
  checkId: string,
  override: EvalHumanOverride | null,
): Promise<void> {
  const res = await fetch(`/api/account/evals/checks/${checkId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ human_override: override }),
  })
  if (!res.ok) throw new Error('Could not record that')
}

// ============================================================
// Formatting
// ============================================================

/** A run's start time, in words. Absolute rather than relative: two runs of
 *  the same suite an hour apart are the thing being compared, and "2h ago" on
 *  both of them is the one rendering that cannot tell them apart. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const CHECK_OUTCOME_CLASS: Record<CheckOutcome, string> = {
  pass: 'text-emerald-600 dark:text-emerald-400',
  fail: 'text-rose-600 dark:text-rose-400',
  // `unknown` and `skipped` are NOT failures and are excluded from the
  // pass-rate denominator (spec §6.4) — muted, so a screen full of them never
  // reads as a screen full of red.
  unknown: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
}

const CHECK_OUTCOME_LABEL: Record<CheckOutcome, string> = {
  pass: 'Pass',
  fail: 'Fail',
  unknown: 'Unknown',
  skipped: 'Skipped',
}

// ============================================================
// Per-trial derived numbers
// ============================================================

/** `pass / (pass + fail)` for one dimension — the P/R pair on a trial row.
 *  `unknown` and `skipped` are out of both halves. */
export function dimensionTally(
  checks: EvalCheckRow[],
  dimension: EvalDimension,
): { pass: number; total: number } {
  let pass = 0
  let total = 0
  for (const check of checks) {
    if (check.dimension !== dimension) continue
    if (check.outcome === 'unknown' || check.outcome === 'skipped') continue
    total += 1
    if (check.outcome === 'pass') pass += 1
  }
  return { pass, total }
}

function Tally({ tally }: { tally: { pass: number; total: number } }) {
  if (tally.total === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span
      className={cn(
        'tabular-nums',
        tally.pass === tally.total
          ? 'text-foreground'
          : 'text-rose-600 dark:text-rose-400',
      )}
    >
      {tally.pass}/{tally.total}
    </span>
  )
}

/** The dimensions a trial row reports, in the order they are read. Gate leads:
 *  `gate_recorded` failing means the auto-apply block never ran, so the
 *  counterfactual — the highest-value thing a trial measures — is absent. */
const ROW_DIMENSIONS: EvalDimension[] = [
  'gate',
  'tools',
  'summary',
  'proposals',
]

/** The row's dimensions for one trial: nudges join only when the trial was
 *  graded on them (a live trial), so a batch row never carries a dead "—". */
export function rowDimensions(checks: EvalCheckRow[]): EvalDimension[] {
  return checks.some((c) => c.dimension === 'nudges') ? [...ROW_DIMENSIONS, 'nudges'] : ROW_DIMENSIONS
}

/**
 * A trial's four tallies as the second line of its row — each labelled, the
 * way the suite page's run rows label theirs.
 *
 * As four right-aligned table columns they needed about 600px, which the main
 * column does not have whenever the Properties sidebar is open. On one muted
 * line they fit; `whitespace-normal` lets them WRAP to a second line rather
 * than being cut off in a narrow column, since a score clipped mid-tally is
 * exactly the information the line exists to carry. The `title` still spells
 * every dimension out.
 */
function ScoreChips({ checks }: { checks: EvalCheckRow[] }) {
  const tallies = rowDimensions(checks).map((dimension) => ({
    dimension,
    tally: dimensionTally(checks, dimension),
  }))
  return (
    <span
      className="whitespace-normal"
      title={tallies
        .map(
          ({ dimension, tally }) =>
            `${dimensionLabel(dimension)}: ${tally.total === 0 ? '—' : `${tally.pass}/${tally.total}`}`,
        )
        .join(' · ')}
    >
      {tallies.map(({ dimension, tally }, index) => (
        <span key={dimension}>
          {index > 0 && <span className="px-1">·</span>}
          {dimensionLabel(dimension)} <Tally tally={tally} />
        </span>
      ))}
    </span>
  )
}

/**
 * Did any flush hit the step ceiling? A truncated flush measures the STEP
 * BUDGET, not the prompt, so it is flagged on the row rather than folded into
 * the score — the proposals dimension is already `unknown` for that trial and
 * the flag is what tells a reader why.
 */
export function hitStepCeiling(
  trace: EvalTrace | Record<string, never> | null,
): boolean {
  const flushes = (trace as EvalTrace | null)?.flushes
  if (!Array.isArray(flushes)) return false
  return flushes.some((flush) => flush.finish_reason === 'step-ceiling')
}

/** The step-ceiling flag from CHECKS, which the poll always carries — the
 *  trace does not come down with the list, so the grader's own check is the
 *  only signal available before a row is opened.
 *
 *  The grader name is `no_step_ceiling_hit`, the check_key the deterministic
 *  grader emits — matching anything else makes this a predicate no row can
 *  satisfy and the warning triangle dead code. */
export function stepCeilingFromChecks(checks: EvalCheckRow[]): boolean {
  return checks.some(
    (check) => check.grader === STEP_CEILING_GRADER && check.outcome === 'fail',
  )
}

// ============================================================
// The expanded trial
// ============================================================

/**
 * One flush: what went in, what came back. The interleave is the point — a
 * nudge that fired on chunk 4 has to be readable next to chunk 4's text, or
 * "the agent interrupted too early" is not a thing anyone can see.
 */
function FlushEntry({ flush }: { flush: FlushRecord }) {
  const calls = flush.response?.tool_call_details ?? []
  const nudges = flush.nudges ?? []
  const truncated = flush.finish_reason === 'step-ceiling'
  return (
    <li className="relative space-y-1.5 pl-4">
      <span
        aria-hidden="true"
        className="border-background bg-muted-foreground/60 absolute top-[7px] -left-[5px] h-2 w-2 rounded-full border-2"
      />
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground text-[10px] font-medium tabular-nums">
          {flush.record_only
            ? `record turn after flush ${flush.index + 1}${flush.live_role === 'notes' ? ' · note-taker' : ''}`
            : `flush ${flush.index + 1}`}
        </span>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {formatDuration(flush.response?.duration_ms)}
          {typeof flush.steps_used === 'number'
            ? ` · ${flush.steps_used} steps`
            : ''}
        </span>
        {truncated && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            step ceiling
          </span>
        )}
      </div>
      {flush.record_only ? (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          No new transcript. Directives injected: {(flush.directive_keys ?? []).join(', ') || 'none'}
        </p>
      ) : (
        <p className="bg-muted/40 rounded-md px-2 py-1 text-[11px] leading-relaxed whitespace-pre-wrap">
          {flush.chunk_text}
        </p>
      )}
      {calls.length > 0 && (
        <ul className="space-y-0.5">
          {calls.map((call, i) => (
            <li
              key={`${call.tool}-${i}`}
              className="text-muted-foreground flex items-center gap-1.5 text-[11px]"
            >
              <Wrench className="h-3 w-3 shrink-0" />
              <span className="font-mono">{call.tool}</span>
            </li>
          ))}
        </ul>
      )}
      {nudges.map((nudge) => (
        <div
          key={nudge.id}
          className="border-primary/20 bg-primary/5 flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px]"
        >
          <MessageSquare className="text-primary mt-0.5 h-3 w-3 shrink-0" />
          <span className="leading-relaxed">{nudge.message}</span>
        </div>
      ))}
    </li>
  )
}

/** One nudge as a check carries it in its evidence (the deterministic nudge
 *  graders): the chunk it landed after, and its words. `nudge_latency` adds
 *  how late it would have landed on the call's clock. */
export type EvidenceNudge = {
  chunk: number
  kind?: string
  message: string
  record_only?: boolean
  lag_chunks?: number
  time_to_nudge_ms?: number
}

/** A nudge's lateness as a short suffix ("· 1 chunk late · 12.4 s"), or ''. Pure. */
export function nudgeLagText(nudge: EvidenceNudge): string {
  const parts: string[] = []
  if (typeof nudge.lag_chunks === 'number') {
    parts.push(nudge.lag_chunks === 0 ? 'on time' : `${nudge.lag_chunks} chunk${nudge.lag_chunks === 1 ? '' : 's'} late`)
  }
  if (typeof nudge.time_to_nudge_ms === 'number') parts.push(`${(nudge.time_to_nudge_ms / 1000).toFixed(1)} s`)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

/** The nudges a check's evidence lists, when it lists any. Pure. */
export function evidenceNudges(evidence: Record<string, unknown> | null): EvidenceNudge[] {
  const raw = evidence?.nudges
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (n): n is EvidenceNudge =>
      !!n && typeof n === 'object' && typeof (n as EvidenceNudge).chunk === 'number' && typeof (n as EvidenceNudge).message === 'string',
  )
}

/** The evidence a check cited, as prose. Quotes first — they are the thing a
 *  reader checks the rationale against — then a judge's short reasons, then
 *  the nudge timeline a nudge check carries (the poll has checks, not the
 *  trace, so this is where a trial's nudges are readable before the flush log
 *  loads). */
function Evidence({ evidence }: { evidence: Record<string, unknown> | null }) {
  const quote = useMemo(() => {
    if (!evidence) return null
    // Judges write `evidence_quote`; older rows and hand-built ones `quote(s)`.
    const raw = evidence.quote ?? evidence.quotes ?? evidence.evidence_quote
    if (typeof raw === 'string') return raw.trim() || null
    if (Array.isArray(raw))
      return raw.filter((q) => typeof q === 'string').join(' … ') || null
    return null
  }, [evidence])
  const reasons = useMemo(
    () =>
      Array.isArray(evidence?.reasons)
        ? (evidence.reasons as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        : [],
    [evidence],
  )
  const nudges = useMemo(() => evidenceNudges(evidence), [evidence])
  if (!quote && reasons.length === 0 && nudges.length === 0) return null
  return (
    <>
      {quote && (
        <blockquote className="border-border text-muted-foreground mt-1 border-l-2 pl-2 text-[11px] leading-relaxed italic">
          “{quote}”
        </blockquote>
      )}
      {reasons.length > 0 && (
        <ul className="text-muted-foreground mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed">
          {reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      )}
      {nudges.length > 0 && (
        <ol className="mt-1 space-y-0.5" aria-label="Nudge timeline">
          {nudges.map((nudge, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[11px]">
              <MessageSquare className="text-primary mt-0.5 h-3 w-3 shrink-0" />
              <span className="text-muted-foreground shrink-0 tabular-nums">
                chunk {nudge.chunk}
                {nudge.record_only ? ' · record turn' : ''}
                {nudgeLagText(nudge)}
              </span>
              <span className="leading-relaxed">{nudge.message}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

function CheckRow({
  check,
  onOverride,
}: {
  check: EvalCheckRow
  onOverride: (override: EvalHumanOverride | null) => void
}) {
  // Only a JUDGE check gets thumbs. A deterministic grader has no opinion to
  // agree with — `tool_called` either saw the call or did not, and offering a
  // disagree there invites a user to argue with arithmetic.
  const judged = check.grader.startsWith('judge')
  return (
    <li className="group/row hover:bg-muted/40 space-y-0.5 rounded-md px-2 py-1.5 transition-colors">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'shrink-0 text-[10px] font-medium',
            CHECK_OUTCOME_CLASS[check.outcome],
          )}
        >
          {CHECK_OUTCOME_LABEL[check.outcome]}
        </span>
        <span className="min-w-0 flex-1 text-xs">{check.label}</span>
        {judged && typeof check.score === 'number' && (
          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
            score {Math.round(check.score * 100)}%
          </span>
        )}
        {check.severity === 'gate' && (
          <span className="shrink-0 rounded-sm bg-rose-500/10 px-1 py-px text-[10px] font-medium text-rose-600 dark:text-rose-400">
            gate
          </span>
        )}
        {/* The thumbs are OFF until the checks route lands: nothing else in the
            app ships a dead control, and a disagreement the user believes they
            recorded is a wrong number they will trust later. */}
        {judged && CHECKS_ROUTE_READY && (
          <span className="flex shrink-0 items-center gap-0.5">
            {(['agree', 'disagree'] as const).map((option) => {
              const active = check.human_override === option
              const Icon = option === 'agree' ? ThumbsUp : ThumbsDown
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${option === 'agree' ? 'Agree' : 'Disagree'} with ${check.label}`}
                  onClick={() => onOverride(active ? null : option)}
                  className={cn(
                    'rounded-md p-1 transition-colors',
                    active
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3" />
                </button>
              )
            })}
          </span>
        )}
      </div>
      {check.rationale && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {check.rationale}
        </p>
      )}
      <Evidence evidence={check.evidence} />
    </li>
  )
}

function TrialDetail({
  trial,
  onOverride,
}: {
  trial: TrialWithChecks
  onOverride: (checkId: string, override: EvalHumanOverride | null) => void
}) {
  const [trace, setTrace] = useState<EvalTrace | null>(null)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [loadingTrace, setLoadingTrace] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoadingTrace(true)
    setTraceError(null)
    void (async () => {
      try {
        const loaded = await fetchTrialTrace(trial.id)
        if (!cancelled) setTrace(loaded)
      } catch (err) {
        if (!cancelled) {
          setTrace(null)
          setTraceError(errorMessage(err, 'Could not load the flush log'))
        }
      } finally {
        if (!cancelled) setLoadingTrace(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [trial.id])

  // Group by dimension in the vocabulary's own order, so two trials of the
  // same case always list their checks in the same order and are readable
  // side by side.
  const byDimension = useMemo(() => {
    const groups = new Map<EvalDimension, EvalCheckRow[]>()
    for (const check of trial.checks) {
      const list = groups.get(check.dimension)
      if (list) list.push(check)
      else groups.set(check.dimension, [check])
    }
    return [...groups.entries()]
  }, [trial.checks])

  const flushes = trace?.flushes ?? []

  return (
    <div className="bg-muted/20 mt-2 space-y-4 rounded-lg border px-4 py-3">
      {trial.error_message && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-400">
          {trial.error_code ? `${trial.error_code}: ` : ''}
          {trial.error_message}
        </p>
      )}

      {/* Tokens read here rather than in the row: they are the number someone
          reaches for AFTER a trial has already caught their eye, and as a
          column they were one of the four that pushed the table past the
          column's width. */}
      <p className="text-muted-foreground text-[11px]">
        <span className="text-foreground/80 tabular-nums">
          {trial.tokens_in.toLocaleString()}
        </span>{' '}
        tokens in ·{' '}
        <span className="text-foreground/80 tabular-nums">
          {trial.tokens_out.toLocaleString()}
        </span>{' '}
        out
      </p>

      <section className="space-y-1.5">
        <p className="text-xs font-medium">Flush log</p>
        {loadingTrace ? (
          <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </p>
        ) : flushes.length > 0 ? (
          <ol className="border-border relative ml-1 space-y-3 border-l pl-1">
            {flushes.map((flush) => (
              <FlushEntry key={`${flush.index}${flush.record_only ? '-record' : ''}`} flush={flush} />
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            {traceError ?? 'No flushes recorded for this attempt.'}
          </p>
        )}
      </section>

      <section className="space-y-1.5">
        <p className="text-xs font-medium">Checks</p>
        {byDimension.length === 0 ? (
          <p className="text-muted-foreground text-[11px]">Not graded yet.</p>
        ) : (
          byDimension.map(([dimension, checks]) => (
            <div key={dimension} className="space-y-0.5">
              <p className="text-muted-foreground px-2 text-[10px] tracking-wide uppercase">
                {dimensionLabel(dimension)}
              </p>
              <ul className="space-y-0.5">
                {checks.map((check) => (
                  <CheckRow
                    key={check.id}
                    check={check}
                    onOverride={(override) => onOverride(check.id, override)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  )
}

// ============================================================
// The page
// ============================================================

export function EvalRunPage({
  runId,
  suiteName,
  onBack,
  onRunLabelLoaded,
}: {
  runId: string
  /** The breadcrumb crumb. A deep link arrives before the suite is known, so
   *  the header falls back to a generic label rather than an empty crumb. */
  suiteName?: string
  onBack: () => void
  /** Deep links arrive with a placeholder label; called once the page knows the
   *  real one so the caller can refresh the history entry/tab label. */
  onRunLabelLoaded?: (id: string, label: string) => void
}) {
  const [payload, setPayload] = useState<RunDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openTrialId, setOpenTrialId] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [canceling, setCanceling] = useState(false)

  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)

  const load = useCallback(async () => {
    return fetchRun(runId)
  }, [runId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPayload(null)
    setOpenTrialId(null)
    void (async () => {
      try {
        const next = await load()
        if (!cancelled) setPayload(next)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Could not load this run'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  /**
   * Liveness as the LOOP sees it, not as React state does: the tick reads it
   * synchronously right after awaiting, and reading `payload` there would read
   * the value captured when the effect was created.
   */
  const liveRef = useRef(false)
  const isLive = payload?.run.is_live ?? false
  liveRef.current = isLive

  /** The current payload, for callbacks that must read it without taking it
   *  as a dependency (see `applyOverride`'s rollback capture). */
  const payloadRef = useRef<RunDetailPayload | null>(null)
  payloadRef.current = payload

  const followedId = isLive ? runId : null
  useEffect(() => {
    if (!followedId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      try {
        const next = await fetchRun(followedId)
        if (cancelled) return
        liveRef.current = next.run.is_live
        setPayload(next)
      } catch {
        // A single failed poll is a blip (a cold lambda, a dropped socket);
        // the run is still going. Keep polling rather than declaring it dead,
        // and let `eval_run.error_code` report a real failure.
      }
      if (cancelled || !liveRef.current) return
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [followedId])

  /**
   * Report the run's label exactly ONCE PER VALUE, from a ref'd callback — the
   * suite-detail request-storm contract. The parent's callback is an inline
   * arrow that calls `navigate`, so a value-deduped effect (never a load dep) is
   * what keeps the poll from pushing a history step every three seconds.
   */
  const onRunLabelLoadedRef = useRef(onRunLabelLoaded)
  onRunLabelLoadedRef.current = onRunLabelLoaded
  const reportedLabelRef = useRef<string | null>(null)
  const run = payload?.run ?? null
  const label = run
    ? `${MODE_LABELS[run.mode]} run · ${formatWhen(run.started_at)}`
    : null
  useEffect(() => {
    if (!label || reportedLabelRef.current === label) return
    reportedLabelRef.current = label
    onRunLabelLoadedRef.current?.(runId, label)
  }, [runId, label])

  const applyOverride = useCallback(
    async (checkId: string, override: EvalHumanOverride | null) => {
      // Optimistic: the thumb is a two-state toggle and a 300ms round trip
      // before it lights up reads as a dead button. Rolled back on failure.
      //
      // The rollback value is captured OUTSIDE the updater. An updater is not
      // guaranteed to run once (StrictMode double-invokes it), so a `previous`
      // written from inside it would be the already-optimistic value on the
      // second pass and the rollback would restore nothing.
      const previous =
        payloadRef.current?.trials
          .flatMap((trial) => trial.checks)
          .find((check) => check.id === checkId)?.human_override ?? null
      setPayload((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          trials: prev.trials.map((trial) => ({
            ...trial,
            checks: trial.checks.map((check) =>
              check.id === checkId
                ? { ...check, human_override: override }
                : check,
            ),
          })),
        }
      })
      try {
        await setCheckOverride(checkId, override)
      } catch (err) {
        setPayload((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            trials: prev.trials.map((trial) => ({
              ...trial,
              checks: trial.checks.map((check) =>
                check.id === checkId
                  ? { ...check, human_override: previous }
                  : check,
              ),
            })),
          }
        })
        setError(errorMessage(err, 'Could not record that'))
      }
    },
    [],
  )

  /** Distinct case ids whose trials failed or errored. A case with three
   *  attempts and one failure is retried once, not three times. */
  const failedCaseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const trial of payload?.trials ?? []) {
      if (trial.outcome === 'failed' || trial.outcome === 'errored')
        ids.add(trial.case_id)
    }
    return [...ids]
  }, [payload])

  const retry = useCallback(async () => {
    if (!payload || failedCaseIds.length === 0) return
    setRetrying(true)
    setError(null)
    try {
      // A FRESH run, not a mutation of this one: a run is the comparable unit
      // and a partially-rerun run would not be comparable to anything.
      const { adopted } = await startRun({
        suite_id: payload.run.suite_id,
        mode: payload.run.mode,
        case_ids: failedCaseIds,
      })
      toast.success(
        adopted
          ? 'This suite already has a run going in this mode — following that one.'
          : `Retrying ${failedCaseIds.length} case${failedCaseIds.length === 1 ? '' : 's'}.`,
      )
    } catch (err) {
      setError(errorMessage(err, 'Could not start the retry'))
    } finally {
      setRetrying(false)
    }
  }, [payload, failedCaseIds])

  const stop = useCallback(async () => {
    if (!payload) return
    setCanceling(true)
    setError(null)
    try {
      const next = await cancelRun(payload.run.id)
      setPayload((prev) => (prev ? { ...prev, run: next } : prev))
    } catch (err) {
      // A run that settled between the render and the click answers 409
      // NOT_CANCELABLE — the run is stopped, which is what the button asked
      // for, so say nothing and re-read.
      if (errorCode(err) !== 'NOT_CANCELABLE') {
        setError(errorMessage(err, 'Could not stop the run'))
      }
      try {
        setPayload(await fetchRun(payload.run.id))
      } catch {
        /* the banner above already says what happened */
      }
    } finally {
      setCanceling(false)
    }
  }, [payload])

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader title="Run" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        </div>
      </div>
    )
  }

  if (!payload) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader
          title="Run"
          actions={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onBack}
            >
              Back to suite
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
          <p className="text-muted-foreground text-sm">
            {error ?? 'Run not found'}
          </p>
          <Button variant="outline" size="sm" onClick={onBack}>
            Close
          </Button>
        </div>
      </div>
    )
  }

  const { trials } = payload
  const currentRun = payload.run
  /** The in/out split, spelled out. It is the tile's `title` and the
   *  Properties row's value — one string so the two can never disagree. */
  const tokenSplit = `${currentRun.tokens_in.toLocaleString()} in · ${currentRun.tokens_out.toLocaleString()} out`
  // WHY ONLY AN ID IS HELD FOR THE OPEN ROW. The detail is rendered from the
  // `trial` the list is already mapping over, so a poll tick that replaces
  // `trials` refreshes the open detail's checks in place rather than freezing
  // them at expand time — which holding the trial OBJECT in state would do.

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ViewHeader
        history="custom"
        className="gap-3"
        title={
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* A suite's name is a sentence ("Smoke 3 — discovery call (self
                bound)"), and the whole thing in the crumb starved the run's own
                title beside it. Shortened by the same helper the views
                breadcrumb uses, with the full name kept in the tooltip. */}
            <PageTitle label={truncateBreadcrumbTitle(suiteName ?? 'Suite')} title={suiteName ?? 'Suite'} iconName="Evals" onClick={onBack} />
            <h1 className="truncate text-sm font-semibold">
              {MODE_LABELS[currentRun.mode]} run ·{' '}
              {formatWhen(currentRun.started_at)}
            </h1>
            {/* A run with no outcome yet is RUNNING, and this is the one place
                on the screen with room to say so. The table's own chips keep
                the shared dash, which is what holds a column's width. */}
            <OutcomeChip
              outcome={currentRun.outcome}
              pendingLabel={isLive ? 'Running' : 'Queued'}
            />
          </div>
        }
        actions={
          <WindowActions className="flex items-center gap-1.5">
            {failedCaseIds.length > 0 && (
              <PreferenceActionButton
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void retry()}
                disabled={retrying || isLive}
              >
                {retrying ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Retry failed cases only
              </PreferenceActionButton>
            )}
            {isLive && (
              <PreferenceActionButton
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void stop()}
                disabled={canceling}
              >
                {canceling ? 'Cancelling…' : 'Cancel run'}
              </PreferenceActionButton>
            )}
          </WindowActions>
        }
      />

      <div ref={panelBodyRef} className="flex min-h-0 flex-1 justify-center">
        <div className="@container mx-auto flex min-h-0 w-full max-w-[736px] min-w-0 flex-col">
          <ScrollArea className="h-full">
            <div className="px-8 pb-28">
              {error && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1" role="alert">
                    {error}
                  </span>
                </div>
              )}

              {isLive && <EvalRunRail run={currentRun} live />}

              {/* Stats row — FOUR tiles in a CONTAINER-query grid. `sm:`
                  measures the WINDOW while this column is only ~300px wide
                  whenever the Properties sidebar is open, which is what put
                  five tiles across a narrow column and clipped "28,561" to
                  "28,56…". `@md` measures the column itself: 2×2 when narrow,
                  one row of four when not.

                  `Model` moved out — it is a long unbreakable slug that no tile
                  can hold, and Properties already carries it (with the prompt
                  version, which is the thing it is actually read against). */}
              <div className="mt-6 grid grid-cols-2 gap-3 @md:grid-cols-4">
                <div className="min-w-0 rounded-lg border px-3 py-2.5">
                  <OutcomeChip
                    outcome={currentRun.outcome}
                    pendingLabel={isLive ? 'Running' : 'Queued'}
                  />
                  <p className="text-muted-foreground mt-1 text-[11px]">
                    Outcome
                  </p>
                </div>
                {[
                  { label: 'Cost', value: formatCost(currentRun.cost_usd) },
                  {
                    label: 'Duration',
                    value: formatDuration(currentRun.duration_ms),
                  },
                  {
                    // The TOTAL, because "28,569 in · 1,372 out" is two numbers
                    // and a separator in a tile that fits one. The split is one
                    // hover away here and spelled out in Properties.
                    label: 'Tokens',
                    value: (
                      currentRun.tokens_in + currentRun.tokens_out
                    ).toLocaleString(),
                    title: tokenSplit,
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="min-w-0 rounded-lg border px-3 py-2.5"
                  >
                    {/* `break-words`, and emphatically not `truncate`: a number
                        that is cut off is not the value. */}
                    <p
                      className="text-sm font-semibold break-words tabular-nums"
                      title={s.title ?? s.value}
                    >
                      {s.value}
                    </p>
                    <p className="text-muted-foreground text-[11px]">
                      {s.label}
                    </p>
                  </div>
                ))}
              </div>

              {/* The x-axis of the whole feature: which run this one is being
                  read against. The baseline's own IDENTITY, not a link, until
                  the compare view exists — and never this run's `started_at`,
                  which would stamp two runs an hour apart with identical
                  baselines and read as confident and wrong. */}
              {currentRun.baseline_run_id && (
                <p className="text-muted-foreground mt-3 font-mono text-[11px]">
                  baseline:{' '}
                  <span title={currentRun.baseline_run_id}>
                    {currentRun.baseline_run_id.slice(0, 8)}
                  </span>
                </p>
              )}

              {/* ── Trials ──

                  A LIST, NOT A TABLE. Five columns inside a main column that
                  is only ~300px wide whenever the Properties sidebar is open
                  could only be read by scrolling sideways, which clipped the
                  last header to "DURATI…" — and a horizontal scrollbar under
                  the primary content of the screen is a hard thing to notice
                  and an easy thing to never scroll. These are the same
                  two-line rows the suite page's RUNS section uses: identity
                  and verdict on line one, the tallies on line two. */}
              <div className="mt-8 space-y-3">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Trials{' '}
                  <span className="text-muted-foreground/70">
                    {trials.length}
                  </span>
                </p>
                {trials.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    No attempts yet.
                  </p>
                ) : (
                  <div className="-mx-4">
                    {trials.map((trial) => {
                      const open = openTrialId === trial.id
                      const ceiling = stepCeilingFromChecks(trial.checks)
                      const toggle = () => setOpenTrialId(open ? null : trial.id)
                      return (
                        <div key={trial.id}>
                          {/* Expanding a trial is the primary gesture on this
                              screen, so it keeps the same keyboard contract it
                              had as a <tr> and that every other row in the
                              feature carries: role, tabIndex, aria-expanded,
                              Enter/Space, and a visible focus ring. */}
                          <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={open}
                            onClick={toggle}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggle()
                              }
                            }}
                            className="hover:bg-muted/50 focus-visible:ring-ring cursor-pointer rounded-lg px-4 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
                          >
                            <div className="flex items-center gap-2 text-sm">
                              <ChevronRight
                                aria-hidden="true"
                                className={cn(
                                  'text-muted-foreground h-3 w-3 shrink-0 transition-transform',
                                  open && 'rotate-90',
                                )}
                              />
                              {/* Only the NAME truncates — it stays
                                  identifiable from its first words, which is
                                  not true of a number. */}
                              <span className="min-w-0 truncate">
                                {trial.case_name}
                              </span>
                              {trial.trial_index > 0 && (
                                <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                                  #{trial.trial_index + 1}
                                </span>
                              )}
                              {ceiling && (
                                <AlertTriangle
                                  className="h-3 w-3 shrink-0 text-amber-500"
                                  aria-label="Hit the step ceiling"
                                />
                              )}
                              <OutcomeChip outcome={trial.outcome} />
                              <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                                {formatCost(trial.cost_usd)} ·{' '}
                                {formatDuration(trial.duration_ms)}
                              </span>
                            </div>
                            {/* The four dimension tallies on one muted line
                                under the row. Each names itself; the gate tally
                                leads, because `gate_recorded` failing means the
                                auto-apply block never ran and the
                                counterfactual — the highest-value thing a trial
                                measures — is absent. */}
                            <p className="text-muted-foreground mt-0.5 text-[11px]">
                              <ScoreChips checks={trial.checks} />
                            </p>
                          </div>

                          {/* The expanded trial is a FULL-WIDTH block directly
                              beneath its own row, never a cell inside one. As a
                              `<td colSpan>` it inherited the table's own scroll
                              width, so a rationale or a flush's chunk text was
                              clipped at the horizontal scroll edge instead of
                              wrapping — the long prose on this screen is
                              exactly the part a table cell cannot hold. */}
                          {open && (
                            <TrialDetail
                              trial={trial}
                              onOverride={applyOverride}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </div>

        <WindowProperties key={runId} title={label || 'Evaluation run'} fallbackVisible={propertiesOpen}>
                <div className="space-y-4 p-4">
                  <PropertyGroup title="Properties">
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">Mode</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {MODE_LABELS[currentRun.mode]}
                      </span>
                    </div>
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">Speed</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {SPEED_LABELS[currentRun.speed]}
                      </span>
                    </div>
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">Model</span>
                      <span className="text-muted-foreground min-w-0 shrink truncate text-xs">
                        {currentRun.target_model ?? 'Default'}
                      </span>
                    </div>
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">Tokens</span>
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {tokenSplit}
                      </span>
                    </div>
                    {currentRun.target_prompt_hash && (
                      <div className="flex h-8 items-center gap-2 px-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          Prompt version
                        </span>
                        <span
                          className="text-muted-foreground shrink-0 font-mono text-xs"
                          title={currentRun.target_prompt_hash}
                        >
                          {currentRun.target_prompt_hash.slice(0, 8)}
                        </span>
                      </div>
                    )}
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">Started</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {formatWhen(currentRun.started_at)}
                      </span>
                    </div>
                    {currentRun.baseline_run_id && (
                      <div className="flex h-8 items-center gap-2 px-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          Baseline run
                        </span>
                        <span
                          className="text-muted-foreground shrink-0 font-mono text-xs"
                          title={currentRun.baseline_run_id}
                        >
                          {currentRun.baseline_run_id.slice(0, 8)}
                        </span>
                      </div>
                    )}
                  </PropertyGroup>
                </div>
              </WindowProperties>
      </div>
    </div>
  )
}
