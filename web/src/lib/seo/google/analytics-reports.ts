/**
 * The fixed Google Analytics reports the SEO area offers, as pure functions:
 * each report's runReport body (fixed dimensions, metrics, filters and
 * order: no caller writes its own), the answer normalized (a restricted
 * metric is null, never zero; Google's limits kept), a previous-period
 * comparison, and each report's own checks (attribution quality, whether
 * there was any ecommerce or site search at all).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type {
  Ga4RunReportRequest,
  Ga4RunReportResponse,
} from './analytics-client'
import { GoogleSeoError } from './errors'
import {
  ANALYTICS_BREAKDOWNS,
  ANALYTICS_OVERVIEW_METRICS,
  metricChange,
  type AnalyticsActivity,
  type AnalyticsChannel,
  type AnalyticsComparison,
  type AnalyticsDiagnostic,
  type AnalyticsReportMetadata,
  type AnalyticsReportName,
  type AnalyticsRow,
} from './view'

/** The table reports (overview and measurement health have their own builders). */
export type TableReportName = Exclude<
  AnalyticsReportName,
  'organic_overview' | 'measurement_health'
>

/** How many rows a whole-report read takes (comparisons, and reports judged as a whole). */
export const COMPLETE_REPORT_LIMIT = 1000

export interface TableReportSpec {
  report: TableReportName
  start_date: string
  end_date: string
  channel: AnalyticsChannel
  limit: number
  offset: number
  breakdown: string
  include_date: boolean
  only_with_transactions: boolean
}

const DEFINITIONS: Record<
  TableReportName,
  { dimensions: readonly string[]; metrics: readonly string[]; order: string }
> = {
  organic_landing_pages: {
    dimensions: ['hostName', 'landingPage'],
    metrics: [
      'sessions',
      'activeUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'sessionKeyEventRate',
      'transactions',
      'purchaseRevenue',
    ],
    order: 'sessions',
  },
  page_performance: {
    dimensions: ['hostName', 'pagePath'],
    metrics: [
      'screenPageViews',
      'activeUsers',
      'userEngagementDuration',
      'keyEvents',
    ],
    order: 'screenPageViews',
  },
  key_events: {
    dimensions: ['eventName'],
    metrics: ['keyEvents', 'totalUsers'],
    order: 'keyEvents',
  },
  traffic_acquisition: {
    dimensions: ['sessionDefaultChannelGroup'],
    metrics: [
      'sessions',
      'activeUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'transactions',
      'purchaseRevenue',
    ],
    order: 'sessions',
  },
  ecommerce_performance: {
    dimensions: ['itemName', 'itemId'],
    metrics: [
      'itemsViewed',
      'itemsAddedToCart',
      'itemsPurchased',
      'itemRevenue',
    ],
    order: 'itemRevenue',
  },
  site_search: {
    dimensions: ['searchTerm'],
    metrics: [
      'eventCount',
      'activeUsers',
      'sessions',
      'engagedSessions',
      'engagementRate',
    ],
    order: 'eventCount',
  },
  audience_breakdown: {
    dimensions: ['deviceCategory'],
    metrics: ['activeUsers', 'sessions', 'engagementRate', 'keyEvents'],
    order: 'activeUsers',
  },
}

const ACQUISITION_DIMENSION: Record<string, string> = {
  channel_group: 'sessionDefaultChannelGroup',
  source_medium: 'sessionSourceMedium',
  campaign: 'sessionCampaignName',
}
const AUDIENCE_DIMENSION: Record<string, string> = {
  device: 'deviceCategory',
  country: 'country',
  new_vs_returning: 'newVsReturning',
}

/** The breakdown a report runs with: the given one if the report takes it, else its default. Throws INVALID_REQUEST for one it doesn't take. */
export function reportBreakdown(
  report: TableReportName,
  breakdown: string | undefined,
): string {
  const allowed = (ANALYTICS_BREAKDOWNS as Record<string, readonly string[]>)[
    report
  ]
  if (!allowed) {
    if (breakdown)
      throw new GoogleSeoError(
        'INVALID_REQUEST',
        'analytics',
        `The ${report.replace(/_/g, ' ')} report takes no breakdown.`,
      )
    return report === 'organic_landing_pages'
      ? 'landing_page'
      : report === 'page_performance'
        ? 'page'
        : 'search_term'
  }
  if (!breakdown) return allowed[0]
  if (!allowed.includes(breakdown))
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      'analytics',
      `Breakdowns for this report: ${allowed.join(', ')}.`,
    )
  return breakdown
}

function definition(spec: Pick<TableReportSpec, 'report' | 'breakdown'>) {
  if (
    spec.report === 'ecommerce_performance' &&
    spec.breakdown === 'landing_page'
  ) {
    return {
      dimensions: ['hostName', 'landingPage'],
      metrics: ['sessions', 'transactions', 'purchaseRevenue'],
      order: 'purchaseRevenue',
    }
  }
  return DEFINITIONS[spec.report]
}

export function reportDimensions(
  spec: Pick<TableReportSpec, 'report' | 'breakdown' | 'include_date'>,
): string[] {
  if (spec.report === 'traffic_acquisition')
    return [ACQUISITION_DIMENSION[spec.breakdown]]
  if (spec.report === 'audience_breakdown')
    return [AUDIENCE_DIMENSION[spec.breakdown]]
  const dimensions = [...definition(spec).dimensions]
  if (spec.report === 'page_performance' && spec.include_date)
    dimensions.push('date')
  if (
    spec.report === 'key_events' &&
    spec.breakdown === 'event_and_landing_page'
  )
    dimensions.push('hostName', 'landingPage')
  return dimensions
}

export function reportMetrics(
  spec: Pick<TableReportSpec, 'report' | 'breakdown'>,
): string[] {
  return [...definition(spec).metrics]
}

function stringFilter(fieldName: string, value: string) {
  return { filter: { fieldName, stringFilter: { matchType: 'EXACT', value } } }
}

const ORGANIC = stringFilter('sessionDefaultChannelGroup', 'Organic Search')

function dimensionFilter(spec: TableReportSpec): unknown {
  if (spec.report === 'site_search') {
    return {
      andGroup: {
        expressions: [
          stringFilter('eventName', 'view_search_results'),
          { notExpression: stringFilter('searchTerm', '(not set)') },
        ],
      },
    }
  }
  return spec.channel === 'organic_search' ? ORGANIC : undefined
}

function positive(fieldName: string) {
  return {
    filter: {
      fieldName,
      numericFilter: { operation: 'GREATER_THAN', value: { doubleValue: 0 } },
    },
  }
}

function metricFilter(spec: TableReportSpec): unknown {
  if (spec.report === 'key_events') return positive('keyEvents')
  if (
    spec.report === 'ecommerce_performance' &&
    spec.breakdown === 'landing_page' &&
    spec.only_with_transactions
  )
    return positive('transactions')
  return undefined
}

/** The runReport body for a table report. Pure. */
export function buildReportRequest(spec: TableReportSpec): Ga4RunReportRequest {
  const def = definition(spec)
  const filter = dimensionFilter(spec)
  const metric = metricFilter(spec)
  return {
    dateRanges: [{ startDate: spec.start_date, endDate: spec.end_date }],
    dimensions: reportDimensions(spec).map((name) => ({ name })),
    metrics: def.metrics.map((name) => ({ name })),
    ...(filter ? { dimensionFilter: filter } : {}),
    ...(metric ? { metricFilter: metric } : {}),
    offset: String(spec.offset),
    limit: String(spec.limit),
    orderBys: [{ metric: { metricName: def.order }, desc: true }],
    keepEmptyRows: false,
    returnPropertyQuota: true,
  }
}

/** The organic overview's body: one summary row, or a daily or weekly trend. Pure. */
export function buildOverviewRequest(
  range: { start_date: string; end_date: string },
  trend?: 'daily' | 'weekly',
): Ga4RunReportRequest {
  const dimension = trend ? (trend === 'daily' ? 'date' : 'yearWeek') : null
  return {
    dateRanges: [{ startDate: range.start_date, endDate: range.end_date }],
    dimensions: dimension ? [{ name: dimension }] : [],
    metrics: ANALYTICS_OVERVIEW_METRICS.map((name) => ({ name })),
    dimensionFilter: ORGANIC,
    offset: '0',
    limit: trend ? '1000' : '1',
    orderBys: dimension ? [{ dimension: { dimensionName: dimension } }] : [],
    keepEmptyRows: false,
    returnPropertyQuota: true,
  }
}

/** Comparisons only where both periods' rows line up on a short, stable key. */
export function supportsComparison(
  report: TableReportName,
  breakdown: string,
): boolean {
  if (report === 'key_events') return breakdown === 'event'
  if (report === 'traffic_acquisition') return breakdown === 'channel_group'
  if (report === 'audience_breakdown')
    return breakdown === 'device' || breakdown === 'new_vs_returning'
  return false
}

/** Reports read whole (then paged here), because they are judged as a whole or compared. */
export function needsCompleteReport(
  report: TableReportName,
  breakdown: string,
  compare: boolean,
): boolean {
  return (
    compare ||
    (report === 'traffic_acquisition' && breakdown === 'source_medium') ||
    report === 'ecommerce_performance' ||
    report === 'site_search'
  )
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface NormalizedReport {
  rows: AnalyticsRow[]
  total_row_count: number
  metadata: AnalyticsReportMetadata
}

function malformed(): GoogleSeoError {
  return new GoogleSeoError(
    'UPSTREAM',
    'analytics',
    'Google Analytics sent a report we couldn’t read. Try again in a moment.',
    { detail: 'report shape' },
  )
}

/**
 * Rows keyed by Google's dimension and metric names, metrics as numbers; a
 * restricted metric is null. Headers must be the ones asked for, except the
 * answer to a window the property has no data for at all (no headers, no
 * rows), which is an empty report. Pure; throws UPSTREAM on a malformed one.
 */
export function normalizeReport(
  response: Ga4RunReportResponse,
  request: Ga4RunReportRequest,
): NormalizedReport {
  const expectedDimensions = request.dimensions.map((d) => d.name)
  const expectedMetrics = request.metrics.map((m) => m.name)
  const dimensions = (response.dimensionHeaders ?? []).map((h) => h.name)
  const metrics = (response.metricHeaders ?? []).map((h) => h.name)
  const headerless =
    response.dimensionHeaders === undefined &&
    response.metricHeaders === undefined &&
    (response.rows?.length ?? 0) === 0
  if (
    !headerless &&
    (dimensions.join('\0') !== expectedDimensions.join('\0') ||
      metrics.join('\0') !== expectedMetrics.join('\0'))
  )
    throw malformed()

  const restricted = (
    response.metadata?.schemaRestrictionResponse?.activeMetricRestrictions ?? []
  ).map((r) => ({
    metric_name: r.metricName,
    restricted_metric_types: r.restrictedMetricTypes ?? [],
  }))
  const restrictedNames = new Set(restricted.map((r) => r.metric_name))
  const rows = (response.rows ?? []).map((row) => {
    if (
      (row.dimensionValues?.length ?? 0) !== dimensions.length ||
      (row.metricValues?.length ?? 0) !== metrics.length
    )
      throw malformed()
    const out: AnalyticsRow = {}
    dimensions.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? ''
    })
    metrics.forEach((name, i) => {
      if (restrictedNames.has(name)) {
        out[name] = null
        return
      }
      const value = Number(row.metricValues?.[i]?.value ?? '')
      if (!Number.isFinite(value)) throw malformed()
      out[name] = value
    })
    return out
  })
  const sampling = (response.metadata?.samplingMetadatas ?? []).map((s) => ({
    samples_read_count: s.samplesReadCount,
    sampling_space_size: s.samplingSpaceSize,
  }))
  const otherRow = response.metadata?.dataLossFromOtherRow ?? false
  const thresholded = response.metadata?.subjectToThresholding ?? false
  return {
    rows,
    total_row_count: response.rowCount ?? rows.length,
    metadata: {
      data_loss_from_other_row: otherRow,
      subject_to_thresholding: thresholded,
      sampling,
      restricted_metrics: restricted,
      empty_reason: response.metadata?.emptyReason ?? null,
      has_limited_data:
        otherRow || thresholded || sampling.length > 0 || restricted.length > 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Comparison and each report's own checks
// ---------------------------------------------------------------------------

function metricValue(
  row: AnalyticsRow | undefined,
  metric: string,
): number | null {
  const value = row?.[metric]
  return typeof value === 'number' ? value : null
}

/** Two periods' rows lined up on their dimensions, each metric now and before. Pure. */
export function buildComparison(args: {
  current: NormalizedReport
  previous: NormalizedReport
  previousRange: { start_date: string; end_date: string }
  dimensions: string[]
  metrics: string[]
}): AnalyticsComparison {
  const key = (row: AnalyticsRow) =>
    JSON.stringify(args.dimensions.map((d) => row[d] ?? null))
  const current = new Map(args.current.rows.map((r) => [key(r), r]))
  const previous = new Map(args.previous.rows.map((r) => [key(r), r]))
  const keys = [
    ...current.keys(),
    ...[...previous.keys()].filter((k) => !current.has(k)),
  ]
  return {
    previous_date_range: args.previousRange,
    dimensions: args.dimensions,
    metrics: args.metrics,
    rows: keys.map((k) => {
      const c = current.get(k)
      const p = previous.get(k)
      return {
        dimensions: Object.fromEntries(
          args.dimensions.map((d) => [d, c?.[d] ?? p?.[d] ?? null]),
        ),
        metrics: Object.fromEntries(
          args.metrics.map((m) => [
            m,
            metricChange(metricValue(c, m), metricValue(p, m)),
          ]),
        ),
      }
    }),
    complete:
      args.current.rows.length === args.current.total_row_count &&
      args.previous.rows.length === args.previous.total_row_count,
    has_limited_data:
      args.current.metadata.has_limited_data ||
      args.previous.metadata.has_limited_data,
  }
}

/** A source that is this machine or a private network (test traffic counted as referrals). Pure. */
export function isInternalHost(value: string): boolean {
  const source = value.split(' / ')[0]?.toLowerCase() ?? ''
  const bare = source.replace(/^https?:\/\//, '')
  if (bare === '::1' || bare.startsWith('[::1]')) return true
  const host = bare.split(':')[0] ?? ''
  if (host === 'localhost' || host.startsWith('127.')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p)))
    return false
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  )
}

function sum(rows: readonly AnalyticsRow[], metric: string): number {
  return rows.reduce((total, row) => total + (metricValue(row, metric) ?? 0), 0)
}

/** Source / medium quality: unattributed sessions, internal referrals, values that differ only by case. Pure. */
export function attributionDiagnostics(
  report: NormalizedReport,
): AnalyticsDiagnostic[] {
  if (
    report.rows.length !== report.total_row_count ||
    report.metadata.has_limited_data
  )
    return []
  const out: AnalyticsDiagnostic[] = []
  const sessions = sum(report.rows, 'sessions')
  const notSet = sum(
    report.rows.filter((r) => r.sessionSourceMedium === '(not set)'),
    'sessions',
  )
  const share = sessions > 0 ? notSet / sessions : 0
  if (share >= 0.05) {
    out.push({
      code: 'attribution_not_set_share_high',
      severity: 'warning',
      message: 'A notable share of sessions has no source / medium.',
      evidence: { sessions: notSet, total_sessions: sessions, share },
    })
  }
  const internal = report.rows.filter(
    (r) =>
      typeof r.sessionSourceMedium === 'string' &&
      isInternalHost(r.sessionSourceMedium),
  )
  const internalSessions = sum(internal, 'sessions')
  if (internalSessions > 0) {
    out.push({
      code: 'internal_referral_traffic_detected',
      severity: 'warning',
      message:
        'Local or private-network sources appear as referrals (test traffic is being counted).',
      evidence: { sessions: internalSessions, sources: internal.length },
    })
  }
  const byLower = new Map<string, Set<string>>()
  for (const row of report.rows) {
    if (typeof row.sessionSourceMedium !== 'string') continue
    const k = row.sessionSourceMedium.toLowerCase()
    byLower.set(k, (byLower.get(k) ?? new Set()).add(row.sessionSourceMedium))
  }
  const variants = [...byLower.values()].filter((v) => v.size > 1).length
  if (variants > 0) {
    out.push({
      code: 'source_medium_case_variants_detected',
      severity: 'info',
      message:
        'Some source / medium values differ only by letter case (one source counted as several).',
      evidence: { groups: variants },
    })
  }
  return out
}

function activityStatus(
  report: NormalizedReport,
  detected: boolean,
): AnalyticsActivity['status'] {
  if (
    report.metadata.has_limited_data ||
    report.rows.length !== report.total_row_count
  )
    return 'unknown'
  return detected ? 'detected' : 'none'
}

/** Whether there was any ecommerce at all in the window. Pure. */
export function ecommerceActivity(
  report: NormalizedReport,
  breakdown: string,
): AnalyticsActivity {
  const metrics =
    breakdown === 'item'
      ? ['itemsViewed', 'itemsAddedToCart', 'itemsPurchased', 'itemRevenue']
      : ['transactions', 'purchaseRevenue']
  const evidence = Object.fromEntries(
    metrics.map((m) => [m, sum(report.rows, m)]),
  )
  const status = activityStatus(
    report,
    Object.values(evidence).some((v) => v > 0),
  )
  return {
    status,
    evidence,
    reason:
      status === 'none'
        ? 'No ecommerce activity was reported for this window and channel.'
        : status === 'unknown'
          ? 'The report is incomplete or limited, so whether there was ecommerce can’t be told.'
          : null,
  }
}

/** Whether visitors searched the site at all in the window. Pure. */
export function siteSearchActivity(
  report: NormalizedReport,
): AnalyticsActivity {
  const events = sum(report.rows, 'eventCount')
  const status = activityStatus(report, events > 0)
  return {
    status,
    evidence: { search_terms: report.total_row_count, search_events: events },
    reason:
      status === 'none'
        ? 'No site searches were measured for this window (site-search measurement may be off).'
        : status === 'unknown'
          ? 'The report is incomplete or limited, so site-search activity can’t be told.'
          : null,
  }
}

/** A sharp fall in organic key events against the period before (at least 5 before, down by half or more). Pure. */
export function keyEventDecline(
  current: AnalyticsRow | null,
  previous: AnalyticsRow | null,
  limited: boolean,
): AnalyticsDiagnostic[] {
  if (limited) return []
  const now = metricValue(current ?? undefined, 'keyEvents')
  const before = metricValue(previous ?? undefined, 'keyEvents')
  if (now == null || before == null || before < 5) return []
  const change = (now - before) / before
  if (change > -0.5) return []
  return [
    {
      code: 'key_events_sharp_decline',
      severity: 'warning',
      message: 'Organic key events fell sharply against the period before.',
      evidence: { current: now, previous: before, percent_change: change },
    },
  ]
}
