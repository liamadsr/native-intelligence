/**
 * Search opportunities from the workspace's own Search Console data, and its
 * Google Analytics when that is chosen too:
 *
 *   striking distance  queries whose BEST page ranks 5 to 20: already
 *                      ranking, not yet on top, where better content most
 *                      plausibly moves real traffic. A query whose best page
 *                      is already above 5 is left out.
 *   low CTR            queries ranking 1 to 10 with real demand whose
 *                      click-through is under half the site's OWN rate at
 *                      that position (a title or snippet that doesn't earn
 *                      the click). Measured against the site itself, never
 *                      an industry curve; this rule is ours.
 *   pages              pages ranking 4 to 20 joined (host + path) with what
 *                      their organic visitors did in Analytics, scored by
 *                      demand, business value and reachability. A page with
 *                      no Analytics row stays listed, unscored: unknown, not
 *                      zero.
 *
 * At most 1000 rows from each source are read: the result says when that
 * cut anything, and is never a whole-site inventory.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { createAnalyticsClient } from './analytics-client'
import {
  buildReportRequest,
  COMPLETE_REPORT_LIMIT,
  normalizeReport,
} from './analytics-reports'
import {
  checkDatePair,
  dateInTimeZone,
  GSC_DATA_LAG_DAYS,
  resolveAnalyticsRange,
  shiftDate,
  type DateRange,
} from './dates'
import { GoogleSeoError, isGoogleSeoError } from './errors'
import type { GoogleSeoDeps } from './search-console'
import {
  createSearchConsoleClient,
  type GscSearchAnalyticsRow,
} from './search-console-client'
import { attributeFailure, resolveReadToken } from './token'
import type {
  AnalyticsRow,
  LowCtrRow,
  PageOpportunities,
  PageOpportunityRow,
  SearchOpportunities,
  StrikingDistanceRow,
} from './view'

const SOURCE_ROW_LIMIT = 1000
export const OPPORTUNITY_DEFAULT_LIMIT = 50
export const OPPORTUNITY_MAX_LIMIT = 100
const STRIKING_MIN = 5
const STRIKING_MAX = 20
const LOW_CTR_MAX_POSITION = 10
const LOW_CTR_MIN_IMPRESSIONS = 100
/** A position needs this many queries before its CTR is the site's own benchmark. */
const LOW_CTR_MIN_PEERS = 3
const LOW_CTR_SHARE = 0.5
const PACIFIC = 'America/Los_Angeles'

type Who = { workspaceId: string; userId: string | null }

// ---------------------------------------------------------------------------
// Pure shaping
// ---------------------------------------------------------------------------

/**
 * ['query','page'] rows collapsed to each query's best page (lowest average
 * position, then most impressions): the site ranks for a query where its
 * best page does. Pure.
 */
export function bestPagePerQuery(
  rows: readonly GscSearchAnalyticsRow[],
): Array<StrikingDistanceRow & { ctr: number }> {
  const best = new Map<string, StrikingDistanceRow & { ctr: number }>()
  for (const row of rows) {
    const query = row.keys?.[0]
    const page = row.keys?.[1]
    if (!query || !page || row.position === undefined) continue
    const current = best.get(query)
    if (
      current &&
      !(
        row.position < current.position ||
        (row.position === current.position &&
          row.impressions > current.impressions)
      )
    )
      continue
    best.set(query, {
      query,
      page,
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
      ctr: row.ctr,
    })
  }
  return [...best.values()]
}

/** One row per query whose best page ranks 5–20, most impressions first. Pure. */
export function buildStrikingDistanceRows(
  rows: readonly GscSearchAnalyticsRow[],
  limit: number = OPPORTUNITY_DEFAULT_LIMIT,
): StrikingDistanceRow[] {
  return bestPagePerQuery(rows)
    .filter((r) => r.position >= STRIKING_MIN && r.position <= STRIKING_MAX)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map(({ query, page, clicks, impressions, position }) => ({
      query,
      page,
      clicks,
      impressions,
      position: round1(position),
    }))
}

/**
 * Queries ranking 1–10 with at least 100 impressions whose CTR is under half
 * the site's own impression-weighted CTR at the same (rounded) position, most
 * missed clicks first. A position with fewer than three such queries is no
 * benchmark and flags nothing. Pure.
 */
export function buildLowCtrRows(
  rows: readonly GscSearchAnalyticsRow[],
  limit: number = OPPORTUNITY_DEFAULT_LIMIT,
): LowCtrRow[] {
  const queries = bestPagePerQuery(rows).filter(
    (r) =>
      r.position <= LOW_CTR_MAX_POSITION &&
      r.impressions >= LOW_CTR_MIN_IMPRESSIONS,
  )
  const buckets = new Map<
    number,
    { clicks: number; impressions: number; count: number }
  >()
  for (const q of queries) {
    const b = Math.max(1, Math.round(q.position))
    const bucket = buckets.get(b) ?? { clicks: 0, impressions: 0, count: 0 }
    bucket.clicks += q.clicks
    bucket.impressions += q.impressions
    bucket.count += 1
    buckets.set(b, bucket)
  }
  const out: LowCtrRow[] = []
  for (const q of queries) {
    const bucket = buckets.get(Math.max(1, Math.round(q.position)))
    if (!bucket || bucket.count < LOW_CTR_MIN_PEERS || bucket.impressions === 0)
      continue
    const expected = bucket.clicks / bucket.impressions
    if (expected <= 0 || q.ctr >= expected * LOW_CTR_SHARE) continue
    out.push({
      query: q.query,
      page: q.page,
      clicks: q.clicks,
      impressions: q.impressions,
      ctr: round4(q.ctr),
      position: round1(q.position),
      expected_ctr: round4(expected),
      missed_clicks: Math.round(q.impressions * (expected - q.ctr)),
    })
  }
  return out.sort((a, b) => b.missed_clicks - a.missed_clicks).slice(0, limit)
}

/**
 * The join key of a page in both sources: lowercased host (default port
 * dropped) + path (case kept, trailing slash dropped except at the root),
 * scheme, query and fragment ignored, www kept apart. Null for (not set),
 * empty and unreadable values. Pure.
 */
export function normalizePageKey(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '(not set)') return null
  try {
    const url = new URL(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    )
    let host = url.hostname.toLowerCase()
    const defaultPort =
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    if (url.port && !defaultPort) host += `:${url.port}`
    let path = url.pathname || '/'
    if (path.length > 1) path = path.replace(/\/+$/, '')
    return `${host}${path}`
  } catch {
    return null
  }
}

/** Each value's rank among the others, 0..1 (ties share a rank). Pure. */
export function percentileRanks(values: readonly number[]): number[] {
  if (values.length === 0) return []
  if (values.length === 1) return [1]
  return values.map(
    (v) => values.filter((other) => other < v).length / (values.length - 1),
  )
}

function num(row: AnalyticsRow, name: string): number {
  const v = row[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const round1 = (v: number) => Math.round(v * 10) / 10
const round4 = (v: number) => Math.round(v * 10_000) / 10_000

/**
 * Pages ranking 4–20 joined with their organic landing-page rows and scored:
 * round(100 × (0.5 demand + 0.3 business value + 0.2 reachability)), each a
 * percentile among the joined pages (demand: log impressions; business
 * value: key-event rate, or engagement rate when no page has a key event;
 * reachability: nearer 4 is higher). Unjoined pages are listed, unscored,
 * after the scored ones. Pure.
 */
export function scorePageOpportunities(
  gscPages: readonly GscSearchAnalyticsRow[],
  landing: { rows: readonly AnalyticsRow[] },
): {
  rows: PageOpportunityRow[]
  engagementFallback: boolean
  matched: number
  unmatchedAnalytics: number
} {
  const byPage = new Map<string, AnalyticsRow>()
  let invalidAnalytics = 0
  for (const row of landing.rows) {
    const host = typeof row.hostName === 'string' ? row.hostName : ''
    const path = typeof row.landingPage === 'string' ? row.landingPage : ''
    // A session with no landing page reads "" or "(not set)": joined to the host alone it would look like the home page.
    const key = path.startsWith('/') ? normalizePageKey(`${host}${path}`) : null
    if (!key) {
      invalidAnalytics += 1
      continue
    }
    byPage.set(key, row)
  }

  const candidates: PageOpportunityRow[] = gscPages
    .filter(
      (r) => r.position !== undefined && r.position >= 4 && r.position <= 20,
    )
    .map((r) => {
      const page = r.keys?.[0] ?? ''
      const key = normalizePageKey(page)
      const a = key ? byPage.get(key) : undefined
      return {
        page,
        normalized_page: key,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: round4(r.ctr),
        position: round1(r.position ?? 0),
        join_status: a ? 'joined' : 'gsc_only',
        analytics: a
          ? {
              sessions: num(a, 'sessions'),
              activeUsers: num(a, 'activeUsers'),
              engagedSessions: num(a, 'engagedSessions'),
              engagementRate: num(a, 'engagementRate'),
              keyEvents: num(a, 'keyEvents'),
              sessionKeyEventRate: num(a, 'sessionKeyEventRate'),
              transactions: num(a, 'transactions'),
              purchaseRevenue:
                typeof a.purchaseRevenue === 'number'
                  ? a.purchaseRevenue
                  : null,
            }
          : null,
        score: null,
        score_components: null,
      }
    })
  const joined = candidates.filter(
    (
      c,
    ): c is PageOpportunityRow & {
      analytics: NonNullable<PageOpportunityRow['analytics']>
    } => c.analytics !== null,
  )
  const fallback =
    joined.length > 0 && joined.every((c) => c.analytics.keyEvents === 0)
  // Position comes from the unrounded row so ties are real ties.
  const positions = new Map(
    gscPages.map((r) => [r.keys?.[0] ?? '', r.position ?? 20]),
  )
  const demand = percentileRanks(joined.map((c) => Math.log1p(c.impressions)))
  const value = percentileRanks(
    joined.map((c) =>
      fallback ? c.analytics.engagementRate : c.analytics.sessionKeyEventRate,
    ),
  )
  const reach = percentileRanks(
    joined.map((c) => 20 - (positions.get(c.page) ?? c.position)),
  )
  joined.forEach((c, i) => {
    const components = {
      demand: round4(demand[i] ?? 0),
      business_value: round4(value[i] ?? 0),
      reachability: round4(reach[i] ?? 0),
    }
    c.score_components = components
    c.score = Math.round(
      100 *
        (0.5 * components.demand +
          0.3 * components.business_value +
          0.2 * components.reachability),
    )
  })
  candidates.sort((a, b) => {
    if (a.score == null && b.score != null) return 1
    if (a.score != null && b.score == null) return -1
    return (b.score ?? 0) - (a.score ?? 0) || b.impressions - a.impressions
  })
  return {
    rows: candidates,
    engagementFallback: fallback,
    matched: joined.length,
    unmatchedAnalytics:
      Math.max(byPage.size - joined.length, 0) + invalidAnalytics,
  }
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

function defaultRange(now: Date): DateRange {
  // 28 days ending three days ago (Search Console's lag), in Search Console's own zone.
  const end = shiftDate(dateInTimeZone(now, PACIFIC), -GSC_DATA_LAG_DAYS)
  return { start_date: shiftDate(end, -27), end_date: end }
}

async function pageOpportunities(
  svc: SupabaseClient,
  who: Who,
  gscPages: GscSearchAnalyticsRow[],
  range: DateRange,
  limit: number,
  deps: GoogleSeoDeps,
): Promise<PageOpportunities> {
  const read = await resolveReadToken(svc, who, 'analytics', deps)
  const row = read.source
  const timeZone = row.ga4_time_zone || 'UTC'
  // Analytics can't read past its last complete day: hold the end there (the window is the same otherwise).
  const dates = resolveAnalyticsRange(range, timeZone, deps.now ?? new Date())
  const request = buildReportRequest({
    report: 'organic_landing_pages',
    ...dates.range,
    channel: 'organic_search',
    limit: COMPLETE_REPORT_LIMIT,
    offset: 0,
    breakdown: 'landing_page',
    include_date: false,
    only_with_transactions: false,
  })
  let landing
  try {
    landing = normalizeReport(
      await createAnalyticsClient(read.token, {
        fetchImpl: deps.fetchImpl,
      }).runReport(row.ga4_property_id!, request),
      request,
    )
  } catch (err) {
    throw attributeFailure(err, 'analytics', read.owner)
  }
  const scored = scorePageOpportunities(gscPages, landing)
  const returned = scored.rows.slice(0, limit)
  return {
    property_id: row.ga4_property_id!,
    property_name: row.ga4_property_name,
    search_console_time_zone: PACIFIC,
    analytics_time_zone: timeZone,
    rows: returned,
    total_candidates: scored.rows.length,
    scoring: {
      formula:
        'round(100 * (0.5 * demand + 0.3 * business_value + 0.2 * reachability))',
      business_value_metric: scored.engagementFallback
        ? 'engagementRate'
        : 'sessionKeyEventRate',
      engagement_fallback: scored.engagementFallback,
      score_data_limited: landing.metadata.has_limited_data,
    },
    coverage: {
      search_console_rows: gscPages.length,
      analytics_rows: landing.rows.length,
      matched_rows: scored.matched,
      unmatched_search_console_rows: scored.rows.length - scored.matched,
      unmatched_analytics_rows: scored.unmatchedAnalytics,
    },
    truncated: {
      search_console: gscPages.length >= SOURCE_ROW_LIMIT,
      analytics: landing.total_row_count > landing.rows.length,
      candidates: returned.length < scored.rows.length,
    },
    warnings: [
      ...dates.warnings,
      ...(timeZone === PACIFIC ? [] : ['source_time_zones_differ']),
      // Pages in Search Console but no organic landing page at all: usually a property newer than the window.
      ...(landing.rows.length === 0 && scored.rows.length > 0
        ? ['analytics_no_organic_landing_pages']
        : []),
      ...(landing.metadata.has_limited_data ? ['analytics_data_limited'] : []),
    ],
  }
}

/** Search opportunities for the workspace's chosen site (and property, when chosen). Throws GoogleSeoError. */
export async function getSearchOpportunities(
  svc: SupabaseClient,
  who: Who,
  input: { start_date?: string; end_date?: string; limit?: number },
  deps: GoogleSeoDeps = {},
): Promise<SearchOpportunities> {
  const limit = input.limit ?? OPPORTUNITY_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > OPPORTUNITY_MAX_LIMIT) {
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      'search_console',
      `limit is a whole number from 1 to ${OPPORTUNITY_MAX_LIMIT}.`,
    )
  }
  const range =
    checkDatePair('search_console', input.start_date, input.end_date) ??
    defaultRange(deps.now ?? new Date())
  const read = await resolveReadToken(svc, who, 'search_console', deps)
  const siteUrl = read.source.sc_site_url!
  const client = createSearchConsoleClient(read.token, {
    fetchImpl: deps.fetchImpl,
  })
  const body = (dimensions: string[]) => ({
    startDate: range.start_date,
    endDate: range.end_date,
    dimensions,
    rowLimit: SOURCE_ROW_LIMIT,
    type: 'web',
    dataState: 'final',
  })
  let queryPages: GscSearchAnalyticsRow[]
  let pages: GscSearchAnalyticsRow[]
  try {
    ;[queryPages, pages] = await Promise.all([
      client.querySearchAnalytics(siteUrl, body(['query', 'page'])),
      read.source.ga4_property_id
        ? client.querySearchAnalytics(siteUrl, body(['page']))
        : Promise.resolve([]),
    ])
  } catch (err) {
    throw attributeFailure(err, 'search_console', read.owner)
  }

  let pageResult: PageOpportunities | null = null
  let unavailable: SearchOpportunities['pages_unavailable'] = null
  if (!read.source.ga4_property_id) {
    unavailable = {
      code: 'NO_SOURCE',
      message:
        'Choose a Google Analytics property too to rank pages by what their search visitors do.',
    }
  } else {
    try {
      pageResult = await pageOpportunities(svc, who, pages, range, limit, deps)
    } catch (err) {
      // Analytics failing never costs the Search Console half.
      if (!isGoogleSeoError(err)) throw err
      unavailable = { code: err.code, message: err.message }
    }
  }

  return {
    site_url: siteUrl,
    start_date: range.start_date,
    end_date: range.end_date,
    striking_distance: buildStrikingDistanceRows(queryPages, limit),
    low_ctr: buildLowCtrRows(queryPages, limit),
    query_rows_considered: queryPages.length,
    query_rows_truncated: queryPages.length >= SOURCE_ROW_LIMIT,
    pages: pageResult,
    pages_unavailable: unavailable,
  }
}
