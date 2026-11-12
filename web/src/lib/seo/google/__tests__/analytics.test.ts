/**
 * Google Analytics reports: the exact runReport body each fixed report
 * sends, normalization (a restricted metric is null, never zero; a property
 * with no data at all is an empty report; a header mismatch is refused), the
 * period-before comparison, each report's own checks, the date window in the
 * property's time zone, and the reads end to end.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { runAnalyticsReport } from '../analytics'
import {
  attributionDiagnostics,
  buildComparison,
  buildOverviewRequest,
  buildReportRequest,
  ecommerceActivity,
  isInternalHost,
  keyEventDecline,
  normalizeReport,
  reportBreakdown,
  type TableReportSpec,
} from '../analytics-reports'
import { resolveAnalyticsRange } from '../dates'
import { GoogleSeoError } from '../errors'
import {
  ALEX,
  BEA,
  chosenSource,
  fakeFetch,
  googleError,
  json,
  on,
  report,
  tokenFor,
  workspace,
  WS,
} from './fixtures'

const NOW = new Date('2026-11-12T15:00:00Z')
const spec = (over: Partial<TableReportSpec>): TableReportSpec => ({
  report: 'organic_landing_pages',
  start_date: '2026-10-01',
  end_date: '2026-10-28',
  channel: 'organic_search',
  limit: 100,
  offset: 0,
  breakdown: 'landing_page',
  include_date: false,
  only_with_transactions: false,
  ...over,
})
const ORGANIC = {
  filter: {
    fieldName: 'sessionDefaultChannelGroup',
    stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
  },
}

async function failureOf(p: Promise<unknown>): Promise<GoogleSeoError> {
  try {
    await p
  } catch (err) {
    if (err instanceof GoogleSeoError) return err
    throw err
  }
  throw new Error('expected a failure')
}

beforeEach(() => {
  tokenFor.mockClear()
})

describe('report requests', () => {
  it('organic landing pages: fixed dimensions, metrics, organic filter, sessions first', () => {
    expect(buildReportRequest(spec({}))).toEqual({
      dateRanges: [{ startDate: '2026-10-01', endDate: '2026-10-28' }],
      dimensions: [{ name: 'hostName' }, { name: 'landingPage' }],
      metrics: [
        'sessions',
        'activeUsers',
        'engagedSessions',
        'engagementRate',
        'keyEvents',
        'sessionKeyEventRate',
        'transactions',
        'purchaseRevenue',
      ].map((name) => ({ name })),
      dimensionFilter: ORGANIC,
      offset: '0',
      limit: '100',
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      keepEmptyRows: false,
      returnPropertyQuota: true,
    })
  })

  it('page performance: a date dimension on request, no filter on every channel', () => {
    const req = buildReportRequest(
      spec({
        report: 'page_performance',
        breakdown: 'page',
        include_date: true,
        channel: 'all',
      }),
    )
    expect(req.dimensions.map((d) => d.name)).toEqual([
      'hostName',
      'pagePath',
      'date',
    ])
    expect(req.dimensionFilter).toBeUndefined()
    expect(req.orderBys).toEqual([
      { metric: { metricName: 'screenPageViews' }, desc: true },
    ])
  })

  it('key events: only events that counted, by event and landing page on request', () => {
    const req = buildReportRequest(
      spec({ report: 'key_events', breakdown: 'event_and_landing_page' }),
    )
    expect(req.dimensions.map((d) => d.name)).toEqual([
      'eventName',
      'hostName',
      'landingPage',
    ])
    expect(req.metricFilter).toEqual({
      filter: {
        fieldName: 'keyEvents',
        numericFilter: { operation: 'GREATER_THAN', value: { doubleValue: 0 } },
      },
    })
  })

  it('acquisition and audience swap their one dimension by breakdown', () => {
    expect(
      buildReportRequest(
        spec({
          report: 'traffic_acquisition',
          breakdown: 'source_medium',
          channel: 'all',
        }),
      ).dimensions,
    ).toEqual([{ name: 'sessionSourceMedium' }])
    expect(
      buildReportRequest(
        spec({ report: 'audience_breakdown', breakdown: 'new_vs_returning' }),
      ).dimensions,
    ).toEqual([{ name: 'newVsReturning' }])
  })

  it('ecommerce by landing page with transactions only; site search filters to real search terms', () => {
    const shop = buildReportRequest(
      spec({
        report: 'ecommerce_performance',
        breakdown: 'landing_page',
        only_with_transactions: true,
      }),
    )
    expect(shop.metrics.map((m) => m.name)).toEqual([
      'sessions',
      'transactions',
      'purchaseRevenue',
    ])
    expect(shop.metricFilter).toMatchObject({
      filter: { fieldName: 'transactions' },
    })
    const search = buildReportRequest(
      spec({ report: 'site_search', breakdown: 'search_term', channel: 'all' }),
    )
    expect(search.dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: 'eventName',
              stringFilter: {
                matchType: 'EXACT',
                value: 'view_search_results',
              },
            },
          },
          {
            notExpression: {
              filter: {
                fieldName: 'searchTerm',
                stringFilter: { matchType: 'EXACT', value: '(not set)' },
              },
            },
          },
        ],
      },
    })
  })

  it('the overview: one summary row, or a trend ordered by its dimension', () => {
    expect(
      buildOverviewRequest({
        start_date: '2026-10-01',
        end_date: '2026-10-28',
      }),
    ).toMatchObject({
      dimensions: [],
      limit: '1',
      orderBys: [],
      dimensionFilter: ORGANIC,
    })
    expect(
      buildOverviewRequest(
        { start_date: '2026-10-01', end_date: '2026-10-28' },
        'weekly',
      ),
    ).toMatchObject({
      dimensions: [{ name: 'yearWeek' }],
      limit: '1000',
      orderBys: [{ dimension: { dimensionName: 'yearWeek' } }],
    })
  })

  it('a breakdown the report doesn’t take is refused', () => {
    expect(reportBreakdown('key_events', undefined)).toBe('event')
    expect(() => reportBreakdown('key_events', 'device')).toThrow(
      GoogleSeoError,
    )
    expect(() => reportBreakdown('site_search', 'item')).toThrow(
      /takes no breakdown/,
    )
  })
})

describe('normalizeReport', () => {
  const req = buildReportRequest(
    spec({ report: 'ecommerce_performance', breakdown: 'landing_page' }),
  )
  const body = (over: Record<string, unknown> = {}) => ({
    dimensionHeaders: [{ name: 'hostName' }, { name: 'landingPage' }],
    metricHeaders: [
      { name: 'sessions' },
      { name: 'transactions' },
      { name: 'purchaseRevenue' },
    ],
    rows: [
      {
        dimensionValues: [{ value: 'example.com' }, { value: '/rugs' }],
        metricValues: [{ value: '10' }, { value: '0' }, { value: '0' }],
      },
    ],
    rowCount: 1,
    ...over,
  })

  it('a restricted metric is null, never zero, and marks the report limited', () => {
    const out = normalizeReport(
      body({
        metadata: {
          schemaRestrictionResponse: {
            activeMetricRestrictions: [
              {
                metricName: 'purchaseRevenue',
                restrictedMetricTypes: ['REVENUE_DATA'],
              },
            ],
          },
        },
      }),
      req,
    )
    expect(out.rows[0]).toEqual({
      hostName: 'example.com',
      landingPage: '/rugs',
      sessions: 10,
      transactions: 0,
      purchaseRevenue: null,
    })
    expect(out.metadata.has_limited_data).toBe(true)
    expect(out.metadata.restricted_metrics).toEqual([
      {
        metric_name: 'purchaseRevenue',
        restricted_metric_types: ['REVENUE_DATA'],
      },
    ])
  })

  it('thresholding, sampling and an "(other)" row each mark it limited', () => {
    expect(
      normalizeReport(body({ metadata: { subjectToThresholding: true } }), req)
        .metadata.has_limited_data,
    ).toBe(true)
    expect(
      normalizeReport(body({ metadata: { dataLossFromOtherRow: true } }), req)
        .metadata.has_limited_data,
    ).toBe(true)
    expect(
      normalizeReport(
        body({
          metadata: {
            samplingMetadatas: [
              { samplesReadCount: '10', samplingSpaceSize: '100' },
            ],
          },
        }),
        req,
      ).metadata.sampling,
    ).toEqual([{ samples_read_count: '10', sampling_space_size: '100' }])
    expect(normalizeReport(body(), req).metadata.has_limited_data).toBe(false)
  })

  it('a window with no data at all is an empty report; a header mismatch or a non-number is refused', () => {
    expect(normalizeReport({}, req)).toMatchObject({
      rows: [],
      total_row_count: 0,
    })
    expect(() =>
      normalizeReport(body({ metricHeaders: [{ name: 'sessions' }] }), req),
    ).toThrow(GoogleSeoError)
    expect(() =>
      normalizeReport(
        body({
          rows: [
            {
              dimensionValues: [{ value: 'a' }, { value: '/' }],
              metricValues: [{ value: 'x' }, { value: '0' }, { value: '0' }],
            },
          ],
        }),
        req,
      ),
    ).toThrow(GoogleSeoError)
  })
})

describe('checks', () => {
  const norm = (
    rows: Array<Record<string, string | number | null>>,
    limited = false,
  ) => ({
    rows,
    total_row_count: rows.length,
    metadata: {
      data_loss_from_other_row: false,
      subject_to_thresholding: limited,
      sampling: [],
      restricted_metrics: [],
      empty_reason: null,
      has_limited_data: limited,
    },
  })

  it('compares two periods row by row, a row in only one period kept', () => {
    const c = buildComparison({
      current: norm([{ deviceCategory: 'mobile', activeUsers: 30 }]),
      previous: norm([
        { deviceCategory: 'mobile', activeUsers: 20 },
        { deviceCategory: 'tablet', activeUsers: 2 },
      ]),
      previousRange: { start_date: '2026-09-03', end_date: '2026-09-30' },
      dimensions: ['deviceCategory'],
      metrics: ['activeUsers'],
    })
    expect(c.rows).toEqual([
      {
        dimensions: { deviceCategory: 'mobile' },
        metrics: {
          activeUsers: {
            current: 30,
            previous: 20,
            absolute_change: 10,
            percent_change: 0.5,
          },
        },
      },
      {
        dimensions: { deviceCategory: 'tablet' },
        metrics: {
          activeUsers: {
            current: null,
            previous: 2,
            absolute_change: null,
            percent_change: null,
          },
        },
      },
    ])
    expect(c.complete).toBe(true)
  })

  it('attribution: unattributed share, internal referrals, case variants', () => {
    expect(isInternalHost('192.168.1.4 / referral')).toBe(true)
    expect(isInternalHost('localhost:3000 / referral')).toBe(true)
    expect(isInternalHost('google / organic')).toBe(false)
    const d = attributionDiagnostics(
      norm([
        { sessionSourceMedium: 'google / organic', sessions: 80 },
        { sessionSourceMedium: '(not set)', sessions: 10 },
        { sessionSourceMedium: '10.0.0.2 / referral', sessions: 3 },
        { sessionSourceMedium: 'Newsletter / email', sessions: 4 },
        { sessionSourceMedium: 'newsletter / email', sessions: 3 },
      ]),
    )
    expect(d.map((x) => x.code)).toEqual([
      'attribution_not_set_share_high',
      'internal_referral_traffic_detected',
      'source_medium_case_variants_detected',
    ])
    expect(
      attributionDiagnostics(
        norm([{ sessionSourceMedium: '(not set)', sessions: 10 }], true),
      ),
    ).toEqual([])
  })

  it('ecommerce activity is detected, none, or unknown when limited', () => {
    expect(
      ecommerceActivity(
        norm([{ transactions: 0, purchaseRevenue: 0 }]),
        'landing_page',
      ).status,
    ).toBe('none')
    expect(
      ecommerceActivity(norm([{ itemsPurchased: 2, itemRevenue: 50 }]), 'item')
        .status,
    ).toBe('detected')
    expect(ecommerceActivity(norm([], true), 'item').status).toBe('unknown')
  })

  it('a sharp key-event fall is flagged, unless the data is limited or too small', () => {
    expect(
      keyEventDecline({ keyEvents: 4 }, { keyEvents: 10 }, false)[0].code,
    ).toBe('key_events_sharp_decline')
    expect(keyEventDecline({ keyEvents: 4 }, { keyEvents: 10 }, true)).toEqual(
      [],
    )
    expect(keyEventDecline({ keyEvents: 0 }, { keyEvents: 4 }, false)).toEqual(
      [],
    )
  })
})

describe('the window, in the property’s time zone', () => {
  it('defaults to the last 28 complete days there', () => {
    // 15:00 UTC on the 12th is 04:00 on the 13th in Auckland, 10:00 on the 12th in New York.
    expect(resolveAnalyticsRange({}, 'Pacific/Auckland', NOW).range).toEqual({
      start_date: '2026-10-16',
      end_date: '2026-11-12',
    })
    expect(resolveAnalyticsRange({}, 'America/New_York', NOW).range).toEqual({
      start_date: '2026-10-15',
      end_date: '2026-11-11',
    })
  })

  it('an end past the last complete day is held there, with a warning', () => {
    const out = resolveAnalyticsRange(
      { start_date: '2026-11-01', end_date: '2026-11-30' },
      'America/New_York',
      NOW,
    )
    expect(out).toMatchObject({
      range: { start_date: '2026-11-01', end_date: '2026-11-11' },
      warnings: ['end_date_clamped'],
      requested: { start_date: '2026-11-01', end_date: '2026-11-30' },
    })
  })
})

describe('runAnalyticsReport', () => {
  it('a table report through the chooser’s connection, paged', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([
      on('properties/123:runReport', () =>
        report(
          ['eventName'],
          ['keyEvents', 'totalUsers'],
          [
            [['generate_lead'], ['12', '10']],
            [['purchase'], ['3', '3']],
          ],
          { rowCount: 5 },
        ),
      ),
    ])
    const out = await runAnalyticsReport(
      db,
      { workspaceId: WS, userId: BEA },
      { report: 'key_events', limit: 2 },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
    )
    expect(out.kind).toBe('table')
    if (out.kind !== 'table') return
    expect(out.rows).toEqual([
      { eventName: 'generate_lead', keyEvents: 12, totalUsers: 10 },
      { eventName: 'purchase', keyEvents: 3, totalUsers: 3 },
    ])
    expect(out.page).toEqual({
      offset: 0,
      limit: 2,
      has_more: true,
      next_offset: 2,
    })
    expect(out.source).toMatchObject({
      property_id: 'properties/123',
      time_zone: 'America/New_York',
    })
    expect(out.request.date_range).toEqual({
      start_date: '2026-10-15',
      end_date: '2026-11-11',
    })
    expect(g.calls[0].auth).toBe('Bearer tok-5555')
    expect(g.calls[0].body).toMatchObject({
      dimensionFilter: ORGANIC,
      limit: '2',
    })
  })

  it('the overview: current, previous, change and the trend', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const M = [
      'sessions',
      'activeUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'transactions',
      'purchaseRevenue',
    ]
    const g = fakeFetch([
      on(':runReport', (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.dimensions.length)
          return report(['date'], M, [
            [['20261015'], ['5', '4', '3', '0.6', '1', '0', '0']],
          ])
        const before = body.dateRanges[0].startDate === '2026-09-17'
        return report([], M, [
          [
            [],
            before
              ? ['50', '40', '30', '0.6', '10', '1', '20']
              : ['100', '80', '60', '0.6', '4', '1', '20'],
          ],
        ])
      }),
    ])
    const out = await runAnalyticsReport(
      db,
      { workspaceId: WS, userId: ALEX },
      { report: 'organic_overview' },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
    )
    if (out.kind !== 'overview') throw new Error('expected the overview')
    expect(out.comparison.sessions).toEqual({
      current: 100,
      previous: 50,
      absolute_change: 50,
      percent_change: 1,
    })
    expect(out.diagnostics.map((d) => d.code)).toEqual([
      'key_events_sharp_decline',
    ])
    expect(out.trend).toHaveLength(1)
    expect(g.calls).toHaveLength(3)
  })

  it('measurement health reads streams, enhanced measurement, key events and custom definitions', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([
      on('/dataStreams/9/enhancedMeasurementSettings', () =>
        json({ streamEnabled: true }),
      ),
      on('/properties/123/dataStreams', () =>
        json({
          dataStreams: [
            {
              name: 'properties/123/dataStreams/9',
              type: 'WEB_DATA_STREAM',
              displayName: 'Site',
              webStreamData: {
                measurementId: 'G-TEST1',
                defaultUri: 'https://example.com',
              },
            },
          ],
        }),
      ),
      on('/keyEvents', () => json({})),
      on('/customDimensions', () =>
        json({
          customDimensions: [
            { parameterName: 'plan', displayName: 'Plan', scope: 'EVENT' },
          ],
        }),
      ),
      on('/customMetrics', () => json({})),
    ])
    const out = await runAnalyticsReport(
      db,
      { workspaceId: WS, userId: ALEX },
      { report: 'measurement_health' },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch },
    )
    if (out.kind !== 'measurement_health')
      throw new Error('expected measurement health')
    expect(out.issues).toEqual([
      'site_search_measurement_disabled',
      'no_key_events_configured',
    ])
    expect(out.web_streams[0]).toMatchObject({
      stream_id: '9',
      measurement_id: 'G-TEST1',
    })
    expect(out.summary).toMatchObject({
      data_streams: 1,
      custom_dimensions: 1,
      issues: 2,
    })
  })

  it('refuses what a report doesn’t offer before asking Google', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([])
    const deps = { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW }
    expect(
      (
        await failureOf(
          runAnalyticsReport(
            db,
            { workspaceId: WS, userId: ALEX },
            { report: 'organic_landing_pages', channel: 'all' },
            deps,
          ),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
    expect(
      (
        await failureOf(
          runAnalyticsReport(
            db,
            { workspaceId: WS, userId: ALEX },
            {
              report: 'traffic_acquisition',
              breakdown: 'campaign',
              compare_previous_period: true,
            },
            deps,
          ),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
    expect(
      (
        await failureOf(
          runAnalyticsReport(
            db,
            { workspaceId: WS, userId: ALEX },
            { report: 'site_search', include_date: true },
            deps,
          ),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
    expect(g.calls).toHaveLength(0)
  })

  it.each([
    [401, {}, 'RECONNECT_NEEDED'],
    [403, {}, 'NO_ACCESS'],
    [429, {}, 'QUOTA'],
    [400, {}, 'INVALID_REQUEST'],
  ] as const)('Google’s %i is %s', async (status, body, code) => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([on(':runReport', () => googleError(status, body))])
    const err = await failureOf(
      runAnalyticsReport(
        db,
        { workspaceId: WS, userId: BEA },
        { report: 'page_performance' },
        { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
      ),
    )
    expect(err.code).toBe(code)
    if (code === 'RECONNECT_NEEDED')
      expect(err.details().reconnect_by?.name).toBe('Alex Rivera')
  })
})
