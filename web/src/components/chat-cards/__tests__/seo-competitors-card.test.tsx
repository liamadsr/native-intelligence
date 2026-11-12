// @vitest-environment jsdom
/**
 * SEO's Competitors card: opening never spends (the own site's stored
 * overview opens from the stored lookups, else the first run with the own
 * site prefilled, or the Recent list), "Look up site" is the request (the
 * own site asked with no domain, another by name; the spend line read again
 * after), a correctable site said beside the field, a 402 as a neutral
 * banner, a failure as an amber banner with a retry, lookups off (the
 * notice, disabled buttons with their reason, stored lookups still open),
 * a site with no data (also stored: Looked up and Refresh, in Recent), a
 * partial overview's quiet note (said once, with Refresh), the Keywords tab (the overview's rows first, more
 * and other sorts asked of ranked-keywords) and the Competitors tab (the
 * site's top searches, Find competitors, the own site pinned, Hide and
 * Look up site).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => React.createElement('span', { 'data-thinking-orb': '' }) }))

import SeoCompetitorsCard from '../pages/seo-competitors-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { DomainKeywordRow, DomainOverview, SerpCompetitorsResult } from '@/lib/seo/domain/view'
import type { SeoSpendView } from '@/lib/seo/spend-view'

const spec: PageCardSpec = { kind: 'seo_competitors', title: 'Competitors' }
const OWN = 'fernhillstudio.example'
const RIVAL = 'oakandloom.example'
const L_OWN = '11111111-1111-4111-8111-111111111111'
const L_RIVAL = '22222222-2222-4222-8222-222222222222'

const kw = (i: number): DomainKeywordRow => ({
  keyword: `linen throw ${i}`,
  position: (i % 20) + 1,
  search_volume: 1000 - i,
  traffic: 500 - i,
  cpc: 1.2,
  keyword_difficulty: 30,
  url: `https://${OWN}/shop/item-${i}`,
  relative_url: `/shop/item-${i}`,
})
const TOP = Array.from({ length: 100 }, (_, i) => kw(i))

const overview = (extra: Partial<DomainOverview> = {}): DomainOverview => ({
  lookup_id: L_OWN,
  domain: OWN,
  is_own_site: true,
  location_code: 2840,
  language_code: 'en',
  organic_traffic: 12_480,
  organic_keywords: 3_204,
  has_data: true,
  top_keywords: TOP,
  top_pages: Array.from({ length: 14 }, (_, i) => ({ url: `https://${OWN}/page-${i}`, relative_path: `/page-${i}`, organic_traffic: 900 - i, keywords: 40 - i })),
  caveats: ['Traffic is an estimate of monthly organic visits from Google.'],
  fetched_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  from_cache: true,
  ...extra,
})
const stored = (o: DomainOverview) => {
  const { lookup_id: _l, is_own_site: _i, fetched_at: _f, from_cache: _c, ...rest } = o
  return rest
}

const SPEND: SeoSpendView = { spent_dollars: 3.4, cap_dollars: 20, resets_at: '2026-12-01T00:00:00Z', configured: true, can_buy: true, refusal: null }
const MARKETS = {
  default_location_code: 2840,
  locations: [
    { code: 2840, label: 'United States', short_label: 'US', default_language: 'en', languages: [{ code: 'en', label: 'English' }], keyword_data: 'labs', domain_data: true },
    { code: 2004, label: 'Afghanistan', short_label: 'AF', default_language: 'en', languages: [{ code: 'en', label: 'English' }], keyword_data: 'google_ads', domain_data: false },
  ],
  serp_languages: [{ code: 'en', label: 'English' }],
}
const recentOf = (...rows: Array<[string, string]>) => ({
  lookups: rows.map(([id, label]) => ({ id, kind: 'domain_overview', label, fetched_at: new Date(Date.now() - 3 * 3600_000).toISOString(), fetched_by: 'user-me' })),
})

let routes: Record<string, unknown>
let posts: Array<{ path: string; body: Record<string, unknown> }>
let postAnswer: (path: string, body: Record<string, unknown>) => { status: number; body: unknown }
let fetchMock: ReturnType<typeof stubAppFetch>
let mount: ReturnType<typeof mountRoot>
let store: ChatCardStore

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  window.localStorage.clear()
  hoisted.toast.mockClear()
  hoisted.toast.error.mockClear()
  posts = []
  routes = {
    '/api/account/seo/spend': SPEND,
    '/api/account/seo/locations': MARKETS,
    '/api/account/seo/audits': { audits: [], default_url: `https://${OWN}`, limits: { min_pages: 10, default_pages: 100, max_pages: 1000 } },
    '/api/account/seo/lookups?kind=domain_overview&limit=20': recentOf([L_OWN, `${OWN} · United States`], [L_RIVAL, `${RIVAL} · United States`]),
    [`/api/account/seo/lookups/${L_OWN}`]: { id: L_OWN, kind: 'domain_overview', label: `${OWN} · United States`, fetched_at: overview().fetched_at, fetched_by: 'user-me', request: {}, result: stored(overview()) },
    [`/api/account/seo/lookups/${L_RIVAL}`]: { id: L_RIVAL, kind: 'domain_overview', label: `${RIVAL} · United States`, fetched_at: overview().fetched_at, fetched_by: 'user-me', request: {}, result: stored(overview({ domain: RIVAL })) },
  }
  postAnswer = (path, body) => {
    // The route answers with the bare hostname of what was named.
    if (path.endsWith('/domain/overview')) return { status: 200, body: overview({ domain: body.domain ? String(body.domain).replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : OWN, is_own_site: !body.domain, from_cache: false, fetched_at: new Date().toISOString() }) }
    if (path.endsWith('/domain/ranked-keywords'))
      return { status: 200, body: { lookup_id: 'r1', target: OWN, scope: 'domain', is_own_site: false, location_code: 2840, language_code: 'en', rows: [kw(500), kw(501)], total_count: 3204, next_offset: 200, caveats: [], fetched_at: new Date().toISOString(), from_cache: false } }
    if (path.endsWith('/domain/competitors')) {
      const hidden = (body.exclude_domains as string[] | undefined) ?? []
      const rows = [
        { domain: RIVAL, keywords_count: 61, avg_position: 4.26, median_position: 4, visibility: 0.18, etv: 8100, own_site: false },
        { domain: 'loomhouse.example', keywords_count: 40, avg_position: 7.5, median_position: 7, visibility: 0.004, etv: 2200, own_site: false },
        { domain: OWN, keywords_count: 100, avg_position: 9.1, median_position: 8, visibility: 0.09, etv: 4000, own_site: true },
      ].filter((r) => !hidden.includes(r.domain))
      const result: SerpCompetitorsResult = { lookup_id: 'c1', keywords: body.keywords as string[], location_code: 2840, language_code: 'en', own_domain: OWN, rows, caveats: [], fetched_at: new Date().toISOString(), from_cache: hidden.length > 0 }
      return { status: 200, body: result }
    }
    return { status: 404, body: { error: 'no' } }
  }
  fetchMock = stubAppFetch(routes)
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const path = String(input)
      const body = init.body ? JSON.parse(String(init.body)) : {}
      posts.push({ path, body })
      const answer = postAnswer(path, body)
      return json(answer.body, answer.status)
    }
    return get(input, init)
  })
  mount = mountRoot()
  store = makeStore('cmp-1', spec)
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
const click = async (sel: string) => {
  await act(async () => q<HTMLElement>(sel)!.click())
  await settle()
  await settle()
}
const type = async (sel: string, value: string) => {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(sel)!
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = async (sel: string, key: string) => {
  await act(async () => {
    q(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await settle()
  await settle()
}
const spendReads = () => fetchMock.mock.calls.filter(([input]) => String(input) === '/api/account/seo/spend').length

async function render() {
  await mount.render(React.createElement(SeoCompetitorsCard, { toolCallId: 'cmp-1', spec, store, fullScreen: true }))
  await settle()
  await settle()
}

describe('SeoCompetitorsCard: opening never spends', () => {
  it('opens the own site’s stored overview from the stored lookups, with no lookup bought', async () => {
    await render()
    expect(posts).toEqual([])
    expect(q('[data-seo-competitors-page]')!.dataset.seoState).toBe('site')
    expect(q('[data-seo-site-title]')!.textContent).toBe(OWN)
    expect(q('[data-seo-own-chip]')).not.toBeNull()
    expect(q('[data-seo-looked-up]')!.textContent).toBe('United States · Looked up 3 hours ago')
    expect(q('[data-seo-refresh]')).not.toBeNull()
    expect(q('[data-seo-spend]')!.textContent).toContain('$3.40 of $20 this month')
    // Only the tiles the overview carries: no top-3 or top-10 counts.
    expect(all('[data-seo-tile]').map((t) => t.dataset.seoTile)).toEqual(['traffic', 'keywords'])
    expect(q('[data-seo-tile="traffic"]')!.textContent).toContain('12,480')
    expect(q('[data-seo-caveats]')!.textContent).toContain('estimate')
    expect(all('[data-seo-top-keyword]')).toHaveLength(10)
    expect(all('[data-seo-top-page]')).toHaveLength(10)
    const link = q<HTMLAnchorElement>('[data-seo-top-page] a')!
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer noopener')
    // Top pages' See all opens the rest in place.
    await click('[data-seo-see-all="Top pages"]')
    expect(all('[data-seo-top-page]')).toHaveLength(14)
    // Top searches' See all moves to the Keywords tab.
    await click('[data-seo-see-all="Top searches"]')
    expect(store.state('cmp-1').tab).toBe('keywords')
  })

  it('shows the first run with the own site prefilled when it has no stored overview, and the Recent list otherwise', async () => {
    routes['/api/account/seo/lookups?kind=domain_overview&limit=20'] = { lookups: [] }
    await render()
    expect(posts).toEqual([])
    expect(q('[data-seo-first-run]')!.textContent).toContain('See what any site ranks for')
    expect(q<HTMLInputElement>('[data-seo-site]')!.value).toBe(OWN)
    expect(q('[data-seo-recent]')).toBeNull()
    mount.unmount()

    routes['/api/account/seo/lookups?kind=domain_overview&limit=20'] = recentOf([L_RIVAL, `${RIVAL} · United States`])
    mount = mountRoot()
    await render()
    expect(posts).toEqual([])
    expect(q('[data-seo-first-run]')).toBeNull()
    expect(q(`[data-seo-recent-row="${L_RIVAL}"]`)!.textContent).toContain(`${RIVAL}United States · 3 hours ago`)
    // A stored lookup reopens for free.
    await click(`[data-seo-recent-row="${L_RIVAL}"] button`)
    expect(posts).toEqual([])
    expect(q('[data-seo-site-title]')!.textContent).toBe(RIVAL)
    expect(q('[data-seo-own-chip]')).toBeNull()
  })

  it('says it could not load, and tries again', async () => {
    delete routes['/api/account/seo/lookups?kind=domain_overview&limit=20']
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your site lookups.')
    routes['/api/account/seo/lookups?kind=domain_overview&limit=20'] = { lookups: [] }
    await click('[data-seo-error] button')
    expect(q('[data-seo-first-run]')).not.toBeNull()
  })
})

describe('SeoCompetitorsCard: looking a site up', () => {
  beforeEach(() => {
    routes['/api/account/seo/lookups?kind=domain_overview&limit=20'] = { lookups: [] }
  })

  it('asks for the own site with no domain, and reads the spend line again after', async () => {
    await render()
    const before = spendReads()
    await click('[data-seo-look-up]')
    expect(posts).toEqual([{ path: '/api/account/seo/domain/overview', body: { location_code: 2840, language_code: 'en' } }])
    expect(spendReads()).toBe(before + 1)
    expect(q('[data-seo-site-title]')!.textContent).toBe(OWN)
    expect(q('[data-seo-own-chip]')).not.toBeNull()
    // Just bought: no Refresh.
    expect(q('[data-seo-refresh]')).toBeNull()
    expect(q('[data-seo-looked-up]')!.textContent).toBe('United States · Looked up just now')
  })

  it('names another site, and the crumb goes back to the index', async () => {
    await render()
    await type('[data-seo-site]', `https://www.${RIVAL}/shop`)
    await press('[data-seo-site]', 'Enter')
    expect(posts[0]).toEqual({ path: '/api/account/seo/domain/overview', body: { domain: `https://www.${RIVAL}/shop`, location_code: 2840, language_code: 'en' } })
    expect(q('[data-seo-site-title]')!.textContent).toBe(RIVAL)
    expect(q('[data-seo-own-chip]')).toBeNull()
    await click('[data-seo-competitors-page] button[title="Competitors"]')
    expect(q('[data-seo-competitors-page]')!.dataset.seoState).toBe('index')
  })

  it('says a site the server can’t use beside the field, never in a toast', async () => {
    postAnswer = () => ({ status: 400, body: { error: 'That isn’t a domain or a web address.', code: 'VALIDATION_ERROR' } })
    await render()
    await type('[data-seo-site]', 'not a site')
    await click('[data-seo-look-up]')
    expect(q('[data-seo-site-error]')!.textContent).toBe('That isn’t a domain or a web address.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    await type('[data-seo-site]', 'not a sit')
    expect(q('[data-seo-site-error]')).toBeNull()
  })

  it('shows the month’s limit as a neutral banner and keeps the page usable', async () => {
    postAnswer = () => ({ status: 402, body: { error: 'This workspace has reached its search data limit for the month.', code: 'SPEND_LIMIT_REACHED' } })
    await render()
    await click('[data-seo-look-up]')
    const banner = q('[data-seo-limit]')!
    expect(banner.textContent).toContain('reached its search data limit')
    expect(banner.className).not.toMatch(/amber|red/)
    expect(q<HTMLButtonElement>('[data-seo-look-up]')!.disabled).toBe(false)
  })

  it('shows a failed lookup as an amber banner with Try again', async () => {
    postAnswer = () => ({ status: 502, body: { error: 'The search data provider didn’t answer. Try again in a moment.', code: 'UPSTREAM_UNAVAILABLE' } })
    await render()
    await click('[data-seo-look-up]')
    expect(q('[data-seo-failed]')!.textContent).toContain('didn’t answer')
    postAnswer = (path, body) => ({ status: 200, body: overview({ domain: (body.domain as string) ?? OWN, from_cache: false }) })
    await click('[data-seo-failed] button')
    expect(posts).toHaveLength(2)
    expect(q('[data-seo-failed]')).toBeNull()
    expect(q('[data-seo-site-title]')).not.toBeNull()
  })

  it('turns lookups off when the route says so after the fact', async () => {
    postAnswer = () => ({ status: 403, body: { error: 'Search data is part of the paid plan.', code: 'FREE_PLAN' } })
    await render()
    await click('[data-seo-look-up]')
    expect(q('[data-seo-data-off="FREE_PLAN"]')).not.toBeNull()
    const button = q<HTMLButtonElement>('[data-seo-look-up]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Part of the paid plan')
  })

  it('shows a site with no search data quietly', async () => {
    postAnswer = () => ({ status: 200, body: overview({ has_data: false, organic_keywords: 0, organic_traffic: 0, top_keywords: [], top_pages: [], from_cache: false }) })
    await render()
    await click('[data-seo-look-up]')
    expect(q('[data-seo-no-data]')!.textContent).toContain('No search data for this site')
    expect(q('[data-seo-tab]')).toBeNull()
    expect(q('[data-seo-tile]')).toBeNull()
  })

  it('a partial overview shows its note as one quiet line under the looked-up line, once, with Refresh', async () => {
    const note = 'Its top pages couldn’t be read just now.'
    postAnswer = () => ({
      status: 200,
      body: overview({
        top_pages: [],
        caveats: ['Traffic is an estimate of monthly organic visits from Google.', note],
        partial: { missing: ['top_pages'], note },
        from_cache: false,
        fetched_at: new Date().toISOString(),
      }),
    })
    await render()
    await click('[data-seo-look-up]')
    const line = q('[data-seo-partial]')!
    expect(line.textContent).toBe(note)
    expect(line.className).toContain('text-muted-foreground')
    expect(line.className).not.toMatch(/amber|destructive|red/)
    expect(q('[data-seo-looked-up]')!.closest('div')!.nextElementSibling).toBe(line)
    // Not an error, not a toast; the site's tabs and tiles are all there.
    expect(q('[data-seo-failed]')).toBeNull()
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    expect(q('[data-seo-tab="keywords"]')).not.toBeNull()
    expect(all('[data-seo-top-keyword]')).toHaveLength(10)
    expect(q('[data-seo-top-pages]')).toBeNull()
    // Said once: the caveats keep their own words and drop the repeat.
    expect(q('[data-seo-caveats]')!.textContent).toBe('Traffic is an estimate of monthly organic visits from Google.')
    expect(document.body.textContent!.split(note)).toHaveLength(2)
    // Just bought but missing a part: Refresh is there, and buys again.
    const refresh = q<HTMLButtonElement>('[data-seo-refresh]')!
    expect(refresh.disabled).toBe(false)
    postAnswer = () => ({ status: 200, body: overview({ from_cache: false, fetched_at: new Date().toISOString() }) })
    await click('[data-seo-refresh]')
    expect(posts.at(-1)).toEqual({ path: '/api/account/seo/domain/overview', body: { location_code: 2840, language_code: 'en', refresh: true } })
    expect(q('[data-seo-partial]')).toBeNull()
  })

  it('a whole overview has no partial line', async () => {
    await render()
    await click('[data-seo-look-up]')
    expect(q('[data-seo-site-title]')).not.toBeNull()
    expect(q('[data-seo-partial]')).toBeNull()
  })

  it('a stored overview with no data reads as the no-data state, with when it was looked up and Refresh, and buys nothing', async () => {
    const L_NEW = '33333333-3333-4333-8333-333333333333'
    postAnswer = () => ({
      status: 200,
      body: overview({
        lookup_id: L_NEW,
        domain: 'newshop.example',
        is_own_site: false,
        has_data: false,
        organic_keywords: 0,
        organic_traffic: 0,
        top_keywords: [],
        top_pages: [],
        from_cache: true,
        fetched_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      }),
    })
    await render()
    const before = spendReads()
    await type('[data-seo-site]', 'newshop.example')
    await click('[data-seo-look-up]')
    expect(q('[data-seo-site-title]')!.textContent).toBe('newshop.example')
    expect(q('[data-seo-no-data]')!.textContent).toContain('No search data for this site')
    expect(q('[data-seo-looked-up]')!.textContent).toBe('United States · Looked up 2 hours ago')
    expect(q('[data-seo-tab]')).toBeNull()
    expect(q('[data-seo-partial]')).toBeNull()
    expect(q('[data-seo-failed]')).toBeNull()
    // From storage: not a purchase, so the spend line is not read again.
    expect(spendReads()).toBe(before)
    const refresh = q<HTMLButtonElement>('[data-seo-refresh]')!
    expect(refresh.disabled).toBe(false)
    await click('[data-seo-refresh]')
    expect(posts.at(-1)).toEqual({ path: '/api/account/seo/domain/overview', body: { domain: 'newshop.example', location_code: 2840, language_code: 'en', refresh: true } })
  })
})

describe('SeoCompetitorsCard: stored overviews with no data', () => {
  const emptyStored = (domain: string) => stored(overview({ domain, has_data: false, organic_keywords: 0, organic_traffic: 0, top_keywords: [], top_pages: [] }))

  it('the own site’s stored empty overview opens by itself as the no-data state, with Refresh', async () => {
    routes[`/api/account/seo/lookups/${L_OWN}`] = { id: L_OWN, kind: 'domain_overview', label: `${OWN} · United States`, fetched_at: overview().fetched_at, fetched_by: 'user-me', request: {}, result: emptyStored(OWN) }
    await render()
    expect(posts).toEqual([])
    expect(q('[data-seo-site-title]')!.textContent).toBe(OWN)
    expect(q('[data-seo-no-data]')).not.toBeNull()
    expect(q('[data-seo-looked-up]')!.textContent).toBe('United States · Looked up 3 hours ago')
    expect(q('[data-seo-refresh]')).not.toBeNull()
  })

  it('sits in Recent like any lookup and reopens for free as the no-data state', async () => {
    routes['/api/account/seo/lookups?kind=domain_overview&limit=20'] = recentOf([L_RIVAL, `${RIVAL} · United States`])
    routes[`/api/account/seo/lookups/${L_RIVAL}`] = { id: L_RIVAL, kind: 'domain_overview', label: `${RIVAL} · United States`, fetched_at: overview().fetched_at, fetched_by: 'user-me', request: {}, result: emptyStored(RIVAL) }
    await render()
    expect(q(`[data-seo-recent-row="${L_RIVAL}"]`)!.textContent).toContain(`${RIVAL}United States · 3 hours ago`)
    await click(`[data-seo-recent-row="${L_RIVAL}"] button`)
    expect(posts).toEqual([])
    expect(q('[data-seo-site-title]')!.textContent).toBe(RIVAL)
    expect(q('[data-seo-no-data]')!.textContent).toContain('It may be new, or too small to be measured yet.')
    expect(q('[data-seo-looked-up]')!.textContent).toBe('United States · Looked up 3 hours ago')
    expect(q('[data-seo-refresh]')).not.toBeNull()
  })
})

describe('SeoCompetitorsCard: lookups off', () => {
  beforeEach(() => {
    routes['/api/account/seo/spend'] = { ...SPEND, can_buy: false, refusal: { code: 'SEO_NOT_CONFIGURED', message: 'Search data isn’t set up on this server yet.' }, configured: false }
  })

  it('shows the notice under the disabled start control when nothing is stored', async () => {
    routes['/api/account/seo/lookups?kind=domain_overview&limit=20'] = { lookups: [] }
    await render()
    expect(q('[data-seo-data-off="SEO_NOT_CONFIGURED"]')!.textContent).toContain('Site data isn’t set up yet')
    expect(q('[data-seo-first-run]')).toBeNull()
    const button = q<HTMLButtonElement>('[data-seo-look-up]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Search data isn’t set up on this server yet')
  })

  it('still opens what is stored, with Refresh off and saying why', async () => {
    await render()
    expect(q('[data-seo-site-title]')!.textContent).toBe(OWN)
    const refresh = q<HTMLButtonElement>('[data-seo-refresh]')!
    expect(refresh.disabled).toBe(true)
    expect(refresh.title).toBe('Search data isn’t set up on this server yet')
  })
})

describe('SeoCompetitorsCard: Keywords tab', () => {
  it('shows the overview’s hundred without a call, then pages and re-sorts through ranked-keywords', async () => {
    await render()
    await click('[data-seo-tab="keywords"]')
    expect(store.state('cmp-1').tab).toBe('keywords')
    expect(all('[data-seo-keyword-row]')).toHaveLength(100)
    expect(posts).toEqual([])
    const before = spendReads()
    await click('[data-seo-keywords-more]')
    expect(posts).toEqual([
      { path: '/api/account/seo/domain/ranked-keywords', body: { target: OWN, location_code: 2840, language_code: 'en', limit: 100, sort_by: 'traffic', offset: 100 } },
    ])
    expect(all('[data-seo-keyword-row]')).toHaveLength(102)
    expect(spendReads()).toBe(before + 1)

    await click('[data-seo-keywords] [data-seo-filter="rank"]')
    expect(posts[1].body).toEqual({ target: OWN, location_code: 2840, language_code: 'en', limit: 100, sort_by: 'rank' })
    await click('[data-seo-keywords] [data-seo-filter="10"]')
    expect(posts[2].body).toMatchObject({ sort_by: 'rank', max_rank: 10 })
    await type('[data-seo-exclude]', 'Fernhill')
    await press('[data-seo-exclude]', 'Enter')
    expect(posts[3].body).toMatchObject({ exclude_terms: ['fernhill'], max_rank: 10 })
    expect(q('[data-seo-excluded="fernhill"]')).not.toBeNull()

    // Back to the defaults: the overview's rows again, for free.
    await click('[data-seo-excluded="fernhill"] button')
    await click('[data-seo-keywords] [data-seo-filter="any"]')
    const asked = posts.length
    await click('[data-seo-keywords] [data-seo-filter="traffic"]')
    expect(posts).toHaveLength(asked)
    expect(all('[data-seo-keyword-row]')).toHaveLength(100)
  })

  it('says a filter the route refuses beside the field', async () => {
    postAnswer = () => ({ status: 400, body: { error: 'Exclude at most 10 terms.', code: 'VALIDATION_ERROR' } })
    await render()
    await click('[data-seo-tab="keywords"]')
    await click('[data-seo-keywords] [data-seo-filter="search_volume"]')
    expect(q('[data-seo-keywords-error]')!.textContent).toBe('Exclude at most 10 terms.')
  })
})

describe('SeoCompetitorsCard: Competitors tab', () => {
  it('compares on the site’s top searches, pins the own site, hides a site for free and looks one up', async () => {
    await render()
    await click('[data-seo-tab="competitors"]')
    expect(q<HTMLButtonElement>('[data-seo-find-competitors]')!.disabled).toBe(true)
    await click('[data-seo-use-top]')
    expect(q<HTMLTextAreaElement>('[data-seo-compare-keywords]')!.value.split('\n')).toHaveLength(100)
    await click('[data-seo-find-competitors]')
    expect(posts).toHaveLength(1)
    expect(posts[0].path).toBe('/api/account/seo/domain/competitors')
    expect(posts[0].body).toMatchObject({ location_code: 2840, language_code: 'en', sort_by: 'visibility' })
    expect((posts[0].body.keywords as string[])).toHaveLength(100)
    expect(all('[data-seo-competitor-row]').map((r) => r.dataset.seoCompetitorRow)).toEqual([OWN, RIVAL, 'loomhouse.example'])
    expect(q(`[data-seo-competitor-row="${OWN}"] [data-seo-own-chip]`)).not.toBeNull()
    expect(q(`[data-seo-competitor-row="${OWN}"] [data-seo-row-hide]`)).toBeNull()
    expect(q(`[data-seo-competitor-row="${RIVAL}"]`)!.textContent).toContain('4.3')
    expect(q(`[data-seo-competitor-row="loomhouse.example"]`)!.textContent).toContain('0.4%')

    await click(`[data-seo-row-hide="loomhouse.example"]`)
    expect(posts[1].body).toMatchObject({ exclude_domains: ['loomhouse.example'] })
    expect(all('[data-seo-competitor-row]')).toHaveLength(2)
    expect(q('[data-seo-hidden]')!.textContent).toContain('1 site hidden')

    await click(`[data-seo-row-look-up="${RIVAL}"]`)
    expect(posts[2]).toEqual({ path: '/api/account/seo/domain/overview', body: { domain: RIVAL, location_code: 2840, language_code: 'en' } })
    expect(q('[data-seo-site-title]')!.textContent).toBe(RIVAL)
    expect(store.state('cmp-1').tab).toBe('overview')
  })

  it('says when no competitors were found', async () => {
    postAnswer = () => ({ status: 200, body: { lookup_id: 'c2', keywords: ['linen throw 0'], location_code: 2840, language_code: 'en', own_domain: OWN, rows: [], caveats: [], fetched_at: new Date().toISOString(), from_cache: false } })
    await render()
    await click('[data-seo-tab="competitors"]')
    await type('[data-seo-compare-keywords]', 'linen throw 0')
    await click('[data-seo-find-competitors]')
    expect(posts[0].body.keywords).toEqual(['linen throw 0'])
    expect(q('[data-seo-competitors-empty]')!.textContent).toBe('No competitors found for these searches')
  })
})
