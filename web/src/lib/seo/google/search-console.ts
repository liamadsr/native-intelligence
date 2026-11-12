/**
 * Search Console for the workspace's chosen site: performance (clicks,
 * impressions, CTR and position by query, page, country, device or date,
 * with the window's totals, its daily trend and the period before) and URL
 * inspection (what Google knows about a few pages). Reads go through the
 * connection the workspace's choice names (./token.ts). Free.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  previousPeriod,
  resolveSearchConsoleRange,
  type DateRange,
} from './dates'
import { GoogleSeoError, isGoogleSeoError } from './errors'
import {
  createSearchConsoleClient,
  type GscInspection,
  type GscSearchAnalyticsRequest,
  type GscSearchAnalyticsRow,
} from './search-console-client'
import { attributeFailure, resolveReadToken, type TokenDeps } from './token'
import {
  GSC_DEFAULT_ROW_LIMIT,
  GSC_DIMENSIONS,
  GSC_FILTER_OPERATORS,
  GSC_MAX_FILTERS,
  GSC_MAX_ROW_LIMIT,
  GSC_SEARCH_TYPES,
  metricChange,
  URL_INSPECTION_MAX,
  type GscDimension,
  type GscSearchType,
  type SearchConsolePerformance,
  type SearchConsolePerformanceInput,
  type SearchConsoleRow,
  type SearchConsoleTotals,
  type UrlInspectionResult,
  type UrlInspectionRow,
} from './view'

export interface GoogleSeoDeps extends TokenDeps {
  fetchImpl?: typeof fetch
  now?: Date
}

/** A day's rows: a 16-month window is about 490. */
const DATE_ROW_LIMIT = 1000
const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Pure shaping
// ---------------------------------------------------------------------------

/** Check the input and build Google's request body. Filters go in dimensionFilterGroups: Google ignores a top-level `filters`. Throws INVALID_REQUEST. */
export function buildSearchAnalyticsRequest(
  input: SearchConsolePerformanceInput,
  now: Date = new Date(),
): GscSearchAnalyticsRequest {
  const invalid = (message: string) =>
    new GoogleSeoError('INVALID_REQUEST', 'search_console', message)
  const dimensions = input.dimensions?.length
    ? input.dimensions
    : (['query'] as GscDimension[])
  if (
    dimensions.some((d) => !(GSC_DIMENSIONS as readonly string[]).includes(d))
  )
    throw invalid(`Dimensions are ${GSC_DIMENSIONS.join(', ')}.`)
  if (new Set(dimensions).size !== dimensions.length || dimensions.length > 4)
    throw invalid('At most four different dimensions.')
  if (dimensions.includes('searchAppearance') && dimensions.length > 1)
    throw invalid('searchAppearance must be the only dimension when used.')
  if (
    input.type &&
    !(GSC_SEARCH_TYPES as readonly string[]).includes(input.type)
  )
    throw invalid(`Search types are ${GSC_SEARCH_TYPES.join(', ')}.`)
  const filters = input.filters ?? []
  if (filters.length > GSC_MAX_FILTERS)
    throw invalid(`At most ${GSC_MAX_FILTERS} filters.`)
  for (const f of filters) {
    if (!(GSC_DIMENSIONS as readonly string[]).includes(f.dimension))
      throw invalid(
        `A filter's dimension is one of ${GSC_DIMENSIONS.join(', ')}.`,
      )
    if (
      f.operator &&
      !(GSC_FILTER_OPERATORS as readonly string[]).includes(f.operator)
    )
      throw invalid(
        `A filter's operator is one of ${GSC_FILTER_OPERATORS.join(', ')}.`,
      )
    if (
      typeof f.expression !== 'string' ||
      !f.expression.trim() ||
      f.expression.length > 1000
    )
      throw invalid('A filter needs an expression (at most 1000 characters).')
  }
  const range = resolveSearchConsoleRange(input, now)
  const request: GscSearchAnalyticsRequest = {
    startDate: range.start_date,
    endDate: range.end_date,
    dimensions,
    rowLimit: clamp(
      Math.trunc(input.row_limit ?? GSC_DEFAULT_ROW_LIMIT),
      1,
      GSC_MAX_ROW_LIMIT,
    ),
    type: input.type ?? 'web',
    dataState: input.data_state ?? 'all',
  }
  if (input.start_row && input.start_row > 0)
    request.startRow = Math.trunc(input.start_row)
  if (filters.length) {
    request.dimensionFilterGroups = [
      {
        groupType: 'and',
        filters: filters.map((f) => ({
          dimension: f.dimension,
          operator: f.operator ?? 'equals',
          expression: f.expression,
        })),
      },
    ]
  }
  return request
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Totals over rows: clicks and impressions summed, CTR from them, position weighted by impressions. Pure. */
export function sumSearchTotals(
  rows: readonly GscSearchAnalyticsRow[],
): SearchConsoleTotals {
  let clicks = 0
  let impressions = 0
  let weighted = 0
  for (const row of rows) {
    clicks += row.clicks
    impressions += row.impressions
    weighted += (row.position ?? 0) * row.impressions
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  }
}

/** One point per day, oldest first, from ['date'] rows: days Google left out are zeros, so a chart's axis doesn't shrink. Pure. */
export function buildDailyTrend(
  rows: readonly GscSearchAnalyticsRow[],
  range: DateRange,
): Array<{ date: string; clicks: number; impressions: number }> {
  const byDate = new Map(rows.map((r) => [r.keys?.[0], r]))
  const out: Array<{ date: string; clicks: number; impressions: number }> = []
  const end = Date.parse(`${range.end_date}T00:00:00Z`)
  for (
    let day = Date.parse(`${range.start_date}T00:00:00Z`);
    day <= end;
    day += DAY_MS
  ) {
    const date = new Date(day).toISOString().slice(0, 10)
    const row = byDate.get(date)
    out.push({
      date,
      clicks: row?.clicks ?? 0,
      impressions: row?.impressions ?? 0,
    })
  }
  return out
}

interface MetricFilter {
  min_position?: number
  max_position?: number
  min_impressions?: number
}

function pickMetricFilter(input: MetricFilter): MetricFilter | null {
  if (
    input.min_position === undefined &&
    input.max_position === undefined &&
    input.min_impressions === undefined
  )
    return null
  return {
    min_position: input.min_position,
    max_position: input.max_position,
    min_impressions: input.min_impressions,
  }
}

/** A row with no position (discover, googleNews) never meets a position bound. Pure. */
export function matchesMetricFilter(
  row: GscSearchAnalyticsRow,
  filter: MetricFilter,
): boolean {
  if (
    filter.min_impressions !== undefined &&
    row.impressions < filter.min_impressions
  )
    return false
  if (
    filter.min_position !== undefined &&
    (row.position === undefined || row.position < filter.min_position)
  )
    return false
  if (
    filter.max_position !== undefined &&
    (row.position === undefined || row.position > filter.max_position)
  )
    return false
  return true
}

/** Google's full-precision floats, trimmed to what anyone reads: four decimals of CTR, one of position. Pure. */
export function shapeRow(row: GscSearchAnalyticsRow): SearchConsoleRow {
  return {
    keys: row.keys ?? [],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10_000) / 10_000,
    position:
      row.position === undefined ? null : Math.round(row.position * 10) / 10,
  }
}

/**
 * The page of rows to return from what Google sent. With a metric filter the
 * whole window (1000 rows) was read and filtered here; paging stays in
 * Google's row numbering, so the next page starts right after the last row
 * returned. Pure.
 */
export function pageRows(
  fetched: readonly GscSearchAnalyticsRow[],
  args: {
    requestedLimit: number
    fetchLimit: number
    startRow: number
    filter: MetricFilter | null
  },
): {
  rows: SearchConsoleRow[]
  hasMore: boolean
  nextStartRow: number | null
  kept: number
} {
  const kept = args.filter
    ? fetched.filter((r) => matchesMetricFilter(r, args.filter!))
    : [...fetched]
  const page = kept.slice(0, args.requestedLimit)
  const last = page[page.length - 1]
  const truncated = kept.length > page.length
  const hasMore = truncated || fetched.length >= args.fetchLimit
  const next =
    truncated && last
      ? args.startRow + fetched.indexOf(last) + 1
      : args.startRow + fetched.length
  return {
    rows: page.map(shapeRow),
    hasMore,
    nextStartRow: hasMore ? next : null,
    kept: kept.length,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Search Console performance for the workspace's chosen site. Throws GoogleSeoError. */
export async function getSearchConsolePerformance(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string | null },
  input: SearchConsolePerformanceInput,
  deps: GoogleSeoDeps = {},
): Promise<SearchConsolePerformance> {
  const now = deps.now ?? new Date()
  const request = buildSearchAnalyticsRequest(input, now)
  const filter = pickMetricFilter(input)
  if (
    filter &&
    filter.min_position !== undefined &&
    filter.max_position !== undefined &&
    filter.min_position > filter.max_position
  ) {
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      'search_console',
      'min_position is above max_position.',
    )
  }
  const requestedLimit = request.rowLimit ?? GSC_DEFAULT_ROW_LIMIT
  // Google can't filter by position or impressions: with such a filter, read the whole top and filter here.
  const fetchLimit = filter ? GSC_MAX_ROW_LIMIT : requestedLimit
  const range: DateRange = {
    start_date: request.startDate,
    end_date: request.endDate,
  }
  const previous = input.compare ? previousPeriod(range) : null

  const read = await resolveReadToken(svc, who, 'search_console', deps)
  const siteUrl = read.source.sc_site_url!
  const client = createSearchConsoleClient(read.token, {
    fetchImpl: deps.fetchImpl,
  })
  const byDate = (r: DateRange): GscSearchAnalyticsRequest => ({
    startDate: r.start_date,
    endDate: r.end_date,
    dimensions: ['date'],
    rowLimit: DATE_ROW_LIMIT,
    type: request.type,
    dataState: request.dataState,
    ...(request.dimensionFilterGroups
      ? { dimensionFilterGroups: request.dimensionFilterGroups }
      : {}),
  })
  try {
    const [rows, days, previousDays] = await Promise.all([
      client.querySearchAnalytics(siteUrl, {
        ...request,
        rowLimit: fetchLimit,
      }),
      client.querySearchAnalytics(siteUrl, byDate(range)),
      previous
        ? client.querySearchAnalytics(siteUrl, byDate(previous))
        : Promise.resolve(null),
    ])
    const paged = pageRows(rows, {
      requestedLimit,
      fetchLimit,
      startRow: request.startRow ?? 0,
      filter,
    })
    const totals = sumSearchTotals(days)
    const previousTotals = previousDays ? sumSearchTotals(previousDays) : null
    return {
      site_url: siteUrl,
      start_date: range.start_date,
      end_date: range.end_date,
      dimensions: (request.dimensions ?? ['query']) as GscDimension[],
      type: (request.type ?? 'web') as GscSearchType,
      rows: paged.rows,
      row_count: paged.rows.length,
      has_more: paged.hasMore,
      next_start_row: paged.nextStartRow,
      filtered: filter ? { fetched: rows.length, kept: paged.kept } : null,
      totals,
      trend: buildDailyTrend(days, range),
      previous:
        previous && previousTotals
          ? { ...previous, totals: previousTotals }
          : null,
      change: previousTotals
        ? {
            clicks: metricChange(totals.clicks, previousTotals.clicks),
            impressions: metricChange(
              totals.impressions,
              previousTotals.impressions,
            ),
            ctr: metricChange(totals.ctr, previousTotals.ctr),
            position: metricChange(
              totals.position || null,
              previousTotals.position || null,
            ),
          }
        : null,
    }
  } catch (err) {
    throw attributeFailure(err, 'search_console', read.owner)
  }
}

/** One inspection, shaped. Pure. */
export function shapeInspection(
  url: string,
  result: GscInspection | null,
): UrlInspectionRow {
  const index = result?.indexStatusResult
  const google = index?.googleCanonical ?? null
  const declared = index?.userCanonical ?? null
  return {
    url,
    verdict: index?.verdict ?? null,
    coverage_state: index?.coverageState ?? null,
    robots_txt_state: index?.robotsTxtState ?? null,
    indexing_state: index?.indexingState ?? null,
    page_fetch_state: index?.pageFetchState ?? null,
    last_crawl_time: index?.lastCrawlTime ?? null,
    crawled_as: index?.crawledAs ?? null,
    google_canonical: google,
    user_canonical: declared,
    canonical_mismatch: Boolean(google && declared && google !== declared),
    sitemaps: index?.sitemap ?? [],
    referring_urls: index?.referringUrls ?? [],
    mobile_usability: result?.mobileUsabilityResult?.verdict ?? null,
    rich_results: result?.richResultsResult?.verdict ?? null,
    details_link: result?.inspectionResultLink ?? null,
    error: result ? null : 'Google returned no inspection for this page.',
  }
}

/** URLs to inspect, checked: 1 to 10 distinct absolute http(s) addresses. Throws INVALID_REQUEST. */
export function checkInspectionUrls(urls: readonly string[]): string[] {
  const list = [
    ...new Set(
      urls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean),
    ),
  ]
  if (!list.length || list.length > URL_INSPECTION_MAX) {
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      'search_console',
      `Inspect 1 to ${URL_INSPECTION_MAX} pages at a time.`,
    )
  }
  for (const u of list) {
    let ok = false
    try {
      const parsed = new URL(u)
      ok =
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        u.length <= 2048
    } catch {
      ok = false
    }
    if (!ok)
      throw new GoogleSeoError(
        'INVALID_REQUEST',
        'search_console',
        'Each page is a full address, like https://example.com/page.',
      )
  }
  return list
}

/**
 * What Google knows about up to 10 pages of the chosen site, all at once (one
 * takes a few seconds). One page's failure is its own row; a dead connection
 * fails the whole call, so the person is asked to reconnect.
 */
export async function inspectUrls(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string | null },
  input: { urls: readonly string[]; language_code?: string },
  deps: GoogleSeoDeps = {},
): Promise<UrlInspectionResult> {
  const urls = checkInspectionUrls(input.urls)
  const language =
    input.language_code &&
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language_code)
      ? input.language_code
      : undefined
  const read = await resolveReadToken(svc, who, 'search_console', deps)
  const siteUrl = read.source.sc_site_url!
  const client = createSearchConsoleClient(read.token, {
    fetchImpl: deps.fetchImpl,
  })
  try {
    const results = await Promise.all(
      urls.map(async (url): Promise<UrlInspectionRow> => {
        try {
          return shapeInspection(
            url,
            await client.inspectUrl(siteUrl, url, language),
          )
        } catch (err) {
          if (isGoogleSeoError(err) && err.code === 'RECONNECT_NEEDED')
            throw err
          return {
            ...shapeInspection(url, null),
            error: isGoogleSeoError(err)
              ? err.message
              : 'The inspection failed.',
          }
        }
      }),
    )
    return { site_url: siteUrl, results }
  } catch (err) {
    throw attributeFailure(err, 'search_console', read.owner)
  }
}
