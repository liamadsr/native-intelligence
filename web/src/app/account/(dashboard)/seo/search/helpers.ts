/**
 * The Search performance page's words, numbers and dates, pure, so the views
 * and their tests read the same strings.
 *
 * House style (as ../ui-helpers.ts): sentence case, plural-aware counts, a
 * clause whose number is zero dropped, ` · ` between clauses, no em dashes.
 */
import type {
  AnalyticsReportName,
  GoogleAccountOption,
  GscDateRange,
  MetricChange,
  UrlInspectionRow,
} from '@/lib/seo/google/view'

// ── The period ───────────────────────────────────────────────────────────

/** The header's periods: the backend's presets, in plain words. */
export type SearchPeriod = Extract<GscDateRange, 'last_7_days' | 'last_28_days' | 'last_3_months' | 'last_12_months'>

export const SEARCH_PERIODS: ReadonlyArray<{ value: SearchPeriod; label: string; words: string }> = [
  { value: 'last_7_days', label: '7 days', words: 'the 7 days before' },
  { value: 'last_28_days', label: '28 days', words: 'the 28 days before' },
  { value: 'last_3_months', label: '3 months', words: 'the 3 months before' },
  { value: 'last_12_months', label: '12 months', words: 'the 12 months before' },
]

export const DEFAULT_PERIOD: SearchPeriod = 'last_28_days'

const DAY_MS = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function monthsBack(date: Date, months: number): Date {
  const day = date.getUTCDate()
  const d = new Date(date)
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}

/**
 * A period's dates for a product that takes dates, not presets: Search
 * Console's ends three days ago (its data trails), Analytics' yesterday (the
 * last complete day; the server clamps it to the property's own time zone).
 * Mirrors src/lib/seo/google/dates.ts, which is server code.
 */
export function periodDates(period: SearchPeriod, product: 'search_console' | 'analytics', now: Date = new Date()): { start_date: string; end_date: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (product === 'search_console' ? 3 : 1) * DAY_MS)
  let start: Date
  if (period === 'last_7_days') start = new Date(end.getTime() - 6 * DAY_MS)
  else if (period === 'last_28_days') start = new Date(end.getTime() - 27 * DAY_MS)
  else start = monthsBack(end, period === 'last_3_months' ? 3 : 12)
  return { start_date: iso(start.getTime()), end_date: iso(end.getTime()) }
}

/** "Nov 1 to Nov 28" (UTC dates, as the reports are). */
export function dateSpan(start: string, end: string): string {
  const fmt = (s: string) => {
    const d = new Date(`${s}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
  return `${fmt(start)} to ${fmt(end)}`
}

/** Analytics names a day 20261101: the ISO date, or null. */
export function gaDate(value: unknown): string | null {
  const s = String(value ?? '')
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null
}

/** Every day from start to end, both included. */
export function daysBetween(start: string, end: string): string[] {
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return []
  const out: string[] = []
  for (let t = a; t <= b && out.length < 800; t += DAY_MS) out.push(iso(t))
  return out
}

// ── Numbers ──────────────────────────────────────────────────────────────

/** A 0..1 rate as a percentage: "3.4%", "12%"; "—" for none. */
export function percent(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—'
  const p = rate * 100
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`
}

/** An average position: "4.2"; "—" for none. */
export function position(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—'
  return value.toFixed(1)
}

/** "1,204". */
export function whole(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString()
}

export type ChangeTone = 'up' | 'down' | 'flat'

/**
 * A tile's change against the period before, in plain words and a tone
 * (up = better). Clicks and impressions move by a percentage, the click rate
 * by points, the position by places (a LOWER position is better). Null when
 * there is nothing to say (no previous number).
 */
export function changeNote(kind: 'count' | 'rate' | 'position', change: MetricChange | null | undefined): { note: string; tone: ChangeTone } | null {
  if (!change || change.current == null || change.previous == null) return null
  const abs = change.absolute_change ?? change.current - change.previous
  if (kind === 'count') {
    if (change.previous === 0) return change.current > 0 ? { note: 'New this period', tone: 'up' } : null
    const pct = change.percent_change ?? abs / change.previous
    const shown = Math.round(Math.abs(pct) * 100)
    if (shown === 0) return { note: 'No change', tone: 'flat' }
    return { note: `${pct > 0 ? 'Up' : 'Down'} ${shown.toLocaleString()}%`, tone: pct > 0 ? 'up' : 'down' }
  }
  if (kind === 'rate') {
    const points = abs * 100
    if (Math.abs(points) < 0.05) return { note: 'No change', tone: 'flat' }
    const n = Math.abs(points) >= 10 ? Math.round(Math.abs(points)).toString() : Math.abs(points).toFixed(1)
    return { note: `${points > 0 ? 'Up' : 'Down'} ${n} ${n === '1.0' || n === '1' ? 'point' : 'points'}`, tone: points > 0 ? 'up' : 'down' }
  }
  if (change.current <= 0 || change.previous <= 0) return null
  if (Math.abs(abs) < 0.05) return { note: 'No change', tone: 'flat' }
  const n = Math.abs(abs).toFixed(1)
  // Lower is better: a fall in the number is a climb up the page.
  return abs < 0 ? { note: `${n} ${n === '1.0' ? 'place' : 'places'} higher`, tone: 'up' } : { note: `${n} ${n === '1.0' ? 'place' : 'places'} lower`, tone: 'down' }
}

// ── Sites and accounts ───────────────────────────────────────────────────

/** A Search Console site as people say it: "sc-domain:example.com" → "example.com", "https://www.example.com/" → "www.example.com". */
export function siteLabel(siteUrl: string): string {
  if (siteUrl.startsWith('sc-domain:')) return siteUrl.slice('sc-domain:'.length)
  try {
    const u = new URL(siteUrl)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `${u.host}${path}`
  } catch {
    return siteUrl
  }
}

/** What kind of Search Console property it is, for a title. */
export function siteKind(siteUrl: string): string {
  return siteUrl.startsWith('sc-domain:') ? 'The whole domain, every address on it' : `Addresses starting with ${siteUrl}`
}

/** Whether the connection a source reads through is one of the viewer's own. */
export function isMine(accountId: string | null | undefined, mine: readonly GoogleAccountOption[]): boolean {
  return !!accountId && mine.some((a) => a.account_id === accountId)
}

// ── URL inspection ───────────────────────────────────────────────────────

const FETCH_WORDS: Record<string, string> = {
  SOFT_404: 'Google thinks the page is empty or missing',
  BLOCKED_ROBOTS_TXT: 'robots.txt tells Google not to read it',
  NOT_FOUND: 'The page answered “not found” (404)',
  ACCESS_DENIED: 'The page asked Google to sign in (401)',
  ACCESS_FORBIDDEN: 'The page refused Google (403)',
  SERVER_ERROR: 'The server answered with an error',
  REDIRECT_ERROR: 'Its redirects did not lead to a page',
  BLOCKED_4XX: 'The page answered with an error',
  INTERNAL_CRAWL_ERROR: 'Google could not read it this time',
  INVALID_URL: 'Google could not read the address',
}

const INDEXING_WORDS: Record<string, string> = {
  BLOCKED_BY_META_TAG: 'The page tells search engines not to list it (noindex)',
  BLOCKED_BY_HTTP_HEADER: 'The server tells search engines not to list it (noindex)',
  BLOCKED_BY_ROBOTS_TXT: 'robots.txt tells Google not to read it',
}

/**
 * One inspected page in plain words: whether Google lists it, and why not.
 * Google's own coverage sentence ("Crawled - currently not indexed") is
 * kept, it is already plain; the enum states are said in words.
 */
export function inspectionSummary(row: UrlInspectionRow): { tone: 'ok' | 'bad' | 'neutral'; headline: string; reasons: string[] } {
  if (row.error) return { tone: 'neutral', headline: 'Could not check this page', reasons: [row.error] }
  const reasons: string[] = []
  if (row.coverage_state) reasons.push(row.coverage_state)
  if (row.page_fetch_state && FETCH_WORDS[row.page_fetch_state]) reasons.push(FETCH_WORDS[row.page_fetch_state])
  if (row.indexing_state && INDEXING_WORDS[row.indexing_state] && !reasons.includes(INDEXING_WORDS[row.indexing_state])) reasons.push(INDEXING_WORDS[row.indexing_state])
  if (row.robots_txt_state === 'DISALLOWED' && !reasons.includes(FETCH_WORDS.BLOCKED_ROBOTS_TXT)) reasons.push(FETCH_WORDS.BLOCKED_ROBOTS_TXT)
  if (row.canonical_mismatch && row.google_canonical) reasons.push(`Google treats ${row.google_canonical} as the main copy of this page`)
  if (row.verdict === 'PASS') return { tone: 'ok', headline: 'On Google', reasons }
  if (row.verdict === 'FAIL' || row.verdict === 'PARTIAL') return { tone: 'bad', headline: 'Not on Google', reasons }
  return { tone: 'neutral', headline: 'Google has not listed it', reasons }
}

// ── Google Analytics ─────────────────────────────────────────────────────

/** The reports, in the picker's order, in plain words. */
export const ANALYTICS_REPORT_OPTIONS: ReadonlyArray<{ value: AnalyticsReportName; label: string }> = [
  { value: 'organic_overview', label: 'Overview' },
  { value: 'organic_landing_pages', label: 'Landing pages' },
  { value: 'page_performance', label: 'Pages' },
  { value: 'traffic_acquisition', label: 'Traffic sources' },
  { value: 'key_events', label: 'Key events' },
  { value: 'audience_breakdown', label: 'Audience' },
  { value: 'site_search', label: 'Site search' },
  { value: 'ecommerce_performance', label: 'Ecommerce' },
  { value: 'measurement_health', label: 'Measurement health' },
]

/** What each report shows, one sentence under the picker. */
export const ANALYTICS_REPORT_CAPTION: Record<AnalyticsReportName, string> = {
  organic_overview: 'Visits from search engines, and what those visitors did.',
  organic_landing_pages: 'The pages search visitors arrived on first.',
  page_performance: 'How often each page was viewed.',
  traffic_acquisition: 'Where every visit came from.',
  key_events: 'The actions you count as results, like a sign-up or a purchase.',
  audience_breakdown: 'Who visited: their device, their country, new or returning.',
  site_search: 'What visitors searched for on your own site.',
  ecommerce_performance: 'What sold, and the pages the sales started from.',
  measurement_health: 'Whether Google Analytics is set up to measure what matters.',
}

/** A report's breakdowns in words (ANALYTICS_BREAKDOWNS' values). */
export const BREAKDOWN_LABEL: Record<string, string> = {
  event: 'By event',
  event_and_landing_page: 'By event and page',
  channel_group: 'By channel',
  source_medium: 'By source',
  campaign: 'By campaign',
  item: 'By product',
  landing_page: 'By landing page',
  device: 'By device',
  country: 'By country',
  new_vs_returning: 'New or returning',
}

/** Google's dimension and metric names, as column labels. */
export const COLUMN_LABEL: Record<string, string> = {
  hostName: 'Site',
  landingPage: 'Landing page',
  pagePath: 'Page',
  date: 'Day',
  eventName: 'Event',
  sessionDefaultChannelGroup: 'Channel',
  sessionSourceMedium: 'Source',
  sessionCampaignName: 'Campaign',
  itemName: 'Product',
  itemId: 'Product id',
  searchTerm: 'Search',
  deviceCategory: 'Device',
  country: 'Country',
  newVsReturning: 'Visitor',
  sessions: 'Visits',
  activeUsers: 'People',
  totalUsers: 'People',
  engagedSessions: 'Engaged visits',
  engagementRate: 'Engaged',
  keyEvents: 'Key events',
  sessionKeyEventRate: 'Key event rate',
  transactions: 'Sales',
  purchaseRevenue: 'Revenue',
  screenPageViews: 'Views',
  userEngagementDuration: 'Time on page',
  itemsViewed: 'Viewed',
  itemsAddedToCart: 'Added to cart',
  itemsPurchased: 'Bought',
  itemRevenue: 'Revenue',
  eventCount: 'Searches',
}

/** What a column means, for its title, where the label alone is not plain. */
export const COLUMN_TITLE: Record<string, string> = {
  engagedSessions: 'Visits that lasted over 10 seconds, saw two pages or did a key event',
  engagementRate: 'The share of visits that were engaged',
  keyEvents: 'The actions you count as results (a sign-up, a purchase)',
  sessionKeyEventRate: 'The share of visits with a key event',
  userEngagementDuration: 'Total time the page was in front of visitors',
  sessionDefaultChannelGroup: 'Google’s grouping of where visits came from',
}

/** A column's label: the map's, else Google's name split into words. */
export function columnLabel(name: string): string {
  if (COLUMN_LABEL[name]) return COLUMN_LABEL[name]
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const RATE_METRICS = new Set(['engagementRate', 'sessionKeyEventRate'])
const MONEY_METRICS = new Set(['purchaseRevenue', 'itemRevenue'])

/** One metric's value as drawn: rates as percentages, money in the property's currency, time in minutes. */
export function formatMetric(name: string, value: string | number | null | undefined, currency: string | null = null): string {
  if (value == null || value === '') return '—'
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (RATE_METRICS.has(name)) return percent(n)
  if (MONEY_METRICS.has(name)) {
    try {
      return n.toLocaleString(undefined, currency ? { style: 'currency', currency, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 })
    } catch {
      return Math.round(n).toLocaleString()
    }
  }
  if (name === 'userEngagementDuration') {
    const minutes = Math.round(n / 60)
    if (minutes < 60) return `${minutes.toLocaleString()} min`
    return `${Math.floor(minutes / 60).toLocaleString()} h ${minutes % 60} min`
  }
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

/** Whether a metric is a rate (its change is in points, not a percentage). */
export function isRateMetric(name: string): boolean {
  return RATE_METRICS.has(name)
}

/** Measurement health's issue codes as a checklist line each: what is missing, and what it means. */
export const MEASUREMENT_ISSUE: Record<string, { missing: string; detail: string }> = {
  no_web_stream: { missing: 'No website is sending data', detail: 'Add a web data stream in Google Analytics and put its tag on your site.' },
  enhanced_measurement_disabled: { missing: 'Enhanced measurement is off', detail: 'Turn it on to count scrolls, outbound clicks, downloads and video plays without extra code.' },
  site_search_measurement_disabled: { missing: 'Site search is not measured', detail: 'Turn on site search in enhanced measurement to see what visitors search for.' },
  no_key_events_configured: { missing: 'No key events are set up', detail: 'Mark the actions that matter (a sign-up, a booking, a purchase) as key events.' },
}
