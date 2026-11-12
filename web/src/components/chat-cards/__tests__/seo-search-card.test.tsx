// @vitest-environment jsdom
/**
 * SEO's Search performance card: the setup states drawn from the Google
 * status (connect, choose a site with the suggested one preselected, a
 * connection someone else or you must sign in to again), the ready page
 * (site line, tiles with their change, the rows, sort, the "contains"
 * filter, the period), Pages with Check indexing, Opportunities, the
 * Analytics tab (its own setup, overview, a table from the report's own
 * columns, measurement health), the reads' errors said in place, and the
 * "…" menu's disconnect through the confirm dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  connect: vi.fn(async () => {}),
  onReturn: null as null | ((r: unknown) => void),
}))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('@/lib/integrations/use-connect-provider', () => ({
  useConnectProvider: (opts: { onReturn?: (r: unknown) => void }) => {
    hoisted.onReturn = opts.onReturn ?? null
    return { connect: hoisted.connect, connectWithUrl: vi.fn(), connectingId: null }
  },
}))

import SeoSearchCard from '../pages/seo-search-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { AnalyticsReport, GoogleSeoStatus, SearchConsolePerformance, SearchOpportunities } from '@/lib/seo/google/view'

const spec: PageCardSpec = { kind: 'seo_search', title: 'Search performance' }
const SITE = 'sc-domain:fernhillstudio.example'
const ORIGIN = 'https://fernhillstudio.example'
const ME = [{ account_id: 'acc-me', email: 'jonas@fernhillstudio.example', status: 'ok' as const }]
const SC_SOURCE = { site_url: SITE, account_id: 'acc-mara', account_email: 'mara@fernhillstudio.example', chosen_by: 'u2', chosen_by_name: 'Mara Lindqvist', chosen_at: '2026-11-01T10:00:00Z', health: 'ok' as const }
const GA_SOURCE = { property_id: 'properties/412233', property_name: 'Fernhill Studio website', time_zone: 'Europe/London', currency_code: 'GBP', account_id: 'acc-mara', account_email: 'mara@fernhillstudio.example', chosen_by: 'u2', chosen_by_name: 'Mara Lindqvist', chosen_at: '2026-11-01T10:00:00Z', health: 'ok' as const }
const SC_OPTIONS = [
  { site_url: `https://shop.fernhillstudio.example/`, permission_level: 'siteFullUser', verified: true, account_id: 'acc-me', account_email: 'jonas@fernhillstudio.example' },
  { site_url: SITE, permission_level: 'siteOwner', verified: true, account_id: 'acc-me', account_email: 'jonas@fernhillstudio.example' },
  { site_url: `https://journal.fernhillstudio.example/`, permission_level: 'siteUnverifiedUser', verified: false, account_id: 'acc-me', account_email: 'jonas@fernhillstudio.example' },
]
const none = { state: 'not_connected' as const, my_accounts: [], source: null, options: [], suggested: null }

const READY: GoogleSeoStatus = {
  workspace_site_url: ORIGIN,
  search_console: { state: 'ready', my_accounts: ME, source: SC_SOURCE, options: SC_OPTIONS, suggested: SITE },
  analytics: { state: 'ready', my_accounts: ME, source: GA_SOURCE, options: [], suggested: null },
}

const change = (current: number, previous: number) => ({ current, previous, absolute_change: current - previous, percent_change: previous ? (current - previous) / previous : null })
const PERF = (dimension: 'query' | 'page', rows: Array<[string, number, number, number]>): SearchConsolePerformance => ({
  site_url: SITE,
  start_date: '2026-10-13',
  end_date: '2026-11-09',
  dimensions: [dimension],
  type: 'web',
  rows: rows.map(([k, clicks, impressions, position]) => ({ keys: [k], clicks, impressions, ctr: clicks / impressions, position })),
  row_count: rows.length,
  has_more: true,
  next_start_row: rows.length,
  filtered: null,
  totals: { clicks: 1384, impressions: 61240, ctr: 0.0226, position: 8.7 },
  trend: [
    { date: '2026-11-08', clicks: 40, impressions: 2000 },
    { date: '2026-11-09', clicks: 46, impressions: 2100 },
  ],
  previous: { start_date: '2026-09-15', end_date: '2026-10-12', totals: { clicks: 1190, impressions: 64300, ctr: 0.0185, position: 9.4 } },
  change: { clicks: change(1384, 1190), impressions: change(61240, 64300), ctr: change(0.0226, 0.0185), position: change(8.7, 9.4) },
})
const QUERIES = PERF('query', [
  ['fernhill studio', 412, 1980, 1.2],
  ['handmade ceramic mugs', 118, 9200, 6.4],
  ['speckled glaze bowls', 51, 3900, 11.7],
])
const PAGES = PERF('page', [
  [`${ORIGIN}/`, 520, 4100, 2.1],
  [`${ORIGIN}/journal/caring-for-stoneware`, 33, 5100, 15.6],
])

const OPPS: SearchOpportunities = {
  site_url: SITE,
  start_date: '2026-10-13',
  end_date: '2026-11-09',
  striking_distance: [{ query: 'speckled glaze bowls', page: `${ORIGIN}/shop/bowls`, clicks: 51, impressions: 3900, position: 11.7 }],
  low_ctr: [{ query: 'handmade ceramic mugs', page: `${ORIGIN}/shop/mugs`, clicks: 118, impressions: 9200, ctr: 0.0128, position: 6.4, expected_ctr: 0.031, missed_clicks: 167 }],
  query_rows_considered: 400,
  query_rows_truncated: false,
  pages: null,
  pages_unavailable: { code: 'NO_SOURCE', message: 'No Google Analytics property is chosen.' },
}

const OVERVIEW: AnalyticsReport = {
  kind: 'overview',
  report: 'organic_overview',
  source: { property_id: 'properties/412233', property_name: 'Fernhill Studio website', time_zone: 'Europe/London', currency_code: 'GBP' },
  request: { requested_date_range: null, date_range: { start_date: '2026-11-09', end_date: '2026-11-11' }, previous_date_range: { start_date: '2026-11-06', end_date: '2026-11-08' }, channel: 'organic_search', trend: 'daily' },
  current: { sessions: 1912, activeUsers: 1540, engagedSessions: 1210, engagementRate: 0.633, keyEvents: 141, transactions: 0, purchaseRevenue: 0 },
  previous: null,
  comparison: { sessions: change(1912, 1760), activeUsers: change(1540, 1490), engagementRate: change(0.633, 0.597), keyEvents: change(141, 150) },
  trend: [
    { date: '20261109', sessions: 60, activeUsers: 50 },
    { date: '20261111', sessions: 70, activeUsers: 55 },
  ],
  diagnostics: [],
  has_limited_data: false,
  warnings: [],
}
const LANDING: AnalyticsReport = {
  kind: 'table',
  report: 'organic_landing_pages',
  source: OVERVIEW.source,
  request: { requested_date_range: null, date_range: { start_date: '2026-10-15', end_date: '2026-11-11' }, channel: 'organic_search', breakdown: '', dimensions: ['hostName', 'landingPage'], metrics: ['sessions', 'engagementRate', 'purchaseRevenue'], limit: 50, offset: 0 },
  row_count: 1,
  total_row_count: 1,
  rows: [{ hostName: 'fernhillstudio.example', landingPage: '/shop/mugs', sessions: 402, engagementRate: 0.65, purchaseRevenue: null }],
  page: { offset: 0, limit: 50, has_more: false, next_offset: null },
  metadata: { data_loss_from_other_row: false, subject_to_thresholding: true, sampling: [], restricted_metrics: [{ metric_name: 'purchaseRevenue', restricted_metric_types: ['REVENUE_DATA'] }], empty_reason: null, has_limited_data: true },
  warnings: [],
  diagnostics: [],
  comparison: null,
  activity: null,
}
const HEALTH: AnalyticsReport = {
  kind: 'measurement_health',
  report: 'measurement_health',
  source: OVERVIEW.source,
  summary: { data_streams: 1, web_streams: 1, key_events: 0, custom_dimensions: 0, custom_metrics: 0, issues: 1 },
  issues: ['no_key_events_configured'],
  web_streams: [{ stream_id: '1', display_name: 'Website', measurement_id: 'G-FERN0001', default_uri: ORIGIN, enhanced_measurement: {} }],
  other_streams: [],
  key_events: [],
  custom_dimensions: [],
  custom_metrics: [],
}

type Answer = { status: number; body: unknown }
const ok = (body: unknown): Answer => ({ status: 200, body })
const fail = (status: number, code: string, details: Record<string, unknown> = { product: 'search_console' }): Answer => ({ status, body: { error: 'Google said no.', code, details } })

let routes: Record<string, unknown>
let sent: Array<{ method: string; path: string; body: unknown }>
let answer: (method: string, path: string, body: Record<string, unknown>) => Answer
let fetchMock: ReturnType<typeof stubAppFetch>
let mount: ReturnType<typeof mountRoot>
let store: ChatCardStore

function defaultAnswer(_method: string, path: string, body: Record<string, unknown>): Answer {
  if (path.endsWith('/search-console/performance')) return ok((body.dimensions as string[])[0] === 'page' ? PAGES : QUERIES)
  if (path.endsWith('/search-console/opportunities')) return ok(OPPS)
  if (path.endsWith('/analytics/report')) return ok(body.report === 'organic_landing_pages' ? LANDING : body.report === 'measurement_health' ? HEALTH : OVERVIEW)
  if (path.endsWith('/search-console/inspect'))
    return ok({
      site_url: SITE,
      results: [
        { url: (body.urls as string[])[0], verdict: 'NEUTRAL', coverage_state: 'Crawled - currently not indexed', robots_txt_state: 'ALLOWED', indexing_state: 'BLOCKED_BY_META_TAG', page_fetch_state: 'SUCCESSFUL', last_crawl_time: null, crawled_as: null, google_canonical: null, user_canonical: null, canonical_mismatch: false, sitemaps: [], referring_urls: [], mobile_usability: null, rich_results: null, details_link: null, error: null },
      ],
    })
  return ok({})
}

beforeEach(() => {
  window.localStorage.clear()
  hoisted.toast.mockClear()
  hoisted.toast.error.mockClear()
  hoisted.connect.mockClear()
  sent = []
  routes = { '/api/account/seo/google/status': READY }
  answer = defaultAnswer
  fetchMock = stubAppFetch(routes)
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      const path = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      sent.push({ method, path, body })
      const a = answer(method, path, body ?? {})
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
    }
    return get(input, init)
  })
  mount = mountRoot()
  store = makeStore('seo-s', spec)
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const all = (sel: string) => Array.from(document.body.querySelectorAll<HTMLElement>(sel))
const click = async (sel: string | HTMLElement) => {
  const el = typeof sel === 'string' ? q(sel)! : sel
  await act(async () => el.click())
  await settle()
  await settle()
}
const buttonByText = (text: string, root: ParentNode = document.body) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text)!
const statusReads = () => fetchMock.mock.calls.filter(([input, init]) => String(input) === '/api/account/seo/google/status' && (init?.method ?? 'GET') === 'GET').length
const posted = (suffix: string) => sent.filter((s) => s.path.endsWith(suffix))

async function render() {
  await mount.render(React.createElement(SeoSearchCard, { toolCallId: 'seo-s', spec, store, fullScreen: true }))
  await settle()
  await settle()
}

describe('SeoSearchCard: setup', () => {
  it('a failed status read: a line and Try again', async () => {
    delete routes['/api/account/seo/google/status']
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your Google connections.')
    routes['/api/account/seo/google/status'] = READY
    await click('[data-seo-error] button')
    expect(q('[data-seo-search-site]')).not.toBeNull()
  })

  it('not connected: what the page shows, read-only, and Connect starts the app’s connect flow', async () => {
    routes['/api/account/seo/google/status'] = { ...READY, search_console: none, analytics: none }
    await render()
    const block = q('[data-seo-search-connect="search_console"]')!
    expect(block.textContent).toContain('See how people find you on Google')
    expect(block.textContent).toContain('Read-only: nothing on your site or account is changed.')
    // Nothing to change yet: no period and no menu.
    expect(q('[data-seo-search-menu]')).toBeNull()
    await click('[data-seo-search-connect-button]')
    expect(hoisted.connect).toHaveBeenCalledWith('google', 'search_console', undefined)
    // The connect's return re-reads the status.
    const before = statusReads()
    await act(async () => hoisted.onReturn?.({ success: true }))
    await settle()
    expect(statusReads()).toBe(before + 1)
  })

  it('choose: the suggested site preselected and marked, an unverified one disabled saying why, Use this site chooses it', async () => {
    routes['/api/account/seo/google/status'] = { ...READY, search_console: { state: 'choose', my_accounts: ME, source: null, options: SC_OPTIONS, suggested: SITE } }
    answer = (method, path, body) => (method === 'PUT' ? ok({ source: SC_SOURCE }) : defaultAnswer(method, path, body))
    await render()
    const options = all('[data-seo-search-option]')
    expect(options.map((o) => o.textContent)).toEqual([
      'shop.fernhillstudio.examplejonas@fernhillstudio.example',
      'fernhillstudio.examplejonas@fernhillstudio.exampleMatches your website',
      'journal.fernhillstudio.exampleNot verified · jonas@fernhillstudio.example',
    ])
    expect(q(`[data-seo-search-option="${SITE}"]`)!.getAttribute('aria-checked')).toBe('true')
    const unverified = q<HTMLButtonElement>('[data-seo-search-option="https://journal.fernhillstudio.example/"]')!
    expect(unverified.disabled).toBe(true)
    expect(unverified.title).toContain('Not verified in Search Console')
    routes['/api/account/seo/google/status'] = READY
    await click('[data-seo-search-use]')
    expect(sent[0]).toEqual({ method: 'PUT', path: '/api/account/seo/google/search-console/site', body: { site_url: SITE, account_id: 'acc-me' } })
    expect(hoisted.toast).toHaveBeenCalledWith('Reading fernhillstudio.example for everyone here.')
    expect(q('[data-seo-search-site]')!.textContent).toBe('fernhillstudio.example · chosen by Mara Lindqvist')
  })

  it('a refused choice says why beside the button, not in a toast', async () => {
    routes['/api/account/seo/google/status'] = { ...READY, search_console: { state: 'choose', my_accounts: ME, source: null, options: SC_OPTIONS, suggested: SITE } }
    answer = () => ({ status: 403, body: { error: 'Your Google account cannot read that site.', code: 'NO_ACCESS' } })
    await render()
    await click('[data-seo-search-use]')
    expect(q('[data-seo-search-pick-error]')!.textContent).toBe('Your Google account cannot read that site.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('needs reconnect by someone else: who, and choosing with your own connection', async () => {
    routes['/api/account/seo/google/status'] = { ...READY, search_console: { ...READY.search_console, state: 'needs_reconnect', source: { ...SC_SOURCE, health: 'needs_reconnect' } } }
    await render()
    const block = q('[data-seo-search-reconnect="search_console"]')!
    expect(block.textContent).toContain('Ask Mara Lindqvist to reconnect, or choose a site with your own connection.')
    expect(q('[data-seo-search-reconnect-button]')).toBeNull()
    await click('[data-seo-search-choose]')
    expect(q('[data-seo-search-picker="search_console"]')).not.toBeNull()
  })

  it('needs reconnect by you: Reconnect signs in again as that account', async () => {
    routes['/api/account/seo/google/status'] = {
      ...READY,
      search_console: { state: 'needs_reconnect', my_accounts: [{ account_id: 'acc-mara', email: 'mara@fernhillstudio.example', status: 'needs_reconnect' }], source: { ...SC_SOURCE, health: 'needs_reconnect' }, options: [], suggested: null },
    }
    await render()
    await click('[data-seo-search-reconnect-button]')
    expect(hoisted.connect).toHaveBeenCalledWith('google', 'search_console', { loginHint: 'mara@fernhillstudio.example' })
  })
})

describe('SeoSearchCard: Queries', () => {
  it('the site line, tiles with their change (position: lower is better), the trend and the rows', async () => {
    await render()
    expect(q('[data-seo-search-site]')!.textContent).toBe('fernhillstudio.example · chosen by Mara Lindqvist')
    expect(q('[data-seo-tab="queries"]')!.getAttribute('aria-selected')).toBe('true')
    expect(posted('/performance')[0].body).toEqual({ dimensions: ['query'], date_range: 'last_28_days', row_limit: 100, compare: true })
    expect(all('[data-seo-tile]').map((t) => t.textContent)).toEqual([
      '1,384ClicksUp 16%',
      '61,240ImpressionsDown 5%',
      '2.3%Click rateUp 0.4 points',
      '8.7Average position0.7 places higher',
    ])
    expect(q('[data-seo-tile="position"] p:last-child')!.className).toContain('text-emerald-600')
    expect(q('[data-seo-tile="impressions"] p:last-child')!.className).toContain('text-red-700')
    expect(all('[data-seo-trend] svg[role="img"]').map((s) => s.getAttribute('aria-label'))).toEqual([
      'Clicks a day from Google, Oct 13 to Nov 9: 1,384 in all.',
      'Times a day your site showed in Google, Oct 13 to Nov 9: 61,240 in all.',
    ])
    expect(all('[data-seo-search-row]').map((r) => r.dataset.seoSearchRow)).toEqual(['fernhill studio', 'handmade ceramic mugs', 'speckled glaze bowls'])
    expect(q('[data-seo-search-row="handmade ceramic mugs"]')!.textContent).toBe('handmade ceramic mugs1189,2001.3%6.4')
  })

  it('sorts the rows by position, best first', async () => {
    await render()
    await click('[data-seo-filter="position"]')
    expect(all('[data-seo-search-row]').map((r) => r.dataset.seoSearchRow)).toEqual(['fernhill studio', 'handmade ceramic mugs', 'speckled glaze bowls'])
    await click('[data-seo-filter="impressions"]')
    expect(all('[data-seo-search-row]').map((r) => r.dataset.seoSearchRow)).toEqual(['handmade ceramic mugs', 'speckled glaze bowls', 'fernhill studio'])
  })

  it('"contains" filters on the server, the period changes the window, and Show more pages on', async () => {
    await render()
    const input = q<HTMLInputElement>('[data-seo-search-contains]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'mug')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(450)
    await settle()
    expect(posted('/performance').at(-1)!.body).toEqual({ dimensions: ['query'], date_range: 'last_28_days', row_limit: 100, compare: true, filters: [{ dimension: 'query', operator: 'contains', expression: 'mug' }] })
    await click('[data-seo-filter="last_7_days"]')
    expect(posted('/performance').at(-1)!.body).toMatchObject({ date_range: 'last_7_days' })
    await click('[data-seo-search-more]')
    expect(posted('/performance').at(-1)!.body).toMatchObject({ start_row: 3 })
    expect(posted('/performance').at(-1)!.body).not.toHaveProperty('compare')
  })

  it('Google’s quota: a neutral banner, and Try again reads again', async () => {
    answer = () => fail(429, 'QUOTA', { product: 'search_console', retry_after_seconds: 60 })
    await render()
    expect(q('[data-seo-search-quota]')!.textContent).toContain('Google is limiting requests right now. Try again in a minute.')
    answer = defaultAnswer
    await click(buttonByText('Try again', q('[data-seo-search-quota]')!))
    expect(all('[data-seo-search-row]')).toHaveLength(3)
  })

  it('no access: says so and offers choosing a site', async () => {
    answer = () => fail(403, 'NO_ACCESS')
    await render()
    expect(q('[data-seo-search-no-access]')!.textContent).toContain('Your Google account can no longer read this site')
    await click('[data-seo-search-choose]')
    expect(q('[data-seo-search-picker]')).not.toBeNull()
  })

  it('Google down: the load-failure line', async () => {
    answer = () => fail(502, 'UPSTREAM')
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your searches from Google.')
  })

  it('a reconnect from a read names who signs in again', async () => {
    answer = () => fail(409, 'RECONNECT_NEEDED', { product: 'search_console', reconnect_by: { user_id: 'u2', name: 'Mara Lindqvist', is_you: false } })
    await render()
    expect(q('[data-seo-search-reconnect]')!.textContent).toContain('Ask Mara Lindqvist to reconnect')
  })

  it('a choice gone since the status was read: the status is read again', async () => {
    await render()
    const before = statusReads()
    answer = () => ({ status: 409, body: { error: 'No site is chosen.', code: 'NO_SOURCE', details: { product: 'search_console' } } })
    routes['/api/account/seo/google/status'] = { ...READY, search_console: { state: 'choose', my_accounts: ME, source: null, options: SC_OPTIONS, suggested: SITE } }
    await click('[data-seo-filter="last_7_days"]')
    expect(statusReads()).toBe(before + 1)
    expect(q('[data-seo-search-picker="search_console"]')).not.toBeNull()
  })
})

describe('SeoSearchCard: Pages', () => {
  it('is the card’s tab: paths as links out, and Check indexing says what Google knows under the row', async () => {
    await render()
    await click('[data-seo-tab="pages"]')
    expect(store.state('seo-s').tab).toBe('pages')
    expect(posted('/performance').at(-1)!.body).toMatchObject({ dimensions: ['page'] })
    const url = `${ORIGIN}/journal/caring-for-stoneware`
    const link = q<HTMLAnchorElement>(`[data-seo-search-row="${url}"] a`)!
    expect(link.textContent).toBe('/journal/caring-for-stoneware')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer noopener')
    await click(`[data-seo-search-inspect="${url}"]`)
    expect(posted('/inspect')[0].body).toEqual({ urls: [url] })
    const line = q(`[data-seo-search-row="${url}"] [data-seo-search-inspection]`)!
    expect(line.textContent).toBe('Google has not listed it · Crawled - currently not indexed · The page tells search engines not to list it (noindex)')
  })

  it('one page’s failure is a quiet line', async () => {
    await render()
    await click('[data-seo-tab="pages"]')
    answer = (method, path, body) => (path.endsWith('/inspect') ? ok({ site_url: SITE, results: [{ url: `${ORIGIN}/`, verdict: null, coverage_state: null, robots_txt_state: null, indexing_state: null, page_fetch_state: null, last_crawl_time: null, crawled_as: null, google_canonical: null, user_canonical: null, canonical_mismatch: false, sitemaps: [], referring_urls: [], mobile_usability: null, rich_results: null, details_link: null, error: 'Google could not inspect this page.' }] }) : defaultAnswer(method, path, body))
    await click(`[data-seo-search-inspect="${ORIGIN}/"]`)
    expect(q('[data-seo-search-inspection="neutral"]')!.textContent).toBe('Could not check this page · Google could not inspect this page.')
  })
})

describe('SeoSearchCard: Opportunities', () => {
  it('two lists with captions, and without Analytics one line pointing to its tab', async () => {
    store.update('seo-s', { tab: 'opportunities' })
    await render()
    expect(posted('/opportunities')[0].body).toMatchObject({ limit: 25, start_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), end_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(all('[data-seo-search-section]').map((s) => s.querySelector('h2')!.textContent)).toEqual(['Almost on page one', 'Shown often, clicked rarely'])
    expect(q('[data-seo-search-striking="speckled glaze bowls"]')!.textContent).toBe('speckled glaze bowls/shop/bowls11.73,900')
    expect(q('[data-seo-search-low-ctr="handmade ceramic mugs"]')!.textContent).toContain('1.3%usually 3.1%')
    expect(q('[data-seo-search-pages-unavailable]')!.textContent).toContain('Google Analytics adds a third list here')
    await click('[data-seo-search-open-analytics]')
    expect(store.state('seo-s').tab).toBe('analytics')
  })

  it('pages scored with Analytics; an unscored one is a dash, never zero', async () => {
    answer = (method, path, body) =>
      path.endsWith('/opportunities')
        ? ok({
            ...OPPS,
            pages_unavailable: null,
            pages: {
              property_id: 'properties/412233', property_name: 'Fernhill Studio website', search_console_time_zone: 'America/Los_Angeles', analytics_time_zone: 'Europe/London',
              rows: [
                { page: `${ORIGIN}/shop/mugs`, normalized_page: null, clicks: 164, impressions: 12800, ctr: 0.0128, position: 6.9, join_status: 'joined', analytics: { sessions: 402, activeUsers: 351, engagedSessions: 260, engagementRate: 0.65, keyEvents: 31, sessionKeyEventRate: 0.077, transactions: 18, purchaseRevenue: 1240 }, score: 82, score_components: { demand: 74, business_value: 91, reachability: 80 } },
                { page: `${ORIGIN}/shop/planters`, normalized_page: null, clicks: 24, impressions: 6600, ctr: 0.0036, position: 13.9, join_status: 'gsc_only', analytics: null, score: null, score_components: null },
              ],
              total_candidates: 2,
              scoring: { formula: '', business_value_metric: 'sessionKeyEventRate', engagement_fallback: false, score_data_limited: true },
              coverage: { search_console_rows: 2, analytics_rows: 1, matched_rows: 1, unmatched_search_console_rows: 1, unmatched_analytics_rows: 0 },
              truncated: { search_console: false, analytics: false, candidates: false },
              warnings: [],
            },
          })
        : defaultAnswer(method, path, body)
    store.update('seo-s', { tab: 'opportunities' })
    await render()
    expect(q('[data-seo-search-section="pages"]')!.textContent).toContain('A missing row is unknown, not zero.')
    expect(q(`[data-seo-search-page-opportunity="${ORIGIN}/shop/mugs"]`)!.textContent).toBe('/shop/mugs826.9164402')
    expect(q(`[data-seo-search-page-opportunity="${ORIGIN}/shop/planters"]`)!.textContent).toBe('/shop/planters—13.924—')
    expect(q('[data-seo-search-pages-unavailable]')).toBeNull()
  })

  it('all empty: nothing stands out, and no empty lists', async () => {
    answer = (method, path, body) => (path.endsWith('/opportunities') ? ok({ ...OPPS, striking_distance: [], low_ctr: [], pages: null, pages_unavailable: null }) : defaultAnswer(method, path, body))
    store.update('seo-s', { tab: 'opportunities' })
    await render()
    expect(q('[data-seo-search-nothing]')!.textContent).toContain('Nothing stands out right now')
    expect(q('[data-seo-search-section]')).toBeNull()
  })
})

describe('SeoSearchCard: Analytics', () => {
  it('not connected: its own small connect block; the rest of the page carries on', async () => {
    routes['/api/account/seo/google/status'] = { ...READY, analytics: none }
    store.update('seo-s', { tab: 'analytics' })
    await render()
    expect(q('[data-seo-search-site]')).not.toBeNull()
    await click('[data-seo-search-connect-button]')
    expect(hoisted.connect).toHaveBeenCalledWith('google', 'analytics', undefined)
  })

  it('the overview: tiles with change, the daily trend over every day of the window', async () => {
    store.update('seo-s', { tab: 'analytics' })
    await render()
    expect(posted('/analytics/report')[0].body).toMatchObject({ report: 'organic_overview', trend: 'daily' })
    expect(q('[data-seo-search-property]')!.textContent).toBe('Fernhill Studio website · chosen by Mara Lindqvist')
    expect(all('[data-seo-tile]').map((t) => t.textContent)).toEqual(['1,912Visits from searchUp 9%', '1,540PeopleUp 3%', '63%EngagedUp 3.6 points', '141Key eventsDown 6%'])
    // Three days in the window, the missing middle one a zero (the report is not limited).
    expect(q('[data-seo-trend]')!.textContent).toContain('Nov 11')
    expect(q('[data-seo-search-limited]')).toBeNull()
  })

  it('a table from the report’s own columns: a host and a path joined into a link, labels from the map, a withheld number a dash', async () => {
    store.update('seo-s', { tab: 'analytics' })
    await render()
    await click('[data-seo-filter="organic_landing_pages"]')
    expect(posted('/analytics/report').at(-1)!.body).toMatchObject({ report: 'organic_landing_pages', limit: 50 })
    const header = q('[data-seo-search-analytics-report="organic_landing_pages"] [aria-hidden]')!
    expect(Array.from(header.children).map((c) => c.textContent)).toEqual(['Landing page', 'Visits', 'Engaged', 'Revenue'])
    const row = q('[data-seo-search-analytics-row="0"]')!
    expect(row.querySelector('a')!.href).toBe('https://fernhillstudio.example/shop/mugs')
    expect(row.textContent).toBe('/shop/mugs40265%—')
    expect(row.lastElementChild!.getAttribute('title')).toBe('Google withheld this number for this property')
    expect(q('[data-seo-search-limited]')!.textContent).toBe('Google is still processing some of this. A missing row is unknown, not zero.')
  })

  it('measurement health: a checklist of what is set up and what is missing', async () => {
    store.update('seo-s', { tab: 'analytics' })
    await render()
    await click('[data-seo-filter="measurement_health"]')
    expect(all('[data-seo-search-health]').map((i) => `${i.dataset.seoSearchHealth}:${i.dataset.ok}`)).toEqual([
      'no_web_stream:yes',
      'enhanced_measurement_disabled:yes',
      'site_search_measurement_disabled:yes',
      'no_key_events_configured:no',
    ])
    expect(q('[data-seo-search-health="no_key_events_configured"]')!.textContent).toContain('No key events are set up')
  })

  it('a property no longer readable: says so and offers choosing a property', async () => {
    answer = (method, path, body) => (path.endsWith('/analytics/report') ? fail(403, 'NO_ACCESS', { product: 'analytics' }) : defaultAnswer(method, path, body))
    store.update('seo-s', { tab: 'analytics' })
    await render()
    expect(q('[data-seo-search-no-access="analytics"]')!.textContent).toContain('Your Google account can no longer read this property')
  })
})

describe('SeoSearchCard: the … menu', () => {
  it('Disconnect this site goes through the confirm dialog, then the page shows its setup again', async () => {
    answer = (method, path, body) => (method === 'DELETE' ? ok({ cleared: true }) : defaultAnswer(method, path, body))
    await render()
    await click('[data-seo-search-menu]')
    expect(q('[data-seo-search-change-site]')!.textContent).toBe('Change site')
    expect(q('[data-seo-search-change-property]')!.textContent).toBe('Change Analytics property')
    await click('[data-seo-search-disconnect]')
    const dialog = q('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Stop reading fernhillstudio.example here?')
    expect(sent.filter((s) => s.method === 'DELETE')).toEqual([])
    routes['/api/account/seo/google/status'] = { ...READY, search_console: { state: 'choose', my_accounts: ME, source: null, options: SC_OPTIONS, suggested: SITE } }
    await act(async () => buttonByText('Disconnect', dialog).click())
    await settle()
    await settle()
    expect(sent.filter((s) => s.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/account/seo/google/search-console/site', body: null }])
    expect(hoisted.toast).toHaveBeenCalledWith('Stopped reading fernhillstudio.example here.')
    expect(q('[data-seo-search-picker="search_console"]')).not.toBeNull()
  })

  it('Change site opens the picker with the site in use marked, and Cancel goes back', async () => {
    await render()
    await click('[data-seo-search-menu]')
    await click('[data-seo-search-change-site]')
    expect(q(`[data-seo-search-option="${SITE}"]`)!.textContent).toContain('In use')
    expect(q<HTMLButtonElement>('[data-seo-search-use]')!.disabled).toBe(true)
    await click(buttonByText('Cancel'))
    expect(q('[data-seo-search-site]')).not.toBeNull()
  })
})
