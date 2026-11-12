/**
 * Client-side fetch layer for SEO's Rankings page: one place that knows the
 * rank routes' shapes (src/app/api/account/seo/rank/*) and the error
 * envelope ({ error, code, details } via src/lib/api-errors).
 *
 * Errors are thrown by the Site audit's jsonOrThrow (../api.ts) as its
 * SeoRequestError, so the page reads them with the same `errorCode` / `errorMessage`. The page
 * branches on: a create's 400 INVALID_INPUT / NO_SITE (said in the form), its
 * 409 DUPLICATE_TRACKER (opens the tracker it names) and TOO_MANY_TRACKERS; a
 * check's 402 SPEND_LIMIT_REACHED (a neutral banner, the page stays usable),
 * 409 ALREADY_RUNNING (follows the live check it carries) and NO_KEYWORDS;
 * the access check's refusals (SEO_DATA_OFF_CODES: lookups are off;
 * CHECK_FAILED: an ordinary failure to retry); and 409 NEEDS_GO_AHEAD
 * (goAheadOf), from a check above the confirmation line or a change that
 * turns on or raises what a tracker spends on its own: the server's estimate,
 * which the page shows on the button that sends the request again with
 * `confirmed: true`.
 *
 * `confirmed` is sent only from a press of a button that names the cost the
 * person was shown. Only `startCheck` spends now; create, update and add can
 * set up spending on a schedule. Every other call reads, changes settings, or
 * does the free estimate maths.
 *
 * Every call goes through the globally patched `window.fetch` (plain `fetch`).
 */
import type { SeoMarketOptions } from '@/lib/seo/keywords/view'
import { SEO_DATA_OFF_CODES } from '@/lib/seo/spend-view'
import type {
  RankEstimateView,
  RankKeywordHistory,
  RankKeywordRow,
  RankPaged,
  RankRunView,
  RankTrackerDetail,
  RankTrackerTrend,
  RankTrackerView,
  RankTrackingDevices,
  RankTrackingScheduleInterval,
} from '@/lib/seo/rank/view'
import { errorCode, jsonOrThrow as readOrThrow, type SeoRequestError } from '../api'

// ── Shapes returned by the routes ────────────────────────────────────────

export interface RankLimits {
  max_trackers: number
  max_keywords_per_tracker: number
  max_keywords_per_add: number
  min_depth: number
  max_depth: number
  default_depth: number
  default_devices: RankTrackingDevices
  default_schedule: RankTrackingScheduleInterval
}

/** GET /api/account/seo/rank/trackers. */
export interface TrackerListPayload {
  trackers: RankPaged<RankTrackerView>
  /** The workspace's own site: the new tracker form's default. */
  default_domain: string | null
  /** The server has search data (the page also reads useSeoData). */
  configured: boolean
  limits: RankLimits
}

/** What an add (or a create's keywords) did. */
export interface KeywordsOutcome {
  added: Array<{ id: string; keyword: string }>
  already_tracked: number
  over_cap: number
  rejected: number
}

export interface TrackerSettings {
  devices?: RankTrackingDevices
  serp_depth?: number
  schedule_interval?: RankTrackingScheduleInterval
  paused?: boolean
}

/** The person saw the cost on the button they pressed. Only then. */
export interface Confirmation {
  confirmed?: boolean
}

export interface NewTrackerInput extends Confirmation {
  domain?: string
  location_code?: number
  language_code?: string
  devices?: RankTrackingDevices
  schedule_interval?: RankTrackingScheduleInterval
  keywords?: string[]
}

export interface TrackerChangeEstimate {
  before: RankEstimateView
  after: RankEstimateView
  raises_cost: boolean
}

// ── Errors ───────────────────────────────────────────────────────────────

const send = (method: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }

/** Codes that mean search data can't be bought here at all. */
export const DATA_OFF_CODES: ReadonlySet<string> = SEO_DATA_OFF_CODES

/** The live check a 409 ALREADY_RUNNING carries, or null. */
export function runningCheckOf(err: unknown): RankRunView | null {
  if (errorCode(err) !== 'ALREADY_RUNNING') return null
  const run = (err as SeoRequestError).apiError.details?.run
  return run && typeof run === 'object' && typeof (run as { id?: unknown }).id === 'string' ? (run as RankRunView) : null
}

/**
 * What a 409 NEEDS_GO_AHEAD carries: the cost with the change (and before
 * it, for a saved tracker), or null for any other error.
 */
export function goAheadOf(err: unknown): { estimate: RankEstimateView; previous: RankEstimateView | null } | null {
  if (errorCode(err) !== 'NEEDS_GO_AHEAD') return null
  const details = (err as SeoRequestError).apiError.details
  const isEstimate = (v: unknown): v is RankEstimateView => !!v && typeof v === 'object' && typeof (v as { per_check_usd?: unknown }).per_check_usd === 'number'
  const estimate = details?.estimate
  const previous = details?.previous_estimate
  if (!isEstimate(estimate)) return null
  return { estimate, previous: isEstimate(previous) ? previous : null }
}

/** The tracker a 409 DUPLICATE_TRACKER names, or null. */
export function duplicateTrackerOf(err: unknown): string | null {
  if (errorCode(err) !== 'DUPLICATE_TRACKER') return null
  const id = (err as SeoRequestError).apiError.details?.tracker_id
  return typeof id === 'string' ? id : null
}

// ── Trackers ─────────────────────────────────────────────────────────────

const BASE = '/api/account/seo/rank'

const paged = (offset?: number, limit?: number) => {
  const qs = new URLSearchParams()
  if (offset) qs.set('offset', String(offset))
  if (limit) qs.set('limit', String(limit))
  const q = qs.toString()
  return q ? `?${q}` : ''
}

export async function fetchTrackers(offset?: number): Promise<TrackerListPayload> {
  return readOrThrow<TrackerListPayload>(await fetch(`${BASE}/trackers${paged(offset)}`))
}

/** Set a tracker up. Free: it starts no check. */
export async function createTracker(input: NewTrackerInput): Promise<{ tracker: RankTrackerView; keywords: KeywordsOutcome }> {
  return readOrThrow(await fetch(`${BASE}/trackers`, send('POST', input)))
}

export async function fetchTracker(id: string): Promise<RankTrackerDetail> {
  return readOrThrow<RankTrackerDetail>(await fetch(`${BASE}/trackers/${id}`))
}

export async function updateTracker(id: string, settings: TrackerSettings & Confirmation): Promise<RankTrackerView> {
  const data = await readOrThrow<{ tracker: RankTrackerView }>(await fetch(`${BASE}/trackers/${id}`, send('PATCH', settings)))
  return data.tracker
}

export async function deleteTracker(id: string): Promise<void> {
  await readOrThrow<{ deleted: boolean }>(await fetch(`${BASE}/trackers/${id}`, send('DELETE')))
}

// ── Keywords ─────────────────────────────────────────────────────────────

export async function fetchKeywords(id: string, offset?: number): Promise<RankPaged<RankKeywordRow>> {
  return readOrThrow<RankPaged<RankKeywordRow>>(await fetch(`${BASE}/trackers/${id}/keywords${paged(offset)}`))
}

export async function addKeywords(id: string, keywords: string[], opts: Confirmation = {}): Promise<KeywordsOutcome> {
  return readOrThrow<KeywordsOutcome>(await fetch(`${BASE}/trackers/${id}/keywords`, send('POST', { keywords, ...(opts.confirmed ? { confirmed: true } : {}) })))
}

export async function removeKeywords(id: string, keywordIds: string[]): Promise<{ removed: number }> {
  return readOrThrow(await fetch(`${BASE}/trackers/${id}/keywords`, send('DELETE', { keyword_ids: keywordIds })))
}

export async function pinKeywords(id: string, keywordIds: string[], pinned: boolean): Promise<{ updated: number }> {
  return readOrThrow(await fetch(`${BASE}/trackers/${id}/keywords`, send('PATCH', { keyword_ids: keywordIds, pinned })))
}

// ── Checks ───────────────────────────────────────────────────────────────

export async function fetchRuns(id: string, offset?: number): Promise<RankPaged<RankRunView>> {
  return readOrThrow<RankPaged<RankRunView>>(await fetch(`${BASE}/trackers/${id}/runs${paged(offset)}`))
}

/**
 * Start a check of every keyword now. THE ONE CALL THAT SPENDS NOW. A second
 * start while one runs throws ALREADY_RUNNING carrying the live check
 * (runningCheckOf); one above the confirmation line without `confirmed`
 * throws NEEDS_GO_AHEAD (goAheadOf).
 */
export async function startCheck(id: string, opts: Confirmation = {}): Promise<RankRunView> {
  const data = await readOrThrow<{ run: RankRunView }>(await fetch(`${BASE}/trackers/${id}/runs`, send('POST', opts.confirmed ? { confirmed: true } : undefined)))
  return data.run
}

/** One check: the poll target. */
export async function fetchRun(runId: string): Promise<RankRunView> {
  const data = await readOrThrow<{ run: RankRunView }>(await fetch(`${BASE}/runs/${runId}`))
  return data.run
}

/** Stop a queued or running check. */
export async function stopCheck(runId: string): Promise<RankRunView> {
  const data = await readOrThrow<{ run: RankRunView }>(await fetch(`${BASE}/runs/${runId}`, send('POST')))
  return data.run
}

// ── History ──────────────────────────────────────────────────────────────

export async function fetchTrend(id: string, days?: number): Promise<RankTrackerTrend[]> {
  const q = days ? `?days=${days}` : ''
  const data = await readOrThrow<{ trend: RankTrackerTrend[] }>(await fetch(`${BASE}/trackers/${id}/history${q}`))
  return data.trend
}

export async function fetchKeywordHistory(id: string, keywordId: string, days?: number): Promise<RankKeywordHistory> {
  const qs = new URLSearchParams({ keyword_id: keywordId })
  if (days) qs.set('days', String(days))
  const data = await readOrThrow<{ history: RankKeywordHistory }>(await fetch(`${BASE}/trackers/${id}/history?${qs.toString()}`))
  return data.history
}

// ── Estimates (free maths) ───────────────────────────────────────────────

/** A tracker not saved yet: what a check costs at most, and a month of them on the schedule. */
export async function estimateDraft(input: {
  keywords: string[]
  language_code?: string
  devices?: RankTrackingDevices
  schedule_interval?: RankTrackingScheduleInterval
}): Promise<RankEstimateView> {
  const data = await readOrThrow<{ estimate: RankEstimateView }>(await fetch(`${BASE}/estimate`, send('POST', input)))
  return data.estimate
}

/** A saved tracker as it is (`before`) and with a change (`after`). */
export async function estimateChange(
  trackerId: string,
  change: TrackerSettings & { add_keywords?: string[] } = {},
): Promise<TrackerChangeEstimate> {
  return readOrThrow<TrackerChangeEstimate>(await fetch(`${BASE}/estimate`, send('POST', { tracker_id: trackerId, ...change })))
}

// ── Markets ──────────────────────────────────────────────────────────────

let markets: Promise<SeoMarketOptions> | null = null

/** The countries and languages (a static list, the same for everyone), read once per page load. */
export function fetchMarkets(): Promise<SeoMarketOptions> {
  if (!markets) {
    markets = fetch('/api/account/seo/locations')
      .then((res) => readOrThrow<SeoMarketOptions>(res))
      .catch((err) => {
        markets = null
        throw err
      })
  }
  return markets
}

/** For tests: forget the markets read. */
export function resetMarketsForTests(): void {
  markets = null
}
