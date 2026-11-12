/**
 * What the SEO page and the tools read about Google Search Console and
 * Google Analytics: the shapes the API returns, and the fixed choices a
 * request may make. Safe to import from client components (types, constants
 * and plain functions only, nothing of the server's).
 *
 * Every read asks Google at the time (nothing of Google's reports is stored)
 * and costs nothing.
 */

export type GoogleProduct = 'search_console' | 'analytics'

export const GOOGLE_PRODUCT_LABEL: Record<GoogleProduct, string> = {
  search_console: 'Search Console',
  analytics: 'Google Analytics',
}

/**
 * Why a Google read or choice failed, in codes a person can act on:
 *
 *   NOT_CONNECTED     nobody here connected the product (the caller has no
 *                     connection of their own): connect it first.
 *   NO_SOURCE         connected, but the workspace has not chosen a site
 *                     (Search Console) or property (Analytics) yet.
 *   RECONNECT_NEEDED  the connection the reads go through is gone, switched
 *                     off, refused by Google (a 401, a revoked grant) or
 *                     missing the scope: `reconnect_by` names who signs in
 *                     again.
 *   NO_ACCESS         the account cannot read that site or property (a 403
 *                     or 404 from Google, an unverified site).
 *   QUOTA             Google's quota for the property is spent for now.
 *   UPSTREAM          Google did not answer, answered something we could
 *                     not read, or the API is not enabled for this app.
 *   INVALID_REQUEST   the request itself is wrong (dates, dimensions, a
 *                     report this property cannot run).
 */
export const GOOGLE_SEO_ERROR_CODES = [
  'NOT_CONNECTED',
  'NO_SOURCE',
  'RECONNECT_NEEDED',
  'NO_ACCESS',
  'QUOTA',
  'UPSTREAM',
  'INVALID_REQUEST',
] as const
export type GoogleSeoErrorCode = (typeof GOOGLE_SEO_ERROR_CODES)[number]

/** A failure as a route answers it: `{ error, code, details? }` with these details. */
export interface GoogleSeoErrorDetails {
  product: GoogleProduct
  /** RECONNECT_NEEDED: the member who has to sign in again (null when unknown). */
  reconnect_by?: {
    user_id: string | null
    name: string | null
    is_you: boolean
  } | null
  /** QUOTA: how long Google asked us to wait, when it said. */
  retry_after_seconds?: number | null
}

// ---------------------------------------------------------------------------
// Connections and the workspace's choice
// ---------------------------------------------------------------------------

/** One of the caller's own Google connections for a product. */
export interface GoogleAccountOption {
  account_id: string
  email: string | null
  /** ok: usable; needs_reconnect: switched off, refused or missing the scope; unavailable: Google did not list what it can read. */
  status: 'ok' | 'needs_reconnect' | 'unavailable'
}

export interface SearchConsoleSiteOption {
  /** Exactly as Google names it: 'sc-domain:example.com' or 'https://www.example.com/'. */
  site_url: string
  permission_level: string
  /** False for 'siteUnverifiedUser': such a site cannot be chosen. */
  verified: boolean
  account_id: string
  account_email: string | null
}

export interface AnalyticsPropertyOption {
  /** 'properties/123' */
  property_id: string
  display_name: string
  account_display_name: string
  account_id: string
  account_email: string | null
}

interface SourceCommon {
  /** The connection every member's reads go through (null once it was removed). */
  account_id: string | null
  account_email: string | null
  chosen_by: string | null
  chosen_by_name: string | null
  chosen_at: string | null
  /** ok, or needs_reconnect: the connection is gone, off, refused or missing the scope. */
  health: 'ok' | 'needs_reconnect'
}

export interface SearchConsoleSourceView extends SourceCommon {
  site_url: string
}

export interface AnalyticsSourceView extends SourceCommon {
  property_id: string
  property_name: string | null
  time_zone: string | null
  currency_code: string | null
}

export interface GoogleProductStatus<Option, Source> {
  /**
   * not_connected: no source and the caller has no connection; choose: the
   * caller can choose one; ready: a source is chosen and its connection is
   * healthy; needs_reconnect: a source is chosen but its connection is not.
   */
  state: 'not_connected' | 'choose' | 'ready' | 'needs_reconnect'
  my_accounts: GoogleAccountOption[]
  source: Source | null
  /** What the caller could choose, read from their own connections (empty without one). */
  options: Option[]
  /** The option matching the workspace's own website, when exactly one does. */
  suggested: string | null
}

export interface GoogleSeoStatus {
  /** The workspace's own website (src/lib/seo/site.ts), for the suggestion. */
  workspace_site_url: string | null
  search_console: GoogleProductStatus<
    SearchConsoleSiteOption,
    SearchConsoleSourceView
  >
  analytics: GoogleProductStatus<AnalyticsPropertyOption, AnalyticsSourceView>
}

/** The state the "Connect Google" card shows for one product. Pure. */
export function googleProductState(args: {
  source: { health: 'ok' | 'needs_reconnect' } | null
  myAccounts: readonly GoogleAccountOption[]
}): GoogleProductStatus<unknown, unknown>['state'] {
  if (args.source)
    return args.source.health === 'ok' ? 'ready' : 'needs_reconnect'
  return args.myAccounts.length > 0 ? 'choose' : 'not_connected'
}

// ---------------------------------------------------------------------------
// Search Console performance
// ---------------------------------------------------------------------------

export const GSC_DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'date',
  'searchAppearance',
] as const
export const GSC_FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
] as const
export const GSC_SEARCH_TYPES = [
  'web',
  'image',
  'video',
  'news',
  'googleNews',
  'discover',
] as const
export const GSC_DATE_RANGES = [
  'last_7_days',
  'last_28_days',
  'last_3_months',
  'last_6_months',
  'last_12_months',
  'last_16_months',
] as const
export const GSC_DATA_STATES = ['all', 'final'] as const

/** 250 rows fit in one answer; more is opt-in, paged with start_row. */
export const GSC_DEFAULT_ROW_LIMIT = 250
/** Rows per call: fetched equals returned, so counts stay honest. Google allows 25,000. */
export const GSC_MAX_ROW_LIMIT = 1000
export const GSC_MAX_FILTERS = 5

export type GscDimension = (typeof GSC_DIMENSIONS)[number]
export type GscFilterOperator = (typeof GSC_FILTER_OPERATORS)[number]
export type GscSearchType = (typeof GSC_SEARCH_TYPES)[number]
export type GscDateRange = (typeof GSC_DATE_RANGES)[number]

export interface GscFilter {
  dimension: GscDimension
  operator?: GscFilterOperator
  expression: string
}

export interface SearchConsolePerformanceInput {
  /** Group rows by these (default ['query']). searchAppearance must be alone. */
  dimensions?: GscDimension[]
  /** A preset window (default last_28_days), ending three days ago. Ignored when both dates are given. */
  date_range?: GscDateRange
  /** YYYY-MM-DD, Pacific Time; with end_date. */
  start_date?: string
  end_date?: string
  /** AND-combined; at most 5. */
  filters?: GscFilter[]
  row_limit?: number
  start_row?: number
  /** Applied here over the top rows (Google cannot filter by them). */
  min_position?: number
  max_position?: number
  min_impressions?: number
  type?: GscSearchType
  data_state?: 'all' | 'final'
  /** Also read the same-length period just before, for the totals' change. */
  compare?: boolean
}

export interface SearchConsoleRow {
  /** The row's values, in `dimensions` order. A query is a searcher's own words. */
  keys: string[]
  clicks: number
  impressions: number
  /** 0..1 */
  ctr: number
  /** 1-based average; null where Google reports none (discover, googleNews). */
  position: number | null
}

export interface SearchConsoleTotals {
  clicks: number
  impressions: number
  /** 0..1 (clicks / impressions). */
  ctr: number
  /** Impression-weighted average position; 0 with no impressions. */
  position: number
}

/** A metric now and in the period before. */
export interface MetricChange {
  current: number | null
  previous: number | null
  absolute_change: number | null
  /** A fraction (0.1 is +10%); null when the previous value is 0 or missing. */
  percent_change: number | null
}

export interface SearchConsolePerformance {
  site_url: string
  start_date: string
  end_date: string
  dimensions: GscDimension[]
  type: GscSearchType
  rows: SearchConsoleRow[]
  row_count: number
  has_more: boolean
  /** Pass as start_row for the next page (Google's own row numbering). */
  next_start_row: number | null
  /** With a position or impressions filter: how many rows were read and kept. */
  filtered: { fetched: number; kept: number } | null
  /** The whole window (with the same filters), whatever the rows show. */
  totals: SearchConsoleTotals
  /** One point per day, oldest first; days Google left out are zeros. */
  trend: Array<{ date: string; clicks: number; impressions: number }>
  previous: {
    start_date: string
    end_date: string
    totals: SearchConsoleTotals
  } | null
  change: Record<
    'clicks' | 'impressions' | 'ctr' | 'position',
    MetricChange
  > | null
}

// ---------------------------------------------------------------------------
// Search opportunities
// ---------------------------------------------------------------------------

export interface StrikingDistanceRow {
  /** A searcher's own words. */
  query: string
  /** The site's best-ranking page for the query. */
  page: string
  clicks: number
  impressions: number
  position: number
}

export interface LowCtrRow {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  /** The site's own click-through rate at that position, across its queries. */
  expected_ctr: number
  /** impressions × (expected_ctr − ctr), rounded. */
  missed_clicks: number
}

export interface PageOpportunityRow {
  page: string
  /** host + path, the key the two sources are joined on; null when the URL could not be read. */
  normalized_page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  join_status: 'joined' | 'gsc_only'
  analytics: {
    sessions: number
    activeUsers: number
    engagedSessions: number
    engagementRate: number
    keyEvents: number
    sessionKeyEventRate: number
    transactions: number
    purchaseRevenue: number | null
  } | null
  /** 0..100; null for a page with no Analytics row (never scored as zero). */
  score: number | null
  score_components: {
    demand: number
    business_value: number
    reachability: number
  } | null
}

export interface PageOpportunities {
  property_id: string
  property_name: string | null
  /** Search Console's dates are Pacific Time; Analytics' are the property's. */
  search_console_time_zone: 'America/Los_Angeles'
  analytics_time_zone: string
  rows: PageOpportunityRow[]
  total_candidates: number
  scoring: {
    formula: string
    business_value_metric: 'sessionKeyEventRate' | 'engagementRate'
    engagement_fallback: boolean
    /** Analytics marked its report limited (thresholding, sampling…): a missing row is unknown, not zero. */
    score_data_limited: boolean
  }
  coverage: {
    search_console_rows: number
    analytics_rows: number
    matched_rows: number
    unmatched_search_console_rows: number
    unmatched_analytics_rows: number
  }
  truncated: {
    search_console: boolean
    analytics: boolean
    candidates: boolean
  }
  warnings: string[]
}

export interface SearchOpportunities {
  site_url: string
  start_date: string
  end_date: string
  /** Queries whose best page ranks 5–20: already ranking, not yet on top. */
  striking_distance: StrikingDistanceRow[]
  /** Queries ranking well whose click-through is well under the site's own at that position. */
  low_ctr: LowCtrRow[]
  /** How many query-and-page rows were read, and whether Google had more. */
  query_rows_considered: number
  query_rows_truncated: boolean
  /** Pages ranking 4–20 joined with what their search visitors did, when Analytics is chosen too. */
  pages: PageOpportunities | null
  /** Why `pages` is null (Analytics not chosen, or its read failed). */
  pages_unavailable: { code: GoogleSeoErrorCode; message: string } | null
}

// ---------------------------------------------------------------------------
// URL inspection
// ---------------------------------------------------------------------------

/** At most this many URLs per inspection: Google answers each in a few seconds. */
export const URL_INSPECTION_MAX = 10

export interface UrlInspectionRow {
  url: string
  /** PASS, PARTIAL, FAIL, NEUTRAL… (Google's verdict); null with an error. */
  verdict: string | null
  coverage_state: string | null
  robots_txt_state: string | null
  indexing_state: string | null
  page_fetch_state: string | null
  last_crawl_time: string | null
  crawled_as: string | null
  google_canonical: string | null
  user_canonical: string | null
  /** Google chose a different canonical than the page declares: the usual answer to "why isn't it indexed?". */
  canonical_mismatch: boolean
  sitemaps: string[]
  referring_urls: string[]
  mobile_usability: string | null
  rich_results: string | null
  /** The page in Search Console. */
  details_link: string | null
  /** This URL's own failure; the others still answered. */
  error: string | null
}

export interface UrlInspectionResult {
  site_url: string
  results: UrlInspectionRow[]
}

// ---------------------------------------------------------------------------
// Google Analytics reports
// ---------------------------------------------------------------------------

export const ANALYTICS_REPORTS = [
  'organic_overview',
  'organic_landing_pages',
  'page_performance',
  'key_events',
  'traffic_acquisition',
  'ecommerce_performance',
  'site_search',
  'audience_breakdown',
  'measurement_health',
] as const
export type AnalyticsReportName = (typeof ANALYTICS_REPORTS)[number]

export const ANALYTICS_CHANNELS = ['organic_search', 'all'] as const
export type AnalyticsChannel = (typeof ANALYTICS_CHANNELS)[number]

/** The breakdowns each report takes (the first is its default); a report not listed takes none. */
export const ANALYTICS_BREAKDOWNS = {
  key_events: ['event', 'event_and_landing_page'],
  traffic_acquisition: ['channel_group', 'source_medium', 'campaign'],
  ecommerce_performance: ['item', 'landing_page'],
  audience_breakdown: ['device', 'country', 'new_vs_returning'],
} as const satisfies Partial<Record<AnalyticsReportName, readonly string[]>>

/** Reports a person may widen to every channel (the others are fixed: organic, or all for acquisition and site search). */
export const ANALYTICS_CHANNEL_REPORTS: readonly AnalyticsReportName[] = [
  'page_performance',
  'key_events',
  'ecommerce_performance',
  'audience_breakdown',
]

export const ANALYTICS_DEFAULT_LIMIT = 100
export const ANALYTICS_MAX_LIMIT = 1000

export interface AnalyticsReportInput {
  report: AnalyticsReportName
  /** YYYY-MM-DD in the property's time zone; both or neither (default: the last 28 complete days). */
  start_date?: string
  end_date?: string
  limit?: number
  offset?: number
  channel?: AnalyticsChannel
  /** page_performance: one row per page per day. */
  include_date?: boolean
  /** One of ANALYTICS_BREAKDOWNS[report]. */
  breakdown?: string
  /** key_events (event), traffic_acquisition (channel_group), audience_breakdown (device, new_vs_returning). */
  compare_previous_period?: boolean
  /** ecommerce_performance by landing_page: only pages with a transaction. */
  only_with_transactions?: boolean
  /** organic_overview: the trend's step. */
  trend?: 'daily' | 'weekly'
}

/** One report row: Google's dimension and metric names as keys. A restricted metric is null, never zero. */
export type AnalyticsRow = Record<string, string | number | null>

export interface AnalyticsReportMetadata {
  data_loss_from_other_row: boolean
  subject_to_thresholding: boolean
  sampling: Array<{ samples_read_count: string; sampling_space_size: string }>
  restricted_metrics: Array<{
    metric_name: string
    restricted_metric_types: string[]
  }>
  empty_reason: string | null
  /** Any of the above: a missing row is unknown, not zero. */
  has_limited_data: boolean
}

export interface AnalyticsSourceInfo {
  property_id: string
  property_name: string | null
  time_zone: string
  currency_code: string | null
}

export interface AnalyticsDiagnostic {
  code: string
  severity: 'info' | 'warning'
  message: string
  evidence: Record<string, unknown>
}

export interface AnalyticsComparison {
  previous_date_range: { start_date: string; end_date: string }
  dimensions: string[]
  metrics: string[]
  rows: Array<{
    dimensions: Record<string, string | number | null>
    metrics: Record<string, MetricChange>
  }>
  /** Both periods were read whole. */
  complete: boolean
  has_limited_data: boolean
}

export interface AnalyticsActivity {
  /** detected, none, or unknown (the report was incomplete or limited). */
  status: 'detected' | 'none' | 'unknown'
  evidence: Record<string, number>
  reason: string | null
}

export interface AnalyticsTableReport {
  kind: 'table'
  report: Exclude<
    AnalyticsReportName,
    'organic_overview' | 'measurement_health'
  >
  source: AnalyticsSourceInfo
  request: {
    requested_date_range: { start_date: string; end_date: string } | null
    date_range: { start_date: string; end_date: string }
    channel: AnalyticsChannel
    breakdown: string
    dimensions: string[]
    metrics: string[]
    limit: number
    offset: number
  }
  row_count: number
  total_row_count: number
  rows: AnalyticsRow[]
  page: {
    offset: number
    limit: number
    has_more: boolean
    next_offset: number | null
  }
  metadata: AnalyticsReportMetadata
  /** end_date_clamped (asked past the last complete day), comparison_incomplete. */
  warnings: string[]
  diagnostics: AnalyticsDiagnostic[]
  comparison: AnalyticsComparison | null
  /** ecommerce_performance: whether there was any. */
  activity: AnalyticsActivity | null
}

export interface AnalyticsOverviewReport {
  kind: 'overview'
  report: 'organic_overview'
  source: AnalyticsSourceInfo
  request: {
    requested_date_range: { start_date: string; end_date: string } | null
    date_range: { start_date: string; end_date: string }
    previous_date_range: { start_date: string; end_date: string }
    channel: 'organic_search'
    trend: 'daily' | 'weekly'
  }
  current: AnalyticsRow | null
  previous: AnalyticsRow | null
  comparison: Record<string, MetricChange>
  trend: AnalyticsRow[]
  diagnostics: AnalyticsDiagnostic[]
  has_limited_data: boolean
  /** end_date_clamped, trend_truncated. */
  warnings: string[]
}

export interface MeasurementHealthReport {
  kind: 'measurement_health'
  report: 'measurement_health'
  source: AnalyticsSourceInfo
  summary: {
    data_streams: number
    web_streams: number
    key_events: number
    custom_dimensions: number
    custom_metrics: number
    issues: number
  }
  /** no_web_stream, enhanced_measurement_disabled, site_search_measurement_disabled, no_key_events_configured. */
  issues: string[]
  web_streams: Array<{
    stream_id: string
    display_name: string
    measurement_id: string | null
    default_uri: string | null
    enhanced_measurement: Record<string, boolean | string>
  }>
  other_streams: Array<{
    stream_id: string
    type: string
    display_name: string
  }>
  key_events: Array<{
    event_name: string
    counting_method: string
    custom: boolean | null
  }>
  custom_dimensions: Array<{
    parameter_name: string
    display_name: string
    scope: string
  }>
  custom_metrics: Array<{
    parameter_name: string
    display_name: string
    scope: string
    measurement_unit: string
  }>
}

export type AnalyticsReport =
  | AnalyticsTableReport
  | AnalyticsOverviewReport
  | MeasurementHealthReport

/** The metrics of the organic overview (and its trend). */
export const ANALYTICS_OVERVIEW_METRICS = [
  'sessions',
  'activeUsers',
  'engagedSessions',
  'engagementRate',
  'keyEvents',
  'transactions',
  'purchaseRevenue',
] as const

/** A metric now and before. Pure. */
export function metricChange(
  current: number | null,
  previous: number | null,
): MetricChange {
  const absolute =
    current != null && previous != null ? current - previous : null
  return {
    current,
    previous,
    absolute_change: absolute,
    percent_change:
      absolute != null && previous != null && previous !== 0
        ? absolute / previous
        : null,
  }
}

export function isAnalyticsReportName(
  value: unknown,
): value is AnalyticsReportName {
  return (
    typeof value === 'string' &&
    (ANALYTICS_REPORTS as readonly string[]).includes(value)
  )
}
