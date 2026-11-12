// @vitest-environment jsdom
/**
 * SEO's Local card: the first run (what the page does, Add business) and
 * the lookups-off notice in its place; the index (a row per business with
 * its address, rating and reviews, its newest scan as neutral chips, a word
 * while a scan runs, Add business at the cap); the add dialog (the town
 * typeahead, Find business as the request, the candidates and "This one",
 * none found, a town that can't be placed, one already followed); one
 * business as the card's place (the crumb, the quiet line, three tabs); Map
 * rankings (the grid form with the route's estimate and Create grid; the
 * square with its cells, bands, centre ring and titles; the tiles and the
 * businesses seen most; a grid never scanned; Scan now always through the
 * estimate dialog, the figure sent as the ceiling, a changed estimate, the
 * spend limit as a neutral banner; a running scan's rail, Stop and its poll;
 * a failed scan; Edit and Delete grid); Profile (stored, never read, Refresh);
 * Reviews (Read reviews, collecting, the filter, replies); lookups off; and
 * removing the business.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => React.createElement('span', { 'data-thinking-orb': '' }) }))

import SeoLocalCard from '../pages/seo-local-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import {
  summarizeCells,
  type GoogleBusinessProfileResult,
  type GoogleBusinessReviewsResult,
  type LocalBusinessListing,
  type LocalGridCell,
  type LocalRankGridView,
  type LocalScanEstimate,
  type LocalScanResult,
  type LocalScanView,
  type TrackedBusinessView,
} from '@/lib/seo/local/view'

const spec: PageCardSpec = { kind: 'seo_local', title: 'Local' }
const B1 = '11111111-1111-4111-8111-111111111111'
const B2 = '22222222-2222-4222-8222-222222222222'
const B3 = '33333333-3333-4333-8333-333333333333'
const G1 = 'aaaaaaa1-1111-4111-8111-111111111111'
const G2 = 'aaaaaaa2-2222-4222-8222-222222222222'
const S1 = 'bbbbbbb1-1111-4111-8111-111111111111'
const S2 = 'bbbbbbb2-2222-4222-8222-222222222222'

const LIMITS = {
  max_businesses: 10,
  max_grids_per_business: 5,
  max_keywords_per_grid: 5,
  grid_sizes: [3, 5, 7],
  default_grid_size: 5,
  min_radius_km: 0.5,
  max_radius_km: 20,
  default_radius_km: 3,
  confirm_above_usd: 0.25,
}
const SPEND: SeoSpendView = { spent_dollars: 3.4, cap_dollars: 20, resets_at: '2026-12-01T00:00:00Z', configured: true, can_buy: true, refusal: null }
const SPEND_OFF: SeoSpendView = { ...SPEND, can_buy: false, refusal: { code: 'FREE_PLAN', message: 'Search data is part of the paid plan.' } }

const business = (id: string, extra: Partial<TrackedBusinessView> = {}): TrackedBusinessView => ({
  id,
  title: 'Fernhill Rug Cleaning',
  cid: '1001',
  place_id: 'place-1001',
  address: '12 Alder St, Portland',
  latitude: 45.52,
  longitude: -122.68,
  category: 'Carpet cleaning service',
  additional_categories: [],
  phone: '(555) 010-0142',
  website: 'https://fernhillrugs.example/',
  domain: 'fernhillrugs.example',
  rating: 4.6,
  review_count: 128,
  is_claimed: true,
  location_code: 2840,
  language_code: 'en',
  profile_fetched_at: '2026-11-10T09:00:00Z',
  added_by: 'user-me',
  created_at: '2026-11-01T09:00:00Z',
  ...extra,
})
const FERNHILL = business(B1)
const EASTSIDE = business(B2, { title: 'Fernhill Rugs Eastside', cid: '1002', address: null, rating: null, review_count: 9 })
const BARE = business(B3, { title: 'Alder Street Weavers', cid: '1003', address: 'Portland', rating: null, review_count: null })

const gridView = (id: string, extra: Partial<LocalRankGridView> = {}): LocalRankGridView => ({
  id,
  business_id: B1,
  keywords: ['rug cleaning'],
  center_latitude: 45.52,
  center_longitude: -122.68,
  radius_km: 3,
  size: 5,
  spacing_km: 1.5,
  device: 'mobile',
  language_code: 'en',
  estimate_usd: 0.05,
  created_by: 'user-me',
  created_at: '2026-11-02T09:00:00Z',
  updated_at: '2026-11-02T09:00:00Z',
  ...extra,
})
const scanView = (id: string, extra: Partial<LocalScanView> = {}): LocalScanView => ({
  id,
  grid_id: G1,
  business_id: B1,
  status: 'completed',
  keywords: ['rug cleaning'],
  size: 5,
  radius_km: 3,
  spacing_km: 1.5,
  center_latitude: 45.52,
  center_longitude: -122.68,
  zoom: 14,
  device: 'mobile',
  points_total: 25,
  points_collected: 25,
  points_found: 20,
  estimate_usd: 0.05,
  cost_usd: 0.05,
  error: null,
  summary: { points_total: 25, points_collected: 25, points_found: 20, top3: 15, top10: 18, top3_percent: 62, average_position: 4.1 },
  started_by: 'user-me',
  created_at: '2026-11-10T09:00:00Z',
  started_at: '2026-11-10T09:00:00Z',
  completed_at: '2026-11-10T09:04:00Z',
  ...extra,
})

/** A 5×5 square from a grid of marks: a number is found there, 'x' not found, 'n' not collected, 'p' pending. */
function square(marks: Array<Array<number | 'x' | 'n' | 'p'>>): LocalGridCell[][] {
  return marks.map((row, r) =>
    row.map((mark, c) => ({
      row: r,
      col: c,
      latitude: 45.5 + r / 100,
      longitude: -122.7 + c / 100,
      status: typeof mark === 'number' ? 'found' : mark === 'x' ? 'not_found' : mark === 'n' ? 'not_collected' : 'pending',
      position: typeof mark === 'number' ? mark : null,
      results_count: typeof mark === 'number' || mark === 'x' ? 20 : null,
      top_result: typeof mark === 'number' && mark === 1 ? { title: 'Fernhill Rug Cleaning', cid: '1001', place_id: null } : typeof mark === 'number' || mark === 'x' ? { title: 'Oakline Carpet Care', cid: '2001', place_id: null } : null,
      competitors: [],
    })),
  )
}
const DONE_MARKS: Array<Array<number | 'x' | 'n' | 'p'>> = [
  [2, 3, 5, 12, 'x'],
  [1, 1, 2, 4, 'x'],
  [1, 1, 1, 3, 16],
  [2, 1, 2, 3, 'n'],
  [3, 2, 7, 'x', 'x'],
]
const resultOf = (scan: LocalScanView, marks = DONE_MARKS): LocalScanResult => {
  const rows = square(marks)
  const summary = summarizeCells(rows.flat())
  return {
    scan,
    size: 5,
    keywords: [{ keyword: 'rug cleaning', rows, summary }],
    summary,
    competitors: [
      { title: 'Oakline Carpet Care', cid: '2001', place_id: null, rating: 4.8, review_count: 311, points_first: 6, points_top3: 19, best_position: 1, average_position: 2.4 },
      { title: 'Hawthorne Rug Spa', cid: '2002', place_id: null, rating: null, review_count: null, points_first: 0, points_top3: 4, best_position: 2, average_position: 6 },
    ],
  }
}
const DONE_SCAN = scanView(S1)
const GRID1 = gridView(G1)
const RUNNING_SCAN = scanView(S2, { grid_id: G2, business_id: B2, status: 'running', points_collected: 31, points_total: 49, size: 7, summary: null, completed_at: null })
const GRID2 = gridView(G2, { business_id: B2, size: 7 })

const ESTIMATE: LocalScanEstimate = { keywords: 1, points: 25, searches: 25, estimate_usd: 0.29, needs_confirmation: true }

const PROFILE: GoogleBusinessProfileResult = {
  profile: {
    title: 'Fernhill Rug Cleaning',
    description: 'Family-run rug and carpet cleaning since 1998. <b>We collect and deliver.</b>',
    category: 'Carpet cleaning service',
    additional_categories: ['Rug store'],
    rating: 4.6,
    review_count: 128,
    rating_distribution: { '5': 90, '4': 20, '3': 8, '2': 4, '1': 6 },
    address: '12 Alder St, Portland',
    phone: '(555) 010-0142',
    website: 'https://fernhillrugs.example/',
    domain: 'fernhillrugs.example',
    is_claimed: false,
    current_status: 'opened',
    hours: [
      { day: 'monday', spans: ['09:00-17:00'] },
      { day: 'tuesday', spans: ['09:00-17:00'] },
      { day: 'wednesday', spans: ['09:00-17:00'] },
      { day: 'thursday', spans: ['09:00-17:00'] },
      { day: 'friday', spans: ['09:00-17:00'] },
      { day: 'saturday', spans: ['10:00-14:00'] },
      { day: 'sunday', spans: [] },
    ],
    total_photos: 42,
    price_level: null,
    cid: '1001',
    place_id: 'place-1001',
    latitude: 45.52,
    longitude: -122.68,
    check_url: null,
  },
  lookup_id: 'l1',
  fetched_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
  from_cache: true,
}

const LONG_TEXT = 'They took our old wool rug and brought it back looking new. '.repeat(8)
const REVIEWS: GoogleBusinessReviewsResult = {
  status: 'completed',
  data: {
    reviews: [
      { review_id: 'r1', position: 1, rating: 5, time_ago: 'a week ago', timestamp: null, text: LONG_TEXT, original_language: 'en', author: 'Sam Example', author_is_local_guide: false, author_review_count: 3, photos: 0, source: 'Google', owner_reply: 'Thank you, Sam.', owner_reply_time_ago: '5 days ago', owner_reply_timestamp: null },
      { review_id: 'r2', position: 2, rating: 2, time_ago: 'a month ago', timestamp: null, text: 'Late pickup.', original_language: 'en', author: 'Robin Example', author_is_local_guide: false, author_review_count: 1, photos: 0, source: 'Google', owner_reply: null, owner_reply_time_ago: null, owner_reply_timestamp: null },
      { review_id: 'r3', position: 3, rating: 4, time_ago: '2 months ago', timestamp: null, text: null, original_language: null, author: 'Kit Example', author_is_local_guide: true, author_review_count: 40, photos: 0, source: 'Google', owner_reply: null, owner_reply_time_ago: null, owner_reply_timestamp: null },
    ],
    total_reviews: 128,
    rating: 4.6,
    rating_distribution: { '5': 1, '4': 1, '2': 1 },
    replied: 1,
    unreplied: 2,
  },
  lookup_id: 'l2',
  fetched_at: new Date().toISOString(),
  from_cache: false,
}

const LISTING: LocalBusinessListing = {
  title: 'Fernhill Rug Cleaning',
  cid: '1001',
  place_id: 'place-1001',
  address: '12 Alder St, Portland',
  latitude: 45.52,
  longitude: -122.68,
  category: 'Carpet cleaning service',
  additional_categories: [],
  rating: 4.6,
  review_count: 128,
  is_claimed: true,
  phone: '(555) 010-0142',
  website: 'https://fernhillrugs.example/',
  domain: 'fernhillrugs.example',
}

let routes: Record<string, unknown>
let sent: Array<{ method: string; path: string; body: unknown }>
let answer: (method: string, path: string, body: unknown) => { status: number; body: unknown } | null
let fetchMock: ReturnType<typeof stubAppFetch>
let mount: ReturnType<typeof mountRoot>
let store: ChatCardStore

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  window.localStorage.clear()
  hoisted.toast.mockClear()
  hoisted.toast.error.mockClear()
  sent = []
  routes = {
    '/api/account/seo/spend': SPEND,
    '/api/account/seo/local/businesses': {
      businesses: [FERNHILL, EASTSIDE, BARE],
      grids: [
        { grid: GRID1, latest_scan: DONE_SCAN },
        { grid: GRID2, latest_scan: RUNNING_SCAN },
      ],
      limits: LIMITS,
    },
    [`/api/account/seo/local/businesses/${B1}`]: { business: FERNHILL, profile: PROFILE, grids: [{ grid: GRID1, latest_scan: DONE_SCAN }] },
    [`/api/account/seo/local/grids/${G1}`]: { grid: GRID1, latest_scan: DONE_SCAN, result: resultOf(DONE_SCAN) },
  }
  answer = () => null
  fetchMock = stubAppFetch(routes)
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (init?.method && init.method !== 'GET') {
      const body = init.body ? JSON.parse(String(init.body)) : null
      sent.push({ method: init.method, path, body })
      const a = answer(init.method, path, body)
      if (a) return json(a.body, a.status)
      if (path === '/api/account/seo/local/estimate') return json({ estimate: ESTIMATE })
      return json({})
    }
    const a = answer('GET', path, null)
    if (a) return json(a.body, a.status)
    return get(input, init)
  })
  mount = mountRoot()
  store = makeStore('local-1', spec)
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
const writes = () => sent.filter((s) => s.path !== '/api/account/seo/local/estimate')
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const openBusiness = (tab?: string, id = B1, label = 'Fernhill Rug Cleaning') => store.update('local-1', { at: { type: 'seo_local_business', id, label }, ...(tab ? { tab } : {}) })

async function render() {
  await mount.render(React.createElement(SeoLocalCard, { toolCallId: 'local-1', spec, store, fullScreen: true }))
  await settle()
  await settle()
}

describe('SeoLocalCard: first run', () => {
  it('says what the page does, with Add business inline', async () => {
    routes['/api/account/seo/local/businesses'] = { businesses: [], grids: [], limits: LIMITS }
    await render()
    const first = q('[data-seo-first-run]')!
    expect(first.textContent).toContain('See how you show up on Google Maps')
    expect(first.textContent).toContain('street by street')
    expect(first.textContent).toContain('reviews')
    expect(all('[data-seo-add-business]')).toHaveLength(1)
    await click('[data-seo-add-business]')
    expect(q('[data-seo-add-dialog]')).not.toBeNull()
  })

  it('with lookups off and no business: the notice in its place', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    routes['/api/account/seo/local/businesses'] = { businesses: [], grids: [], limits: LIMITS }
    await render()
    expect(q('[data-seo-first-run]')).toBeNull()
    expect(q('[data-seo-data-off="FREE_PLAN"]')!.textContent).toContain('Local search data is part of the paid plan')
  })
})

describe('SeoLocalCard: the index', () => {
  it('a row per business: its details, its newest scan as chips, and a word while a scan runs', async () => {
    await render()
    expect(all('[data-seo-business-row]').map((r) => r.dataset.seoBusinessRow)).toEqual([B1, B2, B3])
    const one = q(`[data-seo-business-row="${B1}"]`)!
    expect(one.textContent).toContain('Fernhill Rug Cleaning')
    expect(one.querySelector('[data-seo-business-subline]')!.textContent).toBe('12 Alder St, Portland · 4.6 ★ · 128 reviews')
    expect(Array.from(one.querySelectorAll('[data-seo-scan-chip]')).map((c) => c.textContent)).toEqual(['62% in top 3', 'average 4.1'])
    // What is missing is dropped from the line; a running scan shows its word, no chips.
    const two = q(`[data-seo-business-row="${B2}"]`)!
    expect(two.querySelector('[data-seo-business-subline]')!.textContent).toBe('9 reviews')
    expect(two.querySelector('[data-seo-business-status]')!.textContent).toBe('Scanning')
    expect(two.querySelector('[data-seo-scan-chip]')).toBeNull()
    expect(q(`[data-seo-business-row="${B3}"] [data-seo-scan-chip]`)).toBeNull()
    expect(q('[data-seo-spend]')!.textContent).toContain('$3.40 of $20 this month')
    expect(q('[data-seo-first-run]')).toBeNull()
  })

  it('Add business waits at the cap, saying why', async () => {
    routes['/api/account/seo/local/businesses'] = { businesses: [FERNHILL], grids: [], limits: { ...LIMITS, max_businesses: 1 } }
    await render()
    const add = q<HTMLButtonElement>('[data-seo-add-business]')!
    expect(add.disabled).toBe(true)
    expect(add.title).toContain('1 businesses')
  })

  it('with lookups off: what is followed stays readable, Add business says why it is off', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    await render()
    expect(all('[data-seo-business-row]')).toHaveLength(3)
    const add = q<HTMLButtonElement>('[data-seo-add-business]')!
    expect(add.disabled).toBe(true)
    expect(add.title).toBe('Part of the paid plan')
  })

  it('a failed read: a line and Try again', async () => {
    delete routes['/api/account/seo/local/businesses']
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your businesses.')
    routes['/api/account/seo/local/businesses'] = { businesses: [FERNHILL], grids: [], limits: LIMITS }
    await click(q<HTMLButtonElement>('[data-seo-error] button')!)
    expect(all('[data-seo-business-row]')).toHaveLength(1)
  })
})

describe('SeoLocalCard: adding a business', () => {
  beforeEach(() => {
    routes['/api/account/seo/local/places?country=us&q=portl'] = {
      places: [
        { location_name: 'Portland,Oregon,United States', location_code: 1023191, location_type: 'City', label: 'Portland, Oregon, United States' },
        { location_name: 'Portland,Maine,United States', location_code: 1019031, location_type: 'City', label: 'Portland, Maine, United States' },
      ],
    }
  })

  async function fillForm() {
    await render()
    await click('[data-seo-add-business]')
    await type(q<HTMLInputElement>('[data-seo-local-name]')!, 'Fernhill Rug')
    const town = q<HTMLInputElement>('[data-seo-local-town]')!
    await act(async () => town.focus())
    await type(town, 'portl')
    await settle(300)
    await settle()
  }

  it('the town picks from the places list; Find business is the request; This one follows it and opens it', async () => {
    answer = (method, path) => {
      if (path === '/api/account/seo/local/search') return { status: 200, body: { result: { query: 'Fernhill Rug', place: 'Portland, Oregon, United States', country: 'us', rows: [LISTING, { ...LISTING, title: 'Fernhill Rugs Eastside', cid: '1002', rating: null, review_count: null, category: null }], lookup_id: 'l', fetched_at: '2026-11-12T09:00:00Z', from_cache: false } } }
      if (method === 'POST' && path === '/api/account/seo/local/businesses') return { status: 201, body: { business: FERNHILL } }
      return null
    }
    await fillForm()
    expect(asked()).toContain('/api/account/seo/local/places?country=us&q=portl')
    expect(all('[data-seo-place]').map((o) => o.textContent)).toEqual(['Portland, Oregon, United States', 'Portland, Maine, United States'])
    await act(async () => {
      all('[data-seo-place]')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(q<HTMLInputElement>('[data-seo-local-town]')!.value).toBe('Portland, Oregon, United States')
    await click('[data-seo-find-business]')
    expect(writes()[0]).toEqual({ method: 'POST', path: '/api/account/seo/local/search', body: { query: 'Fernhill Rug', place: 'Portland,Oregon,United States', country: 'us' } })
    const rows = all('[data-seo-result]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('12 Alder St, Portland')
    expect(rows[0].textContent).toContain('4.6 ★ · 128 reviews · Carpet cleaning service')
    await click(rows[0].querySelector<HTMLButtonElement>('[data-seo-choose]')!)
    expect(writes()[1]).toEqual({ method: 'POST', path: '/api/account/seo/local/businesses', body: { ...LISTING, country: 'us' } })
    expect(hoisted.toast).toHaveBeenCalledWith('Added Fernhill Rug Cleaning.')
    expect(store.state('local-1').at).toMatchObject({ type: 'seo_local_business', id: B1, label: 'Fernhill Rug Cleaning' })
  })

  it('none found: says so, with a hint', async () => {
    answer = (_m, path) => (path === '/api/account/seo/local/search' ? { status: 200, body: { result: { query: 'Nowhere Rugs', place: 'portl', country: 'us', rows: [], lookup_id: null, fetched_at: '2026-11-12T09:00:00Z', from_cache: false } } } : null)
    await fillForm()
    await click('[data-seo-find-business]')
    const none = q('[data-seo-no-results]')!
    expect(none.textContent).toContain('No business found by that name in portl')
    expect(none.textContent).toContain('as Google Maps shows it')
  })

  it('a town that can’t be placed is said beside the town, never in a toast', async () => {
    answer = (_m, path) => (path === '/api/account/seo/local/search' ? { status: 400, body: { error: 'No place called “portl” in United States.', code: 'PLACE_NOT_FOUND' } } : null)
    await fillForm()
    await click('[data-seo-find-business]')
    expect(q('[data-seo-field-error="town"]')!.textContent).toBe('No place called “portl” in United States.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('the spend limit is a neutral line in the dialog', async () => {
    answer = (_m, path) => (path === '/api/account/seo/local/search' ? { status: 402, body: { error: 'This workspace reached its search data limit for the month.', code: 'SPEND_LIMIT_REACHED' } } : null)
    await fillForm()
    await click('[data-seo-find-business]')
    expect(q('[data-seo-add-dialog] [data-seo-banner="notice"]')!.textContent).toBe('This workspace reached its search data limit for the month.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('one already followed opens instead', async () => {
    answer = (method, path) => {
      if (path === '/api/account/seo/local/search') return { status: 200, body: { result: { query: 'Fernhill', place: 'portl', country: 'us', rows: [LISTING], lookup_id: null, fetched_at: '2026-11-12T09:00:00Z', from_cache: true } } }
      if (method === 'POST' && path === '/api/account/seo/local/businesses') return { status: 409, body: { error: 'That business is already followed.', code: 'ALREADY_TRACKED', details: { business: FERNHILL } } }
      return null
    }
    await fillForm()
    await click('[data-seo-find-business]')
    await click(q<HTMLButtonElement>('[data-seo-choose]')!)
    expect(hoisted.toast).toHaveBeenCalledWith('That business is already followed.')
    expect(store.state('local-1').at).toMatchObject({ id: B1 })
  })
})

describe('SeoLocalCard: one business', () => {
  it('opens as the card’s place: the crumb back, the quiet line and three tabs, Map rankings first', async () => {
    await render()
    await click(q<HTMLButtonElement>(`[data-seo-business-row="${B1}"] button`)!)
    expect(store.state('local-1').at).toMatchObject({ type: 'seo_local_business', id: B1, label: 'Fernhill Rug Cleaning' })
    expect(q('h1')!.textContent).toBe('Fernhill Rug Cleaning')
    expect(q('[data-seo-business-line]')!.textContent).toBe('12 Alder St, Portland · 4.6 ★ · 128 reviews · Carpet cleaning service')
    expect(all('[data-seo-tab]').map((t) => t.textContent)).toEqual(['Map rankings', 'Profile', 'Reviews'])
    expect(q('[data-seo-tab="grid"]')!.getAttribute('aria-selected')).toBe('true')
    await click('button[aria-label="Local"]')
    expect(store.state('local-1').at).toBeNull()
  })

  it('the … menu removes it through the confirm dialog, then back to the businesses', async () => {
    answer = (method, path) => (method === 'DELETE' && path === `/api/account/seo/local/businesses/${B1}` ? { status: 200, body: { deleted: true } } : null)
    openBusiness()
    await render()
    await click('[data-seo-business-menu]')
    await click('[data-seo-remove-business]')
    const dialog = q('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Remove Fernhill Rug Cleaning?')
    expect(dialog.textContent).toContain('Its rank grids and scans are removed. This cannot be undone.')
    expect(writes()).toEqual([])
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Remove')!
    await act(async () => confirm.click())
    await settle()
    await settle()
    expect(writes()).toEqual([{ method: 'DELETE', path: `/api/account/seo/local/businesses/${B1}`, body: null }])
    expect(store.state('local-1').at).toBeNull()
  })

  it('a business that is gone says so', async () => {
    openBusiness('grid', '44444444-4444-4444-8444-444444444444', 'Gone')
    answer = (method, path) => (path === '/api/account/seo/local/businesses/44444444-4444-4444-8444-444444444444' ? { status: 404, body: { error: 'Business not found', code: 'NOT_FOUND' } } : null)
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('This business is no longer here.')
  })
})

describe('SeoLocalCard: Map rankings', () => {
  it('no grid yet: the form inline, the route’s estimate, and Create grid', async () => {
    routes[`/api/account/seo/local/businesses/${B1}`] = { business: FERNHILL, profile: null, grids: [] }
    answer = (method, path, body) => {
      if (path === '/api/account/seo/local/estimate') return { status: 200, body: { estimate: { keywords: (body as { keywords: string[] }).keywords.length, points: 49, searches: 98, estimate_usd: 0.59, needs_confirmation: true } } }
      if (method === 'POST' && path === '/api/account/seo/local/grids') return { status: 201, body: { grid: gridView(G1, { keywords: ['rug cleaning', 'carpet cleaner'], size: 7 }) } }
      return null
    }
    openBusiness()
    await render()
    const first = q('[data-seo-grid-first-run]')!
    expect(first.textContent).toContain('Check where you rank around town')
    expect(first.textContent).toContain('“rug cleaning”')
    expect(all('[data-seo-filter]').map((b) => b.textContent)).toEqual(['3×3', '5×5', '7×7'])
    expect(q('[data-seo-filter="5"]')!.getAttribute('aria-checked')).toBe('true')
    const radius = q<HTMLInputElement>('[data-seo-grid-radius]')!
    expect([radius.value, radius.min, radius.max]).toEqual(['3', '0.5', '20'])
    expect(q<HTMLButtonElement>('[data-seo-grid-submit]')!.disabled).toBe(true)
    await type(q<HTMLTextAreaElement>('[data-seo-grid-keywords]')!, 'Rug cleaning\ncarpet cleaner\nrug cleaning')
    expect(q('[data-seo-keyword-count]')!.textContent).toBe('2 of 5')
    await click('[data-seo-filter="7"]')
    await settle(450)
    await settle()
    expect(sent.find((s) => s.path === '/api/account/seo/local/estimate')!.body).toEqual({ business_id: B1, keywords: ['rug cleaning', 'carpet cleaner'], size: 7, radius_km: 3 })
    expect(q('[data-seo-estimate]')!.textContent).toBe('49 searches per keyword · 98 in all · about $0.59 for this scan')
    routes[`/api/account/seo/local/businesses/${B1}`] = { business: FERNHILL, profile: null, grids: [{ grid: gridView(G1, { keywords: ['rug cleaning', 'carpet cleaner'], size: 7 }), latest_scan: null }] }
    routes[`/api/account/seo/local/grids/${G1}`] = { grid: gridView(G1, { keywords: ['rug cleaning', 'carpet cleaner'], size: 7 }), latest_scan: null, result: null }
    await click('[data-seo-grid-submit]')
    expect(writes()).toEqual([{ method: 'POST', path: '/api/account/seo/local/grids', body: { business_id: B1, keywords: ['rug cleaning', 'carpet cleaner'], size: 7, radius_km: 3 } }])
    await settle()
    // Never scanned: the outline, every cell muted, and no tiles of nothing.
    expect(all('[data-seo-cell]')).toHaveLength(49)
    expect(all('[data-seo-cell]').every((c) => c.dataset.seoBand === 'unscanned')).toBe(true)
    expect(q('[data-seo-grid-caption]')!.textContent).toContain('Not scanned yet')
    expect(q('[data-seo-tile]')).toBeNull()
    expect(q('[data-seo-legend]')).toBeNull()
  })

  it('a scanned grid: the tiles, the square by band with the centre ringed, each cell titled, and who is seen most', async () => {
    openBusiness()
    await render()
    expect(all('[data-seo-tile]').map((t) => t.textContent)).toEqual(['63%In the top 3', '3.6Average position', '24 of 25Points checked'])
    const cells = all('[data-seo-cell]')
    expect(cells).toHaveLength(25)
    expect(cells.slice(0, 5).map((c) => c.textContent)).toEqual(['2', '3', '5', '12', '–'])
    expect(cells.slice(0, 5).map((c) => c.dataset.seoBand)).toEqual(['top3', 'top3', 'top10', 'top20', 'not_found'])
    expect(q('[data-seo-cell="3:4"]')!.dataset.seoBand).toBe('not_collected')
    expect(q('[data-seo-cell="3:4"]')!.textContent).toBe('')
    expect(q('[data-seo-cell="0:3"]')!.title).toBe('12 of 20 · top result: Oakline Carpet Care')
    expect(q('[data-seo-cell="1:0"]')!.title).toBe('1 of 20 · first here')
    expect(q('[data-seo-cell="0:4"]')!.title).toBe('Not among the 20 businesses listed · top result: Oakline Carpet Care')
    expect(q('[data-seo-cell="2:2"]')!.className).toContain('ring-2')
    expect(q('[data-seo-cell="0:0"]')!.className).not.toContain('ring-2')
    expect(q('[data-seo-square]')!.getAttribute('aria-label')).toBe('rug cleaning: in the top 3 at 15 points of 24 checked, average position 3.6')
    expect(q('[data-seo-legend]')!.textContent).toContain('Top 3')
    expect(q('[data-seo-grid-caption]')!.textContent).toContain('5×5 points across a 6 km square · mobile · scanned')
    const competitors = all('[data-seo-competitor]')
    expect(competitors.map((c) => c.querySelector('span')!.textContent)).toEqual(['Oakline Carpet Care4.8 ★ · 311 reviews', 'Hawthorne Rug Spa'])
    expect(competitors[0].textContent).toContain('2.4')
  })

  it('Scan now always shows the estimate first, then sends it as the ceiling; the rail follows the scan', async () => {
    const started = scanView('ccccccc1-1111-4111-8111-111111111111', { status: 'queued', points_collected: 0, summary: null, completed_at: null })
    answer = (method, path) => {
      if (method === 'POST' && path === `/api/account/seo/local/grids/${G1}/scans`) return { status: 202, body: { scan: started } }
      return null
    }
    openBusiness()
    await render()
    await click('[data-seo-scan-now]')
    expect(sent.find((s) => s.path === '/api/account/seo/local/estimate')!.body).toEqual({ grid_id: G1 })
    const dialog = q('[data-seo-scan-dialog]')!
    expect(dialog.textContent).toContain('Searches Google Maps from 25 points. It costs about $0.29, paid for from this workspace’s search data')
    expect(writes()).toEqual([])
    const running = scanView('ccccccc1-1111-4111-8111-111111111111', { status: 'running', points_collected: 9, summary: null, completed_at: null })
    routes[`/api/account/seo/local/grids/${G1}`] = { grid: GRID1, latest_scan: running, result: resultOf(running, DONE_MARKS.map((row) => row.map(() => 'p' as const))) }
    await click('[data-seo-scan-go]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/local/grids/${G1}/scans`, body: { max_estimate_usd: 0.29, confirmed: true } }])
    expect(q('[data-seo-scan-dialog]')).toBeNull()
    expect(q('[data-seo-run-rail]')!.textContent).toContain('Scanning the map · 9 of 25 points')
    expect(all('[data-seo-cell]').every((c) => c.dataset.seoBand === 'pending')).toBe(true)
    expect(q<HTMLButtonElement>('[data-seo-edit-grid]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-seo-scan-now]')!.disabled).toBe(true)
  })

  it('a grid that changed since its estimate: the dialog says so and shows the new figure', async () => {
    let estimates = 0
    answer = (method, path) => {
      if (path === '/api/account/seo/local/estimate') {
        estimates++
        return { status: 200, body: { estimate: { ...ESTIMATE, estimate_usd: estimates === 1 ? 0.29 : 0.41 } } }
      }
      if (method === 'POST' && path.endsWith('/scans')) return { status: 409, body: { error: 'The grid changed since its estimate was shown. Look at the new estimate before scanning.', code: 'ESTIMATE_CHANGED', details: { estimate_usd: 0.41 } } }
      return null
    }
    openBusiness()
    await render()
    await click('[data-seo-scan-now]')
    await click('[data-seo-scan-go]')
    await settle()
    const dialog = q('[data-seo-scan-dialog]')!
    expect(dialog.querySelector('[data-seo-banner="changed"]')!.textContent).toContain('The grid changed since its estimate was shown.')
    expect(dialog.textContent).toContain('about $0.41')
  })

  it('the spend limit on a scan is a neutral banner, and the page stays usable', async () => {
    answer = (method, path) =>
      method === 'POST' && path.endsWith('/scans') ? { status: 402, body: { error: 'This workspace reached its search data limit for the month.', code: 'SPEND_LIMIT_REACHED' } } : null
    openBusiness()
    await render()
    await click('[data-seo-scan-now]')
    await click('[data-seo-scan-go]')
    expect(q('[data-seo-banner="notice"]')!.textContent).toBe('This workspace reached its search data limit for the month.')
    expect(q('[data-seo-failed]')).toBeNull()
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    expect(all('[data-seo-cell]')).toHaveLength(25)
  })

  it('a running scan: Stop asks the server to stop it; the poll fills the cells in and ends with the scan', async () => {
    const running = scanView(S2, { status: 'running', points_collected: 9, summary: null, completed_at: null })
    routes[`/api/account/seo/local/businesses/${B1}`] = { business: FERNHILL, profile: PROFILE, grids: [{ grid: GRID1, latest_scan: running }] }
    routes[`/api/account/seo/local/grids/${G1}`] = { grid: GRID1, latest_scan: running, result: resultOf(running, DONE_MARKS.map((row, r) => row.map((m) => (r < 2 ? m : 'p')))) }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    openBusiness()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const tick = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    }
    await act(async () => {
      root.render(React.createElement(SeoLocalCard, { toolCallId: 'local-1', spec, store, fullScreen: true }))
    })
    for (let i = 0; i < 4; i++) await tick(20)
    expect(q('[data-seo-run-rail]')!.textContent).toContain('Scanning the map · 9 of 25 points')
    expect(q('[data-seo-cell="0:0"]')!.dataset.seoBand).toBe('top3')
    expect(q('[data-seo-cell="4:4"]')!.dataset.seoBand).toBe('pending')
    // The scan ends: the next tick reads it done, the cells fill in, the rail goes.
    routes[`/api/account/seo/local/grids/${G1}`] = { grid: GRID1, latest_scan: DONE_SCAN, result: resultOf(DONE_SCAN) }
    await tick(3100)
    await tick(20)
    expect(q('[data-seo-run-rail]')).toBeNull()
    expect(q('[data-seo-cell="4:4"]')!.dataset.seoBand).toBe('not_found')
    // It ended: the business reads again (its grids' newest scans), and the poll stops.
    expect(asked()).toContain(`/api/account/seo/local/businesses/${B1}`)
    const reads = asked().filter((p) => p === `/api/account/seo/local/grids/${G1}`).length
    await tick(6500)
    expect(asked().filter((p) => p === `/api/account/seo/local/grids/${G1}`).length).toBe(reads)
    act(() => root.unmount())
    container.remove()
  })

  it('Stop on a running scan', async () => {
    const running = scanView(S2, { status: 'running', points_collected: 9, summary: null, completed_at: null })
    routes[`/api/account/seo/local/grids/${G1}`] = { grid: GRID1, latest_scan: running, result: null }
    answer = (method, path) => (method === 'POST' && path === `/api/account/seo/local/scans/${S2}` ? { status: 200, body: { scan: { ...running, status: 'canceled' } } } : null)
    openBusiness()
    await render()
    routes[`/api/account/seo/local/grids/${G1}`] = { grid: GRID1, latest_scan: { ...running, status: 'canceled' }, result: null }
    await click('[data-seo-stop]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/local/scans/${S2}`, body: null }])
    expect(hoisted.toast).toHaveBeenCalledWith('Stopped. The points already read are kept.')
    expect(q('[data-seo-run-rail]')).toBeNull()
    expect(q('[data-seo-banner="notice"]')!.textContent).toContain('This scan was stopped.')
  })

  it('a failed scan: the reason in an amber banner with Scan again (through the estimate)', async () => {
    const failed = scanView(S2, { status: 'failed', error: 'Google Maps did not answer for this grid.', points_collected: 0, summary: null })
    routes[`/api/account/seo/local/grids/${G1}`] = { grid: GRID1, latest_scan: failed, result: resultOf(failed, DONE_MARKS.map((row) => row.map(() => 'n' as const))) }
    openBusiness()
    await render()
    const banner = q('[data-seo-failed]')!
    expect(banner.textContent).toContain('Google Maps did not answer for this grid.')
    expect(q('[data-seo-tile]')).toBeNull()
    await click(banner.querySelector<HTMLButtonElement>('button')!)
    expect(q('[data-seo-scan-dialog]')).not.toBeNull()
    expect(writes()).toEqual([])
  })

  it('Edit grid saves the changes; Delete grid goes through the confirm dialog', async () => {
    answer = (method, path) => {
      if (method === 'PATCH') return { status: 200, body: { grid: gridView(G1, { radius_km: 5 }) } }
      if (method === 'DELETE') return { status: 200, body: { deleted: true } }
      return null
    }
    openBusiness()
    await render()
    await click('[data-seo-edit-grid]')
    const dialog = q('[data-seo-grid-dialog]')!
    expect(dialog.querySelector<HTMLTextAreaElement>('[data-seo-grid-keywords]')!.value).toBe('rug cleaning')
    await type(dialog.querySelector<HTMLInputElement>('[data-seo-grid-radius]')!, '5')
    await click(dialog.querySelector<HTMLButtonElement>('[data-seo-grid-submit]')!)
    expect(writes()).toEqual([{ method: 'PATCH', path: `/api/account/seo/local/grids/${G1}`, body: { keywords: ['rug cleaning'], size: 5, radius_km: 5 } }])
    expect(hoisted.toast).toHaveBeenCalledWith('Saved. The next scan uses the new grid.')
    await click('[data-seo-grid-menu]')
    await click('[data-seo-delete-grid]')
    const confirm = Array.from(q('[role="alertdialog"]')!.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Delete')!
    await act(async () => confirm.click())
    await settle()
    expect(writes()[1]).toEqual({ method: 'DELETE', path: `/api/account/seo/local/grids/${G1}`, body: null })
  })

  it('with lookups off: the grid stays readable, Scan now says why it is off', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    openBusiness()
    await render()
    expect(all('[data-seo-cell]')).toHaveLength(25)
    const scan = q<HTMLButtonElement>('[data-seo-scan-now]')!
    expect(scan.disabled).toBe(true)
    expect(scan.title).toBe('Part of the paid plan')
  })
})

describe('SeoLocalCard: Profile', () => {
  it('the stored profile: when, the rating with stars by count, the rows, and plain text', async () => {
    openBusiness('profile')
    await render()
    expect(q('[data-seo-looked-up]')!.textContent).toBe('Looked up 2 days ago')
    expect(all('[data-seo-rating-bar]').map((b) => b.textContent)).toEqual(['5 ★90', '4 ★20', '3 ★8', '2 ★4', '1 ★6'])
    expect(q('[data-seo-rating]')!.textContent).toContain('128 reviews')
    expect(all('[data-seo-profile-row]').map((r) => r.dataset.seoProfileRow)).toEqual(['category', 'address', 'phone', 'website', 'hours', 'claimed', 'photos'])
    expect(q('[data-seo-profile-row="category"]')!.textContent).toContain('Carpet cleaning service, Rug store')
    expect(q('[data-seo-profile-row="hours"]')!.textContent).toBe('HoursMon–Fri9:00–17:00Sat10:00–14:00SunClosed')
    expect(q('[data-seo-profile-row="claimed"]')!.textContent).toContain('Not claimed')
    const link = q<HTMLAnchorElement>('[data-seo-profile-row="website"] a')!
    expect(link.textContent).toBe('fernhillrugs.example')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer noopener')
    // Google's text is never markup.
    expect(q('[data-seo-profile-description]')!.textContent).toContain('<b>We collect and deliver.</b>')
    expect(q('[data-seo-profile-description] b')).toBeNull()
  })

  it('Refresh buys it again, with a POST: a GET never spends', async () => {
    openBusiness('profile')
    await render()
    await click('[data-seo-refresh-profile]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/local/businesses/${B1}/refresh`, body: null }])
    expect(asked().some((path) => path.includes('?refresh'))).toBe(false)
  })

  it('never read: a small block and Read profile; with lookups off it says why', async () => {
    routes[`/api/account/seo/local/businesses/${B1}`] = { business: FERNHILL, profile: null, grids: [] }
    answer = (method, path) =>
      method === 'POST' && path === `/api/account/seo/local/businesses/${B1}/refresh` ? { status: 200, body: { business: FERNHILL, profile: PROFILE, grids: [] } } : null
    openBusiness('profile')
    await render()
    expect(q('[data-seo-profile-first-run]')!.textContent).toContain('Read the profile as Google shows it')
    await click('[data-seo-read-profile]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/local/businesses/${B1}/refresh`, body: null }])
    expect(q('[data-seo-profile-rows]')).not.toBeNull()
  })

  it('with lookups off, Read profile is disabled saying why', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    routes[`/api/account/seo/local/businesses/${B1}`] = { business: FERNHILL, profile: null, grids: [] }
    openBusiness('profile')
    await render()
    const read = q<HTMLButtonElement>('[data-seo-read-profile]')!
    expect(read.disabled).toBe(true)
    expect(read.title).toBe('Part of the paid plan')
  })
})

describe('SeoLocalCard: Reviews', () => {
  it('Read reviews is the request; the line, the filter, the rows and the owner’s reply', async () => {
    answer = (method, path) => (method === 'POST' && path === `/api/account/seo/local/businesses/${B1}/reviews` ? { status: 200, body: { result: REVIEWS } } : null)
    openBusiness('reviews')
    await render()
    expect(q('[data-seo-reviews-first-run]')!.textContent).toContain('up to a minute')
    await click('[data-seo-read-reviews]')
    expect(writes()).toEqual([{ method: 'POST', path: `/api/account/seo/local/businesses/${B1}/reviews`, body: {} }])
    expect(q('[data-seo-reviews-line]')!.textContent).toBe('3 newest of 128 reviews · 2 without a reply')
    expect(all('[data-seo-review]').map((r) => r.dataset.seoReview)).toEqual(['r1', 'r2', 'r3'])
    expect(q('[data-seo-review="r1"] [data-seo-owner-reply]')!.textContent).toBe('Owner’s reply · 5 days agoThank you, Sam.')
    expect(q('[data-seo-review="r1"] [data-seo-review-text]')!.className).toContain('line-clamp-3')
    await click('[data-seo-review="r1"] [data-seo-review-more]')
    expect(q('[data-seo-review="r1"] [data-seo-review-text]')!.className).not.toContain('line-clamp-3')
    expect(q('[data-seo-review="r2"] [data-seo-review-more]')).toBeNull()
    await click('[data-seo-filter="unreplied"]')
    expect(all('[data-seo-review]').map((r) => r.dataset.seoReview)).toEqual(['r2', 'r3'])
    await click('[data-seo-filter="low"]')
    expect(all('[data-seo-review]').map((r) => r.dataset.seoReview)).toEqual(['r2'])
    // What was read stays while the tabs change.
    await click('[data-seo-tab="profile"]')
    await click('[data-seo-tab="reviews"]')
    expect(all('[data-seo-review]')).toHaveLength(3)
    await click('[data-seo-refresh-reviews]')
    expect(writes()[1]).toEqual({ method: 'POST', path: `/api/account/seo/local/businesses/${B1}/reviews`, body: { refresh: true } })
  })

  it('still collecting: a neutral line and Check again (free)', async () => {
    let n = 0
    answer = (method, path) => {
      if (method === 'POST' && path.endsWith('/reviews')) {
        n++
        return { status: 200, body: { result: n === 1 ? { ...REVIEWS, status: 'collecting', data: null } : REVIEWS } }
      }
      return null
    }
    openBusiness('reviews')
    await render()
    await click('[data-seo-read-reviews]')
    expect(q('[data-seo-reviews-collecting]')!.textContent).toContain('Still collecting. Check again in a moment.')
    await click('[data-seo-check-again]')
    expect(writes()).toHaveLength(2)
    expect(all('[data-seo-review]')).toHaveLength(3)
  })
})
