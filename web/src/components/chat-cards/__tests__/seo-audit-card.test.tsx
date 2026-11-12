// @vitest-environment jsdom
/**
 * SEO's Site audit card: the first run (what an audit does, the address
 * prefilled, Start audit), the index (a row per audit, its findings by
 * severity or its status, the run rail of a live one, New audit waiting
 * while one runs), one audit as the card's place (tiles, the severity bar,
 * Findings opened in place with their pages read on demand, Pages as the
 * card's tab), a failed or stopped audit, and the start dialog's inline
 * error and its 409 (the running audit opens instead).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => React.createElement('span', { 'data-thinking-orb': '' }) }))

import SeoAuditCard from '../pages/seo-audit-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { SiteAuditDetail, SiteAuditIssueRow, SiteAuditPageRow, SiteAuditView } from '@/lib/seo/audit/view'

const spec: PageCardSpec = { kind: 'seo_audit', title: 'Site audit' }
const LIMITS = { min_pages: 10, default_pages: 100, max_pages: 1000 }
const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const A3 = '33333333-3333-4333-8333-333333333333'

const audit = (id: string, extra: Partial<SiteAuditView> = {}): SiteAuditView => ({
  id,
  start_url: 'https://fernhillstudio.example/',
  host: 'fernhillstudio.example',
  status: 'completed',
  phase: 'done',
  max_pages: 100,
  pages_crawled: 42,
  pages_queued: 42,
  counts: { critical: 2, warning: 0, info: 5 },
  error: null,
  started_by: 'user-me',
  created_at: '2026-11-12T10:00:00Z',
  started_at: '2026-11-12T10:00:00Z',
  completed_at: '2026-11-12T10:03:00Z',
  ...extra,
})
const DONE = audit(A1)
const RUNNING = audit(A2, { host: 'shop.fernhillstudio.example', status: 'running', phase: 'crawl', pages_crawled: 17, pages_queued: 60, counts: { critical: 0, warning: 0, info: 0 }, completed_at: null })
const FAILED = audit(A3, { host: 'old.fernhillstudio.example', status: 'failed', phase: 'discovery', pages_crawled: 0, pages_queued: 0, counts: { critical: 0, warning: 0, info: 0 }, error: 'The site did not answer.' })

const DETAIL: SiteAuditDetail = {
  audit: DONE,
  issues: [
    { type: 'broken-internal-link', severity: 'critical', title: 'Broken internal link', explanation: 'Links that go nowhere.', how_to_fix: 'Point them at a live page.', count: 4, pages: 3 },
    { type: 'missing-title', severity: 'critical', title: 'Missing title tag', explanation: 'No title.', how_to_fix: 'Add one.', count: 1, pages: 1 },
    { type: 'title-too-long', severity: 'info', title: 'Title too long', explanation: 'Cut off.', how_to_fix: 'Shorten it.', count: 5, pages: 5 },
  ],
}
const BROKEN: SiteAuditIssueRow[] = [
  { id: 'i1', type: 'broken-internal-link', severity: 'critical', page_id: 'p1', page_url: 'https://fernhillstudio.example/journal/spring', details: { targetUrl: 'https://fernhillstudio.example/old-shop', targetStatus: 404 } },
]
const PAGES: SiteAuditPageRow[] = [
  { id: 'p1', url: 'https://fernhillstudio.example/', status_code: 200, fetch_class: 'ok', redirect_url: null, title: 'Fernhill Studio', meta_description: null, canonical_url: null, h1_count: 1, word_count: 812, images_total: 4, images_missing_alt: 0, internal_link_count: 24, external_link_count: 3, has_structured_data: true, is_indexable: true, crawl_depth: 0, in_sitemap: true, response_time_ms: 210 },
  { id: 'p2', url: 'https://fernhillstudio.example/old-shop', status_code: 404, fetch_class: 'ok', redirect_url: null, title: null, meta_description: null, canonical_url: null, h1_count: 0, word_count: 0, images_total: 0, images_missing_alt: 0, internal_link_count: 0, external_link_count: 0, has_structured_data: false, is_indexable: true, crawl_depth: null, in_sitemap: false, response_time_ms: 90 },
  { id: 'p3', url: 'https://fernhillstudio.example/members', status_code: 403, fetch_class: 'blocked', redirect_url: null, title: null, meta_description: null, canonical_url: null, h1_count: 0, word_count: 0, images_total: 0, images_missing_alt: 0, internal_link_count: 0, external_link_count: 0, has_structured_data: false, is_indexable: true, crawl_depth: 2, in_sitemap: true, response_time_ms: 40 },
]

let routes: Record<string, unknown>
let posts: Array<{ path: string; body: unknown }>
let postAnswer: (path: string, body: unknown) => { status: number; body: unknown }
let fetchMock: ReturnType<typeof stubAppFetch>
let mount: ReturnType<typeof mountRoot>
let store: ChatCardStore

beforeEach(() => {
  // A card's place is kept per device (card-storage.ts): each test starts on the index.
  window.localStorage.clear()
  hoisted.toast.mockClear()
  hoisted.toast.error.mockClear()
  posts = []
  routes = {
    '/api/account/seo/audits': { audits: [RUNNING, DONE, FAILED], default_url: 'https://fernhillstudio.example', limits: LIMITS },
    [`/api/account/seo/audits/${A1}`]: DETAIL,
    [`/api/account/seo/audits/${A3}`]: { audit: FAILED, issues: [] },
    [`/api/account/seo/audits/${A1}/issues?type=broken-internal-link`]: { issues: BROKEN, next_offset: 1 },
    [`/api/account/seo/audits/${A1}/pages`]: { pages: PAGES, next_offset: null },
  }
  postAnswer = () => ({ status: 201, body: { audit: audit('44444444-4444-4444-8444-444444444444', { status: 'queued', phase: 'discovery' }) } })
  fetchMock = stubAppFetch(routes)
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      const path = String(input)
      const body = init.body ? JSON.parse(String(init.body)) : null
      posts.push({ path, body })
      const answer = postAnswer(path, body)
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
    }
    return get(input, init)
  })
  mount = mountRoot()
  store = makeStore('seo-1', spec)
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
const click = async (sel: string) => {
  await act(async () => q(sel)!.click())
  await settle()
  await settle()
}
const asked = () => fetchMock.mock.calls.map(([input]) => String(input))

async function render() {
  await mount.render(React.createElement(SeoAuditCard, { toolCallId: 'seo-1', spec, store, fullScreen: true }))
  await settle()
}

describe('SeoAuditCard: first run', () => {
  it('says what an audit does and starts one inline, the address prefilled with the workspace’s site', async () => {
    routes['/api/account/seo/audits'] = { audits: [], default_url: 'https://fernhillstudio.example', limits: LIMITS }
    await render()
    const first = q('[data-seo-first-run]')!
    expect(first.textContent).toContain('Check your website for search problems')
    expect(first.textContent).toContain('costs nothing')
    // Nothing to start twice: the form is right there.
    expect(q('[data-seo-new-audit]')).toBeNull()
    expect(q<HTMLInputElement>('[data-seo-start-url]')!.value).toBe('https://fernhillstudio.example')
    await click('[data-seo-start]')
    expect(posts).toEqual([{ path: '/api/account/seo/audits', body: { url: 'https://fernhillstudio.example', max_pages: 100 } }])
    // The new audit opens as the card's place.
    expect(store.state('seo-1').at).toMatchObject({ type: 'seo_audit', id: '44444444-4444-4444-8444-444444444444', label: 'fernhillstudio.example' })
  })

  it('says a correctable address error beside the field, never in a toast', async () => {
    routes['/api/account/seo/audits'] = { audits: [], default_url: null, limits: LIMITS }
    postAnswer = () => ({ status: 400, body: { error: 'That isn’t a public website.', code: 'BAD_REQUEST', details: { code: 'NOT_PUBLIC' } } })
    await render()
    const input = q<HTMLInputElement>('[data-seo-start-url]')!
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('example.com')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'localhost:3000')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('[data-seo-start]')
    expect(q('[data-seo-start-error]')!.textContent).toBe('That isn’t a public website.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    expect(store.state('seo-1').at ?? null).toBeNull()
  })
})

describe('SeoAuditCard: the index', () => {
  it('a row per audit: its site, pages and when, findings by severity with zeros dropped, or its status', async () => {
    await render()
    expect(all('[data-seo-audit-row]').map((r) => r.dataset.seoAuditRow)).toEqual([A2, A1, A3])
    const done = q(`[data-seo-audit-row="${A1}"]`)!
    expect(done.textContent).toContain('fernhillstudio.example')
    expect(done.textContent).toContain('42 pages')
    expect(Array.from(done.querySelectorAll<HTMLElement>('[data-seo-count]')).map((c) => c.textContent)).toEqual(['2 critical', '5 info'])
    expect(q(`[data-seo-audit-row="${A2}"] [data-seo-audit-status]`)!.textContent).toBe('Running')
    expect(q(`[data-seo-audit-row="${A3}"] [data-seo-audit-status]`)!.textContent).toBe('Failed')
  })

  it('a live audit: its run rail above the list, and New audit waits saying why', async () => {
    await render()
    const rail = q(`[data-seo-run-rail="${A2}"]`)!
    expect(rail.textContent).toBe('Checking pages · 17 of about 60 · shop.fernhillstudio.example' + 'Stop')
    const button = q<HTMLButtonElement>('[data-seo-new-audit]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('shop.fernhillstudio.example')
  })

  it('Stop asks the server to stop it and says what is kept', async () => {
    postAnswer = () => ({ status: 200, body: { audit: { ...RUNNING, status: 'canceled', phase: 'done' } } })
    routes['/api/account/seo/audits'] = { audits: [RUNNING, DONE], default_url: null, limits: LIMITS }
    await render()
    routes['/api/account/seo/audits'] = { audits: [{ ...RUNNING, status: 'canceled' }, DONE], default_url: null, limits: LIMITS }
    await click('[data-seo-stop]')
    expect(posts.map((p) => p.path)).toEqual([`/api/account/seo/audits/${A2}/cancel`])
    expect(hoisted.toast).toHaveBeenCalledWith('Stopped. What it found is kept.')
    expect(q('[data-seo-run-rail]')).toBeNull()
    expect(q(`[data-seo-audit-row="${A2}"] [data-seo-audit-status]`)!.textContent).toBe('Stopped')
  })

  it('a failed read: a line and Try again', async () => {
    delete routes['/api/account/seo/audits']
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your audits.')
    routes['/api/account/seo/audits'] = { audits: [DONE], default_url: null, limits: LIMITS }
    await act(async () => q<HTMLButtonElement>('[data-seo-error] button')!.click())
    await settle()
    expect(all('[data-seo-audit-row]')).toHaveLength(1)
  })
})

describe('SeoAuditCard: one audit', () => {
  it('opens as the card’s place: the crumb back, tiles, the severity bar and the findings most serious first', async () => {
    await render()
    await click(`[data-seo-audit-row="${A1}"] button`)
    expect(store.state('seo-1').at).toMatchObject({ type: 'seo_audit', id: A1, label: 'fernhillstudio.example' })
    expect(q('h1')!.textContent).toBe('fernhillstudio.example')
    expect(all('[data-seo-tile]').map((t) => t.textContent)).toEqual(['42Pages checked', '2Critical', '0Warnings', '5Info'])
    const bar = q('[data-seo-bar]')!
    expect(bar.getAttribute('role')).toBe('img')
    expect(bar.getAttribute('aria-label')).toBe('Findings: 2 critical, 5 info')
    expect(all('[data-seo-bar-segment]').map((s) => s.dataset.seoBarSegment)).toEqual(['critical', 'info'])
    expect(all('[data-seo-finding]').map((r) => r.dataset.seoFinding)).toEqual(['broken-internal-link', 'missing-title', 'title-too-long'])
    expect(q('[data-seo-finding="broken-internal-link"]')!.textContent).toContain('4 on 3 pages')
    expect(q('[data-seo-finding="title-too-long"]')!.textContent).toContain('5 pages')
    expect(q('[data-seo-finding="missing-title"]')!.textContent).toContain('1 page')
    expect(q('[data-seo-tab="findings"]')!.getAttribute('aria-selected')).toBe('true')
    // Back: the crumb walks the card to the index.
    await click('button[aria-label="Site audit"]')
    expect(store.state('seo-1').at).toBeNull()
    expect(all('[data-seo-audit-row]')).toHaveLength(3)
  })

  it('a finding opens in place: what it means, how to fix it, and its pages read on demand', async () => {
    store.update('seo-1', { at: { type: 'seo_audit', id: A1, label: 'fernhillstudio.example' } })
    await render()
    const toggle = q<HTMLButtonElement>('[data-seo-finding="broken-internal-link"] button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(asked()).not.toContain(`/api/account/seo/audits/${A1}/issues?type=broken-internal-link`)
    await act(async () => toggle.click())
    await settle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const body = q('[data-seo-finding-body="broken-internal-link"]')!
    expect(body.textContent).toContain('What it means')
    expect(body.textContent).toContain('Links that go nowhere.')
    expect(body.textContent).toContain('How to fix it')
    expect(asked()).toContain(`/api/account/seo/audits/${A1}/issues?type=broken-internal-link`)
    const link = q<HTMLAnchorElement>('[data-seo-affected-row="i1"] a')!
    expect(link.textContent).toBe('/journal/spring')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer noopener')
    expect(q('[data-seo-affected-row="i1"]')!.textContent).toContain('links to /old-shop (404)')
    expect(q('[data-seo-affected-more]')!.textContent).toBe('Show more')
  })

  it('Pages is the card’s tab: filters, status colours, and the numbers', async () => {
    store.update('seo-1', { at: { type: 'seo_audit', id: A1, label: 'fernhillstudio.example' } })
    await render()
    await click('[data-seo-tab="pages"]')
    expect(store.state('seo-1').tab).toBe('pages')
    expect(asked()).toContain(`/api/account/seo/audits/${A1}/pages`)
    expect(all('[data-seo-pages-filter]').map((b) => b.textContent)).toEqual(['All', 'Errors', 'Redirects', 'Not indexed', 'Not in sitemap'])
    expect(all('[data-seo-page-status]').map((s) => `${s.textContent}:${s.dataset.seoPageStatus}`)).toEqual(['200:ok', '404:error', 'Blocked:error'])
    expect(q('[data-seo-page-row="p1"]')!.textContent).toContain('Fernhill Studio')
    expect(q('[data-seo-page-row="p2"]')!.textContent).toContain('—')
    routes[`/api/account/seo/audits/${A1}/pages?show=errors`] = { pages: [PAGES[1], PAGES[2]], next_offset: null }
    await click('[data-seo-pages-filter="errors"]')
    expect(asked().at(-1)).toBe(`/api/account/seo/audits/${A1}/pages?show=errors`)
    expect(all('[data-seo-page-row]')).toHaveLength(2)
  })

  it('a clean audit says so quietly, and hides the bar', async () => {
    routes[`/api/account/seo/audits/${A1}`] = { audit: { ...DONE, counts: { critical: 0, warning: 0, info: 0 } }, issues: [] }
    store.update('seo-1', { at: { type: 'seo_audit', id: A1, label: 'fernhillstudio.example' } })
    await render()
    expect(q('[data-seo-clean]')!.textContent).toContain('No problems found')
    expect(q('[data-seo-clean]')!.textContent).toContain('Every page that was checked passed.')
    expect(q('[data-seo-bar]')).toBeNull()
  })

  it('a failed audit: the reason in an amber banner, and Run again starts the same site and limit', async () => {
    store.update('seo-1', { at: { type: 'seo_audit', id: A3, label: 'old.fernhillstudio.example' } })
    await render()
    const banner = q('[data-seo-failed]')!
    expect(banner.textContent).toContain('The site did not answer.')
    // It checked nothing: no tiles of zeros, and never "No problems found".
    expect(q('[data-seo-tile]')).toBeNull()
    expect(q('[data-seo-clean]')).toBeNull()
    expect(q(`[data-seo-audit-row]`)).toBeNull()
    await act(async () => banner.querySelector<HTMLButtonElement>('button')!.click())
    await settle()
    expect(posts).toEqual([{ path: '/api/account/seo/audits', body: { url: 'https://fernhillstudio.example/', max_pages: 100 } }])
    expect(store.state('seo-1').at).toMatchObject({ id: '44444444-4444-4444-8444-444444444444' })
  })

  it('while it runs: the run rail, and the findings’ counts unknown, not zero', async () => {
    routes[`/api/account/seo/audits/${A2}`] = { audit: RUNNING, issues: [] }
    store.update('seo-1', { at: { type: 'seo_audit', id: A2, label: RUNNING.host } })
    await render()
    expect(q(`[data-seo-run-rail="${A2}"]`)!.textContent).toContain('Checking pages · 17 of about 60')
    expect(all('[data-seo-tile]').map((t) => t.textContent)).toEqual(['17Pages checked', '—Critical', '—Warnings', '—Info'])
    expect(q('[data-seo-clean]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-seo-run-again]')).toBeNull()
  })

  it('a stopped audit: a quiet line', async () => {
    routes[`/api/account/seo/audits/${A1}`] = { ...DETAIL, audit: { ...DONE, status: 'canceled' } }
    store.update('seo-1', { at: { type: 'seo_audit', id: A1, label: 'fernhillstudio.example' } })
    await render()
    expect(q('[data-seo-canceled]')!.textContent).toBe('Stopped early. What it found is below.')
  })

  it('the … menu deletes it through the confirm dialog, then back to the audits', async () => {
    postAnswer = () => ({ status: 200, body: { deleted: true } })
    store.update('seo-1', { at: { type: 'seo_audit', id: A1, label: 'fernhillstudio.example' } })
    await render()
    await click('[data-seo-audit-menu]')
    expect(q('[data-seo-run-again]')!.textContent).toBe('Run again')
    await click('[data-seo-delete]')
    const dialog = q('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Delete the audit of fernhillstudio.example?')
    expect(dialog.textContent).toContain('Its pages and findings are removed. This cannot be undone.')
    expect(posts).toEqual([])
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Delete')!
    await act(async () => confirm.click())
    await settle()
    await settle()
    expect(posts).toEqual([{ path: `/api/account/seo/audits/${A1}`, body: null }])
    expect(store.state('seo-1').at).toBeNull()
  })

  it('a start while one runs (409) opens the running audit instead', async () => {
    routes['/api/account/seo/audits'] = { audits: [DONE], default_url: 'https://fernhillstudio.example', limits: LIMITS }
    postAnswer = () => ({ status: 409, body: { error: 'An audit is already running.', code: 'AUDIT_ALREADY_RUNNING', details: { audit: RUNNING } } })
    await render()
    await click('[data-seo-new-audit]')
    const dialog = q('[data-seo-start-dialog]')!
    expect(Array.from(dialog.querySelectorAll<HTMLElement>('[data-seo-pages]')).map((b) => b.textContent)).toEqual(['50', '100', '250', '500', '1,000'])
    expect(dialog.querySelector('[data-seo-pages="100"]')!.getAttribute('aria-checked')).toBe('true')
    expect(dialog.textContent).toContain('About a second per page.')
    await act(async () => dialog.querySelector<HTMLButtonElement>('[data-seo-pages="250"]')!.click())
    await act(async () => dialog.querySelector<HTMLButtonElement>('[data-seo-start]')!.click())
    await settle()
    expect(posts[0].body).toEqual({ url: 'https://fernhillstudio.example', max_pages: 250 })
    expect(store.state('seo-1').at).toMatchObject({ type: 'seo_audit', id: A2 })
  })
})
