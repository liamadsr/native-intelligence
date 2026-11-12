/**
 * Search Console performance and inspection: the request Google gets (dates,
 * dimensions, filters in dimensionFilterGroups), the shaping (totals, the
 * daily trend with gaps filled, the period before, paging under a metric
 * filter), and the reads end to end against stubbed answers.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { previousPeriod, resolveSearchConsoleRange } from '../dates'
import { GoogleSeoError } from '../errors'
import {
  buildDailyTrend,
  buildSearchAnalyticsRequest,
  checkInspectionUrls,
  getSearchConsolePerformance,
  inspectUrls,
  pageRows,
  sumSearchTotals,
} from '../search-console'
import {
  ALEX,
  BEA,
  chosenSource,
  fakeFetch,
  googleError,
  json,
  on,
  tokenFor,
  workspace,
  WS,
} from './fixtures'

const NOW = new Date('2026-11-12T15:00:00Z')

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

describe('dates', () => {
  it('a preset ends three days back and is inclusive', () => {
    expect(resolveSearchConsoleRange({}, NOW)).toEqual({
      start_date: '2026-10-13',
      end_date: '2026-11-09',
    })
    expect(
      resolveSearchConsoleRange({ date_range: 'last_7_days' }, NOW),
    ).toEqual({ start_date: '2026-11-03', end_date: '2026-11-09' })
    expect(
      resolveSearchConsoleRange({ date_range: 'last_3_months' }, NOW),
    ).toEqual({ start_date: '2026-08-09', end_date: '2026-11-09' })
  })

  it('explicit dates are kept, the start held to the 16 months Google keeps', () => {
    expect(
      resolveSearchConsoleRange(
        { start_date: '2026-10-01', end_date: '2026-10-31' },
        NOW,
      ),
    ).toEqual({ start_date: '2026-10-01', end_date: '2026-10-31' })
    expect(
      resolveSearchConsoleRange(
        { start_date: '2024-01-01', end_date: '2026-10-31' },
        NOW,
      ).start_date,
    ).toBe('2025-07-12')
  })

  it('half a pair, a reversed pair and a non-date are refused', () => {
    expect(() =>
      resolveSearchConsoleRange({ start_date: '2026-10-01' }, NOW),
    ).toThrow(GoogleSeoError)
    expect(() =>
      resolveSearchConsoleRange(
        { start_date: '2026-10-31', end_date: '2026-10-01' },
        NOW,
      ),
    ).toThrow(/start on or before/)
    expect(() =>
      resolveSearchConsoleRange(
        { start_date: '2026-02-30', end_date: '2026-03-01' },
        NOW,
      ),
    ).toThrow(GoogleSeoError)
  })

  it('the period before is the same length, just before', () => {
    expect(
      previousPeriod({ start_date: '2026-10-13', end_date: '2026-11-09' }),
    ).toEqual({ start_date: '2026-09-15', end_date: '2026-10-12' })
    expect(
      previousPeriod({ start_date: '2026-11-01', end_date: '2026-11-01' }),
    ).toEqual({ start_date: '2026-10-31', end_date: '2026-10-31' })
  })
})

describe('buildSearchAnalyticsRequest', () => {
  it('defaults: query, web, all data, 250 rows', () => {
    expect(buildSearchAnalyticsRequest({}, NOW)).toEqual({
      startDate: '2026-10-13',
      endDate: '2026-11-09',
      dimensions: ['query'],
      rowLimit: 250,
      type: 'web',
      dataState: 'all',
    })
  })

  it('wraps filters in dimensionFilterGroups (Google ignores a top-level `filters`) and clamps the row limit', () => {
    const req = buildSearchAnalyticsRequest(
      {
        dimensions: ['query'],
        filters: [
          { dimension: 'page', expression: 'https://example.com/rugs' },
        ],
        row_limit: 5000,
        start_row: 250,
      },
      NOW,
    )
    expect(req.dimensionFilterGroups).toEqual([
      {
        groupType: 'and',
        filters: [
          {
            dimension: 'page',
            operator: 'equals',
            expression: 'https://example.com/rugs',
          },
        ],
      },
    ])
    expect(req.rowLimit).toBe(1000)
    expect(req.startRow).toBe(250)
    expect('filters' in req).toBe(false)
  })

  it('searchAppearance must be alone; dimensions are known ones', () => {
    expect(() =>
      buildSearchAnalyticsRequest(
        { dimensions: ['searchAppearance', 'query'] },
        NOW,
      ),
    ).toThrow(/only dimension/)
    expect(() =>
      buildSearchAnalyticsRequest({ dimensions: ['nope' as never] }, NOW),
    ).toThrow(GoogleSeoError)
  })
})

describe('shaping', () => {
  const day = (
    date: string,
    clicks: number,
    impressions: number,
    position: number,
  ) => ({
    keys: [date],
    clicks,
    impressions,
    ctr: clicks / impressions,
    position,
  })

  it('totals weight position by impressions; none means zeros', () => {
    expect(
      sumSearchTotals([day('a', 10, 100, 2), day('b', 0, 300, 10)]),
    ).toEqual({ clicks: 10, impressions: 400, ctr: 0.025, position: 8 })
    expect(sumSearchTotals([])).toEqual({
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    })
  })

  it('the trend has one point per day, gaps as zeros', () => {
    expect(
      buildDailyTrend([day('2026-11-02', 4, 40, 3)], {
        start_date: '2026-11-01',
        end_date: '2026-11-03',
      }),
    ).toEqual([
      { date: '2026-11-01', clicks: 0, impressions: 0 },
      { date: '2026-11-02', clicks: 4, impressions: 40 },
      { date: '2026-11-03', clicks: 0, impressions: 0 },
    ])
  })

  it('under a metric filter, paging stays in Google’s row numbering', () => {
    const rows = [1, 7, 3, 9, 12, 2].map((position, i) => ({
      keys: [`q${i}`],
      clicks: 1,
      impressions: 100,
      ctr: 0.01,
      position,
    }))
    const out = pageRows(rows, {
      requestedLimit: 2,
      fetchLimit: 1000,
      startRow: 0,
      filter: { min_position: 5, max_position: 20 },
    })
    expect(out.rows.map((r) => r.keys[0])).toEqual(['q1', 'q3'])
    expect(out.hasMore).toBe(true)
    expect(out.nextStartRow).toBe(4)
    expect(out.kept).toBe(3)
    const plain = pageRows(rows, {
      requestedLimit: 6,
      fetchLimit: 6,
      startRow: 0,
      filter: null,
    })
    expect(plain).toMatchObject({ hasMore: true, nextStartRow: 6 })
  })
})

describe('getSearchConsolePerformance', () => {
  function google() {
    return fakeFetch([
      on('/searchAnalytics/query', (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.dimensions[0] === 'date') {
          return body.startDate === '2026-10-13'
            ? json({
                rows: [
                  {
                    keys: ['2026-10-13'],
                    clicks: 20,
                    impressions: 400,
                    ctr: 0.05,
                    position: 8.5,
                  },
                ],
              })
            : json({
                rows: [
                  {
                    keys: ['2026-09-15'],
                    clicks: 10,
                    impressions: 400,
                    ctr: 0.025,
                    position: 9,
                  },
                ],
              })
        }
        return json({
          rows: [
            {
              keys: ['rug cleaning pasadena', 'https://example.com/rugs'],
              clicks: 12,
              impressions: 300,
              ctr: 0.041237113402061855,
              position: 6.333,
            },
          ],
        })
      }),
    ])
  }

  it('reads through the chooser’s connection and returns rows, totals, trend and the change', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = google()
    const out = await getSearchConsolePerformance(
      db,
      { workspaceId: WS, userId: BEA },
      { dimensions: ['query', 'page'], compare: true },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
    )
    expect(out.site_url).toBe('sc-domain:example.com')
    expect(out.rows).toEqual([
      {
        keys: ['rug cleaning pasadena', 'https://example.com/rugs'],
        clicks: 12,
        impressions: 300,
        ctr: 0.0412,
        position: 6.3,
      },
    ])
    expect(out.totals).toEqual({
      clicks: 20,
      impressions: 400,
      ctr: 0.05,
      position: 8.5,
    })
    expect(out.previous).toMatchObject({
      start_date: '2026-09-15',
      end_date: '2026-10-12',
    })
    expect(out.change?.clicks).toEqual({
      current: 20,
      previous: 10,
      absolute_change: 10,
      percent_change: 1,
    })
    expect(out.trend).toHaveLength(28)
    expect(
      g.calls.every((c) => c.auth === `Bearer tok-${'44444444'.slice(0, 4)}`),
    ).toBe(true)
  })

  it('a refused request is INVALID_REQUEST before anyone asks Google', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = google()
    const err = await failureOf(
      getSearchConsolePerformance(
        db,
        { workspaceId: WS, userId: ALEX },
        { start_date: '2026-10-01' },
        { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
      ),
    )
    expect(err.code).toBe('INVALID_REQUEST')
    expect(g.calls).toHaveLength(0)
  })

  it('Google refusing the chooser’s grant mid-read says who has to reconnect', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([on('/searchAnalytics/query', () => googleError(401))])
    const err = await failureOf(
      getSearchConsolePerformance(
        db,
        { workspaceId: WS, userId: BEA },
        {},
        { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
      ),
    )
    expect(err.code).toBe('RECONNECT_NEEDED')
    expect(err.details().reconnect_by?.name).toBe('Alex Rivera')
  })
})

describe('inspectUrls', () => {
  it('checks the list: 1 to 10 full http(s) addresses', () => {
    expect(
      checkInspectionUrls(['https://example.com/a', 'https://example.com/a']),
    ).toEqual(['https://example.com/a'])
    expect(() => checkInspectionUrls([])).toThrow(GoogleSeoError)
    expect(() => checkInspectionUrls(['ftp://example.com/a'])).toThrow(
      /full address/,
    )
    expect(() =>
      checkInspectionUrls(
        Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`),
      ),
    ).toThrow(GoogleSeoError)
  })

  it('inspects each page; one page’s failure is its own row; a canonical mismatch is called out', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([
      on('index:inspect', (_url, init) => {
        const url = JSON.parse(String(init?.body)).inspectionUrl as string
        if (url.endsWith('/gone')) return googleError(403)
        return json({
          inspectionResult: {
            indexStatusResult: {
              verdict: 'NEUTRAL',
              coverageState:
                'Duplicate, Google chose different canonical than user',
              googleCanonical: 'https://example.com/rugs',
              userCanonical: 'https://example.com/rugs?x=1',
              sitemap: ['https://example.com/sitemap.xml'],
            },
            mobileUsabilityResult: { verdict: 'PASS' },
          },
        })
      }),
    ])
    const out = await inspectUrls(
      db,
      { workspaceId: WS, userId: ALEX },
      { urls: ['https://example.com/rugs?x=1', 'https://example.com/gone'] },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch },
    )
    expect(out.results[0]).toMatchObject({
      verdict: 'NEUTRAL',
      canonical_mismatch: true,
      sitemaps: ['https://example.com/sitemap.xml'],
      mobile_usability: 'PASS',
      error: null,
    })
    expect(out.results[1]).toMatchObject({
      url: 'https://example.com/gone',
      verdict: null,
    })
    expect(out.results[1].error).toMatch(/can’t read/)
  })

  it('a dead grant fails the whole inspection', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([on('index:inspect', () => googleError(401))])
    const err = await failureOf(
      inspectUrls(
        db,
        { workspaceId: WS, userId: ALEX },
        { urls: ['https://example.com/a', 'https://example.com/b'] },
        { tokenForAccount: tokenFor, fetchImpl: g.fetch },
      ),
    )
    expect(err.code).toBe('RECONNECT_NEEDED')
    expect(err.details().reconnect_by?.is_you).toBe(true)
  })
})
