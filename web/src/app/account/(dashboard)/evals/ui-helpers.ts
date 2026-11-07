/**
 * Formatting shared by every Evals screen — the index, the suite detail, the
 * case editor and the run detail.
 *
 * It exists as its own module (rather than living beside the first screen that
 * needed it) because four files import it and two of those are written by a
 * different author: a cost rendered as "$0.04" on one screen and "0.042" on
 * the next would read as two different numbers about the same run.
 */

import type {
  EvalDimension,
  EvalMode,
  EvalSpeed,
  RunOutcome,
} from '@/lib/evals/types'
import { RUNNABLE_EVAL_SPEEDS } from '@/lib/evals/types'

/**
 * A run's cost, in dollars.
 *
 * FOUR decimal places under a DIME, two above it. `eval_run.cost_usd` is
 * `numeric(10,6)`, and per-trial costs are the numbers this feature exists to
 * let someone watch: a batch trial lands near $0.005 and an instant live trial
 * near $0.015. A one-cent cut rounds that live trial to "$0.02" — a 28%
 * overstatement of the single most-read number on the run table, and it
 * flattens every small run into looking like the same run. Ten cents is the
 * threshold where the fourth place stops carrying information: run totals of
 * $2.40 render as "$2.40" rather than the noise of "$2.4000".
 */
export function formatCost(usd: number | string | null | undefined): string {
  const value = typeof usd === 'string' ? Number(usd) : usd
  if (value === null || value === undefined || !Number.isFinite(value))
    return '—'
  if (value === 0) return '$0.00'
  if (Math.abs(value) < 0.1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/**
 * A duration in milliseconds, as the shortest thing that is still true.
 *
 * A batch trial is seconds, a live sweep is minutes, and a twenty-case run is
 * tens of minutes — one unit cannot serve all three without either losing the
 * difference between 3s and 8s or printing "1284000ms".
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes - hours * 60}m`
}

/** The human label for one `eval_check.dimension`. */
const DIMENSION_LABELS: Record<EvalDimension, string> = {
  proposals: 'Proposals',
  summary: 'Summary',
  nudges: 'Nudges',
  tools: 'Tools',
  gate: 'Gate',
  cost: 'Cost',
  latency: 'Latency',
}

/**
 * A dimension's label. Takes a bare `string` rather than `EvalDimension`
 * because `eval_run.scores` is jsonb typed as a loose record — a run stored
 * before a dimension was renamed must still render as SOMETHING readable
 * instead of blanking a whole column.
 */
export function dimensionLabel(dimension: string): string {
  return DIMENSION_LABELS[dimension as EvalDimension] ?? dimension
}

/**
 * A per-dimension pass rate as a percentage, or '—' when the denominator was
 * empty. `null` is not zero: every check in that dimension was `unknown` or
 * `skipped`, both of which are excluded from the denominator (spec §6.4), and
 * printing "0%" for "we could not tell" is the single most misleading thing
 * this screen could do.
 */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}

/**
 * The same rate WITHOUT its `%` sign — for the one-line score chips on a run
 * row, where four labelled percentages could not fit the column and the label
 * beside each number already establishes the unit. Returns '—' for an empty
 * denominator on exactly the same terms as {@link formatRate}, so a chip never
 * reads as a bare zero.
 */
export function formatRateBare(rate: number | null | undefined): string {
  const formatted = formatRate(rate)
  return formatted === '—' ? formatted : formatted.slice(0, -1)
}

/** Sentence-case label for a run's outcome. */
export const OUTCOME_LABELS: Record<RunOutcome | 'errored', string> = {
  passed: 'Passed',
  scored: 'Scored',
  failed: 'Failed',
  errored: 'Errored',
}

export const MODE_LABELS: Record<EvalMode, string> = {
  batch: 'Batch',
  live: 'Live',
}

/**
 * A run's start time, ABSOLUTE. Two runs of the same suite an hour apart are
 * the thing being compared, and "2h ago" on both cannot tell them apart.
 */
export function formatRunWhen(iso: string | null | undefined): string {
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

/**
 * The label a run carries everywhere it is NAMED — the suite page's run rows,
 * the tab bar, Recently viewed, and the Runs views list.
 *
 * It lives here rather than on the suite page because `entity-row` now renders
 * run rows too, and a shared views row importing a page component would drag
 * the whole detail screen into every list bundle. A run has no `name` column,
 * so this composition IS its identity: two spellings of it would be two
 * different-looking names for the same run depending on which screen you were
 * on.
 *
 * Deliberately takes the two fields rather than a row type: the views select
 * (EVAL_RUN_VIEW_SELECT) and the page's `EvalRunRow` are different shapes that
 * happen to share these two columns.
 */
export function runLabel(run: {
  mode: EvalMode
  started_at: string | null
}): string {
  return `${MODE_LABELS[run.mode]} run · ${formatRunWhen(run.started_at)}`
}

/**
 * A run's per-dimension pass rates as ONE line: "Gate 100 · Tools 100 ·
 * Summary 100 · Proposals 60".
 *
 * The `%` is dropped for width — the label beside each number establishes the
 * unit, and four labelled percentages do not fit a row cell. Returns the
 * entries rather than a string so a caller can put each dimension's full
 * sentence in its own `title`; {@link dimensionTallyText} is the flat form for
 * a cell's own tooltip.
 */
export function dimensionTally(
  scores: Record<string, { rate?: number | null } | null> | null | undefined,
): { dimension: string; label: string; value: string; title: string }[] {
  return Object.entries(scores ?? {}).map(([dimension, score]) => ({
    dimension,
    label: dimensionLabel(dimension),
    value: formatRateBare(score?.rate),
    title: `${dimensionLabel(dimension)} pass rate: ${formatRate(score?.rate)}`,
  }))
}

/** The same tally as one plain string WITH its `%` signs, for a `title`
 *  attribute — where there is room to be unambiguous. */
export function dimensionTallyText(
  scores: Record<string, { rate?: number | null } | null> | null | undefined,
): string {
  return Object.entries(scores ?? {})
    .map(([dimension, score]) => `${dimensionLabel(dimension)} ${formatRate(score?.rate)}`)
    .join(' · ')
}

/**
 * The three replay speeds. Only `instant` runs in P0 — `realtime` and `fast`
 * need the client driver (spec §4.1, P1), and the picker shows them disabled
 * rather than hiding them so the shape of the feature is visible.
 */
export const SPEED_LABELS: Record<EvalSpeed, string> = {
  realtime: 'Real time',
  fast: '10× speed',
  instant: 'Instant',
}

/** Which speeds the server driver can actually run today. Re-exported from the
 *  shared enum rather than re-listed, so the picker and the route that rejects a
 *  non-runnable speed can never disagree about which ones those are. */
export const P0_SPEEDS: readonly EvalSpeed[] = RUNNABLE_EVAL_SPEEDS

/** Relative time, short form. Mirrors the prospecting helper of the same name
 *  so two sibling views never disagree about what "2h ago" looks like. */
export function relativeTimeShort(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

/** "3 cases" / "1 case". */
export function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`
}
