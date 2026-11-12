/**
 * The Local page's words and colours, pure, so the views and their tests
 * read the same strings.
 *
 * House style (../ui-helpers.ts): sentence case, plural-aware counts, a
 * clause whose value is missing or zero dropped, ` · ` between clauses,
 * tabular figures wherever a number is drawn. Every cost shown is a figure
 * the estimate route returned, worded here, never worked out here.
 */
import { LOCAL_RANK_DEPTH } from '@/lib/seo/local/limits'
import {
  isLiveScan,
  type GoogleBusinessHours,
  type GoogleBusinessReview,
  type LocalCellBand,
  type LocalGridCell,
  type LocalGridSummary,
  type LocalRankGridDetail,
  type LocalRankGridView,
  type LocalScanEstimate,
  type LocalScanView,
  type TrackedBusinessView,
} from '@/lib/seo/local/view'
import { count } from '../ui-helpers'

// ── Ratings and businesses ───────────────────────────────────────────────

/** "4.6 ★", or null with no rating. The star is a character, never an icon font. */
export function ratingWords(rating: number | null | undefined): string | null {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return null
  return `${rating.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ★`
}

/** Five star characters for a whole-star rating: filled and empty, so the two can be coloured apart. */
export function starParts(rating: number | null | undefined): { filled: string; empty: string } {
  const n = rating === null || rating === undefined || !Number.isFinite(rating) ? 0 : Math.min(5, Math.max(0, Math.round(rating)))
  return { filled: '★'.repeat(n), empty: '☆'.repeat(5 - n) }
}

/** The index row's second line: "<address> · 4.6 ★ · 128 reviews", what is missing dropped. */
export function businessSubline(b: Pick<TrackedBusinessView, 'address' | 'rating' | 'review_count'>): string {
  return [b.address, ratingWords(b.rating), b.review_count ? count(b.review_count, 'review') : null].filter(Boolean).join(' · ')
}

/** The business page's quiet line: address · rating · reviews · the main category. */
export function businessLine(b: Pick<TrackedBusinessView, 'address' | 'rating' | 'review_count' | 'category'>): string {
  return [b.address, ratingWords(b.rating), b.review_count ? count(b.review_count, 'review') : null, b.category].filter(Boolean).join(' · ')
}

// ── Scans on the index ───────────────────────────────────────────────────

/** A business's grids, from every grid the index read. */
export function gridsOf(grids: readonly LocalRankGridDetail[], businessId: string): LocalRankGridDetail[] {
  return grids.filter((g) => g.grid.business_id === businessId)
}

/** Its live scan, if one of its grids is being scanned. */
export function liveScanOf(grids: readonly LocalRankGridDetail[]): LocalScanView | null {
  return grids.map((g) => g.latest_scan).find((s): s is LocalScanView => !!s && isLiveScan(s.status)) ?? null
}

/** Its newest completed scan with numbers, for the index row's headline. */
export function latestCompletedScan(grids: readonly LocalRankGridDetail[]): LocalScanView | null {
  const done = grids
    .map((g) => g.latest_scan)
    .filter((s): s is LocalScanView => !!s && s.status === 'completed' && !!s.summary)
  done.sort((a, b) => Date.parse(b.completed_at ?? b.created_at) - Date.parse(a.completed_at ?? a.created_at))
  return done[0] ?? null
}

/** "62% in top 3", "average 4.1": a scan's headline as neutral chips, the unknown ones dropped. */
export function scanHeadline(summary: LocalGridSummary | null): string[] {
  if (!summary) return []
  const out: string[] = []
  if (summary.top3_percent !== null) out.push(`${summary.top3_percent}% in top 3`)
  if (summary.average_position !== null) out.push(`average ${formatAverage(summary.average_position)}`)
  return out
}

/** One decimal, dropped when whole: 4.1, 3. */
export function formatAverage(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

// ── Money ────────────────────────────────────────────────────────────────

/** "$0.29", or "less than a cent". */
export function usdWords(usd: number): string {
  if (usd < 0.005) return 'less than a cent'
  return `$${usd.toFixed(2)}`
}

const about = (usd: number) => (usd < 0.005 ? 'less than a cent' : `about ${usdWords(usd)}`)

/** The grid form's live line: "49 searches per keyword · 98 in all · about $0.59 for this scan". */
export function estimateLine(estimate: LocalScanEstimate): string {
  return [
    `${count(estimate.points, 'search', 'searches')} per keyword`,
    estimate.keywords > 1 ? `${estimate.searches.toLocaleString()} in all` : null,
    `${about(estimate.estimate_usd)} for this scan`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The scan dialog's sentence, from the route's numbers. */
export function scanDialogSentence(estimate: LocalScanEstimate): string {
  const where = `Searches Google Maps from ${count(estimate.points, 'point')}`
  const what = estimate.keywords > 1 ? ` for each of ${count(estimate.keywords, 'keyword')}, ${count(estimate.searches, 'search', 'searches')} in all.` : '.'
  return `${where}${what} It costs ${about(estimate.estimate_usd)}, paid for from this workspace’s search data, and usually takes a few minutes.`
}

// ── Grids ────────────────────────────────────────────────────────────────

/** "5×5 points across a 6 km square · mobile". */
export function gridSettingsLine(grid: Pick<LocalRankGridView, 'size' | 'radius_km' | 'device'>): string {
  const across = (grid.radius_km * 2).toLocaleString(undefined, { maximumFractionDigits: 1 })
  return `${grid.size}×${grid.size} points across a ${across} km square · ${grid.device === 'desktop' ? 'desktop' : 'mobile'}`
}

/** The grid changed since this scan searched it (its keywords, size or reach). */
export function gridChangedSince(grid: LocalRankGridView, scan: LocalScanView | null): boolean {
  if (!scan) return false
  return grid.size !== scan.size || grid.radius_km !== scan.radius_km || grid.keywords.join('\n') !== scan.keywords.join('\n')
}

/** The run rail's line for a live scan: "Scanning the map · 31 of 49 points". */
export function scanRailLine(scan: Pick<LocalScanView, 'status' | 'points_total' | 'points_collected' | 'keywords'>): { verb: string; clauses: string[] } {
  if (scan.status === 'queued') return { verb: 'Starting the scan', clauses: [] }
  const unit = scan.keywords.length > 1 ? 'searches' : 'points'
  return {
    verb: 'Scanning the map',
    clauses: scan.points_total > 0 ? [`${scan.points_collected.toLocaleString()} of ${scan.points_total.toLocaleString()} ${unit}`] : [],
  }
}

/** Keywords as typed in the form: one per line (or commas), tidied, each once. */
export function parseKeywords(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[\n,]/)) {
    const k = part.replace(/\s+/g, ' ').trim().toLowerCase()
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

// ── A cell of the square ─────────────────────────────────────────────────

/** What a cell shows: its position, "20+" past the depth read, "–" where not found, nothing otherwise. */
export function cellText(cell: Pick<LocalGridCell, 'status' | 'position'>): string {
  if (cell.status === 'found' && cell.position !== null) return cell.position > LOCAL_RANK_DEPTH ? `${LOCAL_RANK_DEPTH}+` : String(cell.position)
  if (cell.status === 'not_found') return '–'
  return ''
}

/** A cell's `title`: "3 of 20 · top result: Fernhill Rugs". The top result's name is another business's text. */
export function cellTitle(cell: Pick<LocalGridCell, 'status' | 'position' | 'results_count' | 'top_result'>): string {
  if (cell.status === 'pending') return 'Still searching here'
  if (cell.status === 'not_collected') return 'Not collected: this search did not come back'
  const listed = cell.results_count
  const top = cell.top_result?.title ? `top result: ${cell.top_result.title}` : null
  if (cell.status === 'found' && cell.position !== null) {
    const where = listed ? `${cell.position.toLocaleString()} of ${listed.toLocaleString()}` : `Position ${cell.position.toLocaleString()}`
    return [where, cell.position === 1 ? 'first here' : top].filter(Boolean).join(' · ')
  }
  const miss = listed ? `Not among the ${count(listed, 'business', 'businesses')} listed` : 'Not listed here'
  return [miss, top].filter(Boolean).join(' · ')
}

/** Cell colours by band, in the app's status palette with dark pairs. */
export const CELL_TONE: Record<LocalCellBand, string> = {
  top3: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300',
  top10: 'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-300',
  top20: 'border-red-500/30 bg-red-500/10 text-red-700 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-300',
  not_found: 'border-border bg-muted text-muted-foreground',
  not_collected: 'border-dashed border-border bg-transparent text-muted-foreground',
  pending: 'border-border bg-muted/60 text-muted-foreground animate-pulse motion-reduce:animate-none',
}

/** The legend under the square, in band order. */
export const CELL_LEGEND: ReadonlyArray<{ band: LocalCellBand; label: string }> = [
  { band: 'top3', label: 'Top 3' },
  { band: 'top10', label: '4 to 10' },
  { band: 'top20', label: `11 to ${LOCAL_RANK_DEPTH}` },
  { band: 'not_found', label: 'Not found' },
  { band: 'not_collected', label: 'Not collected' },
]

// ── Profile ──────────────────────────────────────────────────────────────

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
const DAY_SHORT: Record<(typeof DAYS)[number], string> = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' }

/** "09:00-17:00" as "9:00–17:00". */
function spanWords(span: string): string {
  return span
    .split('-')
    .map((t) => t.trim().replace(/^0(\d)/, '$1'))
    .join('–')
}

/** A week's hours, runs of days with the same hours folded: [{ days: "Mon–Fri", hours: "9:00–17:00" }, …]. */
export function weeklyHours(hours: readonly GoogleBusinessHours[] | null): Array<{ days: string; hours: string }> {
  if (!hours || hours.length === 0) return []
  const byDay = new Map(hours.map((h) => [h.day.toLowerCase(), h.spans]))
  const rows: Array<{ from: string; to: string; hours: string }> = []
  for (const day of DAYS) {
    if (!byDay.has(day)) continue
    const spans = byDay.get(day) ?? []
    const words = spans.length > 0 ? spans.map(spanWords).join(', ') : 'Closed'
    const last = rows[rows.length - 1]
    const prevDay = DAYS[DAYS.indexOf(day) - 1]
    if (last && last.hours === words && prevDay && DAY_SHORT[prevDay] === last.to) last.to = DAY_SHORT[day]
    else rows.push({ from: DAY_SHORT[day], to: DAY_SHORT[day], hours: words })
  }
  return rows.map((r) => ({ days: r.from === r.to ? r.from : `${r.from}–${r.to}`, hours: r.hours }))
}

/** Stars by count, 5 down to 1, each with its share of the whole (0 to 1). */
export function ratingBars(distribution: Record<string, number> | null): Array<{ stars: number; count: number; share: number }> {
  if (!distribution) return []
  const rows = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: Math.max(0, Number(distribution[String(stars)] ?? 0) || 0) }))
  const total = rows.reduce((sum, r) => sum + r.count, 0)
  if (total === 0) return []
  return rows.map((r) => ({ ...r, share: r.count / total }))
}

// ── Reviews ──────────────────────────────────────────────────────────────

export type ReviewFilter = 'all' | 'unreplied' | 'low'

export const REVIEW_FILTERS: ReadonlyArray<{ value: ReviewFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unreplied', label: 'Without a reply' },
  { value: 'low', label: '1 to 3 stars' },
]

/** The reviews read, narrowed on the page (the route has no filter). */
export function filterReviews(reviews: readonly GoogleBusinessReview[], filter: ReviewFilter): GoogleBusinessReview[] {
  if (filter === 'unreplied') return reviews.filter((r) => !r.owner_reply)
  if (filter === 'low') return reviews.filter((r) => r.rating !== null && r.rating <= 3)
  return [...reviews]
}

/** "20 newest of 128 reviews · 12 without a reply", or "20 reviews · …" when every one was read. */
export function reviewsLine(read: number, total: number | null, unreplied: number): string {
  const head = total !== null && total > read ? `${read.toLocaleString()} newest of ${count(total, 'review')}` : count(read, 'review')
  return [head, unreplied > 0 ? `${unreplied.toLocaleString()} without a reply` : null].filter(Boolean).join(' · ')
}

/** A link out only for an http(s) address (text from Google is never trusted as a link of another kind). */
export function httpUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}
