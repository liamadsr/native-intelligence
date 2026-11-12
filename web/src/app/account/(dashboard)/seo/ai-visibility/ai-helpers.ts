/**
 * The AI visibility page's words, pure, so the views and their tests read
 * the same strings. House style as ../ui-helpers.ts: sentence case,
 * plural-aware counts, a clause whose number is zero dropped, ` · ` between
 * clauses.
 *
 * Every money figure here is one the estimate route returned; nothing is
 * priced on this side.
 */
import { ALL_AI_ENGINES, MAX_PROMPTS_PER_TRACKER, type AiScheduleSetting } from '@/lib/seo/ai-visibility/limits'
import {
  answerErrorMessage,
  type AiAnswerRow,
  type AiCostEstimate,
  type AiEngine,
  type AiPromptScope,
  type AiRunView,
  type AiSourceOwnership,
  type AiTrackerListItem,
  type AiTrackerView,
  type AiTrendComparison,
} from '@/lib/seo/ai-visibility/view'
import { markdownToText } from '@/lib/seo/ai-visibility/evidence'
import { AI_ENGINE_LABELS, AI_UNSUPPORTED_LOCATIONS, aiCountryLabel } from '@/lib/seo/shared/ai-visibility'
import { getLanguageCode } from '@/lib/seo/shared/keyword-locations'
import { count } from '../ui-helpers'

// ── Engines and schedule ─────────────────────────────────────────────────

/** The engines in their fixed order (the order the marks and rows use). */
export function orderedEngines(engines: readonly AiEngine[]): AiEngine[] {
  return ALL_AI_ENGINES.filter((e) => engines.includes(e))
}

/** "ChatGPT, Gemini, Perplexity" */
export function engineList(engines: readonly AiEngine[]): string {
  return orderedEngines(engines)
    .map((e) => AI_ENGINE_LABELS[e])
    .join(', ')
}

/** Why an engine can't be chosen in a country, or null when it can. */
export function engineUnavailable(engine: AiEngine, locationCode: number): string | null {
  return AI_UNSUPPORTED_LOCATIONS[engine].includes(locationCode) ? `${AI_ENGINE_LABELS[engine]} can’t be checked in ${aiCountryLabel(locationCode)}` : null
}

export const SCHEDULE_OPTIONS: ReadonlyArray<{ value: AiScheduleSetting; label: string }> = [
  { value: 'off', label: 'By hand' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

export function scheduleWords(interval: AiScheduleSetting): string {
  return interval === 'off' ? 'checked by hand' : `checked ${interval}`
}

/** The country, and the language when it isn't the country's own. */
export function marketWords(t: Pick<AiTrackerView, 'location_code' | 'language_code' | 'market_label'>): string {
  const country = aiCountryLabel(t.location_code)
  if (t.language_code === getLanguageCode(t.location_code)) return country
  const language = t.market_label.split(' · ')[1]
  return language ? `${country} · ${language}` : country
}

/** "next check Monday", "next check tomorrow", "next check Dec 4"; null without a time. */
export function nextCheckWords(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const day = (d: Date) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
  const days = day(at) - day(now)
  if (days <= 0) return 'next check today'
  if (days === 1) return 'next check tomorrow'
  if (days < 7) return `next check ${at.toLocaleDateString(undefined, { weekday: 'long' })}`
  return `next check ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })}`
}

/** The tracker's quiet line: "ChatGPT, Gemini · United States · checked weekly · next check Monday". */
export function trackerSettingsLine(t: AiTrackerView, now: Date = new Date()): string {
  const parts = [engineList(t.engines), marketWords(t)]
  if (t.paused) parts.push('Paused')
  else {
    parts.push(scheduleWords(t.schedule_interval))
    if (t.schedule_interval !== 'off') {
      const next = nextCheckWords(t.next_run_at, now)
      if (next) parts.push(next)
    }
  }
  return parts.filter(Boolean).join(' · ')
}

/** The index row's second line: "12 questions · ChatGPT, Gemini · checked weekly". */
export function trackerSubline(t: AiTrackerListItem): string {
  return [count(t.prompt_count, 'question'), engineList(t.engines), scheduleWords(t.schedule_interval)].filter(Boolean).join(' · ')
}

export interface TrackerStatus {
  word: string
  title?: string
  tone: 'muted' | 'red'
}

/** The index row's status word, or null when the tracker is simply checked. */
export function trackerStatus(t: AiTrackerListItem): TrackerStatus | null {
  const run = t.latest_run
  if (run && (run.status === 'queued' || run.status === 'running')) return { word: 'Checking', tone: 'muted' }
  if (t.paused) return { word: 'Paused', title: 'No scheduled checks until it is resumed', tone: 'muted' }
  if (t.last_skip_message) return { word: 'Skipped', title: t.last_skip_message, tone: 'muted' }
  if (run?.status === 'failed') return { word: 'Failed', title: run.error ?? 'The last check could not finish', tone: 'red' }
  return null
}

// ── A check ──────────────────────────────────────────────────────────────

/** The run rail's sentence for a live check: "Asking the assistants · 18 of 30 answers in". */
export function runRailLine(run: Pick<AiRunView, 'status' | 'answers_total' | 'answers_open'>): { verb: string; clauses: string[] } {
  if (run.status === 'queued') return { verb: 'Starting the check', clauses: run.answers_total > 0 ? [count(run.answers_total, 'answer') + ' to ask for'] : [] }
  const total = run.answers_total
  const done = Math.max(0, total - run.answers_open)
  return { verb: 'Asking the assistants', clauses: total > 0 ? [`${done.toLocaleString()} of ${total.toLocaleString()} answers in`] : [] }
}

/** How long to wait before reading a live check again: the route's word, never under 5 s. */
export function pollDelayMs(run: Pick<AiRunView, 'poll_after_seconds'> | null | undefined): number {
  const s = run?.poll_after_seconds ?? 5
  return Math.max(5, Number.isFinite(s) ? s : 5) * 1000
}

export const SCOPE_OPTIONS: ReadonlyArray<{ value: AiPromptScope; label: string }> = [
  { value: 'neutral', label: 'Questions without your name' },
  { value: 'branded', label: 'With your name' },
  { value: 'all', label: 'All' },
]

// ── Money ────────────────────────────────────────────────────────────────

export function usdWords(usd: number): string {
  if (usd < 0.005) return 'less than a cent'
  return `$${usd.toFixed(2)}`
}

/** "about $0.14", or "less than a cent". */
export function aboutUsd(usd: number): string {
  return usd < 0.005 ? 'less than a cent' : `about ${usdWords(usd)}`
}

/**
 * The estimate in a sentence: "A check asks 15 questions of 2 assistants and
 * costs about $0.14. Weekly, about $0.60 a month." Null with nothing to ask.
 */
export function estimateSentence(e: AiCostEstimate): string | null {
  if (e.prompt_count <= 0 || e.engines.length === 0) return null
  const check = `A check asks ${count(e.prompt_count, 'question')} of ${count(e.engines.length, 'assistant')} and costs ${aboutUsd(e.run_usd)}.`
  if (e.schedule_interval === 'off' || e.checks_per_month <= 0) return check
  const how = e.schedule_interval.charAt(0).toUpperCase() + e.schedule_interval.slice(1)
  return `${check} ${how}, ${aboutUsd(e.monthly_usd)} a month.`
}

/**
 * What a tracker spends on its own each month: "about $0.60 a month",
 * "nothing until questions are added" (a schedule with no questions yet) or
 * "nothing on its own".
 */
export function monthlyWords(e: AiCostEstimate): string {
  if (e.schedule_interval === 'off' || e.checks_per_month <= 0) return 'nothing on its own'
  if (e.prompt_count === 0) return 'nothing until questions are added'
  return `${aboutUsd(e.monthly_usd)} a month`
}

/**
 * The estimate as a spend confirmation shows it (its before and after):
 * estimateSentence, and also a sentence where that has none. A schedule
 * with no questions yet costs nothing now and per check once questions are
 * added; no schedule spends nothing on its own. Null with no assistants.
 */
export function spendSentence(e: AiCostEstimate): string | null {
  if (e.engines.length === 0) return null
  const sentence = estimateSentence(e)
  if (e.schedule_interval === 'off' || e.checks_per_month <= 0) return sentence ? `${sentence} Nothing is spent on its own.` : 'Nothing is spent on its own.'
  if (sentence) return sentence
  const how = e.schedule_interval.charAt(0).toUpperCase() + e.schedule_interval.slice(1)
  return `${how} checks cost nothing while there are no questions. Once questions are added, every check costs for each one it asks, and you are asked first.`
}

// ── Typed input ──────────────────────────────────────────────────────────

/** The questions typed one per line: trimmed, inner spaces collapsed, once each (case ignored), as typed otherwise. */
export function parseQuestionLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const q = line.trim().replace(/\s+/g, ' ')
    if (!q) continue
    const key = q.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(q)
  }
  return out
}

/** Other names, comma-separated: trimmed, once each. */
export function parseNames(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(',')) {
    const n = part.trim().replace(/\s+/g, ' ')
    if (!n || seen.has(n.toLowerCase())) continue
    seen.add(n.toLowerCase())
    out.push(n)
  }
  return out
}

/** An add's outcome: "Added 3 questions. 1 was already there." */
export function addedWords(out: { added: number; skipped_duplicates: number; skipped_over_cap: number }): string {
  const notes: string[] = []
  if (out.skipped_duplicates > 0) notes.push(`${out.skipped_duplicates.toLocaleString()} ${out.skipped_duplicates === 1 ? 'was' : 'were'} already there`)
  if (out.skipped_over_cap > 0) notes.push(`${out.skipped_over_cap.toLocaleString()} didn’t fit (a tracker holds up to ${MAX_PROMPTS_PER_TRACKER})`)
  return `Added ${count(out.added, 'question')}.${notes.length ? ` ${notes.join(', ')}.` : ''}`
}

// ── Numbers ──────────────────────────────────────────────────────────────

/** "42%", "42.5%"; null stays null. */
export function pct(rate: number | null | undefined): string | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null
  return `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}

/** A change in percentage points as a tile note: up is better here. */
export function pointsChange(change: number | null): { note: string; tone: 'up' | 'down' | 'flat' } | null {
  if (change === null || !Number.isFinite(change)) return null
  const abs = Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 1 })
  if (Math.abs(change) < 0.05) return { note: 'No change', tone: 'flat' }
  return change > 0 ? { note: `Up ${abs} ${Math.abs(change) === 1 ? 'point' : 'points'}`, tone: 'up' } : { note: `Down ${abs} ${Math.abs(change) === 1 ? 'point' : 'points'}`, tone: 'down' }
}

/** Why a trend's change isn't shown, in plain words, for the tile's title. */
export function comparisonReason(comparison: AiTrendComparison, days: number): string | null {
  switch (comparison) {
    case 'comparable':
      return null
    case 'incomplete':
      return `Not compared with the ${days} days before: some answers are missing in one of the two periods.`
    case 'scope_changed':
      return `Not compared with the ${days} days before: the questions, assistants or country changed in between.`
    case 'no_previous':
      return `Not compared yet: there were no checks in the ${days} days before.`
    case 'no_data':
      return `Not compared: no finished checks in the last ${days} days.`
  }
}

// ── Answers ──────────────────────────────────────────────────────────────

export type AnswerMark = 'named' | 'not_named' | 'no_answer' | 'waiting'

/** One engine's mark for one question: named (✓), not named (–), no answer (·), or still coming. */
export function answerMark(row: Pick<AiAnswerRow, 'status' | 'answer_status' | 'brand_mentioned'> | null | undefined): AnswerMark {
  if (!row) return 'no_answer'
  if (row.status === 'pending' || row.status === 'asking' || row.status === 'posted') return 'waiting'
  if (row.answer_status !== 'answered') return 'no_answer'
  return row.brand_mentioned ? 'named' : 'not_named'
}

/** A mark's title: the engine and what happened, the reason when no answer came. */
export function markTitle(
  engine: AiEngine,
  row: (Pick<AiAnswerRow, 'status' | 'answer_status' | 'brand_mentioned' | 'error' | 'late'> & { error_code?: string | null }) | null | undefined,
): string {
  const label = AI_ENGINE_LABELS[engine]
  const mark = answerMark(row)
  const late = row?.late ? ' (came in late)' : ''
  if (mark === 'named') return `${label} named you${late}`
  if (mark === 'not_named') return `${label} answered without naming you${late}`
  if (mark === 'waiting') return `${label}: the answer is still on its way`
  if (!row) return `${label}: not asked in this check`
  if (row.answer_status === 'no_answer') return engine === 'google_ai_overview' ? `${label}: Google showed no AI Overview` : `${label} gave no real answer`
  return `${label}: ${row.error ?? answerErrorMessage(row.error_code ?? null) ?? 'no answer came'}`
}

/** "Named 2nd", "Named first"; null when not named. */
export function positionWords(position: number | null): string | null {
  if (position === null || position < 1) return null
  if (position === 1) return 'Named first'
  const n = position
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'
  return `Named ${n}${suffix}`
}

/**
 * An answer's markdown as one line of plain text for a short excerpt: the
 * core's own plain prose (links keep their label, citation pills, images,
 * emphasis and heading marks go), folded onto one line and cut.
 */
export function excerptText(markdown: string | null, max = 600): string {
  if (!markdown) return ''
  const text = markdownToText(markdown).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

// ── Sources ──────────────────────────────────────────────────────────────

export const OWNERSHIP_LABEL: Record<AiSourceOwnership, string> = {
  own: 'Yours',
  competitor: 'Competitor',
  other: 'Other',
}

export const OWNERSHIP_CHIP: Record<AiSourceOwnership, string> = {
  own: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  competitor: 'border-border bg-muted/40 text-foreground',
  other: 'border-border bg-transparent text-muted-foreground',
}

/** A URL without its scheme and "www.", for a page row: "example.com/guide". */
export function urlWords(url: string): string {
  try {
    const u = new URL(url)
    const path = `${u.pathname}${u.search}`
    return `${u.hostname.replace(/^www\./, '')}${path === '/' ? '' : path}`
  } catch {
    return url
  }
}
