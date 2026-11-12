/**
 * Client-side fetch layer for SEO's AI visibility page: one place that knows
 * the routes' shapes (src/app/api/account/seo/ai-visibility/*) and the error
 * envelope ({ error, code, details } via src/lib/api-errors).
 *
 * Errors are thrown as the Site audit's SeoRequestError (../api.ts), so the
 * page reads them with the same `errorCode` / `errorMessage`. The page
 * branches on: 409 CONFIRMATION_REQUIRED (the estimates it carries, before
 * and after, are shown, and the request is sent again with `confirmed: true`
 * only on the press of the button that names the cost), 409
 * RUN_IN_PROGRESS (follows the live check it carries), 400
 * VALIDATION_ERROR / NO_SITE / NO_PROMPTS (said where the person corrects
 * it), 422 TRACKER_LIMIT, 409 DUPLICATE_TRACKER, 402 SPEND_LIMIT_REACHED (a
 * neutral banner), 503 SEO_NOT_CONFIGURED / 403 FREE_PLAN / 403
 * NOT_A_MEMBER (lookups are off), 503 CHECK_FAILED (an ordinary failure in
 * the route's words, with a way to try again that asks afresh).
 *
 * Only `startCheck` and `explore` spend. Creating or changing a tracker,
 * resuming it, and adding or turning on questions while its schedule runs
 * set up or raise spending on a schedule, which the routes hold until
 * confirmed (turning a schedule on even with no questions yet).
 *
 * Every call goes through the globally patched `window.fetch` (plain `fetch`).
 */
import type { AiMentionsExploreResult } from '@/lib/seo/ai-visibility/explore'
import type { AiScheduleSetting } from '@/lib/seo/ai-visibility/limits'
import type {
  AiAnswerDetail,
  AiCostEstimate,
  AiEngine,
  AiPromptScope,
  AiPromptSource,
  AiPromptView,
  AiRunResults,
  AiRunView,
  AiSourcesView,
  AiTrackerListItem,
  AiTrackerSummary,
  AiTrackerView,
  AiTrend,
} from '@/lib/seo/ai-visibility/view'
import { SEO_DATA_OFF_CODES } from '@/lib/seo/spend-view'
import { SeoRequestError, errorCode, jsonOrThrow } from '../api'

// ── Shapes ───────────────────────────────────────────────────────────────

/** GET trackers. */
export interface AiTrackerListPayload {
  trackers: AiTrackerListItem[]
  /** The workspace's own site: the new tracker form's default. */
  default_domain: string | null
}

/** The fields a tracker is made of (create and change). */
export interface AiTrackerFields {
  brand_name?: string
  brand_aliases?: string[]
  domain?: string | null
  competitors?: Array<{ name?: string | null; domain: string }>
  location_code?: number
  language_code?: string
  engines?: AiEngine[]
  schedule_interval?: AiScheduleSetting
  paused?: boolean
}

export interface AiCreated {
  tracker: AiTrackerView
  prompts: AiPromptView[]
  estimate: AiCostEstimate
}

export interface AiPromptsAdded {
  added: number
  skipped_duplicates: number
  skipped_over_cap: number
  estimate: AiCostEstimate
}

export interface Paged<T> {
  rows: T[]
  next_offset: number | null
}

// ── Errors ───────────────────────────────────────────────────────────────

/** Codes that mean search data can't be bought here at all. */
export const DATA_OFF_CODES: ReadonlySet<string> = SEO_DATA_OFF_CODES

/** What a 409 CONFIRMATION_REQUIRED carries: the estimate to show before asking again. */
export interface AiConfirmation {
  message: string
  estimate: AiCostEstimate | null
  previous_estimate: AiCostEstimate | null
  /** A lookup's price (the explorer), when there is no estimate object. */
  estimate_usd: number | null
}

export function confirmationOf(err: unknown): AiConfirmation | null {
  if (errorCode(err) !== 'CONFIRMATION_REQUIRED') return null
  const api = (err as SeoRequestError).apiError
  const d = api.details ?? {}
  const est = (v: unknown) => (v && typeof v === 'object' && typeof (v as { run_usd?: unknown }).run_usd === 'number' ? (v as AiCostEstimate) : null)
  return {
    message: api.message,
    estimate: est(d.estimate),
    previous_estimate: est(d.previous_estimate),
    estimate_usd: typeof d.estimate_usd === 'number' ? d.estimate_usd : null,
  }
}

/** The live check a 409 RUN_IN_PROGRESS carries, or null. */
export function runningCheckOf(err: unknown): AiRunView | null {
  if (errorCode(err) !== 'RUN_IN_PROGRESS') return null
  const run = (err as SeoRequestError).apiError.details?.run
  return run && typeof run === 'object' && typeof (run as { id?: unknown }).id === 'string' ? (run as AiRunView) : null
}

const send = (method: string, body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }

const BASE = '/api/account/seo/ai-visibility'

// ── Trackers ─────────────────────────────────────────────────────────────

export async function fetchTrackers(): Promise<AiTrackerListPayload> {
  return jsonOrThrow<AiTrackerListPayload>(await fetch(`${BASE}/trackers`))
}

export async function createTracker(fields: AiTrackerFields & { prompts?: Array<string | { text: string; source?: AiPromptSource }>; confirmed?: boolean }): Promise<AiCreated> {
  return jsonOrThrow<AiCreated>(await fetch(`${BASE}/trackers`, send('POST', fields)))
}

export async function fetchTracker(id: string): Promise<AiTrackerSummary> {
  return jsonOrThrow<AiTrackerSummary>(await fetch(`${BASE}/${id}`))
}

export async function updateTracker(id: string, change: AiTrackerFields & { confirmed?: boolean }): Promise<{ tracker: AiTrackerView; estimate: AiCostEstimate }> {
  return jsonOrThrow(await fetch(`${BASE}/${id}`, send('PATCH', change)))
}

export async function deleteTracker(id: string): Promise<void> {
  await jsonOrThrow<{ deleted: boolean }>(await fetch(`${BASE}/${id}`, send('DELETE')))
}

// ── Questions ────────────────────────────────────────────────────────────

export async function fetchPrompts(trackerId: string): Promise<AiPromptView[]> {
  return (await jsonOrThrow<{ prompts: AiPromptView[] }>(await fetch(`${BASE}/${trackerId}/prompts`))).prompts
}

export async function addPrompts(
  trackerId: string,
  prompts: Array<string | { text: string; source?: AiPromptSource }>,
  confirmed?: boolean,
): Promise<AiPromptsAdded> {
  return jsonOrThrow<AiPromptsAdded>(await fetch(`${BASE}/${trackerId}/prompts`, send('POST', { prompts, ...(confirmed ? { confirmed: true } : {}) })))
}

export async function setPromptsActive(trackerId: string, promptIds: string[], active: boolean, confirmed?: boolean): Promise<void> {
  await jsonOrThrow<unknown>(await fetch(`${BASE}/${trackerId}/prompts`, send('PATCH', { prompt_ids: promptIds, active, ...(confirmed ? { confirmed: true } : {}) })))
}

export async function removePrompts(trackerId: string, promptIds: string[]): Promise<void> {
  await jsonOrThrow<unknown>(await fetch(`${BASE}/${trackerId}/prompts`, send('DELETE', { prompt_ids: promptIds })))
}

// ── Checks ───────────────────────────────────────────────────────────────

/** Start a check now. PAID. Above the threshold it throws CONFIRMATION_REQUIRED until `confirmed`. */
export async function startCheck(trackerId: string, confirmed?: boolean): Promise<AiRunView> {
  const data = await jsonOrThrow<{ run: AiRunView }>(await fetch(`${BASE}/${trackerId}/runs`, send('POST', confirmed ? { confirmed: true } : {})))
  return data.run
}

/** A check's results (the poll target while it runs). */
export async function fetchRunResults(runId: string, opts: { scope?: AiPromptScope; offset?: number } = {}): Promise<AiRunResults> {
  const qs = new URLSearchParams()
  if (opts.scope && opts.scope !== 'neutral') qs.set('scope', opts.scope)
  if (opts.offset) qs.set('offset', String(opts.offset))
  const q = qs.toString()
  return (await jsonOrThrow<{ results: AiRunResults }>(await fetch(`${BASE}/runs/${runId}${q ? `?${q}` : ''}`))).results
}

/** Stop a live check; answers already in stay. */
export async function stopCheck(runId: string): Promise<AiRunView> {
  return (await jsonOrThrow<{ run: AiRunView }>(await fetch(`${BASE}/runs/${runId}`, send('POST')))).run
}

/** A check's answers as a CSV file, saved through the browser. */
export async function downloadRunCsv(runId: string): Promise<void> {
  const res = await fetch(`${BASE}/runs/${runId}/export`)
  if (!res.ok) await jsonOrThrow<never>(res)
  const blob = await res.blob()
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `ai-visibility-${runId.slice(0, 8)}.csv`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function fetchTrend(trackerId: string, days: number): Promise<AiTrend> {
  return (await jsonOrThrow<{ trend: AiTrend }>(await fetch(`${BASE}/${trackerId}/trend?days=${days}`))).trend
}

export async function fetchSources(
  trackerId: string,
  opts: { groupBy: 'domain' | 'page'; domain?: string | null; offset?: number; runId?: string | null },
): Promise<AiSourcesView> {
  const qs = new URLSearchParams()
  if (opts.runId) qs.set('run_id', opts.runId)
  qs.set('group_by', opts.groupBy)
  if (opts.domain) qs.set('domain', opts.domain)
  if (opts.offset) qs.set('offset', String(opts.offset))
  return (await jsonOrThrow<{ sources: AiSourcesView }>(await fetch(`${BASE}/${trackerId}/sources?${qs.toString()}`))).sources
}

export async function fetchAnswer(answerId: string, full = false): Promise<AiAnswerDetail> {
  return (await jsonOrThrow<{ answer: AiAnswerDetail }>(await fetch(`${BASE}/answers/${answerId}${full ? '?full=1' : ''}`))).answer
}

// ── Estimates and the explorer ───────────────────────────────────────────

export async function fetchEstimate(input: {
  tracker_id?: string
  prompt_count?: number
  engines?: AiEngine[]
  schedule_interval?: AiScheduleSetting
  location_code?: number
  language_code?: string
}): Promise<AiCostEstimate> {
  return (await jsonOrThrow<{ estimate: AiCostEstimate }>(await fetch(`${BASE}/estimate`, send('POST', input)))).estimate
}

/**
 * Recorded questions whose AI answers mention a brand or site. PAID (a stored
 * answer younger than a day is free). The result can be partial: a part that
 * could not be looked up after earlier parts were bought is null, and
 * `partial.note` says so in plain words.
 */
export async function exploreQuestions(input: {
  target: string
  location_code?: number
  language_code?: string
  refresh?: boolean
  confirmed?: boolean
}): Promise<{ explore: AiMentionsExploreResult; estimate_usd: number }> {
  return jsonOrThrow(await fetch(`${BASE}/explore`, send('POST', { ...input, parts: ['questions'] })))
}
