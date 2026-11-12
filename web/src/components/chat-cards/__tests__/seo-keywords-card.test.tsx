// @vitest-environment jsdom
/**
 * SEO's Keywords card: Research's first run (what research does, the start
 * control, the market remembered per browser), a lookup and its result (the
 * line, the rows with their difficulty and intent chips, the filters, a
 * Google-Ads-only country's fewer columns), the recent lookups reopened for
 * free and Refresh buying again, lookups off (the notice, the disabled start
 * control saying why), a correctable seed said beside the field, the spend
 * limit's neutral line and a failure's amber banner, saving the selection
 * with a tag, a partial lookup's quiet note (with Refresh), live results
 * (polled while reads are coming; a check that found nothing as a calm empty
 * state with when and Refresh; a refresh answered from a check still coming
 * in, not bought), and the Saved
 * tab (rows, tags, market, Refresh numbers, Remove through the confirm
 * dialog, the empty state, the count for the card header).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => React.createElement('span', { 'data-thinking-orb': '' }) }))

import SeoKeywordsCard from '../pages/seo-keywords-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { KeywordResearchResult, KeywordRow, SavedKeyword, SerpResult } from '@/lib/seo/keywords/view'
import type { SeoSpendView } from '@/lib/seo/spend-view'

const spec: PageCardSpec = { kind: 'seo_keywords', title: 'Keywords' }
const L1 = '11111111-1111-4111-8111-111111111111'
const S1 = '21111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const SERP = '33333333-3333-4333-8333-333333333333'

const SPEND: SeoSpendView = { spent_dollars: 3.4, cap_dollars: 20, resets_at: '2026-12-01T00:00:00Z', configured: true, can_buy: true, refusal: null }
const SPEND_OFF: SeoSpendView = { ...SPEND, can_buy: false, refusal: { code: 'FREE_PLAN', message: 'Search data is part of the paid plan.' } }

const trend = (base: number) => Array.from({ length: 12 }, (_, i) => ({ year: 2026, month: i + 1, search_volume: base + i * 10 }))
const ROWS: KeywordRow[] = [
  { keyword: 'linen throw', search_volume: 2400, cpc: 1.2, competition: 0.4, keyword_difficulty: 18, intent: 'commercial', trend: trend(2000) },
  { keyword: 'linen throw blanket', search_volume: 880, cpc: 0.95, competition: 0.3, keyword_difficulty: 44, intent: 'transactional', trend: trend(800) },
  { keyword: 'how to wash a linen throw', search_volume: 12100, cpc: null, competition: null, keyword_difficulty: 71, intent: 'informational', trend: [] },
]
const RESULT: KeywordResearchResult = {
  lookup_id: L1,
  seed: 'linen throw',
  location_code: 2840,
  language_code: 'en',
  mode: 'auto',
  source: 'blended',
  used_fallback: false,
  data_provider: 'labs',
  rows: ROWS,
  fetched_at: new Date().toISOString(),
  from_cache: false,
}

const saved = (id: string, keyword: string, extra: Partial<SavedKeyword> = {}): SavedKeyword => ({
  id,
  keyword,
  location_code: 2840,
  language_code: 'en',
  search_volume: 2400,
  cpc: 1.2,
  competition: 0.4,
  keyword_difficulty: 18,
  intent: 'commercial',
  trend: [],
  metrics_fetched_at: '2026-11-10T10:00:00Z',
  tags: [],
  note: null,
  created_by: 'user-me',
  created_at: '2026-11-10T10:00:00Z',
  ...extra,
})
const SAVED_ROWS = [saved(S1, 'linen throw', { tags: ['linen'] }), saved(S2, 'oak side table', { location_code: 2826, keyword_difficulty: null, search_volume: null, metrics_fetched_at: null })]
const SAVED_PAGE = { rows: SAVED_ROWS, total: 2, next_offset: null, tags: [{ tag: 'linen', keyword_count: 1 }], max: 10000 }
const EMPTY_SAVED = { rows: [], total: 0, next_offset: null, tags: [], max: 10000 }

const SERP_PARTIAL: SerpResult = {
  lookup_id: SERP,
  keyword: 'linen throw',
  location_code: 2840,
  language_code: 'en',
  device: 'desktop',
  depth: 10,
  status: 'partial',
  reads_total: 3,
  reads_in: 2,
  items: [
    { type: 'organic', rank: 1, best_position: 1, seen_in: 2, domain: 'fernhillstudio.example', title: 'Linen throws · Fernhill Studio', url: 'https://fernhillstudio.example/shop/linen-throw', description: '<b>Handwoven</b> linen throws.', etv: null, referring_domains: null, backlinks: null },
    { type: 'people_also_ask', rank: null, best_position: null, seen_in: 2, domain: null, title: null, url: null, description: null, etv: null, referring_domains: null, backlinks: null },
  ],
  fetched_at: new Date().toISOString(),
  from_cache: false,
}

const LOOKUPS = '/api/account/seo/lookups?kind=keyword_research&limit=8'

let routes: Record<string, unknown>
let sent: Array<{ method: string; path: string; body: unknown }>
let answer: (method: string, path: string, body: unknown) => { status: number; body: unknown }
let fetchMock: ReturnType<typeof stubAppFetch>
let mount: ReturnType<typeof mountRoot>
let store: ChatCardStore
let onCount: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  hoisted.toast.mockClear()
  hoisted.toast.error.mockClear()
  sent = []
  routes = {
    '/api/account/seo/spend': SPEND,
    [LOOKUPS]: { lookups: [] },
    '/api/account/seo/keywords/saved*': SAVED_PAGE,
    [`/api/account/seo/serp/${SERP}`]: { ...SERP_PARTIAL, status: 'complete', reads_in: 3 },
  }
  answer = (_method, path) => {
    if (path === '/api/account/seo/keywords/research') return { status: 200, body: RESULT }
    if (path === '/api/account/seo/serp') return { status: 200, body: SERP_PARTIAL }
    return { status: 200, body: {} }
  }
  fetchMock = stubAppFetch(routes)
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      const path = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      sent.push({ method, path, body })
      const a = answer(method, path, body)
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
    }
    return get(input, init)
  })
  mount = mountRoot()
  store = makeStore('kw-1', spec)
  onCount = vi.fn()
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
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click())
  await settle()
  await settle()
}
const asked = () => fetchMock.mock.calls.map(([input, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(input)}`)
const type = async (sel: string, text: string) => {
  const input = q<HTMLInputElement>(sel)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const enter = async (sel: string) => {
  await act(async () => {
    q(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await settle()
  await settle()
}

async function render() {
  await mount.render(React.createElement(SeoKeywordsCard, { toolCallId: 'kw-1', spec, store, fullScreen: true, onCount }))
  await settle()
  await settle()
}
async function research(seed = 'linen throw') {
  await type('[data-kw-seed]', seed)
  await enter('[data-kw-seed]')
}

describe('SeoKeywordsCard: research', () => {
  // The Saved tab stays mounted (hidden) beside Research: nothing saved keeps its rows out of these.
  beforeEach(() => {
    routes['/api/account/seo/keywords/saved*'] = EMPTY_SAVED
  })

  it('first run: says what research does, the header has no primary button, and the spend line shows', async () => {
    await render()
    expect(q('h1')!.textContent).toBe('Keywords')
    expect(q('[data-seo-spend]')!.textContent).toBe('$3.40 of $20 this month · resets Dec 1')
    const first = q('[data-kw-first-run]')!
    expect(first.textContent).toContain('Find the words people search for')
    expect(first.textContent).toContain('how many people search each one a month')
    expect(q('[data-kw-recent]')).toBeNull()
    expect(q<HTMLInputElement>('[data-kw-seed]')!.placeholder).toBe('A topic, product or phrase')
    expect(q<HTMLButtonElement>('[data-kw-find]')!.disabled).toBe(true)
    expect(q('[data-seo-tab="research"]')!.getAttribute('aria-selected')).toBe('true')
  })

  it('Enter looks it up in the picked market, then the line, the rows and their chips; the spend is read again', async () => {
    await render()
    const spendReads = () => asked().filter((a) => a === 'GET /api/account/seo/spend').length
    expect(spendReads()).toBe(1)
    await research()
    expect(sent).toEqual([{ method: 'POST', path: '/api/account/seo/keywords/research', body: { seed: 'linen throw', location_code: 2840, language_code: 'en' } }])
    expect(q('[data-kw-result-line]')!.textContent).toBe('3 keywords for “linen throw” · United States · Looked up just now')
    // A fresh lookup is not offered again for money.
    expect(q('[data-kw-refresh]')).toBeNull()
    expect(all('[data-kw-row]').map((r) => r.dataset.kwRow)).toEqual(['how to wash a linen throw', 'linen throw', 'linen throw blanket'])
    expect(all('[data-kw-difficulty]').map((c) => `${c.textContent}:${c.dataset.kwDifficulty}`)).toEqual(['71:hard', '18:easy', '44:medium'])
    expect(q('[data-kw-difficulty="easy"]')!.title).toBe('Easy · 18 of 100')
    expect(q('[data-kw-row="linen throw"]')!.textContent).toContain('2,400')
    expect(q('[data-kw-row="linen throw"]')!.textContent).toContain('$1.20')
    expect(q('[data-kw-row="linen throw"] [data-kw-intent]')!.textContent).toBe('Commercial')
    // A keyword with no cost per click says so, never 0.
    expect(q('[data-kw-row="how to wash a linen throw"]')!.textContent).toContain('—')
    // A trend draws; a row without one draws nothing.
    expect(q('[data-kw-row="linen throw"] svg[role="img"]')!.getAttribute('aria-label')).toContain('Searches a month over the last 12 months')
    expect(q('[data-kw-row="how to wash a linen throw"] svg')).toBeNull()
    expect(spendReads()).toBe(2)
    // A new lookup was bought: the recent list is read again.
    expect(asked().filter((a) => a === `GET ${LOOKUPS}`)).toHaveLength(2)
  })

  it('remembers the market per browser and asks in it', async () => {
    window.localStorage.setItem('ni.seo.keywords.market', JSON.stringify({ location_code: 2826, language_code: 'en' }))
    await render()
    await research('oak side table')
    expect(sent[0].body).toEqual({ seed: 'oak side table', location_code: 2826, language_code: 'en' })
  })

  it('the filter narrows the rows and the line says how many of how many', async () => {
    await render()
    await research()
    await type('[data-kw-filter-text]', 'blanket')
    expect(all('[data-kw-row]').map((r) => r.dataset.kwRow)).toEqual(['linen throw blanket'])
    expect(q('[data-kw-result-line]')!.textContent).toContain('1 of 3 keywords for “linen throw”')
    await type('[data-kw-filter-text]', 'velvet')
    expect(q('[data-kw-no-match]')!.textContent).toBe('No keywords match.')
    await click(q('[data-kw-clear-filters]'))
    expect(all('[data-kw-row]')).toHaveLength(3)
  })

  it('a country served by Google Ads data has no difficulty or intent columns', async () => {
    answer = () => ({ status: 200, body: { ...RESULT, location_code: 2352, language_code: 'is', data_provider: 'google_ads', rows: ROWS.map((r) => ({ ...r, keyword_difficulty: null, intent: 'unknown' })) } })
    await render()
    await research()
    expect(q('[data-kw-result-line]')!.textContent).toContain('· Iceland')
    expect(q('[data-kw-difficulty]')).toBeNull()
    expect(q('[data-kw-intent]')).toBeNull()
    expect(q('[data-kw-filter-difficulty]')).toBeNull()
    expect(q('[data-kw-filter-intent]')).toBeNull()
    expect(q('[data-kw-result]')!.textContent).not.toContain('Difficulty')
  })

  it('a correctable seed is said beside the field, never in a toast', async () => {
    answer = () => ({ status: 400, body: { error: 'Keep the keyword under 120 characters.', code: 'VALIDATION_ERROR' } })
    await render()
    await research('a very long phrase')
    expect(q('[data-kw-seed-error]')!.textContent).toBe('Keep the keyword under 120 characters.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    await type('[data-kw-seed]', 'shorter')
    expect(q('[data-kw-seed-error]')).toBeNull()
  })

  it('the month’s limit is a neutral line, not an error, and the page stays usable', async () => {
    answer = () => ({ status: 402, body: { error: 'This workspace has spent its $20 of search data this month. It resets Dec 1.', code: 'SPEND_LIMIT_REACHED' } })
    await render()
    await research()
    const line = q('[data-kw-problem="neutral"]')!
    expect(line.textContent).toBe('This workspace has spent its $20 of search data this month. It resets Dec 1.')
    expect(q('[data-kw-problem="failed"]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-kw-find]')!.disabled).toBe(false)
  })

  it('a failure is the amber banner with the sentence, and Try again asks again', async () => {
    let calls = 0
    answer = () => (++calls === 1 ? { status: 502, body: { error: 'The search data provider didn’t answer. Try again in a moment.', code: 'UPSTREAM_UNAVAILABLE' } } : { status: 200, body: RESULT })
    await render()
    await research()
    const banner = q('[data-kw-problem="failed"]')!
    expect(banner.textContent).toContain('The search data provider didn’t answer.')
    await click(banner.querySelector('button'))
    expect(sent).toHaveLength(2)
    expect(q('[data-kw-problem]')).toBeNull()
    expect(all('[data-kw-row]')).toHaveLength(3)
  })

  it('a past lookup reopens its stored result for free, and Refresh buys it again with what it asked', async () => {
    routes[LOOKUPS] = { lookups: [{ id: L1, kind: 'keyword_research', label: 'linen throw · United States', fetched_at: '2026-11-10T09:00:00Z', fetched_by: 'user-me' }] }
    routes[`/api/account/seo/lookups/${L1}`] = {
      id: L1,
      kind: 'keyword_research',
      label: 'linen throw · United States',
      fetched_at: '2026-11-10T09:00:00Z',
      fetched_by: 'user-me',
      request: { v: 1, seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'ideas', result_limit: 300, clickstream: false, group_keywords: false },
      result: { seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'ideas', source: 'ideas', used_fallback: false, data_provider: 'labs', rows: ROWS },
    }
    await render()
    // Past lookups: not a first run.
    expect(q('[data-kw-first-run]')).toBeNull()
    expect(q(`[data-kw-recent-row="${L1}"]`)!.textContent).toContain('linen throw · United States')
    await click(q(`[data-kw-recent-row="${L1}"] button`))
    expect(sent).toEqual([])
    expect(q('[data-kw-result-line]')!.textContent).toMatch(/^3 keywords for “linen throw” · United States · Looked up /)
    expect(q<HTMLInputElement>('[data-kw-seed]')!.value).toBe('linen throw')
    await click(q('[data-kw-refresh]'))
    expect(sent).toEqual([
      { method: 'POST', path: '/api/account/seo/keywords/research', body: { seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'ideas', result_limit: 300, refresh: true } },
    ])
  })

  it('lookups off: the notice under a disabled start control saying why, and stored lookups still open', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    routes[LOOKUPS] = { lookups: [{ id: L1, kind: 'keyword_research', label: 'linen throw · United States', fetched_at: '2026-11-10T09:00:00Z', fetched_by: null }] }
    await render()
    expect(q('[data-seo-data-off="FREE_PLAN"]')!.textContent).toContain('Keyword data is part of the paid plan')
    expect(q('[data-kw-first-run]')).toBeNull()
    const find = q<HTMLButtonElement>('[data-kw-find]')!
    expect(find.disabled).toBe(true)
    expect(find.title).toBe('Part of the paid plan')
    expect(q<HTMLInputElement>('[data-kw-seed]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>(`[data-kw-recent-row="${L1}"] button`)!.disabled).toBe(false)
  })

  it('selected rows save with a tag and the numbers they have; the Saved tab reads again', async () => {
    answer = (method, path) => {
      if (path === '/api/account/seo/keywords/research') return { status: 200, body: RESULT }
      if (method === 'POST' && path === '/api/account/seo/keywords/saved') return { status: 201, body: { added: 1, already_saved: 1, rows: [] } }
      return { status: 200, body: {} }
    }
    await render()
    await research()
    expect(q('[data-kw-island]')).toBeNull()
    await click(q('[data-kw-row="linen throw"] button[role="checkbox"]'))
    await click(q('[data-kw-row="linen throw blanket"] button[role="checkbox"]'))
    expect(q('[data-kw-island]')!.textContent).toContain('2 selected')
    // Check results is for one keyword.
    expect(q('[data-kw-island-check]')).toBeNull()
    const savedReads = () => asked().filter((a) => a.startsWith('GET /api/account/seo/keywords/saved')).length
    const before = savedReads()
    await click(q('[data-kw-save]'))
    expect(q('[data-kw-save]')!.textContent).toBe('Save · 2')
    await type('[data-kw-save-tag]', 'Linen!')
    await click(q('[data-kw-save-confirm]'))
    const post = sent.find((s) => s.path === '/api/account/seo/keywords/saved')!
    expect(post.body).toMatchObject({ keywords: ['linen throw', 'linen throw blanket'], location_code: 2840, language_code: 'en', tags: ['linen'] })
    expect((post.body as { metrics: unknown[] }).metrics[0]).toMatchObject({ keyword: 'linen throw', search_volume: 2400, keyword_difficulty: 18, intent: 'commercial' })
    expect(hoisted.toast).toHaveBeenCalledWith('Saved 1 keyword · 1 was already saved.')
    expect(q('[data-kw-island]')).toBeNull()
    expect(savedReads()).toBe(before + 1)
  })

  it('Check results opens the live results: buying once, then reading the rest for free until complete', async () => {
    await render()
    await research()
    await click(q('[data-kw-row="linen throw"] button[role="checkbox"]'))
    await click(q('[data-kw-island-check]'))
    expect(sent.at(-1)).toEqual({ method: 'POST', path: '/api/account/seo/serp', body: { keyword: 'linen throw', location_code: 2840, language_code: 'en' } })
    const sheet = q('[data-kw-serp]')!
    expect(sheet.textContent).toContain('linen throw')
    expect(sheet.querySelector('[data-seo-run-rail]')!.textContent).toContain('More reads coming…')
    expect(sheet.querySelector('[data-seo-run-rail]')!.textContent).toContain('2 of 3 reads in')
    const row = sheet.querySelector<HTMLElement>('[data-kw-serp-row="1"]')!
    expect(row.querySelector('span')!.title).toBe('Seen in 2 of 3 reads')
    const link = row.querySelector<HTMLAnchorElement>('a')!
    expect(link.textContent).toBe('Linen throws · Fernhill Studio')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer noopener')
    expect(row.textContent).toContain('fernhillstudio.example/shop/linen-throw')
    // Text from other sites is text, never markup.
    expect(row.textContent).toContain('<b>Handwoven</b> linen throws.')
    expect(row.querySelector('b')).toBeNull()
    expect(sheet.querySelector('[data-kw-serp-features]')!.textContent).toBe('Also on the page: People also ask')
    await settle(3100)
    expect(asked()).toContain(`GET /api/account/seo/serp/${SERP}`)
    expect(q('[data-kw-serp] [data-seo-run-rail]')).toBeNull()
    expect(q('[data-kw-serp-status="complete"]')!.textContent).toContain('Top 1 result · Checked just now')
    expect(sent.filter((s) => s.path === '/api/account/seo/serp')).toHaveLength(1)
  })

  it('a partial lookup shows its note as one quiet line under the result line, with Refresh to look the whole of it up again', async () => {
    const note = 'Related searches could not be added just now. The keywords that did come back are shown; a refresh looks the whole research up again.'
    answer = () => ({ status: 200, body: { ...RESULT, partial: { missing: ['related'], note } } })
    await render()
    await research()
    const result = q('[data-kw-result]')!
    const line = result.querySelector<HTMLElement>('[data-seo-partial]')!
    expect(line.textContent).toBe(note)
    // Quiet and neutral: not the amber banner, not a toast, and the rows are there.
    expect(line.className).toContain('text-muted-foreground')
    expect(line.className).not.toMatch(/amber|destructive|red/)
    expect(q('[data-kw-problem]')).toBeNull()
    expect(hoisted.toast).not.toHaveBeenCalled()
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    expect(all('[data-kw-row]')).toHaveLength(3)
    // It sits right under the "N keywords for …" line.
    expect(q('[data-kw-result-line]')!.closest('div')!.nextElementSibling).toBe(line)
    // Just bought, but missing a part: Refresh is offered, and buys again.
    answer = () => ({ status: 200, body: RESULT })
    await click(q('[data-kw-refresh]'))
    expect(sent.at(-1)).toEqual({ method: 'POST', path: '/api/account/seo/keywords/research', body: { seed: 'linen throw', location_code: 2840, language_code: 'en', refresh: true } })
    expect(q('[data-seo-partial]')).toBeNull()
  })

  it('a whole lookup has no partial line', async () => {
    await render()
    await research()
    expect(q('[data-kw-result]')).not.toBeNull()
    expect(q('[data-seo-partial]')).toBeNull()
  })

  it('a stored partial lookup reopened from Recent keeps its note', async () => {
    const note = 'Keywords from the same topic could not be read just now. The keywords that did come back are shown; a refresh looks the whole research up again.'
    routes[LOOKUPS] = { lookups: [{ id: L1, kind: 'keyword_research', label: 'linen throw · United States', fetched_at: '2026-11-10T09:00:00Z', fetched_by: 'user-me' }] }
    routes[`/api/account/seo/lookups/${L1}`] = {
      id: L1,
      kind: 'keyword_research',
      label: 'linen throw · United States',
      fetched_at: '2026-11-10T09:00:00Z',
      fetched_by: 'user-me',
      request: { v: 1, seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'auto', result_limit: 150, clickstream: false, group_keywords: false },
      result: { seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'auto', source: 'blended', used_fallback: false, data_provider: 'labs', rows: ROWS.slice(0, 1), partial: { missing: ['ideas'], note } },
    }
    await render()
    await click(q(`[data-kw-recent-row="${L1}"] button`))
    expect(sent).toEqual([])
    expect(q('[data-kw-result] [data-seo-partial]')!.textContent).toBe(note)
    expect(q('[data-kw-refresh]')).not.toBeNull()
  })
})

describe('SeoKeywordsCard: live results that found nothing', () => {
  beforeEach(() => {
    routes['/api/account/seo/keywords/saved*'] = EMPTY_SAVED
  })
  const SERP_EMPTY: SerpResult = { ...SERP_PARTIAL, status: 'complete', reads_in: 3, items: [] }
  async function openSheet() {
    await render()
    await research()
    await click(q('[data-kw-row="linen throw"] [data-kw-row-check]'))
  }

  it('a check complete with no results is a calm empty state: when it was checked and Refresh, never a failure or a spinner', async () => {
    answer = (_m, path) => (path === '/api/account/seo/serp' ? { status: 200, body: SERP_EMPTY } : { status: 200, body: RESULT })
    await openSheet()
    const sheet = q('[data-kw-serp]')!
    expect(sheet.querySelector('[data-kw-serp-empty]')!.textContent).toBe('Nothing found for this search yet.')
    expect(sheet.querySelector('[data-kw-serp-status="complete"]')!.textContent).toContain('Checked just now')
    expect(sheet.querySelector('[data-seo-run-rail]')).toBeNull()
    expect(sheet.querySelector('[data-kw-problem]')).toBeNull()
    expect(sheet.querySelector('[data-kw-serp-gone]')).toBeNull()
    // Complete: nothing is polled.
    await settle(3100)
    expect(asked()).not.toContain(`GET /api/account/seo/serp/${SERP}`)
    expect(q('[data-kw-serp] [data-seo-run-rail]')).toBeNull()
    // Refresh buys a new check, even of one just bought.
    const refresh = q<HTMLButtonElement>('[data-kw-serp-refresh]')!
    expect(refresh.disabled).toBe(false)
    expect(refresh.title).toBe('Buys a new check of the results')
    await click(refresh)
    expect(sent.at(-1)).toEqual({ method: 'POST', path: '/api/account/seo/serp', body: { keyword: 'linen throw', location_code: 2840, language_code: 'en', refresh: true } })
  })

  it('a stored empty check says when it was looked up and offers Refresh, and buys nothing on opening', async () => {
    answer = (_m, path) =>
      path === '/api/account/seo/serp'
        ? { status: 200, body: { ...SERP_EMPTY, from_cache: true, fetched_at: new Date(Date.now() - 2 * 3600_000).toISOString() } }
        : { status: 200, body: RESULT }
    await openSheet()
    const spendReads = () => asked().filter((a) => a === 'GET /api/account/seo/spend').length
    const before = spendReads()
    expect(q('[data-kw-serp-empty]')!.textContent).toBe('Nothing found for this search yet.')
    expect(q('[data-kw-serp-status="complete"]')!.textContent).toContain('Checked 2 hours ago')
    expect(q('[data-kw-serp-refresh]')).not.toBeNull()
    // A stored answer is not a purchase: the spend line is not read again.
    expect(spendReads()).toBe(before)
  })

  it('a refresh answered from the first check still coming in is not a purchase, and keeps reading the rest', async () => {
    let serpCalls = 0
    answer = (_m, path) => {
      if (path !== '/api/account/seo/serp') return { status: 200, body: RESULT }
      serpCalls += 1
      return serpCalls === 1 ? { status: 200, body: SERP_EMPTY } : { status: 200, body: { ...SERP_PARTIAL, from_cache: true } }
    }
    await openSheet()
    const spendReads = () => asked().filter((a) => a === 'GET /api/account/seo/spend').length
    const before = spendReads()
    await click(q('[data-kw-serp-refresh]'))
    expect(q('[data-kw-serp] [data-seo-run-rail]')!.textContent).toContain('2 of 3 reads in')
    expect(spendReads()).toBe(before)
    await settle(3100)
    expect(asked()).toContain(`GET /api/account/seo/serp/${SERP}`)
    expect(q('[data-kw-serp-status="complete"]')!.textContent).toContain('Top 1 result')
    expect(q('[data-kw-serp-empty]')).toBeNull()
  })
})

describe('SeoKeywordsCard: saved', () => {
  it('the saved keywords: tags, another market named, a missing number explained, and the count for the header', async () => {
    store.update('kw-1', { tab: 'saved' })
    await render()
    expect(q('[data-seo-tab="saved"]')!.getAttribute('aria-selected')).toBe('true')
    expect(q('[data-seo-tab="saved"]')!.textContent).toBe('Saved2')
    expect(onCount).toHaveBeenLastCalledWith(2)
    expect(all('[data-kw-saved] [data-kw-row]').map((r) => r.dataset.kwRow)).toEqual([S1, S2])
    expect(q(`[data-kw-row="${S1}"] [data-kw-row-tag]`)!.textContent).toBe('linen')
    expect(q(`[data-kw-row="${S1}"]`)!.textContent).not.toContain('United Kingdom')
    expect(q(`[data-kw-row="${S2}"]`)!.textContent).toContain('United Kingdom')
    expect(q(`[data-kw-row="${S2}"] [title="No numbers yet: select it and press Refresh numbers"]`)!.textContent).toBe('—')
    expect(q('[data-kw-tag-chip="linen"]')!.textContent).toBe('linen1')
    await click(q('[data-kw-tag-chip="linen"]'))
    expect(asked().at(-1)).toBe('GET /api/account/seo/keywords/saved?limit=50&tag=linen&sort=created_at&dir=desc')
  })

  it('Refresh numbers asks once per market, buying again, and reads the list again', async () => {
    answer = (_m, path) => (path === '/api/account/seo/keywords/metrics' ? { status: 200, body: { rows: [ROWS[0]], missing: [], from_cache: false } } : { status: 200, body: {} })
    store.update('kw-1', { tab: 'saved' })
    await render()
    await click(q('[data-kw-saved] [data-kw-check-all]'))
    const button = q<HTMLButtonElement>('[data-kw-refresh-numbers]')!
    expect(button.textContent).toBe('Refresh numbers · 2')
    expect(button.title).toBe('Buys fresh numbers for the selected keywords')
    await click(button)
    expect(sent).toEqual([
      { method: 'POST', path: '/api/account/seo/keywords/metrics', body: { keywords: ['linen throw'], location_code: 2840, language_code: 'en', refresh: true } },
      { method: 'POST', path: '/api/account/seo/keywords/metrics', body: { keywords: ['oak side table'], location_code: 2826, language_code: 'en', refresh: true } },
    ])
    expect(hoisted.toast).toHaveBeenCalledWith('Refreshed the numbers for 2 keywords.')
  })

  it('lookups off: the list still works, Refresh numbers waits saying why', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    store.update('kw-1', { tab: 'saved' })
    await render()
    await click(q(`[data-kw-row="${S1}"] button[role="checkbox"]`))
    const button = q<HTMLButtonElement>('[data-kw-refresh-numbers]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Part of the paid plan')
    expect(q<HTMLButtonElement>('[data-kw-remove]')!.disabled).toBe(false)
  })

  it('Tag adds a tag to the selection', async () => {
    store.update('kw-1', { tab: 'saved' })
    await render()
    await click(q(`[data-kw-row="${S2}"] button[role="checkbox"]`))
    await click(q('[data-kw-tag]'))
    await type('[data-kw-tag-input]', 'Furniture')
    await click(q('[data-kw-tag-add]'))
    expect(sent).toEqual([{ method: 'PATCH', path: '/api/account/seo/keywords/saved', body: { ids: [S2], add_tags: ['furniture'] } }])
  })

  it('Remove goes through the confirm dialog', async () => {
    answer = () => ({ status: 200, body: { removed: 2 } })
    store.update('kw-1', { tab: 'saved' })
    await render()
    await click(q('[data-kw-saved] [data-kw-check-all]'))
    await click(q('[data-kw-remove]'))
    const dialog = q('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Remove 2 saved keywords?')
    expect(dialog.textContent).toContain('This cannot be undone.')
    expect(sent).toEqual([])
    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Remove')!)
    expect(sent).toEqual([{ method: 'DELETE', path: '/api/account/seo/keywords/saved', body: { ids: [S1, S2] } }])
    expect(hoisted.toast).toHaveBeenCalledWith('Removed 2 saved keywords.')
  })

  it('empty: says what goes here, and Find keywords moves to Research', async () => {
    routes['/api/account/seo/keywords/saved*'] = EMPTY_SAVED
    store.update('kw-1', { tab: 'saved' })
    await render()
    const empty = q('[data-kw-saved-empty]')!
    expect(empty.textContent).toContain('No saved keywords yet')
    expect(empty.textContent).toContain('Keywords you save from Research show here.')
    expect(onCount).toHaveBeenLastCalledWith(0)
    await click(q('[data-kw-go-research]'))
    expect(store.state('kw-1').tab).toBe('research')
    expect(q('[data-seo-tab="research"]')!.getAttribute('aria-selected')).toBe('true')
  })

  it('a failed read: a line and Try again', async () => {
    delete routes['/api/account/seo/keywords/saved*']
    store.update('kw-1', { tab: 'saved' })
    await render()
    expect(q('[data-kw-saved-error], [data-seo-error]')!.textContent).toContain('Could not load your saved keywords.')
    routes['/api/account/seo/keywords/saved*'] = SAVED_PAGE
    await click(q('[data-seo-error] button'))
    expect(all('[data-kw-saved] [data-kw-row]')).toHaveLength(2)
  })
})
