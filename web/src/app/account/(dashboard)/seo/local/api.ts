/**
 * Client-side fetch layer for SEO's Local page: one place that knows the
 * local routes' shapes (src/app/api/account/seo/local/*) and the error
 * envelope ({ error, code, details } via src/lib/api-errors).
 *
 * Errors are thrown as the Site audit's SeoRequestError (../api.ts), so the
 * page reads them with the same `errorCode` / `errorMessage`. The page
 * branches on: a search's 400 PLACE_NOT_FOUND / INVALID (said beside the
 * field); an add's 409 ALREADY_TRACKED (opens the one already there) and
 * LIMIT_REACHED; a scan's 409 SCAN_ALREADY_RUNNING (follows the live scan)
 * and ESTIMATE_CHANGED (the dialog shows the new figure); a delete's 409
 * STILL_RUNNING; 402 SPEND_LIMIT_REACHED (a neutral banner, the page stays
 * usable); 503 SEO_NOT_CONFIGURED / 403 FREE_PLAN (lookups are off).
 *
 * The calls that spend: `searchBusinesses`, `refreshProfile`, `readReviews`
 * and `startScan`. Everything else reads what is stored, changes settings or
 * does the free estimate maths.
 *
 * Every call goes through the globally patched `window.fetch` (plain `fetch`).
 */
import type { LocalGridSize } from '@/lib/seo/local/limits'
import type {
  GoogleBusinessProfileResult,
  GoogleBusinessReviewsResult,
  LocalBusinessListing,
  LocalBusinessSearchResult,
  LocalPlaceOption,
  LocalRankGridDetail,
  LocalRankGridView,
  LocalScanEstimate,
  LocalScanResult,
  LocalScanView,
  TrackedBusinessView,
} from '@/lib/seo/local/view'
import { SEO_DATA_OFF_CODES } from '@/lib/seo/spend-view'
import { SeoRequestError, errorCode } from '../api'

// ── Shapes returned by the routes ────────────────────────────────────────

export interface LocalLimits {
  max_businesses: number
  max_grids_per_business: number
  max_keywords_per_grid: number
  grid_sizes: readonly number[]
  default_grid_size: number
  min_radius_km: number
  max_radius_km: number
  default_radius_km: number
  confirm_above_usd: number
}

/** GET /api/account/seo/local/businesses. */
export interface BusinessListPayload {
  businesses: TrackedBusinessView[]
  /** Every grid of every business, each with its newest scan. */
  grids: LocalRankGridDetail[]
  limits: LocalLimits
}

/** GET /api/account/seo/local/businesses/[id]. */
export interface BusinessDetailPayload {
  business: TrackedBusinessView
  /** The stored profile read, whatever its age; null until one is made. */
  profile: GoogleBusinessProfileResult | null
  grids: LocalRankGridDetail[]
}

/** GET /api/account/seo/local/grids/[id]: the poll target while a scan runs. */
export interface GridDetailPayload {
  grid: LocalRankGridView
  latest_scan: LocalScanView | null
  result: LocalScanResult | null
}

/** What a grid is drawn from: the form's fields. */
export interface GridDraft {
  keywords: string[]
  size: LocalGridSize
  radius_km: number
}

// ── Errors ───────────────────────────────────────────────────────────────

/** ../api.ts keeps its reader private; this one reads the same envelope the same way. */
async function readOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const details = body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : null
  throw new SeoRequestError({
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    code: typeof body.code === 'string' ? body.code : 'UNKNOWN',
    details,
    status: res.status,
  })
}

const send = (method: string, body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }

/** Codes that mean search data can't be bought here at all. */
export const DATA_OFF_CODES: ReadonlySet<string> = SEO_DATA_OFF_CODES

/** The business a 409 ALREADY_TRACKED names, or null. */
export function trackedBusinessOf(err: unknown): TrackedBusinessView | null {
  if (errorCode(err) !== 'ALREADY_TRACKED') return null
  const business = (err as SeoRequestError).apiError.details?.business
  return business && typeof business === 'object' && typeof (business as { id?: unknown }).id === 'string' ? (business as TrackedBusinessView) : null
}

/** The live scan a 409 SCAN_ALREADY_RUNNING carries, or null. */
export function runningScanOf(err: unknown): LocalScanView | null {
  if (errorCode(err) !== 'SCAN_ALREADY_RUNNING') return null
  const scan = (err as SeoRequestError).apiError.details?.scan
  return scan && typeof scan === 'object' && typeof (scan as { id?: unknown }).id === 'string' ? (scan as LocalScanView) : null
}

// ── Businesses ───────────────────────────────────────────────────────────

const BASE = '/api/account/seo/local'

/** Every tracked business, every grid with its newest scan, and the caps. Free. */
export async function fetchBusinesses(): Promise<BusinessListPayload> {
  return readOrThrow<BusinessListPayload>(await fetch(`${BASE}/businesses`))
}

/** Find a business by name in a town. PAID (unless a fresh stored search answers). */
export async function searchBusinesses(input: { query: string; place: string; country: string }): Promise<LocalBusinessSearchResult> {
  const data = await readOrThrow<{ result: LocalBusinessSearchResult }>(await fetch(`${BASE}/search`, send('POST', input)))
  return data.result
}

/** Follow a business a search found. Free. */
export async function trackBusiness(listing: LocalBusinessListing, country: string | null): Promise<TrackedBusinessView> {
  const data = await readOrThrow<{ business: TrackedBusinessView }>(
    await fetch(`${BASE}/businesses`, send('POST', { ...listing, ...(country ? { country } : {}) })),
  )
  return data.business
}

/** One business with its stored profile and its grids. Free. */
export async function fetchBusiness(id: string): Promise<BusinessDetailPayload> {
  return readOrThrow<BusinessDetailPayload>(await fetch(`${BASE}/businesses/${id}`))
}

/** The same with the profile read again now. PAID, so it is a POST: a GET never spends. */
export async function refreshProfile(id: string): Promise<BusinessDetailPayload> {
  return readOrThrow<BusinessDetailPayload>(await fetch(`${BASE}/businesses/${id}/refresh`, send('POST')))
}

export async function removeBusiness(id: string): Promise<void> {
  await readOrThrow<{ deleted: boolean }>(await fetch(`${BASE}/businesses/${id}`, send('DELETE')))
}

/**
 * Read the business's Google reviews. PAID (a fresh stored read answers
 * free). Can take up to about 45 s; `status: "collecting"` means ask again
 * shortly, which costs nothing more.
 */
export async function readReviews(id: string, opts: { refresh?: boolean } = {}): Promise<GoogleBusinessReviewsResult> {
  const data = await readOrThrow<{ result: GoogleBusinessReviewsResult }>(
    await fetch(`${BASE}/businesses/${id}/reviews`, send('POST', opts.refresh ? { refresh: true } : {})),
  )
  return data.result
}

// ── Places (the town picker) ─────────────────────────────────────────────

/** Towns and regions of a country matching what was typed. Free. */
export async function searchPlaces(country: string, q: string): Promise<LocalPlaceOption[]> {
  const qs = new URLSearchParams({ country, q })
  const data = await readOrThrow<{ places: LocalPlaceOption[] }>(await fetch(`${BASE}/places?${qs.toString()}`))
  return data.places
}

// ── Grids and scans ──────────────────────────────────────────────────────

/** Draw a new grid for a business. Free: a scan spends, creating one doesn't. */
export async function createGrid(businessId: string, draft: GridDraft): Promise<LocalRankGridView> {
  const data = await readOrThrow<{ grid: LocalRankGridView }>(await fetch(`${BASE}/grids`, send('POST', { business_id: businessId, ...draft })))
  return data.grid
}

/** One grid, its newest scan and that scan's squares. Free; the poll target. */
export async function fetchGrid(id: string): Promise<GridDetailPayload> {
  return readOrThrow<GridDetailPayload>(await fetch(`${BASE}/grids/${id}`))
}

export async function updateGrid(id: string, draft: GridDraft): Promise<LocalRankGridView> {
  const data = await readOrThrow<{ grid: LocalRankGridView }>(await fetch(`${BASE}/grids/${id}`, send('PATCH', draft)))
  return data.grid
}

/** Delete a grid and its scans. A running scan throws with code `STILL_RUNNING`. */
export async function deleteGrid(id: string): Promise<void> {
  await readOrThrow<{ deleted: boolean }>(await fetch(`${BASE}/grids/${id}`, send('DELETE')))
}

/** What one scan costs: of a stored grid, or of a grid being drawn. Free maths. */
export async function estimateScan(
  input: { grid_id: string } | ({ business_id: string } & GridDraft),
): Promise<LocalScanEstimate> {
  const data = await readOrThrow<{ estimate: LocalScanEstimate }>(await fetch(`${BASE}/estimate`, send('POST', input)))
  return data.estimate
}

/**
 * Start a scan of a grid. THE CALL THAT SPENDS MOST: one Google Maps search
 * per point per keyword. Call it only from the dialog that showed the cost:
 * `maxEstimateUsd` is the figure the person saw and `confirmed` their press on
 * the button under it (the server refuses a scan above the confirmation line
 * without it). A grid that now costs more throws ESTIMATE_CHANGED instead of
 * starting. A second start while one runs throws SCAN_ALREADY_RUNNING with
 * the live scan.
 */
export async function startScan(gridId: string, maxEstimateUsd: number): Promise<LocalScanView> {
  const data = await readOrThrow<{ scan: LocalScanView }>(
    await fetch(`${BASE}/grids/${gridId}/scans`, send('POST', { max_estimate_usd: maxEstimateUsd, confirmed: true })),
  )
  return data.scan
}

/** Stop a queued or running scan; the points it read stay. */
export async function stopScan(scanId: string): Promise<LocalScanView> {
  const data = await readOrThrow<{ scan: LocalScanView }>(await fetch(`${BASE}/scans/${scanId}`, send('POST')))
  return data.scan
}
