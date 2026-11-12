// @vitest-environment jsdom
/**
 * SEO's Backlinks card: opening never spends (the own site's stored overview
 * opens from the stored lookups, else the first run with the own site
 * prefilled, or the Recent list), "Look up links" is the request (the target
 * as typed, a page's scope choice, the spend line read again after), a
 * correctable address said beside the field, a 402 as a neutral banner, a
 * failure as an amber banner with a retry, lookups off (the notice, disabled
 * buttons with their reason, stored lookups still open), a site with no
 * links, a folder (no history, the scope note, no Sites list), and the three
 * lists: each waits for its Load button, then sorts, filters, Show more and
 * the Sites tab's "See its links".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => React.createElement('span', { 'data-thinking-orb': '' }) }))

import SeoBacklinksCard from '../pages/seo-backlinks-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { BacklinkRow, BacklinksOverview, BacklinksProfilePage, BacklinksTrendPoint } from '@/lib/seo/backlinks/view'
import type { SeoSpendView } from '@/lib/seo/spend-view'

const spec: PageCardSpec = { kind: 'seo_backlinks', title: 'Backlinks' }
const OWN = 'fernhillstudio.example'
const RIVAL = 'oakandloom.example'
const L_OWN = '11111111-1111-4111-8111-111111111111'
const L_RIVAL = '22222222-2222-4222-8222-222222222222'
const RECENT = '/api/account/seo/lookups?kind=backlinks_overview&limit=20'

const SPEND: SeoSpendView = { spent_dollars: 3.4, cap_dollars: 20, resets_at: '2026-12-01T00:00:00Z', configured: true, can_buy: true, refusal: null }
const OFF: SeoSpendView = { ...SPEND, can_buy: false, refusal: { code: 'FREE_PLAN', message: 'Search data is part of the paid plan.' } }

const point = (date: string, rd: number, bl: number, extra: Partial<BacklinksTrendPoint> = {}): BacklinksTrendPoint => ({
  date,
  referring_domains: rd,
  backlinks: bl,
  rank: null,
  new_backlinks: null,
  lost_backlinks: null,
  new_referring_domains: null,
  lost_referring_domains: null,
  ...extra,
})
const HISTORY = [
  point('2025-11-01', 300, 9000),
  point('2026-06-01', 360, 11000),
  point('2026-11-01', 420, 12480, { new_referring_domains: 14, lost_referring_domains: 3, new_backlinks: 90, lost_backlinks: 25 }),
]

const overview = (extra: Partial<BacklinksOverview> = {}): BacklinksOverview => ({
  lookup_id: L_OWN,
  target: OWN,
  display_target: OWN,
  scope: 'subdomains',
  summary: {
    rank: 212,
    backlinks: 12480,
    referring_pages: 9000,
    referring_domains: 420,
    broken_backlinks: 3,
    broken_pages: 1,
    dofollow_share: 0.823,
    backlinks_spam_score: 4,
    target_spam_score: 2,
    new_backlinks: null,
    lost_backlinks: null,
    new_referring_domains: null,
    lost_referring_domains: null,
  },
  history: HISTORY,
  scope_note: null,
  fetched_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  from_cache: true,
  ...extra,
})
const stored = (o: BacklinksOverview) => {
  const { lookup_id: _a, fetched_at: _b, from_cache: _c, ...rest } = o
  return rest
}
const recentOf = (...rows: Array<[string, string]>) => ({
  lookups: rows.map(([id, label]) => ({ id, kind: 'backlinks_overview', label, fetched_at: new Date(Date.now() - 3 * 3600_000).toISOString(), fetched_by: 'user-me' })),
})

const link = (i: number, extra: Partial<BacklinkRow> = {}): BacklinkRow => ({
  domain_from: `blog${i}.${RIVAL}`,
  url_from: `https://blog${i}.${RIVAL}/notes/linen-${i}`,
  url_to: `https://${OWN}/shop/linen-throw`,
  anchor: `linen throw ${i}`,
  item_type: 'anchor',
  dofollow: true,
  rel_attributes: [],
  rank: 100 - i,
  domain_from_rank: 300,
  page_from_rank: 50,
  spam_score: 1,
  first_seen: '2026-11-09',
  last_seen: null,
  is_lost: false,
  is_broken: false,
  links_count: 1,
  ...extra,
})
const meta = { target: OWN, display_target: OWN, scope: 'subdomains' as const, page_size: 50, lookup_id: 'p1', fetched_at: new Date().toISOString(), from_cache: false }

function profileAnswer(body: Record<string, unknown>): BacklinksProfilePage {
  const page = (body.page as number) ?? 1
  if (body.tab === 'domains')
    return {
      ...meta,
      tab: 'domains',
      page,
      total_count: 2,
      has_more: false,
      rows: [
        { domain: RIVAL, backlinks: 61, referring_pages: 20, rank: 310, spam_score: 2, first_seen: '2026-01-04', broken_backlinks: 0, broken_pages: 0 },
        { domain: 'loomhouse.example', backlinks: 4, referring_pages: 3, rank: 120, spam_score: 1, first_seen: '2026-10-30', broken_backlinks: 0, broken_pages: 0 },
      ],
    }
  if (body.tab === 'pages')
    return {
      ...meta,
      tab: 'pages',
      page,
      total_count: 1,
      has_more: false,
      rows: [{ page: `https://${OWN}/shop/linen-throw`, backlinks: 900, referring_domains: 120, rank: 40, broken_backlinks: 0 }],
    }
  return {
    ...meta,
    tab: 'backlinks',
    page,
    total_count: 120,
    has_more: page < 3,
    rows: page === 1 ? [link(1), link(2, { dofollow: false, rel_attributes: ['nofollow', 'ugc'], is_lost: true, anchor: '<b>Shop</b>' }), link(3, { is_broken: true, anchor: '' })] : [link(50 + page)],
  }
}

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
    '/api/account/seo/audits': { audits: [], default_url: `https://www.${OWN}/`, limits: { min_pages: 10, default_pages: 100, max_pages: 1000 } },
    [RECENT]: recentOf([L_OWN, `${OWN} · backlinks overview`], [L_RIVAL, `${RIVAL} · backlinks overview`]),
    [`/api/account/seo/lookups/${L_OWN}`]: { id: L_OWN, kind: 'backlinks_overview', label: `${OWN} · backlinks overview`, fetched_at: overview().fetched_at, fetched_by: 'user-me', request: {}, result: stored(overview()) },
    [`/api/account/seo/lookups/${L_RIVAL}`]: {
      id: L_RIVAL,
      kind: 'backlinks_overview',
      label: `${RIVAL} · backlinks overview`,
      fetched_at: overview().fetched_at,
      fetched_by: 'user-me',
      request: {},
      result: stored(overview({ target: RIVAL, display_target: RIVAL })),
    },
  }
  postAnswer = (path, body) => {
    if (path.endsWith('/backlinks/overview')) {
      const target = String(body.target ?? OWN).replace(/^https?:\/\/(www\.)?/, '')
      return { status: 200, body: { overview: overview({ target, display_target: target, scope: (body.scope as BacklinksOverview['scope']) ?? 'subdomains', from_cache: false, fetched_at: new Date().toISOString() }) } }
    }
    if (path.endsWith('/backlinks/profile')) return { status: 200, body: { profile: profileAnswer(body) } }
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
  store = makeStore('bl-1', spec)
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
  const el = q<HTMLInputElement>(sel)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
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
const profilePosts = () => posts.filter((p) => p.path.endsWith('/backlinks/profile'))

async function render() {
  await mount.render(React.createElement(SeoBacklinksCard, { toolCallId: 'bl-1', spec, store, fullScreen: true }))
  await settle()
  await settle()
}

describe('SeoBacklinksCard: opening never spends', () => {
  it('opens the own site’s stored overview: tiles in plain words, two trends, looked-up line with Refresh', async () => {
    await render()
    expect(posts).toEqual([])
    expect(q('[data-seo-backlinks-page]')!.dataset.seoState).toBe('site')
    expect(q('[data-seo-target-title]')!.textContent).toBe(OWN)
    expect(q('[data-seo-own-chip]')).not.toBeNull()
    expect(q('[data-seo-looked-up]')!.textContent).toBe('Looked up 3 hours ago')
    expect(q('[data-seo-refresh]')).not.toBeNull()
    expect(q('[data-seo-scope-note]')).toBeNull()
    expect(q('[data-seo-spend]')!.textContent).toContain('$3.40 of $20 this month')
    expect(all('[data-seo-tile]').map((t) => t.dataset.seoTile)).toEqual(['sites', 'links', 'followed', 'new', 'lost', 'rank', 'spam'])
    const sites = q('[data-seo-tile="sites"]')!
    expect(sites.textContent).toContain('420')
    expect(sites.textContent).toContain('Sites linking to you')
    expect(sites.textContent).toContain('up 120 in a year')
    expect(sites.querySelector('[title]')!.getAttribute('title')).toContain('Referring domains')
    expect(q('[data-seo-tile="followed"]')!.textContent).toContain('82%')
    expect(q('[data-seo-tile="new"]')!.textContent).toContain('14')
    expect(q('[data-seo-tile="new"]')!.textContent).toContain('90 new links')
    expect(q('[data-seo-tile="lost"]')!.textContent).toContain('25 lost links')
    expect(q('[data-seo-trend-sites] svg')!.getAttribute('aria-label')).toContain('Sites linking: 300 on')
    expect(q('[data-seo-trend-links] [data-seo-trend-line="links"]')).not.toBeNull()
    // The tab pills carry the counts the overview has.
    expect(q('[data-seo-tab="links"]')!.textContent).toBe('Links12,480')
    expect(q('[data-seo-tab="domains"]')!.textContent).toBe('Sites420')
  })

  it('shows the first run with the own site prefilled when it has no stored overview, and the Recent list otherwise', async () => {
    routes[RECENT] = { lookups: [] }
    await render()
    expect(posts).toEqual([])
    expect(q('[data-seo-first-run]')!.textContent).toContain('See who links to your site')
    expect(q<HTMLInputElement>('[data-seo-site]')!.value).toBe(OWN)
    expect(q('[data-seo-recent]')).toBeNull()
    mount.unmount()

    routes[RECENT] = recentOf([L_RIVAL, `${RIVAL} · backlinks overview`])
    mount = mountRoot()
    await render()
    expect(posts).toEqual([])
    expect(q('[data-seo-first-run]')).toBeNull()
    expect(q(`[data-seo-recent-row="${L_RIVAL}"]`)!.textContent).toBe(`${RIVAL}3 hours ago`)
    await click(`[data-seo-recent-row="${L_RIVAL}"] button`)
    expect(posts).toEqual([])
    expect(q('[data-seo-target-title]')!.textContent).toBe(RIVAL)
    expect(q('[data-seo-own-chip]')).toBeNull()
    expect(q('[data-seo-tile="sites"]')!.textContent).toContain('Sites linking to it')
    // Back to the index.
    await click('[data-seo-backlinks-page] button[title="Backlinks"]')
    expect(q('[data-seo-backlinks-page]')!.dataset.seoState).toBe('index')
  })

  it('leaves the field empty when the own site is not known', async () => {
    routes[RECENT] = { lookups: [] }
    routes['/api/account/seo/audits'] = { audits: [], default_url: null, limits: {} }
    await render()
    expect(q<HTMLInputElement>('[data-seo-site]')!.value).toBe('')
    expect(q<HTMLButtonElement>('[data-seo-look-up]')!.disabled).toBe(true)
  })

  it('says it could not load, and tries again', async () => {
    delete routes[RECENT]
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your backlink lookups.')
    routes[RECENT] = { lookups: [] }
    await click('[data-seo-error] button')
    expect(q('[data-seo-first-run]')).not.toBeNull()
  })
})

describe('SeoBacklinksCard: looking a site up', () => {
  beforeEach(() => {
    routes[RECENT] = { lookups: [] }
  })

  it('asks the overview route for the typed site, and reads the spend line again after', async () => {
    await render()
    const before = spendReads()
    await type('[data-seo-site]', RIVAL)
    await click('[data-seo-look-up]')
    expect(posts).toEqual([{ path: '/api/account/seo/backlinks/overview', body: { target: RIVAL } }])
    expect(q('[data-seo-target-title]')!.textContent).toBe(RIVAL)
    expect(q('[data-seo-refresh]')).toBeNull()
    expect(spendReads()).toBe(before + 1)
  })

  it('offers how far a page address reaches, and sends it', async () => {
    await render()
    expect(q('[data-seo-page-scope]')).toBeNull()
    await type('[data-seo-site]', `${RIVAL}/journal`)
    expect(q('[data-seo-page-scope]')).not.toBeNull()
    await click('[data-seo-page-scope] [data-seo-filter="subfolder"]')
    await press('[data-seo-site]', 'Enter')
    expect(posts[0].body).toEqual({ target: `${RIVAL}/journal`, scope: 'subfolder' })
  })

  it('says the route’s refusal of an address beside the field, and clears it on typing', async () => {
    await render()
    await type('[data-seo-site]', 'fernhill studio')
    postAnswer = () => ({ status: 400, body: { error: 'Enter a valid domain like example.com', code: 'VALIDATION_ERROR' } })
    await click('[data-seo-look-up]')
    expect(q('[data-seo-site-error]')!.textContent).toBe('Enter a valid domain like example.com')
    expect(q('[data-seo-backlinks-page]')!.dataset.seoState).toBe('index')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    await type('[data-seo-site]', 'fernhill.example')
    expect(q('[data-seo-site-error]')).toBeNull()
  })

  it('says the route’s NO_SITE sentence beside the field', async () => {
    await render()
    postAnswer = () => ({ status: 400, body: { error: 'Which website? Give a domain or a page address (for example example.com).', code: 'NO_SITE' } })
    await click('[data-seo-look-up]')
    expect(q('[data-seo-site-error]')!.textContent).toContain('Which website?')
  })

  it('shows the month’s limit as a neutral banner, and a failure as an amber banner with a retry', async () => {
    await render()
    postAnswer = () => ({ status: 402, body: { error: 'This workspace has reached its search data limit for the month.', code: 'SPEND_LIMIT_REACHED' } })
    await click('[data-seo-look-up]')
    expect(q('[data-seo-limit]')!.textContent).toContain('search data limit')
    expect(q('[data-seo-failed]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-seo-look-up]')!.disabled).toBe(false)

    postAnswer = () => ({ status: 502, body: { error: 'The search data provider didn’t answer. Try again in a moment.', code: 'UPSTREAM_UNAVAILABLE' } })
    await click('[data-seo-look-up]')
    expect(q('[data-seo-limit]')).toBeNull()
    expect(q('[data-seo-failed]')!.textContent).toContain('didn’t answer')
    postAnswer = (path, body) => ({ status: 200, body: { overview: overview({ target: String(body.target), display_target: String(body.target), from_cache: false }) } })
    await click('[data-seo-failed] button')
    expect(q('[data-seo-target-title]')!.textContent).toBe(OWN)
    expect(posts.at(-1)!.body).toEqual({ target: OWN })
  })

  it('turns lookups off when the route refuses after the fact', async () => {
    await render()
    postAnswer = () => ({ status: 403, body: { error: 'Search data is part of the paid plan.', code: 'FREE_PLAN' } })
    routes['/api/account/seo/spend'] = OFF
    await click('[data-seo-look-up]')
    await settle()
    expect(q('[data-seo-data-off="FREE_PLAN"]')!.textContent).toContain('Backlink data is part of the paid plan')
    expect(q<HTMLButtonElement>('[data-seo-look-up]')!.title).toBe('Part of the paid plan')
  })

  it('draws no trend for a folder, says why, and does not list its linking sites', async () => {
    await render()
    postAnswer = () => ({
      status: 200,
      body: {
        overview: overview({
          target: OWN,
          display_target: `${OWN}/journal`,
          scope: 'subfolder',
          history: [],
          summary: { ...overview().summary, rank: null, dofollow_share: null, target_spam_score: null },
          scope_note: 'For a subfolder only the backlink and referring-domain totals can be counted; rank, history and the referring-domains list are not available.',
          from_cache: false,
        }),
      },
    })
    await type('[data-seo-site]', `${OWN}/journal`)
    await click('[data-seo-page-scope] [data-seo-filter="subfolder"]')
    await click('[data-seo-look-up]')
    expect(q('[data-seo-scope-note]')!.textContent).toContain('only the backlink and referring-domain totals')
    expect(q('[data-seo-trend]')).toBeNull()
    expect(all('[data-seo-tile]').map((t) => t.dataset.seoTile)).toEqual(['sites', 'links'])
    expect(q('[data-seo-own-chip]')).toBeNull()
    await click('[data-seo-tab="domains"]')
    expect(q('[data-seo-sites-folder]')).not.toBeNull()
    expect(q('[data-seo-load="domains"]')).toBeNull()
  })

  it('says when a site has no links', async () => {
    await render()
    postAnswer = () => ({ status: 200, body: { overview: overview({ summary: { ...overview().summary, backlinks: 0, referring_domains: 0 }, history: [], from_cache: false }) } })
    await click('[data-seo-look-up]')
    expect(q('[data-seo-no-links]')!.textContent).toBe('No links found for this site yet')
    expect(q('[data-seo-tile]')).toBeNull()
  })
})

describe('SeoBacklinksCard: lookups off', () => {
  beforeEach(() => {
    routes['/api/account/seo/spend'] = OFF
  })

  it('shows the notice where the page would be empty, with the button disabled and saying why', async () => {
    routes[RECENT] = { lookups: [] }
    await render()
    expect(q('[data-seo-data-off="FREE_PLAN"]')).not.toBeNull()
    expect(q('[data-seo-first-run]')).toBeNull()
    const button = q<HTMLButtonElement>('[data-seo-look-up]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Part of the paid plan')
  })

  it('still opens stored lookups, with Refresh and the lists’ Load buttons disabled', async () => {
    await render()
    expect(q('[data-seo-target-title]')!.textContent).toBe(OWN)
    expect(q<HTMLButtonElement>('[data-seo-refresh]')!.disabled).toBe(true)
    await click('[data-seo-tab="links"]')
    const load = q<HTMLButtonElement>('[data-seo-load="backlinks"]')!
    expect(load.disabled).toBe(true)
    expect(load.title).toBe('Part of the paid plan')
    expect(posts).toEqual([])
  })
})

describe('SeoBacklinksCard: Links', () => {
  it('waits for Load links, then shows the links with their text as plain text', async () => {
    await render()
    await click('[data-seo-tab="links"]')
    expect(store.state('bl-1').tab).toBe('links')
    expect(profilePosts()).toEqual([])
    expect(q('[data-seo-load-gate="backlinks"]')!.textContent).toContain('Reads up to 50 rows')
    const before = spendReads()
    await click('[data-seo-load="backlinks"]')
    expect(profilePosts()[0].body).toEqual({
      tab: 'backlinks',
      target: OWN,
      scope: 'subdomains',
      page: 1,
      page_size: 50,
      sort_field: 'firstSeen',
      sort_order: 'desc',
      filters: {},
      mode: 'one_per_domain',
      hide_spam: true,
    })
    expect(spendReads()).toBe(before + 1)
    const rows = all('[data-seo-link-row]')
    expect(rows).toHaveLength(3)
    const first = rows[0]
    const a = first.querySelector<HTMLAnchorElement>('a')!
    expect(a.href).toBe(`https://blog1.${RIVAL}/notes/linen-1`)
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noreferrer noopener')
    expect(a.querySelector('.font-medium')!.textContent).toBe(`blog1.${RIVAL}`)
    expect(first.querySelector('[data-seo-follow]')!.textContent).toBe('Followed')
    // Another site's words stay words.
    expect(rows[1].textContent).toContain('<b>Shop</b>')
    expect(rows[1].querySelector('b')).toBeNull()
    expect(rows[1].querySelector('[data-seo-follow]')!.getAttribute('title')).toContain('nofollow, ugc')
    expect(rows[1].querySelector('[data-seo-lost]')).not.toBeNull()
    expect(rows[2].querySelector('[data-seo-broken]')).not.toBeNull()
    expect(rows[2].textContent).toContain('No link text')
    expect(q('[data-seo-list-meta]')!.textContent).toBe('3 of 120 sites')
  })

  it('asks again on a sort, the toggles and "contains", and Show more reads the next page', async () => {
    await render()
    await click('[data-seo-tab="links"]')
    await click('[data-seo-load="backlinks"]')
    await click('[data-seo-list="backlinks"] [data-seo-filter="domainRank"]')
    expect(profilePosts().at(-1)!.body.sort_field).toBe('domainRank')
    await click('[data-seo-toggle="hide-lost"]')
    expect(profilePosts().at(-1)!.body.filters).toEqual({ hideLost: true })
    await click('[data-seo-toggle="hide-spam"]')
    expect(profilePosts().at(-1)!.body.hide_spam).toBe(false)
    await type('[data-seo-contains]', 'blog')
    await press('[data-seo-contains]', 'Enter')
    expect(profilePosts().at(-1)!.body.filters).toEqual({ include: 'blog', hideLost: true })
    const asked = profilePosts().length
    await click('[data-seo-more="backlinks"]')
    expect(profilePosts()).toHaveLength(asked + 1)
    expect(profilePosts().at(-1)!.body.page).toBe(2)
    expect(all('[data-seo-link-row]')).toHaveLength(4)
    // Clearing "contains" asks again without it.
    await click('[data-seo-contains-clear]')
    expect(profilePosts().at(-1)!.body.filters).toEqual({ hideLost: true })
  })

  it('says a stored copy answered, with Refresh buying it again', async () => {
    postAnswer = (path, body) => ({ status: 200, body: { profile: { ...profileAnswer(body), from_cache: true, fetched_at: new Date(Date.now() - 2 * 3600_000).toISOString() } } })
    await render()
    await click('[data-seo-tab="links"]')
    const before = spendReads()
    await click('[data-seo-load="backlinks"]')
    expect(spendReads()).toBe(before)
    expect(q('[data-seo-list-meta]')!.textContent).toBe('3 of 120 sites · Looked up 2 hours ago')
    await click('[data-seo-list-refresh="backlinks"]')
    expect(profilePosts().at(-1)!.body.refresh).toBe(true)
  })

  it('says when nothing is found, and when a filter matches nothing', async () => {
    postAnswer = (path, body) => ({ status: 200, body: { profile: { ...profileAnswer(body), rows: [], total_count: 0, has_more: false } } })
    await render()
    await click('[data-seo-tab="links"]')
    await click('[data-seo-load="backlinks"]')
    expect(q('[data-seo-list-empty]')!.textContent).toBe('No links found for this site yet')
    await click('[data-seo-toggle="hide-lost"]')
    expect(q('[data-seo-list-empty]')!.textContent).toBe('No links match.')
  })

  it('shows a failed page with Try again, a 400 beside the controls, and the limit neutrally', async () => {
    await render()
    await click('[data-seo-tab="links"]')
    postAnswer = () => ({ status: 502, body: { error: 'Upstream', code: 'UPSTREAM_UNAVAILABLE' } })
    await click('[data-seo-load="backlinks"]')
    expect(q('[data-seo-list-failed]')!.textContent).toContain('Could not load the links.')
    postAnswer = () => ({ status: 400, body: { error: 'Use at most eight filter conditions.', code: 'VALIDATION_ERROR' } })
    await click('[data-seo-list-failed] button')
    expect(q('[data-seo-list-error]')!.textContent).toBe('Use at most eight filter conditions.')
    postAnswer = () => ({ status: 402, body: { error: 'This workspace has reached its search data limit for the month.', code: 'SPEND_LIMIT_REACHED' } })
    await click('[data-seo-toggle="hide-lost"]')
    expect(q('[data-seo-list="backlinks"] [data-seo-limit]')!.textContent).toContain('search data limit')
  })
})

describe('SeoBacklinksCard: Sites and Pages', () => {
  it('lists the linking sites, and "See its links" opens every link from that site', async () => {
    await render()
    await click('[data-seo-tab="domains"]')
    expect(profilePosts()).toEqual([])
    await click('[data-seo-load="domains"]')
    expect(profilePosts()[0].body).toEqual({ tab: 'domains', target: OWN, scope: 'subdomains', page: 1, page_size: 50, sort_field: 'backlinks', sort_order: 'desc', filters: {} })
    const row = q(`[data-seo-site-row="${RIVAL}"]`)!
    expect(row.textContent).toContain('61')
    expect(row.querySelector<HTMLAnchorElement>('a')!.href).toBe(`https://${RIVAL}/`)
    await click(`[data-seo-see-links="${RIVAL}"]`)
    expect(store.state('bl-1').tab).toBe('links')
    const asked = profilePosts().at(-1)!.body
    expect(asked.tab).toBe('backlinks')
    expect(asked.filters).toEqual({ domainFrom: RIVAL })
    expect(asked.mode).toBe('as_is')
    expect(q(`[data-seo-domain-filter="${RIVAL}"]`)).not.toBeNull()
    await click(`[data-seo-domain-filter="${RIVAL}"] button`)
    expect(profilePosts().at(-1)!.body.mode).toBe('one_per_domain')
    expect(q('[data-seo-domain-filter]')).toBeNull()
  })

  it('lists the most-linked pages, and keeps a loaded list across tab switches', async () => {
    await render()
    await click('[data-seo-tab="pages"]')
    await click('[data-seo-load="pages"]')
    expect(profilePosts()[0].body).toEqual({ tab: 'pages', target: OWN, scope: 'subdomains', page: 1, page_size: 50, sort_field: 'backlinks', sort_order: 'desc', filters: {} })
    const row = q('[data-seo-page-row]')!
    expect(row.textContent).toBe('/shop/linen-throw120900')
    await click('[data-seo-tab="overview"]')
    await click('[data-seo-tab="pages"]')
    expect(q('[data-seo-page-row]')).not.toBeNull()
    expect(profilePosts()).toHaveLength(1)
    await click('[data-seo-list="pages"] [data-seo-filter="referringDomains"]')
    expect(profilePosts().at(-1)!.body.sort_field).toBe('referringDomains')
  })
})
