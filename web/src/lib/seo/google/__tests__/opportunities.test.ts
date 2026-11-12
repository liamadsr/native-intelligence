/**
 * Search opportunities: striking distance (a query's BEST page in 5–20),
 * low CTR against the site's own rate at the same position, the host + path
 * join of the two sources, percentile scoring with ties, the key-event
 * fallback, unscored Search-Console-only pages, and the read with and
 * without Google Analytics chosen.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildLowCtrRows,
  buildStrikingDistanceRows,
  getSearchOpportunities,
  normalizePageKey,
  percentileRanks,
  scorePageOpportunities,
} from '../opportunities'
import {
  ALEX,
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
const qp = (
  query: string,
  page: string,
  position: number,
  impressions: number,
  clicks = 0,
) => ({
  keys: [query, page],
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
})

beforeEach(() => {
  tokenFor.mockClear()
})

describe('striking distance', () => {
  it('keeps a query only when its best page ranks 5–20, most impressions first', () => {
    const rows = [
      qp('rug cleaning', 'https://example.com/rugs', 12, 500),
      qp('rug cleaning', 'https://example.com/blog/rugs', 8, 200), // the best page for the query
      qp('wool rug repair', 'https://example.com/repair', 3, 900), // already near the top
      qp('wool rug repair', 'https://example.com/blog', 9, 900),
      qp('persian rug wash', 'https://example.com/wash', 15, 700),
      qp('tassel fix', 'https://example.com/tassels', 25, 1000),
    ]
    expect(buildStrikingDistanceRows(rows)).toEqual([
      {
        query: 'persian rug wash',
        page: 'https://example.com/wash',
        clicks: 0,
        impressions: 700,
        position: 15,
      },
      {
        query: 'rug cleaning',
        page: 'https://example.com/blog/rugs',
        clicks: 0,
        impressions: 200,
        position: 8,
      },
    ])
  })

  it('ties on position go to the page with more impressions', () => {
    expect(
      buildStrikingDistanceRows([
        qp('q', 'https://example.com/a', 7, 10),
        qp('q', 'https://example.com/b', 7, 50),
      ])[0].page,
    ).toBe('https://example.com/b')
  })
})

describe('low CTR', () => {
  it('flags a query well under the site’s own rate at its position, most missed clicks first', () => {
    const rows = [
      qp('a', 'https://example.com/a', 2.1, 1000, 100),
      qp('b', 'https://example.com/b', 1.9, 1000, 120),
      qp('c', 'https://example.com/c', 2.2, 1000, 10), // far under its peers at position 2
      qp('d', 'https://example.com/d', 8, 1000, 1), // position 8 has no peers: no benchmark
      qp('e', 'https://example.com/e', 2, 50, 0), // too few impressions to judge
    ]
    const out = buildLowCtrRows(rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      query: 'c',
      ctr: 0.01,
      position: 2.2,
      expected_ctr: 0.0767,
    })
    expect(out[0].missed_clicks).toBe(67)
  })
})

describe('the join and the score', () => {
  it('normalizes host + path: scheme, query, fragment, default port and trailing slash ignored; www and path case kept', () => {
    expect(normalizePageKey('https://Example.com:443/Rugs/?utm=x#top')).toBe(
      'example.com/Rugs',
    )
    expect(normalizePageKey('http://example.com:80/')).toBe('example.com/')
    expect(normalizePageKey('example.com:8080/a/')).toBe('example.com:8080/a')
    expect(normalizePageKey('https://www.example.com/a')).not.toBe(
      normalizePageKey('https://example.com/a'),
    )
    expect(normalizePageKey('(not set)')).toBeNull()
    expect(normalizePageKey('')).toBeNull()
  })

  it('percentile ranks share a rank on ties', () => {
    expect(percentileRanks([])).toEqual([])
    expect(percentileRanks([5])).toEqual([1])
    expect(percentileRanks([1, 3, 3, 9])).toEqual([0, 1 / 3, 1 / 3, 1])
  })

  it('scores joined pages, keeps Search-Console-only pages unscored and last, and falls back to engagement with no key events', () => {
    const gsc = [
      {
        keys: ['https://example.com/rugs/'],
        clicks: 10,
        impressions: 1000,
        ctr: 0.01,
        position: 5,
      },
      {
        keys: ['https://example.com/wash'],
        clicks: 5,
        impressions: 100,
        ctr: 0.05,
        position: 15,
      },
      {
        keys: ['https://example.com/orphan'],
        clicks: 1,
        impressions: 5000,
        ctr: 0.0002,
        position: 6,
      },
      {
        keys: ['https://example.com/top'],
        clicks: 90,
        impressions: 1000,
        ctr: 0.09,
        position: 1.5,
      }, // not a 4–20 candidate
    ]
    const ga = {
      rows: [
        {
          hostName: 'example.com',
          landingPage: '/rugs',
          sessions: 40,
          engagementRate: 0.7,
          keyEvents: 0,
          sessionKeyEventRate: 0,
          activeUsers: 30,
          engagedSessions: 28,
          transactions: 0,
          purchaseRevenue: 0,
        },
        {
          hostName: 'example.com',
          landingPage: '/wash',
          sessions: 4,
          engagementRate: 0.2,
          keyEvents: 0,
          sessionKeyEventRate: 0,
          activeUsers: 4,
          engagedSessions: 1,
          transactions: 0,
          purchaseRevenue: null,
        },
        {
          hostName: 'example.com',
          landingPage: '(not set)',
          sessions: 9,
          engagementRate: 0,
          keyEvents: 0,
          sessionKeyEventRate: 0,
          activeUsers: 9,
          engagedSessions: 0,
          transactions: 0,
          purchaseRevenue: 0,
        },
      ],
    }
    const out = scorePageOpportunities(gsc, ga)
    expect(out.engagementFallback).toBe(true)
    expect(out.matched).toBe(2)
    expect(out.unmatchedAnalytics).toBe(1)
    expect(out.rows.map((r) => [r.page, r.join_status, r.score])).toEqual([
      ['https://example.com/rugs/', 'joined', 100],
      ['https://example.com/wash', 'joined', 0],
      ['https://example.com/orphan', 'gsc_only', null],
    ])
    expect(out.rows[0].score_components).toEqual({
      demand: 1,
      business_value: 1,
      reachability: 1,
    })
    expect(out.rows[1].analytics?.purchaseRevenue).toBeNull()
  })
})

describe('getSearchOpportunities', () => {
  const gscRoute = on('/searchAnalytics/query', (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.dimensions.length === 2)
      return json({
        rows: [
          qp('rug cleaning pasadena', 'https://example.com/rugs', 9, 800, 8),
        ],
      })
    return json({
      rows: [
        {
          keys: ['https://example.com/rugs'],
          clicks: 8,
          impressions: 800,
          ctr: 0.01,
          position: 9,
        },
      ],
    })
  })

  it('without Analytics: the Search Console lists, and why pages are missing', async () => {
    const { db } = workspace({
      source: [
        chosenSource({
          ga4_property_id: null,
          ga4_account_id: null,
          ga4_chosen_by: null,
        }),
      ],
    })
    const g = fakeFetch([gscRoute])
    const out = await getSearchOpportunities(
      db,
      { workspaceId: WS, userId: ALEX },
      {},
      { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
    )
    expect(out).toMatchObject({
      site_url: 'sc-domain:example.com',
      start_date: '2026-10-13',
      end_date: '2026-11-09',
      pages: null,
      pages_unavailable: { code: 'NO_SOURCE' },
    })
    expect(out.striking_distance).toHaveLength(1)
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0].body).toMatchObject({
      dimensions: ['query', 'page'],
      rowLimit: 1000,
      dataState: 'final',
      type: 'web',
    })
  })

  it('with Analytics: pages joined and scored, both time zones named', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([
      gscRoute,
      on(':runReport', () =>
        report(
          ['hostName', 'landingPage'],
          [
            'sessions',
            'activeUsers',
            'engagedSessions',
            'engagementRate',
            'keyEvents',
            'sessionKeyEventRate',
            'transactions',
            'purchaseRevenue',
          ],
          [
            [
              ['example.com', '/rugs'],
              ['30', '25', '20', '0.66', '3', '0.1', '1', '120.5'],
            ],
          ],
        ),
      ),
    ])
    const out = await getSearchOpportunities(
      db,
      { workspaceId: WS, userId: ALEX },
      { limit: 10 },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
    )
    expect(out.pages?.rows[0]).toMatchObject({
      page: 'https://example.com/rugs',
      join_status: 'joined',
      score: 100,
    })
    expect(out.pages?.analytics_time_zone).toBe('America/New_York')
    expect(out.pages?.warnings).toContain('source_time_zones_differ')
    const ga4 = g.calls.find((c) => c.url.includes(':runReport'))!
    expect(ga4.body).toMatchObject({
      dimensions: [{ name: 'hostName' }, { name: 'landingPage' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      limit: '1000',
      keepEmptyRows: false,
      returnPropertyQuota: true,
    })
  })

  it('Analytics failing never costs the Search Console half', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const g = fakeFetch([gscRoute, on(':runReport', () => googleError(403))])
    const out = await getSearchOpportunities(
      db,
      { workspaceId: WS, userId: ALEX },
      {},
      { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
    )
    expect(out.pages).toBeNull()
    expect(out.pages_unavailable?.code).toBe('NO_ACCESS')
    expect(out.striking_distance).toHaveLength(1)
  })
})
