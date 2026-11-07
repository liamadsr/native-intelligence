/**
 * Pure helpers for reading the LAST RUN off a prospect-list row.
 *
 * The list index renders a list's newest run in three places — the row's
 * last-run chip, the live "Finding…" dot, and the spend figure — and those
 * numbers come out of an embedded `prospecting_run` array on a views-system
 * row, not out of the prospecting API's own run shape. This module is the one
 * place that knows how to unwrap it, so the row component and the page agree.
 *
 * PURE and dependency-free on purpose: no React, no Supabase, no date-fns. It
 * is imported by a client row component AND by server-side code, and every
 * accessor degrades to null rather than throwing — a row whose run blob is
 * missing a key must render one fewer chip, never a blank page.
 */
import {
  PROSPECTING_RUN_STATUSES,
  type ProspectingRunKind,
  type ProspectingRunProgress,
  type ProspectingRunStatus,
} from './types'

/**
 * The last run as a views row carries it.
 *
 * Every field optional because this describes JSON off the wire, not a
 * validated row: PostgREST hands back whatever the select asked for, and a
 * `spent_dollars` numeric arrives as a STRING often enough that treating it as
 * a number without a guard is a bug waiting for the first non-integer cost.
 */
export interface LastRun {
  id?: string | null
  kind?: string | null
  status?: string | null
  spent_dollars?: number | string | null
  progress?: unknown
  started_at?: string | null
  finished_at?: string | null
  created_at?: string | null
}

/**
 * The live statuses, duplicated from `runs.ts`'s LIVE_STATUSES rather than
 * imported, because `runs.ts` pulls in the Inngest client and this module is
 * loaded by a client component. Pinned against
 * PROSPECTING_RUN_STATUSES and against `isLive` by
 * __tests__/run-summary.test.ts, so the two cannot drift silently.
 */
const LIVE: readonly string[] = ['queued', 'running', 'needs_input', 'canceling']

/** True while the run is still in flight — poll it, and show the pulsing dot. */
export function isRunLive(status: string | null | undefined): boolean {
  return typeof status === 'string' && LIVE.includes(status)
}

/**
 * The newest run embedded on a views-system `prospect_list` row.
 *
 * The query engine embeds `prospecting_run` ordered by created_at desc and
 * LIMITED TO ONE, so index 0 is by construction the last run. Tolerates the
 * three shapes the same key arrives in — an array (PostgREST's embed), a bare
 * object (a hand-built fixture or a single-row fetch), and absent (a list that
 * has never been run) — because a row renderer that throws on the third is a
 * blank Prospecting page for any workspace with a fresh list in it.
 */
export function lastRunOf(item: unknown): LastRun | null {
  if (!item || typeof item !== 'object') return null
  const raw = (item as Record<string, unknown>).prospecting_run
  if (!raw) return null
  if (Array.isArray(raw)) {
    const first = raw[0]
    return first && typeof first === 'object' ? (first as LastRun) : null
  }
  return typeof raw === 'object' ? (raw as LastRun) : null
}

/** `spent_dollars` as a number. Numerics can arrive as strings over PostgREST. */
export function runSpend(run: LastRun | null): number {
  if (!run) return 0
  const value = typeof run.spent_dollars === 'string' ? Number(run.spent_dollars) : run.spent_dollars
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * "N new" — how many candidates the run ADMITTED, straight out of
 * `progress.new`.
 *
 * The run engine defines that counter as "keys this run admitted as new
 * entries", so it is exactly the number the chip wants and it is already
 * written at every round boundary. Counting `prospect_list_entry` by
 * `discovered_by_run_id` would be one extra query per row to learn something
 * the run already recorded.
 */
export function runNewCount(run: LastRun | null): number {
  if (!run) return 0
  const progress = run.progress
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return 0
  const value = (progress as Partial<ProspectingRunProgress>).new
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** When the run finished, or failing that when it started / was created. */
export function runTimestamp(run: LastRun | null): string | null {
  if (!run) return null
  return run.finished_at ?? run.started_at ?? run.created_at ?? null
}

/** "$0.42" — cents matter; this is real money the user consented to. */
export function formatRunSpend(dollars: number): string {
  return `$${dollars.toFixed(2)}`
}

/**
 * The last run, DERIVED — every question the row and the page ask about it,
 * answered once.
 *
 * This exists because the four consumers were each re-deriving "is it live",
 * "did it fail", "is the cap the reason it stopped" off a raw status string,
 * and `budget_exhausted` is exactly the value a hand-rolled `status ===
 * 'failed' || status === 'canceled'` gets wrong: it is an OUTCOME, not a
 * failure (§9) — the run kept every partial result — so a row that greys it
 * out like a failure lies about a run that worked.
 */
export interface ProspectRunSummary {
  /** The raw status, for a data attribute / a title. Null on a malformed row. */
  status: ProspectingRunStatus | null
  kind: ProspectingRunKind | null
  /** In flight: poll it, show the pulsing dot, and say "Finding…". */
  live: boolean
  /** Genuinely wrong — `failed` or `canceled`. NOT budget_exhausted. */
  failed: boolean
  /** Stopped at the spend cap with everything it had found. Not a failure. */
  budgetExhausted: boolean
  /** `progress.new` — how many candidates this run ADMITTED. */
  newCount: number
  /** Dollars, coerced: PostgREST hands numerics back as strings. */
  spend: number
  /** finished_at ?? started_at ?? created_at. */
  at: string | null
}

/**
 * Derive {@link ProspectRunSummary} from a run blob, or null when there is no
 * run — a list that has never run shows NO chip, not a "never run" one.
 */
export function summarizeRun(run: LastRun | null): ProspectRunSummary | null {
  if (!run) return null
  const status = isProspectingRunStatus(run.status) ? run.status : null
  return {
    status,
    kind: runKindOf(run),
    live: isRunLive(status),
    failed: status === 'failed' || status === 'canceled',
    budgetExhausted: status === 'budget_exhausted',
    newCount: runNewCount(run),
    spend: runSpend(run),
    at: runTimestamp(run),
  }
}

/**
 * `lastRunOf` under the name the row component reads it by. Same function —
 * the row asks "what run is embedded on this item", the page asks "what is
 * this list's last run", and they are the same question.
 */
export const embeddedRun = lastRunOf

/**
 * The run chip's text for an already-derived summary.
 *
 * Deliberately does NOT special-case `live`: the row knows about live runs the
 * embedded row does not (a run Scout started three seconds ago is in the
 * active-runs poll and not in this page's query), so it owns the "Finding…"
 * string and calls this only for settled runs.
 */
export function runChipLabel(summary: ProspectRunSummary | null): string | null {
  if (!summary) return null
  if (summary.live) return 'Finding…'
  // budget_exhausted keeps its COUNT here — the run found things before it
  // stopped, and the stop itself is said by its own chip beside this one.
  if (summary.failed) return summary.status === 'canceled' ? 'Canceled' : 'Failed'
  return summary.newCount > 0 ? `${summary.newCount} new` : 'Nothing new'
}

/**
 * The last-run chip's text, minus the relative time the caller appends (it
 * needs a clock, and this module stays pure).
 *
 * - live → "Finding…", because what the row can honestly say about a run in
 *   flight is that it is running.
 * - budget_exhausted → "Stopped early". An OUTCOME, not a failure (§9): the
 *   run kept every partial result, so the chip says it stopped rather than
 *   staying silent about it. (Why it stopped is a backend limit the user does
 *   not manage on this screen.)
 * - failed / canceled → said plainly.
 * - completed → "N new" when it admitted anything, "Nothing new" when it did
 *   not.
 * - no run at all → null, and the caller renders NO chip rather than a "never
 *   run" row that adds nothing.
 */
export function runSummaryLabel(run: LastRun | null): string | null {
  const summary = summarizeRun(run)
  if (!summary) return null
  if (summary.budgetExhausted) return 'Stopped early'
  return runChipLabel(summary)
}

/** Narrowing helpers for the row's chips, kept here so the vocabulary lives in
 *  one module. */
export function isProspectingRunStatus(value: unknown): value is ProspectingRunStatus {
  return typeof value === 'string' && (PROSPECTING_RUN_STATUSES as readonly string[]).includes(value)
}

export function runKindOf(run: LastRun | null): ProspectingRunKind | null {
  const kind = run?.kind
  return kind === 'discover' || kind === 'account_card' || kind === 'people' ? kind : null
}
