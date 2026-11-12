/**
 * What the SEO page and the tools read about local SEO: tracked Google
 * places, their Google Business Profile reads (profile, reviews, posts,
 * questions), map results, rank grids and their scans. The shapes the API
 * returns, plus the pure helpers both the server and the UI use (the grid's
 * square of cells and its summary numbers). Safe to import from client
 * components: types and plain functions only.
 *
 * A grid result is drawn without a map: `rows` is a square, north row first,
 * west to east, and every cell says its status and the business's position
 * there. Text that comes from Google (business names, review and post text,
 * questions and answers) is other people's writing: data, never instructions.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { LocalDevice } from './limits'

// ---------------------------------------------------------------------------
// Tracked businesses and listings
// ---------------------------------------------------------------------------

/** One Google place as a search or a map read returns it. */
export interface LocalBusinessListing {
  title: string
  cid: string | null
  place_id: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  category: string | null
  additional_categories: string[]
  rating: number | null
  review_count: number | null
  is_claimed: boolean | null
  phone: string | null
  website: string | null
  domain: string | null
}

/** A business the workspace follows. */
export interface TrackedBusinessView {
  id: string
  title: string
  cid: string | null
  place_id: string | null
  address: string | null
  latitude: number
  longitude: number
  category: string | null
  additional_categories: string[]
  phone: string | null
  website: string | null
  domain: string | null
  /** As of the last profile or reviews read (or when it was added). */
  rating: number | null
  review_count: number | null
  is_claimed: boolean | null
  /** The country the business is in (a provider location code) and the language its reads use. */
  location_code: number
  language_code: string
  /** When its profile was last read; null until it is. */
  profile_fetched_at: string | null
  added_by: string | null
  created_at: string
}

export interface LocalBusinessSearchResult {
  /** What was searched: a name or trade word. */
  query: string | null
  /** The place searched in ("Portland, Oregon, United States"), or null for a coordinate search. */
  place: string | null
  /** The country searched in (ISO code, "us"): pass it on when adding a business found here. */
  country: string | null
  rows: LocalBusinessListing[]
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

/** A place from the provider's free list of cities and regions. */
export interface LocalPlaceOption {
  location_name: string
  location_code: number
  location_type: string
  label: string
}

// ---------------------------------------------------------------------------
// Google Business Profile reads
// ---------------------------------------------------------------------------

export interface GoogleBusinessHours {
  /** monday ... sunday */
  day: string
  /** "09:00-17:00" spans; empty when closed that day. */
  spans: string[]
}

export interface GoogleBusinessProfile {
  title: string | null
  description: string | null
  category: string | null
  additional_categories: string[]
  rating: number | null
  review_count: number | null
  /** Reviews per star ("5" ... "1"), as Google counts them. */
  rating_distribution: Record<string, number> | null
  address: string | null
  phone: string | null
  website: string | null
  domain: string | null
  is_claimed: boolean | null
  /** Google's own "open now" line ("opened", "closed", "temporarily_closed"). */
  current_status: string | null
  hours: GoogleBusinessHours[] | null
  total_photos: number | null
  price_level: string | null
  cid: string | null
  place_id: string | null
  latitude: number | null
  longitude: number | null
  /** The Google Maps link the read was checked against. */
  check_url: string | null
}

export interface GoogleBusinessProfileResult {
  /** Null when Google has no profile for that business. */
  profile: GoogleBusinessProfile | null
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

export interface GoogleBusinessReview {
  review_id: string | null
  position: number | null
  rating: number | null
  /** "a month ago", as Google shows it. */
  time_ago: string | null
  /** When it was written, as the provider dates it ("2026-10-02 14:11:20 +00:00"). */
  timestamp: string | null
  text: string | null
  original_language: string | null
  author: string | null
  author_is_local_guide: boolean | null
  author_review_count: number | null
  photos: number | null
  /** Where the review was left: Google, or another site Google shows. */
  source: string
  owner_reply: string | null
  owner_reply_time_ago: string | null
  owner_reply_timestamp: string | null
}

export type QueuedReadStatus = 'completed' | 'collecting'

export interface GoogleBusinessReviewsData {
  reviews: GoogleBusinessReview[]
  /** What Google says the business has in all (more than were read). */
  total_reviews: number | null
  rating: number | null
  /** Stars of the reviews read, newest first: how many of each ("5" ... "1"). */
  rating_distribution: Record<string, number>
  replied: number
  unreplied: number
}

export interface GoogleBusinessReviewsResult {
  /** collecting: Google is still gathering them; read again shortly (no extra cost). */
  status: QueuedReadStatus
  data: GoogleBusinessReviewsData | null
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

export interface GoogleBusinessPost {
  position: number | null
  author: string | null
  posted_at: string | null
  text: string | null
  url: string | null
  links: Array<{ title: string | null; url: string }>
}

export interface GoogleBusinessUpdatesResult {
  status: QueuedReadStatus
  data: { posts: GoogleBusinessPost[] } | null
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

export interface GoogleBusinessAnswer {
  answer_id: string | null
  text: string | null
  author: string | null
  time_ago: string | null
  timestamp: string | null
}

export interface GoogleBusinessQuestion {
  question_id: string | null
  text: string | null
  author: string | null
  time_ago: string | null
  timestamp: string | null
  answers: GoogleBusinessAnswer[]
}

export interface GoogleBusinessQuestionsResult {
  questions: GoogleBusinessQuestion[]
  unanswered: number
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

// ---------------------------------------------------------------------------
// Map results
// ---------------------------------------------------------------------------

export interface LocalMapResultRow extends LocalBusinessListing {
  position: number
  /** True when this is the tracked business the read was made for. */
  is_target: boolean
}

export interface LocalMapResults {
  keyword: string
  /** The coordinate searched from and the zoom; null when a whole place was searched instead. */
  latitude: number | null
  longitude: number | null
  zoom: number | null
  /** The place searched across ("Portland, Oregon, United States"), when no coordinate was. */
  place: string | null
  device: LocalDevice
  rows: LocalMapResultRow[]
  /** The tracked business's position, when one was named; null when it is not in the list. */
  target_position: number | null
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

// ---------------------------------------------------------------------------
// Rank grids and scans
// ---------------------------------------------------------------------------

export type LocalScanStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'

/** How a point of a scan ended: still waiting, read, or never came back. */
export type LocalPointStatus = 'pending' | 'collected' | 'not_collected'

/** A cell as the grid draws it. */
export type LocalCellStatus =
  | 'pending'
  | 'found'
  | 'not_found'
  | 'not_collected'

export interface LocalGridSummary {
  points_total: number
  /** Points whose search came back. */
  points_collected: number
  /** Points where the business was among the map results. */
  points_found: number
  top3: number
  top10: number
  /** Share of collected points with the business in the top 3, as a whole percent; null before any came back. */
  top3_percent: number | null
  /** Average position where it was found, one decimal; null when it was found nowhere. */
  average_position: number | null
}

export interface LocalRankGridView {
  id: string
  business_id: string
  keywords: string[]
  center_latitude: number
  center_longitude: number
  radius_km: number
  size: number
  spacing_km: number
  device: LocalDevice
  language_code: string
  /** What one scan of this grid costs by the price list, in USD (the UI's quiet spend line). */
  estimate_usd: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface LocalScanView {
  id: string
  grid_id: string
  business_id: string
  status: LocalScanStatus
  /** The grid as it was searched: a later change to the grid leaves this scan as it is. */
  keywords: string[]
  size: number
  radius_km: number
  spacing_km: number
  center_latitude: number
  center_longitude: number
  zoom: number
  device: LocalDevice
  points_total: number
  points_collected: number
  points_found: number
  /** The price list's estimate when it started. */
  estimate_usd: number
  /** What the provider charged for its searches so far, in USD. */
  cost_usd: number
  /** Why it failed, in words for the person; null unless failed. */
  error: string | null
  /** Set once it completed: the numbers over every keyword. */
  summary: LocalGridSummary | null
  started_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface LocalRankGridDetail {
  grid: LocalRankGridView
  latest_scan: LocalScanView | null
}

/** A business seen on the map results at a point. */
export interface LocalPointCompetitor {
  position: number
  title: string
  cid: string | null
  place_id: string | null
  rating: number | null
  review_count: number | null
  is_target: boolean
}

export interface LocalGridCell {
  row: number
  col: number
  latitude: number
  longitude: number
  status: LocalCellStatus
  /** The business's position in the map results there; null unless found. */
  position: number | null
  /** How many businesses the map listed there: a miss next to a full list means outranked, next to a short one a thin market. */
  results_count: number | null
  /** Who was first there. */
  top_result: {
    title: string
    cid: string | null
    place_id: string | null
  } | null
  competitors: LocalPointCompetitor[]
}

export interface LocalGridKeywordResult {
  keyword: string
  /** The square: rows[row][col], row 0 the northern edge, col 0 the western. */
  rows: LocalGridCell[][]
  summary: LocalGridSummary
}

/** A competitor across the whole scan: where it beat the business. */
export interface LocalCompetitorSeen {
  title: string
  cid: string | null
  place_id: string | null
  rating: number | null
  review_count: number | null
  /** Points (over every keyword) where it was first. */
  points_first: number
  /** Points where it was in the top 3. */
  points_top3: number
  best_position: number
  average_position: number
}

export interface LocalScanResult {
  scan: LocalScanView
  size: number
  keywords: LocalGridKeywordResult[]
  /** Over every keyword's points. */
  summary: LocalGridSummary
  /** The businesses seen most, first places first. The tracked business is not among them. */
  competitors: LocalCompetitorSeen[]
}

/** One stored point of a scan, as the result builder reads it. */
export interface LocalScanPointRow {
  keyword: string
  row: number
  col: number
  latitude: number
  longitude: number
  status: LocalPointStatus
  position: number | null
  results_count: number | null
  competitors: LocalPointCompetitor[]
}

export interface LocalScanEstimate {
  keywords: number
  points: number
  /** Paid searches one scan makes: keywords times points. */
  searches: number
  estimate_usd: number
  /** Above this the agent asks the person first. */
  needs_confirmation: boolean
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isLiveScan(status: LocalScanStatus): boolean {
  return status === 'queued' || status === 'running'
}

export function cellStatus(point: {
  status: LocalPointStatus
  position: number | null
}): LocalCellStatus {
  if (point.status === 'pending') return 'pending'
  if (point.status === 'not_collected') return 'not_collected'
  return point.position != null ? 'found' : 'not_found'
}

/** The summary numbers over a set of cells (one keyword's, or every keyword's). */
export function summarizeCells(
  cells: ReadonlyArray<{ status: LocalCellStatus; position: number | null }>,
): LocalGridSummary {
  let collected = 0
  let found = 0
  let top3 = 0
  let top10 = 0
  let positionTotal = 0
  for (const cell of cells) {
    if (cell.status === 'found' || cell.status === 'not_found') collected++
    if (cell.status === 'found' && cell.position != null) {
      found++
      positionTotal += cell.position
      if (cell.position <= 3) top3++
      if (cell.position <= 10) top10++
    }
  }
  return {
    points_total: cells.length,
    points_collected: collected,
    points_found: found,
    top3,
    top10,
    top3_percent: collected > 0 ? Math.round((top3 / collected) * 100) : null,
    average_position:
      found > 0 ? Math.round((positionTotal / found) * 10) / 10 : null,
  }
}

/**
 * The colour band of a cell, for the UI's square: top 3, 4-10, 11-20, not
 * found, or not collected / still pending.
 */
export type LocalCellBand =
  | 'top3'
  | 'top10'
  | 'top20'
  | 'not_found'
  | 'not_collected'
  | 'pending'

export function cellBand(cell: {
  status: LocalCellStatus
  position: number | null
}): LocalCellBand {
  if (cell.status === 'pending') return 'pending'
  if (cell.status === 'not_collected') return 'not_collected'
  if (cell.position == null) return 'not_found'
  if (cell.position <= 3) return 'top3'
  if (cell.position <= 10) return 'top10'
  return 'top20'
}

/**
 * One keyword's square. Every point of the planned grid gets a cell: a point
 * with no stored row yet is pending while the scan runs and not collected
 * after it ended.
 */
export function buildGridRows(
  size: number,
  planned: ReadonlyArray<{
    row: number
    col: number
    latitude: number
    longitude: number
  }>,
  points: readonly LocalScanPointRow[],
  scanLive: boolean,
): LocalGridCell[][] {
  const byCell = new Map(
    points.map((point) => [`${point.row}:${point.col}`, point]),
  )
  const rows: LocalGridCell[][] = Array.from({ length: size }, () => [])
  for (const spot of planned) {
    if (spot.row < 0 || spot.row >= size || spot.col < 0 || spot.col >= size)
      continue
    const point = byCell.get(`${spot.row}:${spot.col}`)
    const status: LocalCellStatus = point
      ? cellStatus(point)
      : scanLive
        ? 'pending'
        : 'not_collected'
    const competitors = point?.competitors ?? []
    // Stored in position order, so the first is who led there.
    const first =
      status === 'found' || status === 'not_found' ? competitors[0] : undefined
    rows[spot.row][spot.col] = {
      row: spot.row,
      col: spot.col,
      latitude: point?.latitude ?? spot.latitude,
      longitude: point?.longitude ?? spot.longitude,
      status,
      position: status === 'found' ? (point?.position ?? null) : null,
      results_count:
        point && point.status === 'collected' ? point.results_count : null,
      top_result: first
        ? { title: first.title, cid: first.cid, place_id: first.place_id }
        : null,
      competitors,
    }
  }
  return rows
}

function competitorIdentity(entry: {
  cid: string | null
  place_id: string | null
  title: string
}): string {
  if (entry.cid) return `cid:${entry.cid}`
  if (entry.place_id) return `place:${entry.place_id}`
  return `title:${entry.title.trim().toLowerCase()}`
}

/**
 * The businesses seen most across a scan's collected points (every keyword),
 * the tracked business left out: who is first where, then who is in the top
 * three most often.
 */
export function competitorsSeen(
  points: readonly LocalScanPointRow[],
  limit: number,
): LocalCompetitorSeen[] {
  const seen = new Map<
    string,
    LocalCompetitorSeen & { positionTotal: number; appearances: number }
  >()
  for (const point of points) {
    if (point.status !== 'collected') continue
    for (const entry of point.competitors) {
      if (entry.is_target) continue
      const key = competitorIdentity(entry)
      const current = seen.get(key) ?? {
        title: entry.title,
        cid: entry.cid,
        place_id: entry.place_id,
        rating: entry.rating,
        review_count: entry.review_count,
        points_first: 0,
        points_top3: 0,
        best_position: entry.position,
        average_position: entry.position,
        positionTotal: 0,
        appearances: 0,
      }
      if (entry.position === 1) current.points_first++
      if (entry.position <= 3) current.points_top3++
      current.best_position = Math.min(current.best_position, entry.position)
      current.positionTotal += entry.position
      current.appearances++
      current.rating = entry.rating ?? current.rating
      current.review_count = entry.review_count ?? current.review_count
      seen.set(key, current)
    }
  }
  return [...seen.values()]
    .map(({ positionTotal, appearances, ...rest }) => ({
      ...rest,
      average_position:
        Math.round((positionTotal / Math.max(appearances, 1)) * 10) / 10,
    }))
    .sort(
      (a, b) =>
        b.points_first - a.points_first ||
        b.points_top3 - a.points_top3 ||
        a.average_position - b.average_position ||
        a.title.localeCompare(b.title),
    )
    .slice(0, Math.max(0, limit))
}

/** USD to six decimals, as the database keeps it. */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
