/**
 * Google Analytics reports for the workspace's chosen property: the fixed
 * reports of ./analytics-reports.ts run through the connection the
 * workspace's choice names (./token.ts), dated in the property's own time
 * zone. Nothing is stored; every read asks Google, which costs nothing.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { createAnalyticsClient, type AnalyticsClient } from './analytics-client'
import {
  attributionDiagnostics,
  buildComparison,
  buildOverviewRequest,
  buildReportRequest,
  COMPLETE_REPORT_LIMIT,
  ecommerceActivity,
  keyEventDecline,
  needsCompleteReport,
  normalizeReport,
  reportBreakdown,
  reportDimensions,
  reportMetrics,
  siteSearchActivity,
  supportsComparison,
  type TableReportName,
  type TableReportSpec,
} from './analytics-reports'
import { previousPeriod, resolveAnalyticsRange } from './dates'
import { GoogleSeoError } from './errors'
import type { GoogleSeoDeps } from './search-console'
import { attributeFailure, resolveReadToken, type ReadToken } from './token'
import {
  ANALYTICS_CHANNEL_REPORTS,
  ANALYTICS_CHANNELS,
  ANALYTICS_DEFAULT_LIMIT,
  ANALYTICS_MAX_LIMIT,
  ANALYTICS_OVERVIEW_METRICS,
  isAnalyticsReportName,
  metricChange,
  type AnalyticsChannel,
  type AnalyticsOverviewReport,
  type AnalyticsReport,
  type AnalyticsReportInput,
  type AnalyticsSourceInfo,
  type AnalyticsTableReport,
  type MeasurementHealthReport,
} from './view'

type Who = { workspaceId: string; userId: string | null }

interface Session {
  read: ReadToken
  client: AnalyticsClient
  source: AnalyticsSourceInfo
}

async function openSession(
  svc: SupabaseClient,
  who: Who,
  deps: GoogleSeoDeps,
): Promise<Session> {
  const read = await resolveReadToken(svc, who, 'analytics', deps)
  const row = read.source
  return {
    read,
    client: createAnalyticsClient(read.token, { fetchImpl: deps.fetchImpl }),
    source: {
      property_id: row.ga4_property_id!,
      property_name: row.ga4_property_name,
      // Chosen before its time zone was known (never, today): report in UTC rather than refuse.
      time_zone: row.ga4_time_zone || 'UTC',
      currency_code: row.ga4_currency_code,
    },
  }
}

function invalid(message: string): GoogleSeoError {
  return new GoogleSeoError('INVALID_REQUEST', 'analytics', message)
}

function checkedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const n = value ?? fallback
  if (!Number.isInteger(n) || n < min || n > max)
    throw invalid(`${name} is a whole number from ${min} to ${max}.`)
  return n
}

/**
 * The channel a report runs on: organic search by default; `all` only for
 * the reports that offer it; acquisition and site search always look at
 * every channel; landing pages are organic only.
 */
function reportChannel(
  report: TableReportName,
  asked: AnalyticsChannel | undefined,
): AnalyticsChannel {
  if (asked && !(ANALYTICS_CHANNELS as readonly string[]).includes(asked))
    throw invalid('channel is organic_search or all.')
  if (report === 'traffic_acquisition' || report === 'site_search') return 'all'
  if (report === 'organic_landing_pages') {
    if (asked === 'all')
      throw invalid(
        'Landing pages are read for organic search only. Use page_performance for every channel.',
      )
    return 'organic_search'
  }
  return ANALYTICS_CHANNEL_REPORTS.includes(report)
    ? (asked ?? 'organic_search')
    : 'organic_search'
}

async function runTableReport(
  session: Session,
  report: TableReportName,
  input: AnalyticsReportInput,
  now: Date,
): Promise<AnalyticsTableReport> {
  const limit = checkedInt(
    input.limit,
    ANALYTICS_DEFAULT_LIMIT,
    1,
    ANALYTICS_MAX_LIMIT,
    'limit',
  )
  const offset = checkedInt(input.offset, 0, 0, 10_000_000, 'offset')
  const breakdown = reportBreakdown(report, input.breakdown)
  const channel = reportChannel(report, input.channel)
  const compare = input.compare_previous_period === true
  if (compare && !supportsComparison(report, breakdown)) {
    throw invalid(
      'The period-before comparison is for key events by event, acquisition by channel group, and audience by device or new versus returning.',
    )
  }
  if (input.include_date && report !== 'page_performance')
    throw invalid('include_date is for page_performance.')
  if (
    input.only_with_transactions &&
    !(report === 'ecommerce_performance' && breakdown === 'landing_page')
  ) {
    throw invalid(
      'only_with_transactions is for ecommerce_performance by landing_page.',
    )
  }
  const dates = resolveAnalyticsRange(input, session.source.time_zone, now)
  const whole = needsCompleteReport(report, breakdown, compare)
  const spec: TableReportSpec = {
    report,
    ...dates.range,
    channel,
    limit: whole ? COMPLETE_REPORT_LIMIT : limit,
    offset: whole ? 0 : offset,
    breakdown,
    include_date: input.include_date === true,
    only_with_transactions: input.only_with_transactions === true,
  }
  const request = buildReportRequest(spec)
  const previousRange = compare ? previousPeriod(dates.range) : null
  const previousRequest = previousRange
    ? buildReportRequest({
        ...spec,
        ...previousRange,
        limit: COMPLETE_REPORT_LIMIT,
        offset: 0,
      })
    : null
  const property = session.source.property_id

  const [response, previousResponse] = await Promise.all([
    session.client.runReport(property, request),
    previousRequest
      ? session.client.runReport(property, previousRequest)
      : Promise.resolve(null),
  ])
  const normalized = normalizeReport(response, request)

  // A whole-report read is paged here; a page past what it holds is read on its own.
  let rows = whole
    ? normalized.rows.slice(offset, offset + limit)
    : normalized.rows
  if (
    whole &&
    normalized.total_row_count > normalized.rows.length &&
    offset + limit > normalized.rows.length
  ) {
    const pageRequest = {
      ...request,
      offset: String(offset),
      limit: String(limit),
    }
    rows = normalizeReport(
      await session.client.runReport(property, pageRequest),
      pageRequest,
    ).rows
  }
  const next = offset + rows.length
  const hasMore = next < normalized.total_row_count
  const dimensions = reportDimensions(spec)
  const metrics = reportMetrics(spec)
  const comparison =
    previousResponse && previousRequest && previousRange
      ? buildComparison({
          current: normalized,
          previous: normalizeReport(previousResponse, previousRequest),
          previousRange,
          dimensions,
          metrics,
        })
      : null
  const activity =
    report === 'ecommerce_performance'
      ? ecommerceActivity(normalized, breakdown)
      : report === 'site_search'
        ? siteSearchActivity(normalized)
        : null
  const diagnostics =
    report === 'traffic_acquisition' && breakdown === 'source_medium'
      ? attributionDiagnostics(normalized)
      : activity?.status === 'none'
        ? [
            {
              code:
                report === 'site_search'
                  ? 'no_site_search_activity'
                  : 'no_ecommerce_activity',
              severity: 'info' as const,
              message: activity.reason ?? '',
              evidence: activity.evidence,
            },
          ]
        : []

  return {
    kind: 'table',
    report,
    source: session.source,
    request: {
      requested_date_range: dates.requested,
      date_range: dates.range,
      channel,
      breakdown,
      dimensions,
      metrics,
      limit,
      offset,
    },
    row_count: rows.length,
    total_row_count: normalized.total_row_count,
    rows,
    page: {
      offset,
      limit,
      has_more: hasMore,
      next_offset: hasMore ? next : null,
    },
    metadata: normalized.metadata,
    warnings: [
      ...dates.warnings,
      ...(comparison && !comparison.complete ? ['comparison_incomplete'] : []),
    ],
    diagnostics,
    comparison,
    activity,
  }
}

async function organicOverview(
  session: Session,
  input: AnalyticsReportInput,
  now: Date,
): Promise<AnalyticsOverviewReport> {
  if (input.trend && input.trend !== 'daily' && input.trend !== 'weekly')
    throw invalid('trend is daily or weekly.')
  const dates = resolveAnalyticsRange(input, session.source.time_zone, now)
  const previousRange = previousPeriod(dates.range)
  const trend = input.trend ?? 'daily'
  const currentRequest = buildOverviewRequest(dates.range)
  const previousRequest = buildOverviewRequest(previousRange)
  const trendRequest = buildOverviewRequest(dates.range, trend)
  const property = session.source.property_id
  const [c, p, t] = await Promise.all([
    session.client.runReport(property, currentRequest),
    session.client.runReport(property, previousRequest),
    session.client.runReport(property, trendRequest),
  ])
  const current = normalizeReport(c, currentRequest)
  const previous = normalizeReport(p, previousRequest)
  const trendReport = normalizeReport(t, trendRequest)
  const currentRow = current.rows[0] ?? null
  const previousRow = previous.rows[0] ?? null
  const limited = [current, previous, trendReport].some(
    (r) => r.metadata.has_limited_data,
  )
  const num = (row: typeof currentRow, m: string) =>
    typeof row?.[m] === 'number' ? (row[m] as number) : null
  return {
    kind: 'overview',
    report: 'organic_overview',
    source: session.source,
    request: {
      requested_date_range: dates.requested,
      date_range: dates.range,
      previous_date_range: previousRange,
      channel: 'organic_search',
      trend,
    },
    current: currentRow,
    previous: previousRow,
    comparison: Object.fromEntries(
      ANALYTICS_OVERVIEW_METRICS.map((m) => [
        m,
        metricChange(num(currentRow, m), num(previousRow, m)),
      ]),
    ),
    trend: trendReport.rows,
    diagnostics: keyEventDecline(currentRow, previousRow, limited),
    has_limited_data: limited,
    warnings: [
      ...dates.warnings,
      ...(trendReport.total_row_count > trendReport.rows.length
        ? ['trend_truncated']
        : []),
    ],
  }
}

async function measurementHealth(
  session: Session,
): Promise<MeasurementHealthReport> {
  const property = session.source.property_id
  const streams = await session.client.listDataStreams(property)
  const webStreams: MeasurementHealthReport['web_streams'] = []
  for (const stream of streams) {
    if (stream.type !== 'WEB_DATA_STREAM') continue
    const enhanced = await session.client.getEnhancedMeasurementSettings(
      stream.name,
    )
    webStreams.push({
      stream_id: stream.name.split('/').at(-1) ?? stream.name,
      display_name: stream.displayName,
      measurement_id: stream.webStreamData?.measurementId ?? null,
      default_uri: stream.webStreamData?.defaultUri ?? null,
      enhanced_measurement: enhanced,
    })
  }
  const [keyEvents, dimensions, metrics] = await Promise.all([
    session.client.listKeyEvents(property),
    session.client.listCustomDimensions(property),
    session.client.listCustomMetrics(property),
  ])
  const issues: string[] = []
  if (webStreams.length === 0) issues.push('no_web_stream')
  if (
    webStreams.length > 0 &&
    webStreams.every((s) => !s.enhanced_measurement.streamEnabled)
  )
    issues.push('enhanced_measurement_disabled')
  if (
    webStreams.length > 0 &&
    webStreams.every(
      (s) =>
        !s.enhanced_measurement.streamEnabled ||
        !s.enhanced_measurement.siteSearchEnabled,
    )
  ) {
    issues.push('site_search_measurement_disabled')
  }
  if (keyEvents.length === 0) issues.push('no_key_events_configured')
  return {
    kind: 'measurement_health',
    report: 'measurement_health',
    source: session.source,
    summary: {
      data_streams: streams.length,
      web_streams: webStreams.length,
      key_events: keyEvents.length,
      custom_dimensions: dimensions.length,
      custom_metrics: metrics.length,
      issues: issues.length,
    },
    issues,
    web_streams: webStreams,
    other_streams: streams
      .filter((s) => s.type !== 'WEB_DATA_STREAM')
      .map((s) => ({
        stream_id: s.name.split('/').at(-1) ?? s.name,
        type: s.type,
        display_name: s.displayName,
      })),
    key_events: keyEvents.map((k) => ({
      event_name: k.eventName,
      counting_method: k.countingMethod,
      custom: k.custom ?? null,
    })),
    custom_dimensions: dimensions.map((d) => ({
      parameter_name: d.parameterName,
      display_name: d.displayName,
      scope: d.scope,
    })),
    custom_metrics: metrics.map((m) => ({
      parameter_name: m.parameterName,
      display_name: m.displayName,
      scope: m.scope,
      measurement_unit: m.measurementUnit,
    })),
  }
}

/** One Google Analytics report for the workspace's chosen property. Throws GoogleSeoError. */
export async function runAnalyticsReport(
  svc: SupabaseClient,
  who: Who,
  input: AnalyticsReportInput,
  deps: GoogleSeoDeps = {},
): Promise<AnalyticsReport> {
  if (!isAnalyticsReportName(input.report)) throw invalid('Unknown report.')
  const now = deps.now ?? new Date()
  const session = await openSession(svc, who, deps)
  try {
    if (input.report === 'organic_overview')
      return await organicOverview(session, input, now)
    if (input.report === 'measurement_health')
      return await measurementHealth(session)
    return await runTableReport(session, input.report, input, now)
  } catch (err) {
    throw attributeFailure(err, 'analytics', session.read.owner)
  }
}
