// @vitest-environment jsdom
/**
 * SEO's Rankings card: the first run (what tracking does, New tracker) and
 * the lookups-off notice in its place; the index (a row per tracker with its
 * keywords, market, device and schedule, a status word, the run rail of a
 * live check with Stop, New tracker at the cap); the new tracker dialog (the
 * site prefilled, the estimate from the route, the request, a duplicate
 * opening the existing tracker); one tracker as the card's place (the
 * settings line, tiles with their change, Positions with pins, moves and the
 * selection's Remove, History as the card's tab with a keyword's position
 * over time); Check now (straight, or through the cost dialog above $0.25,
 * the spend limit as a neutral banner); a running, failed and noted check;
 * the schedule dialog's before → after; lookups off; delete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => React.createElement('span', { 'data-thinking-orb': '' }) }))

import SeoRankingsCard from '../pages/seo-rankings-card'
import { resetMarketsForTests } from '@/app/account/(dashboard)/seo/rankings/api'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import type {
  RankEstimateView,
  RankKeywordRow,
  RankPositionView,
  RankRunView,
  RankTrackerDetail,
  RankTrackerSummary,
  RankTrackerView,
} from '@/lib/seo/rank/view'

const spec: PageCardSpec = { kind: 'seo_rankings', title: 'Rankings' }
const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const T3 = '33333333-3333-4333-8333-333333333333'
const R1 = 'aaaaaaa1-1111-4111-8111-111111111111'
const R2 = 'aaaaaaa2-2222-4222-8222-222222222222'
const K1 = 'bbbbbbb1-1111-4111-8111-111111111111'
const K2 = 'bbbbbbb2-2222-4222-8222-222222222222'
const K3 = 'bbbbbbb3-3333-4333-8333-333333333333'

const LIMITS = {
  max_trackers: 20,
  max_keywords_per_tracker: 500,
  max_keywords_per_add: 200,
  min_depth: 10,
  max_depth: 100,
  default_depth: 20,
  default_devices: 'mobile',
  default_schedule: 'manual',
}
const SPEND: SeoSpendView = { spent_dollars: 3.4, cap_dollars: 20, resets_at: '2026-12-01T00:00:00Z', configured: true, can_buy: true, refusal: null }
const SPEND_OFF: SeoSpendView = { ...SPEND, can_buy: false, refusal: { code: 'FREE_PLAN', message: 'Search data is part of the paid plan.' } }
const MARKETS = {
  default_location_code: 2840,
  locations: [
    { code: 2840, label: 'United States', short_label: 'US', default_language: 'en', languages: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }], keyword_data: 'labs', domain_data: true },
    { code: 2826, label: 'United Kingdom', short_label: 'UK', default_language: 'en', languages: [{ code: 'en', label: 'English' }], keyword_data: 'labs', domain_data: true },
  ],
  serp_languages: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }],
}

const run = (id: string, extra: Partial<RankRunView> = {}): RankRunView => ({
  id,
  tracker_id: T1,
  trigger: 'manual',
  status: 'completed',
  keywords_total: 3,
  keywords_checked: 3,
  checks_total: 3,
  checks_collected: 3,
  estimate_usd: 0.06,
  cost_usd: 0.04,
  error: null,
  note: null,
  started_by: 'user-me',
  scheduled_for: null,
  created_at: '2026-11-11T09:00:00Z',
  started_at: '2026-11-11T09:00:00Z',
  completed_at: '2026-11-11T09:50:00Z',
  ...extra,
})

const tracker = (id: string, extra: Partial<RankTrackerView> = {}): RankTrackerView => ({
  id,
  domain: 'fernhillstudio.example',
  location_code: 2840,
  language_code: 'en',
  location_name: null,
  devices: 'mobile',
  serp_depth: 20,
  schedule: { interval: 'daily', weekday: null, hour: 9, minute: 0, time_zone: null },
  next_check_at: '2099-01-01T09:00:00Z',
  last_checked_at: '2026-11-11T09:50:00Z',
  paused: false,
  skip_reason: null,
  skip_message: null,
  keyword_count: 3,
  created_by: 'user-me',
  created_at: '2026-11-01T09:00:00Z',
  latest_run: run(R1),
  ...extra,
})

const DONE = tracker(T1)
const RUNNING = tracker(T2, { domain: 'shop.fernhillstudio.example', schedule: { interval: 'manual', weekday: null, hour: null, minute: null, time_zone: null }, devices: 'both', latest_run: run(R2, { tracker_id: T2, status: 'running', keywords_total: 31, keywords_checked: 0, completed_at: null, started_at: new Date(Date.now() - 12 * 60_000).toISOString() }) })
const PAUSED = tracker(T3, { domain: 'journal.fernhillstudio.example', paused: true, language_code: 'es', keyword_count: 1 })

const pos = (extra: Partial<RankPositionView>): RankPositionView => ({
  device: 'mobile',
  status: 'ranked',
  position: 4,
  previous_position: 6,
  change: 2,
  movement: 'up',
  ranking_url: 'https://fernhillstudio.example/shop/oak-side-table',
  serp_features: [],
  checked_at: '2026-11-11T09:50:00Z',
  ...extra,
})
const KEYWORDS: RankKeywordRow[] = [
  { id: K1, keyword: 'oak side table', pinned: true, created_at: '2026-11-01T09:00:00Z', desktop: null, mobile: pos({}), google_serp_url: 'https://www.google.com/search?q=oak+side+table' },
  { id: K2, keyword: 'linen throw', pinned: false, created_at: '2026-11-01T09:00:00Z', desktop: null, mobile: pos({ position: 15, previous_position: 9, change: -6, movement: 'down', ranking_url: 'https://fernhillstudio.example/shop/linen-throw' }), google_serp_url: 'https://www.google.com/search?q=linen+throw' },
  { id: K3, keyword: 'handmade ceramic bowl', pinned: false, created_at: '2026-11-01T09:00:00Z', desktop: null, mobile: pos({ status: 'not_found', position: null, previous_position: null, change: null, movement: null, ranking_url: null }), google_serp_url: 'https://www.google.com/search?q=handmade+ceramic+bowl' },
]
const summary = (extra: Partial<RankTrackerSummary> = {}): RankTrackerSummary => ({
  device: 'mobile',
  tracked: 3,
  checked: 3,
  ranking: 2,
  not_found: 1,
  top3: 1,
  top10: 1,
  top100: 2,
  average_position: 9.5,
  improved: 1,
  declined: 1,
  unchanged: 0,
  new_rankings: 0,
  lost_rankings: 0,
  movers: { up: [], down: [] },
  ...extra,
})
const DETAIL: RankTrackerDetail = { tracker: DONE, summaries: [summary()] }
const TREND = [
  {
    device: 'mobile',
    points: [
      { run_id: 'r0', checked_at: '2026-11-10T09:50:00Z', keywords_total: 3, checked: 3, found: 2, top3: 0, top10: 2, top100: 2, average_position: 10.4 },
      { run_id: R1, checked_at: '2026-11-11T09:50:00Z', keywords_total: 3, checked: 3, found: 2, top3: 1, top10: 1, top100: 2, average_position: 9.5 },
    ],
  },
]
const estimate = (extra: Partial<RankEstimateView> = {}): RankEstimateView => ({
  keyword_count: 3,
  devices: 'mobile',
  serp_depth: 20,
  searches_per_read: 3,
  reads_per_check: { min: 3, max: 6 },
  per_check_usd: 0.06,
  schedule: 'daily',
  checks_per_month: 30,
  monthly_usd: 1.8,
  ...extra,
})

/** The estimate route's answer, unless the test's own `answer` gives one. */
function estimateAnswer(own: typeof answer, body: unknown): { status: number; body: unknown } {
  const mine = own('POST', '/api/account/seo/rank/estimate', body)
  const b = (body ?? {}) as Record<string, unknown>
  const shaped = b.tracker_id ? 'before' in (mine.body as object) : 'estimate' in (mine.body as object)
  if (shaped) return mine
  if (b.tracker_id) return { status: 200, body: { before: estimate(), after: estimate(), raises_cost: false } }
  return { status: 200, body: { estimate: estimate({ keyword_count: ((b.keywords as string[] | undefined) ?? []).length, schedule: (b.schedule_interval as RankEstimateView['schedule']) ?? 'manual' }) } }
}

let routes: Record<string, unknown>
let sent: Array<{ method: string; path: string; body: unknown }>
let answer: (method: string, path: string, body: unknown) => { status: number; body: unknown }
let fetchMock: ReturnType<typeof stubAppFetch>
let mount: ReturnType<typeof mountRoot>
let store: ChatCardStore

beforeEach(() => {
  window.localStorage.clear()
  resetMarketsForTests()
  hoisted.toast.mockClear()
  hoisted.toast.error.mockClear()
  sent = []
  routes = {
    '/api/account/seo/spend': SPEND,
    '/api/account/seo/locations': MARKETS,
    '/api/account/seo/rank/trackers': { trackers: { rows: [RUNNING, DONE, PAUSED], next_offset: null }, default_domain: 'fernhillstudio.example', configured: true, spend: null, limits: LIMITS },
    [`/api/account/seo/rank/trackers/${T1}`]: DETAIL,
    [`/api/account/seo/rank/trackers/${T1}/history`]: { trend: TREND },
    [`/api/account/seo/rank/trackers/${T1}/keywords`]: { rows: KEYWORDS, next_offset: null },
  }
  answer = () => ({ status: 200, body: {} })
  fetchMock = stubAppFetch(routes)
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      const path = String(input)
      const body = init.body ? JSON.parse(String(init.body)) : null
      sent.push({ method: init.method, path, body })
      const a = (path === '/api/account/seo/rank/estimate' && estimateAnswer(answer, body)) || answer(init.method, path, body)
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
    }
    return get(input, init)
  })
  mount = mountRoot()
  store = makeStore('rank-1', spec)
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
  vi.useRealTimers()
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
const asked = () => fetchMock.mock.calls.map(([input]) => String(input))
const writes = () => sent.filter((s) => s.path !== '/api/account/seo/rank/estimate')
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const openTracker = (id = T1, label = 'fernhillstudio.example') => store.update('rank-1', { at: { type: 'seo_rank_tracker', id, label } })

async function render() {
  await mount.render(React.createElement(SeoRankingsCard, { toolCallId: 'rank-1', spec, store, fullScreen: true }))
  await settle()
  await settle()
}

describe('SeoRankingsCard: first run', () => {
  it('says what tracking does, with New tracker inline', async () => {
    routes['/api/account/seo/rank/trackers'] = { trackers: { rows: [], next_offset: null }, default_domain: 'fernhillstudio.example', configured: true, spend: null, limits: LIMITS }
    await render()
    const first = q('[data-seo-first-run]')!
    expect(first.textContent).toContain('Track where you rank on Google')
    expect(first.textContent).toContain('keeps the history')
    // One New tracker: the first-run block's.
    expect(all('[data-seo-new-tracker]')).toHaveLength(1)
    await click('[data-seo-new-tracker]')
    expect(q('[data-seo-new-tracker-dialog]')).not.toBeNull()
  })

  it('with lookups off and no trackers: the notice instead', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    routes['/api/account/seo/rank/trackers'] = { trackers: { rows: [], next_offset: null }, default_domain: null, configured: true, spend: null, limits: LIMITS }
    await render()
    expect(q('[data-seo-data-off="FREE_PLAN"]')!.textContent).toContain('Rank tracking is part of the paid plan')
    expect(q('[data-seo-first-run]')).toBeNull()
  })
})

describe('SeoRankingsCard: the index', () => {
  it('a row per tracker: keywords, market, device and schedule; a status word where there is one', async () => {
    await render()
    expect(all('[data-seo-tracker-row]').map((r) => r.dataset.seoTrackerRow)).toEqual([T2, T1, T3])
    expect(q(`[data-seo-tracker-row="${T1}"] [data-seo-tracker-subline]`)!.textContent).toBe('3 keywords · United States · mobile · checked daily')
    expect(q(`[data-seo-tracker-row="${T2}"] [data-seo-tracker-subline]`)!.textContent).toBe('3 keywords · United States · mobile and desktop · checked by hand')
    expect(q(`[data-seo-tracker-row="${T3}"] [data-seo-tracker-subline]`)!.textContent).toBe('1 keyword · United States · Spanish · mobile · checked daily')
    expect(q(`[data-seo-tracker-row="${T2}"] [data-seo-tracker-status]`)!.textContent).toBe('Checking')
    expect(q(`[data-seo-tracker-row="${T3}"] [data-seo-tracker-status]`)!.textContent).toBe('Paused')
    expect(q(`[data-seo-tracker-row="${T1}"] [data-seo-tracker-checked]`)!.textContent).toMatch(/^Checked /)
    expect(q('[data-seo-spend]')!.textContent).toContain('$3.40 of $20 this month')
  })

  it('a skipped schedule says so, the reason in its title', async () => {
    routes['/api/account/seo/rank/trackers'] = { trackers: { rows: [tracker(T1, { skip_reason: 'free_plan', skip_message: 'Scheduled checks are skipped: the person who set this tracker up is on the free plan.' })], next_offset: null }, default_domain: null, configured: true, spend: null, limits: LIMITS }
    await render()
    const status = q(`[data-seo-tracker-row="${T1}"] [data-seo-tracker-status]`)!
    expect(status.textContent).toBe('Skipped')
    expect(status.title).toContain('free plan')
  })

  it('a live check: the run rail above the list, and Stop asks the server to stop it', async () => {
    answer = () => ({ status: 200, body: { run: { ...RUNNING.latest_run, status: 'canceled' } } })
    await render()
    const rail = q('[data-seo-run-rail]')!
    expect(rail.textContent).toContain('Checking rankings · shop.fernhillstudio.example · 31 keywords · started 12 minutes ago')
    await click('[data-seo-stop]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/rank/runs/${R2}`, body: null }])
    expect(hoisted.toast).toHaveBeenCalledWith('Stopped. Positions stay as the last finished check left them.')
  })

  it('at the cap, New tracker waits and says why', async () => {
    routes['/api/account/seo/rank/trackers'] = { trackers: { rows: [DONE], next_offset: null }, default_domain: null, configured: true, spend: null, limits: { ...LIMITS, max_trackers: 1 } }
    await render()
    const button = q<HTMLButtonElement>('[data-seo-new-tracker]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('A workspace can have 1 rank trackers. Delete one to add another.')
  })

  it('a failed read: a line and Try again', async () => {
    delete routes['/api/account/seo/rank/trackers']
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your rank trackers.')
  })
})

describe('SeoRankingsCard: new tracker', () => {
  it('prefills the site, shows the route’s estimate, and creates it as the card’s place', async () => {
    answer = (method, path, body) => {
      if (path === '/api/account/seo/rank/estimate') {
        const b = body as { keywords: string[]; schedule_interval: RankEstimateView['schedule'] }
        return { status: 200, body: { estimate: estimate({ keyword_count: b.keywords.length, schedule: b.schedule_interval, checks_per_month: b.schedule_interval === 'manual' ? 0 : 30 }) } }
      }
      return { status: 201, body: { tracker: tracker('44444444-4444-4444-8444-444444444444', { latest_run: null }), keywords: { added: [{ id: K1, keyword: 'oak side table' }], already_tracked: 0, over_cap: 0, rejected: 0 } } }
    }
    await render()
    await click('[data-seo-new-tracker]')
    const dialog = q('[data-seo-new-tracker-dialog]')!
    expect(q<HTMLInputElement>('[data-seo-rank-domain]')!.value).toBe('fernhillstudio.example')
    // The backend's defaults: mobile, checked by hand.
    expect(dialog.querySelector('[data-seo-filter="mobile"]')!.getAttribute('aria-checked')).toBe('true')
    expect(dialog.querySelector('[data-seo-filter="manual"]')!.getAttribute('aria-checked')).toBe('true')
    expect(Array.from(dialog.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="How often"] [role="radio"]')).map((b) => b.textContent)).toEqual(['By hand', 'Daily', 'Weekly', 'Monthly'])
    // No keywords: no estimate line, no estimate asked.
    expect(q('[data-seo-estimate]')).toBeNull()
    await type(q<HTMLTextAreaElement>('[data-seo-keywords]')!, 'Oak side table\nlinen throw\noak side table\n')
    expect(q('[data-seo-keyword-count]')!.textContent).toBe('2 of 200')
    await click(dialog.querySelector<HTMLElement>('[data-seo-filter="daily"]')!)
    await settle(450)
    await settle()
    expect(q('[data-seo-estimate]')!.textContent).toBe('A check costs about $0.06. Daily, about $1.80 a month.')
    expect(sent.filter((s) => s.path === '/api/account/seo/rank/estimate').at(-1)!.body).toEqual({ keywords: ['oak side table', 'linen throw'], language_code: 'en', devices: 'mobile', schedule_interval: 'daily' })
    // A schedule spends on its own: the primary names its monthly cost, and pressing it is the yes.
    expect(q('[data-seo-create-tracker]')!.textContent).toBe('Create, about $1.80 a month')
    await click('[data-seo-create-tracker]')
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/api/account/seo/rank/trackers',
        body: { domain: 'fernhillstudio.example', location_code: 2840, language_code: 'en', devices: 'mobile', schedule_interval: 'daily', keywords: ['oak side table', 'linen throw'], confirmed: true },
      },
    ])
    expect(store.state('rank-1').at).toMatchObject({ type: 'seo_rank_tracker', id: '44444444-4444-4444-8444-444444444444', label: 'fernhillstudio.example' })
  })

  it('a tracker of that site and market already: opens it', async () => {
    answer = (method, path) =>
      path === '/api/account/seo/rank/estimate'
        ? { status: 200, body: { estimate: estimate() } }
        : { status: 409, body: { error: 'fernhillstudio.example is already tracked in that market.', code: 'DUPLICATE_TRACKER', details: { tracker_id: T1 } } }
    await render()
    await click('[data-seo-new-tracker]')
    await click('[data-seo-create-tracker]')
    expect(store.state('rank-1').at).toMatchObject({ type: 'seo_rank_tracker', id: T1 })
    expect(hoisted.toast).toHaveBeenCalledWith('fernhillstudio.example is already tracked in that market.')
  })

  it('a refused site is said beside the field', async () => {
    answer = (method, path) =>
      path === '/api/account/seo/rank/estimate'
        ? { status: 200, body: { estimate: estimate() } }
        : { status: 400, body: { error: 'Enter a valid domain like example.com.', code: 'INVALID_INPUT' } }
    await render()
    await click('[data-seo-new-tracker]')
    await type(q<HTMLInputElement>('[data-seo-rank-domain]')!, 'not a site')
    await click('[data-seo-create-tracker]')
    expect(q('[data-seo-field-error]')!.textContent).toBe('Enter a valid domain like example.com.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    expect(store.state('rank-1').at ?? null).toBeNull()
  })
})

describe('SeoRankingsCard: one tracker', () => {
  it('opens as the card’s place: the crumb, the settings line, tiles with their change, and positions', async () => {
    await render()
    await click(`[data-seo-tracker-row="${T1}"] button`)
    expect(store.state('rank-1').at).toMatchObject({ type: 'seo_rank_tracker', id: T1, label: 'fernhillstudio.example' })
    expect(q('h1')!.textContent).toBe('fernhillstudio.example')
    expect(q('[data-seo-tracker-settings]')!.textContent).toMatch(/^United States · mobile · checked daily · next check /)
    expect(all('[data-seo-tile]').map((t) => t.textContent)).toEqual([
      '1In the top 31 more',
      '1In the top 101 fewer',
      '2In the top 20No change',
      '9.5Average position0.9 better',
    ])
    expect(q('[data-seo-tile="top3"] p:last-child')!.className).toContain('emerald')
    expect(q('[data-seo-tile="top10"] p:last-child')!.className).toContain('red')
    // Positions: pinned first, the number, "Not in top 20", and the move.
    expect(all('[data-seo-keyword-row]').map((r) => r.dataset.seoKeywordRow)).toEqual([K1, K2, K3])
    expect(all('[data-seo-position]').map((p) => p.textContent)).toEqual(['4', '15', 'Not in top 20'])
    const up = q(`[data-seo-keyword-row="${K1}"] [data-seo-change] span`)!
    expect(up.textContent).toBe('↑ 2')
    expect(up.className).toContain('emerald')
    const down = q(`[data-seo-keyword-row="${K2}"] [data-seo-change] span`)!
    expect(down.textContent).toBe('↓ 6')
    expect(down.className).toContain('red')
    expect(q(`[data-seo-keyword-row="${K3}"] [data-seo-change]`)!.textContent).toBe('')
    const link = q<HTMLAnchorElement>(`[data-seo-keyword-row="${K1}"] a`)!
    expect(link.textContent).toBe('/shop/oak-side-table')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer noopener')
    // Back: the crumb walks the card to the index.
    await click('button[aria-label="Rankings"]')
    expect(store.state('rank-1').at).toBeNull()
  })

  it('never checked: tiles are dashes that say when they fill, and positions say not checked yet', async () => {
    routes[`/api/account/seo/rank/trackers/${T1}`] = { tracker: tracker(T1, { latest_run: null, last_checked_at: null }), summaries: [summary({ checked: 0, ranking: 0, top3: 0, top10: 0, top100: 0, average_position: null })] }
    routes[`/api/account/seo/rank/trackers/${T1}/history`] = { trend: [] }
    routes[`/api/account/seo/rank/trackers/${T1}/keywords`] = { rows: [{ ...KEYWORDS[0], mobile: pos({ status: 'not_checked', position: null, previous_position: null, change: null, movement: null, ranking_url: null, checked_at: null }) }], next_offset: null }
    openTracker()
    await render()
    expect(all('[data-seo-tile] p:first-child').map((p) => `${p.textContent}|${p.title}`)).toEqual(Array(4).fill('—|After the first check'))
    const cell = q('[data-seo-position]')!
    expect(cell.textContent).toBe('—')
    expect(cell.title).toBe('Not checked yet')
  })

  it('a row opens its keyword’s history on the History tab, position over time with 1 at the top', async () => {
    routes[`/api/account/seo/rank/trackers/${T1}/history?keyword_id=${K2}&days=90`] = {
      history: {
        keyword_id: K2,
        keyword: 'linen throw',
        series: {
          desktop: null,
          mobile: [
            { run_id: 'r0', checked_at: '2026-11-10T09:50:00Z', position: 9, ranking_url: 'https://fernhillstudio.example/shop/linen-throw' },
            { run_id: 'rx', checked_at: '2026-11-10T21:50:00Z', position: null, ranking_url: null },
            { run_id: R1, checked_at: '2026-11-11T09:50:00Z', position: 15, ranking_url: 'https://fernhillstudio.example/shop/linen-throw' },
          ],
        },
      },
    }
    routes[`/api/account/seo/rank/trackers/${T1}/runs`] = { rows: [run(R1)], next_offset: null }
    openTracker()
    await render()
    await click(`[data-seo-keyword-row="${K2}"]`)
    await settle()
    expect(store.state('rank-1').tab).toBe('history')
    expect(asked()).toContain(`/api/account/seo/rank/trackers/${T1}/history?keyword_id=${K2}&days=90`)
    const chart = q(`[data-seo-keyword-history="${K2}"] svg[role="img"]`)!
    expect(chart.getAttribute('aria-label')).toContain('“linen throw”')
    // A gap where it was not found: two sub-paths.
    expect((q('[data-seo-trend-line="position"]')!.getAttribute('d')!.match(/M/g) ?? []).length).toBe(2)
    expect(all('[data-seo-keyword-check]').map((r) => r.textContent!.includes('Not in top 20') ? 'out' : r.querySelector('span:nth-child(2)')!.textContent)).toEqual(['15', 'out', '9'])
  })

  it('History with no keyword: top 3 / 10 / 20 per check, the checks under it, and the range as days', async () => {
    routes[`/api/account/seo/rank/trackers/${T1}/history?days=90`] = { trend: TREND }
    routes[`/api/account/seo/rank/trackers/${T1}/history?days=30`] = { trend: TREND }
    routes[`/api/account/seo/rank/trackers/${T1}/runs`] = { rows: [run(R1), run('r-failed', { status: 'failed', error: 'The search data provider did not answer.', cost_usd: 0.01 })], next_offset: null }
    store.update('rank-1', { at: { type: 'seo_rank_tracker', id: T1, label: 'fernhillstudio.example' }, tab: 'history' })
    await render()
    expect(all('[data-seo-trend-line]').map((l) => l.dataset.seoTrendLine)).toEqual(['top3', 'top10', 'top100'])
    expect(all('[data-seo-check-row]')).toHaveLength(2)
    const failed = q('[data-seo-check-status="failed"]')!
    expect(failed.textContent).toBe('Failed')
    expect(failed.title).toBe('The search data provider did not answer.')
    expect(q(`[data-seo-check-row="${R1}"]`)!.textContent).toContain('$0.04')
    await click('[data-seo-filter="30"]')
    expect(asked()).toContain(`/api/account/seo/rank/trackers/${T1}/history?days=30`)
  })

  it('pins a keyword, and removes the selected ones through the confirm dialog', async () => {
    answer = (method, path) => (method === 'DELETE' ? { status: 200, body: { removed: 2 } } : { status: 200, body: { updated: 1 } })
    openTracker()
    await render()
    await click(`[data-seo-pin="${K2}"]`)
    expect(writes()).toEqual([{ method: 'PATCH', path: `/api/account/seo/rank/trackers/${T1}/keywords`, body: { keyword_ids: [K2], pinned: true } }])
    expect(store.state('rank-1').tab ?? 'positions').toBe('positions')
    await click(`[data-seo-select-keyword="${K2}"]`)
    await click(`[data-seo-select-keyword="${K3}"]`)
    expect(q('[data-seo-remove-selected]')!.textContent).toBe('Remove · 2')
    await click('[data-seo-remove-selected]')
    const dialog = q('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Stop tracking 2 keywords?')
    expect(dialog.textContent).toContain('history of their past checks is kept')
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Remove')!
    await act(async () => confirm.click())
    await settle()
    await settle()
    expect(writes().at(-1)).toEqual({ method: 'DELETE', path: `/api/account/seo/rank/trackers/${T1}/keywords`, body: { keyword_ids: [K2, K3] } })
    expect(hoisted.toast).toHaveBeenCalledWith('Stopped tracking 2 keywords. Their history is kept.')
  })

  it('an empty tracker: No keywords yet, and Add keywords', async () => {
    routes[`/api/account/seo/rank/trackers/${T1}/keywords`] = { rows: [], next_offset: null }
    routes[`/api/account/seo/rank/trackers/${T1}`] = { tracker: tracker(T1, { keyword_count: 0, latest_run: null, last_checked_at: null }), summaries: [summary({ tracked: 0, checked: 0 })] }
    openTracker()
    await render()
    expect(q('[data-seo-positions-empty]')!.textContent).toContain('No keywords yet')
    // Nothing to count yet: no tiles of dashes.
    expect(q('[data-seo-tile]')).toBeNull()
    await click('[data-seo-positions-add]')
    expect(q('[data-seo-add-keywords-dialog]')).not.toBeNull()
  })
})

describe('SeoRankingsCard: checks', () => {
  it('Check now under about $0.25 is the request itself', async () => {
    answer = (method, path) =>
      path === '/api/account/seo/rank/estimate'
        ? { status: 200, body: { before: estimate(), after: estimate(), raises_cost: false } }
        : { status: 201, body: { run: run('r-new', { status: 'queued', completed_at: null }) } }
    openTracker()
    await render()
    const button = q<HTMLButtonElement>('[data-seo-check-now]')!
    expect(button.title).toBe('Check every keyword now. A check costs about $0.06.')
    await click(button)
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/rank/trackers/${T1}/runs`, body: null }])
    expect(q('[data-seo-spend-confirm]')).toBeNull()
    expect(q('[data-seo-run-rail]')!.textContent).toContain('Starting the check')
    expect(q('[data-seo-run-caption]')!.textContent).toContain('about an hour, sometimes two')
  })

  it('above about $0.25 it shows the estimate first', async () => {
    answer = (method, path) =>
      path === '/api/account/seo/rank/estimate'
        ? { status: 200, body: { before: estimate({ per_check_usd: 0.42 }), after: estimate({ per_check_usd: 0.42 }), raises_cost: false } }
        : { status: 201, body: { run: run('r-new', { status: 'queued', completed_at: null }) } }
    openTracker()
    await render()
    await click('[data-seo-check-now]')
    expect(writes()).toEqual([])
    const dialog = q('[data-seo-spend-confirm]')!
    expect(dialog.textContent).toContain('Check 3 keywords now?')
    expect(dialog.textContent).toContain('up to about $0.42')
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Check now, about $0.42')
    await click('[data-seo-spend-confirm-go]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/rank/trackers/${T1}/runs`, body: { confirmed: true } }])
  })

  it('when the server asks for the yes (its figure is above the line), the confirm shows its figure and the press sends it', async () => {
    answer = (method, path, body) => {
      if (path === '/api/account/seo/rank/estimate') return { status: 200, body: { before: estimate(), after: estimate(), raises_cost: false } }
      if ((body as { confirmed?: boolean } | null)?.confirmed) return { status: 201, body: { run: run('r-new', { status: 'queued', completed_at: null }) } }
      return { status: 409, body: { error: 'This check costs up to $0.4200. Confirm to start it.', code: 'NEEDS_GO_AHEAD', details: { estimate: estimate({ keyword_count: 9, per_check_usd: 0.42 }), previous_estimate: null } } }
    }
    openTracker()
    await render()
    await click('[data-seo-check-now]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/rank/trackers/${T1}/runs`, body: null }])
    const dialog = q('[data-seo-spend-confirm]')!
    expect(dialog.textContent).toContain('Check 9 keywords now?')
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Check now, about $0.42')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    await click('[data-seo-spend-confirm-go]')
    expect(writes().at(-1)).toEqual({ method: 'POST', path: `/api/account/seo/rank/trackers/${T1}/runs`, body: { confirmed: true } })
    expect(q('[data-seo-spend-confirm]')).toBeNull()
  })

  it('a plan that couldn’t be read is an ordinary failure with its own words and a Try again', async () => {
    answer = (method, path) =>
      path === '/api/account/seo/rank/estimate'
        ? { status: 200, body: { before: estimate(), after: estimate(), raises_cost: false } }
        : { status: 503, body: { error: 'We couldn’t check your plan just now, so nothing was looked up. Try again in a moment.', code: 'CHECK_FAILED' } }
    openTracker()
    await render()
    await click('[data-seo-check-now]')
    expect(hoisted.toast.error).toHaveBeenCalledWith('Could not start the check', expect.objectContaining({ description: 'We couldn’t check your plan just now, so nothing was looked up. Try again in a moment.', action: expect.objectContaining({ label: 'Try again' }) }))
    // Not "lookups are off": Check now stays.
    expect(q<HTMLButtonElement>('[data-seo-check-now]')!.disabled).toBe(false)
  })

  it('the spend limit is a neutral banner, not an error', async () => {
    answer = (method, path) =>
      path === '/api/account/seo/rank/estimate'
        ? { status: 200, body: { before: estimate(), after: estimate(), raises_cost: false } }
        : { status: 402, body: { error: 'This check could cost up to $0.06, more than this workspace has left this month.', code: 'SPEND_LIMIT_REACHED' } }
    openTracker()
    await render()
    await click('[data-seo-check-now]')
    const banner = q('[data-seo-banner="notice"]')!
    expect(banner.textContent).toContain('more than this workspace has left this month')
    expect(banner.className).not.toContain('amber')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('while a check runs: the rail with Stop and the caption, and Check now waits', async () => {
    routes[`/api/account/seo/rank/trackers/${T2}`] = { tracker: RUNNING, summaries: [summary(), summary({ device: 'desktop', top3: 2 })] }
    routes[`/api/account/seo/rank/trackers/${T2}/history`] = { trend: [] }
    routes[`/api/account/seo/rank/trackers/${T2}/keywords`] = { rows: [], next_offset: null }
    openTracker(T2, RUNNING.domain)
    await render()
    expect(q('[data-seo-run-rail]')!.textContent).toContain('Checking rankings · 31 keywords · started 12 minutes ago')
    expect(q('[data-seo-stop]')).not.toBeNull()
    const button = q<HTMLButtonElement>('[data-seo-check-now]')!
    expect(button.disabled).toBe(true)
    // It checks both: the device switch, mobile first.
    expect(all('[role="radiogroup"][aria-label="Device"] [role="radio"]').map((b) => b.textContent)).toEqual(['Desktop', 'Mobile'])
    expect(q('[data-seo-tile="top3"] p')!.textContent).toBe('1')
    await click('[data-seo-filter="desktop"]')
    expect(q('[data-seo-tile="top3"] p')!.textContent).toBe('2')
  })

  it('a failed check: the reason in an amber banner, and Check again', async () => {
    routes[`/api/account/seo/rank/trackers/${T1}`] = { ...DETAIL, tracker: tracker(T1, { latest_run: run(R1, { status: 'failed', error: 'The search data provider did not answer.' }) }) }
    openTracker()
    await render()
    const banner = q('[data-seo-failed]')!
    expect(banner.textContent).toContain('The search data provider did not answer.')
    expect(banner.textContent).toContain('Check again')
  })

  it('a check the tracker outgrew before it ran: its words, and Check again prices it anew', async () => {
    const words = 'The tracker changed after this check was started, so it was not run. Nothing was bought. Start it again.'
    routes[`/api/account/seo/rank/trackers/${T1}`] = { ...DETAIL, tracker: tracker(T1, { latest_run: run(R1, { status: 'failed', error: words }) }) }
    answer = (method, path) =>
      path === '/api/account/seo/rank/estimate'
        ? { status: 200, body: { before: estimate({ per_check_usd: 0.42 }), after: estimate({ per_check_usd: 0.42 }), raises_cost: false } }
        : { status: 201, body: { run: run('r-new', { status: 'queued', completed_at: null }) } }
    openTracker()
    await render()
    const banner = q('[data-seo-failed]')!
    expect(banner.textContent).toContain(words)
    await click(Array.from(banner.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent === 'Check again')!)
    // The new size is above the line: the cost is shown before anything is sent.
    expect(writes()).toEqual([])
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Check now, about $0.42')
  })

  it('a finished check with a note: the note in a neutral banner', async () => {
    routes[`/api/account/seo/rank/trackers/${T1}`] = { ...DETAIL, tracker: tracker(T1, { latest_run: run(R1, { note: '2 keywords got no result this time.' }) }) }
    openTracker()
    await render()
    expect(q('[data-seo-banner="note"]')!.textContent).toBe('2 keywords got no result this time.')
  })
})

describe('SeoRankingsCard: settings', () => {
  it('Schedule and devices shows before → after and names the new monthly figure when it rises', async () => {
    answer = (method, path, body) => {
      if (path === '/api/account/seo/rank/estimate') {
        const b = body as Record<string, unknown>
        if (b.devices === 'both') return { status: 200, body: { before: estimate(), after: estimate({ devices: 'both', per_check_usd: 0.12, monthly_usd: 3.6 }), raises_cost: true } }
        return { status: 200, body: { before: estimate(), after: estimate(), raises_cost: false } }
      }
      return { status: 200, body: { tracker: tracker(T1, { devices: 'both' }) } }
    }
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-schedule]')
    const dialog = q('[data-seo-schedule-dialog]')!
    expect(q<HTMLButtonElement>('[data-seo-save-schedule]')!.disabled).toBe(true)
    await click(dialog.querySelector<HTMLElement>('[data-seo-filter="both"]')!)
    await settle(450)
    await settle()
    expect(q('[data-seo-estimate="before"]')!.textContent).toContain('Daily, about $1.80 a month.')
    expect(q('[data-seo-estimate="after"]')!.textContent).toContain('A check costs about $0.12. Daily, about $3.60 a month.')
    expect(q('[data-seo-raises-cost]')).not.toBeNull()
    const save = q<HTMLButtonElement>('[data-seo-save-schedule]')!
    expect(save.textContent).toBe('Save, about $3.60 a month')
    await click(save)
    expect(writes()).toEqual([{ method: 'PATCH', path: `/api/account/seo/rank/trackers/${T1}`, body: { devices: 'both', confirmed: true } }])
  })

  it('adding keywords: when the server’s figure is a rise the estimate missed, the primary names it and nothing is added until it is pressed', async () => {
    answer = (method, path, body) => {
      if (path === '/api/account/seo/rank/estimate') return { status: 200, body: { before: estimate(), after: estimate(), raises_cost: false } }
      if ((body as { confirmed?: boolean }).confirmed) return { status: 201, body: { added: [{ id: K1, keyword: 'oak bench' }], already_tracked: 0, over_cap: 0, rejected: 0 } }
      return {
        status: 409,
        body: { error: 'Confirm to go ahead.', code: 'NEEDS_GO_AHEAD', details: { estimate: estimate({ keyword_count: 4, monthly_usd: 2.4 }), previous_estimate: estimate() } },
      }
    }
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-add]')
    await type(q<HTMLTextAreaElement>('[data-seo-keywords]')!, 'oak bench')
    await settle(450)
    await settle()
    const add = q<HTMLButtonElement>('[data-seo-add-keywords-submit]')!
    expect(add.textContent).toBe('Add 1')
    await click(add)
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/rank/trackers/${T1}/keywords`, body: { keywords: ['oak bench'] } }])
    expect(q('[data-seo-add-keywords-dialog]')).not.toBeNull()
    expect(q('[data-seo-raises-cost]')).not.toBeNull()
    expect(q<HTMLButtonElement>('[data-seo-add-keywords-submit]')!.textContent).toBe('Add, about $2.40 a month')
    await click('[data-seo-add-keywords-submit]')
    expect(writes().at(-1)).toEqual({ method: 'POST', path: `/api/account/seo/rank/trackers/${T1}/keywords`, body: { keywords: ['oak bench'], confirmed: true } })
  })

  it('with lookups off: what is stored stays readable, Check now and the schedule are off saying why', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    openTracker()
    await render()
    expect(all('[data-seo-keyword-row]')).toHaveLength(3)
    const button = q<HTMLButtonElement>('[data-seo-check-now]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Part of the paid plan')
    await click('[data-seo-tracker-menu]')
    const schedule = q<HTMLButtonElement>('[data-seo-menu-schedule]')!
    expect(schedule.disabled).toBe(true)
    expect(schedule.title).toBe('Part of the paid plan')
  })

  it('pauses, and deletes through the confirm dialog, then back to the trackers', async () => {
    answer = (method) => (method === 'PATCH' ? { status: 200, body: { tracker: tracker(T1, { paused: true }) } } : { status: 200, body: { deleted: true } })
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-pause]')
    expect(writes()).toEqual([{ method: 'PATCH', path: `/api/account/seo/rank/trackers/${T1}`, body: { paused: true } }])
    expect(q('[data-seo-tracker-settings]')!.textContent).toContain('Paused')
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-delete]')
    const dialog = q('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Delete the tracker of fernhillstudio.example?')
    expect(dialog.textContent).toContain('Its keywords and history are removed. This cannot be undone.')
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Delete')!
    await act(async () => confirm.click())
    await settle()
    await settle()
    expect(writes().at(-1)).toEqual({ method: 'DELETE', path: `/api/account/seo/rank/trackers/${T1}`, body: null })
    expect(store.state('rank-1').at).toBeNull()
  })
})
