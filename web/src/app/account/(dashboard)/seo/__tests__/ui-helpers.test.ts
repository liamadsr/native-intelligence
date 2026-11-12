/**
 * The Site audit page's words: the run rail's sentence (a zero clause
 * dropped, "of about" only while more pages are known than checked), the
 * counts (plural-aware), a finding's one-line detail, a page's answer, and
 * the start dialog's page presets held to the route's bounds.
 */
import { describe, expect, it } from 'vitest'
import type { SiteAuditView } from '@/lib/seo/audit/view'
import { pagePresets } from '../start-audit'
import { auditRailLine, findingsOnPages, issueDetail, pageStatus, pathOf, relativeWhen, severityCountLabel } from '../ui-helpers'

const live = (extra: Partial<SiteAuditView>) =>
  ({ status: 'running', phase: 'crawl', host: 'fernhillstudio.example', pages_crawled: 0, pages_queued: 0, ...extra }) as SiteAuditView

const line = (a: SiteAuditView) => {
  const { verb, clauses } = auditRailLine(a)
  return [verb, ...clauses].join(' · ')
}

describe('the run rail’s line', () => {
  it('says the phase, the numbers that move, and the site', () => {
    expect(line(live({ status: 'queued', phase: 'discovery' }))).toBe('Starting · fernhillstudio.example')
    expect(line(live({ phase: 'discovery' }))).toBe('Reading the sitemap · fernhillstudio.example')
    expect(line(live({ pages_crawled: 42, pages_queued: 100 }))).toBe('Checking pages · 42 of about 100 · fernhillstudio.example')
    expect(line(live({ pages_crawled: 100, pages_queued: 100 }))).toBe('Checking pages · 100 · fernhillstudio.example')
    expect(line(live({ pages_crawled: 0, pages_queued: 100 }))).toBe('Checking pages · fernhillstudio.example')
    expect(line(live({ phase: 'analysis', pages_crawled: 1204, pages_queued: 1204 }))).toBe('Comparing pages · 1,204 checked')
    expect(line(live({ phase: 'analysis' }))).toBe('Comparing pages')
  })
})

describe('counts', () => {
  it('are plural-aware', () => {
    expect(severityCountLabel('critical', 1)).toBe('1 critical')
    expect(severityCountLabel('warning', 1)).toBe('1 warning')
    expect(severityCountLabel('warning', 12)).toBe('12 warnings')
    expect(severityCountLabel('info', 5)).toBe('5 info')
    expect(findingsOnPages(4, 3)).toBe('4 on 3 pages')
    expect(findingsOnPages(1, 1)).toBe('1 page')
    expect(findingsOnPages(5, 5)).toBe('5 pages')
    expect(findingsOnPages(2, 1)).toBe('2 on 1 page')
  })

  it('say when, relative to now', () => {
    const now = new Date('2026-11-12T12:00:00Z')
    expect(relativeWhen('2026-11-12T11:59:40Z', now)).toBe('just now')
    expect(relativeWhen('2026-11-12T11:59:00Z', now)).toBe('1 minute ago')
    expect(relativeWhen('2026-11-12T09:00:00Z', now)).toBe('3 hours ago')
    expect(relativeWhen('2026-11-11T11:00:00Z', now)).toBe('yesterday')
    expect(relativeWhen('2026-11-09T12:00:00Z', now)).toBe('3 days ago')
    expect(relativeWhen(null, now)).toBe('')
  })
})

describe('a finding’s detail', () => {
  const d = (type: string, details: Record<string, unknown>) => issueDetail({ type, details })
  it('says what the check measured, in a few words', () => {
    expect(d('broken-internal-link', { targetUrl: 'https://fernhillstudio.example/old-shop', targetStatus: 404 })).toBe('links to /old-shop (404)')
    expect(d('title-too-long', { length: 74, max: 60 })).toBe('74 characters')
    expect(d('meta-description-too-short', { length: 1 })).toBe('1 character')
    expect(d('duplicate-title', { groupSize: 3, otherUrls: [] })).toBe('same as 2 other pages')
    expect(d('duplicate-content', { groupSize: 2 })).toBe('same as 1 other page')
    expect(d('server-error', { statusCode: 503 })).toBe('answered 503')
    expect(d('slow-response', { responseTimeMs: 2340 })).toBe('2.3 s to answer')
    expect(d('redirect-chain', { hops: ['a', 'b', 'https://fernhillstudio.example/c'], finalUrl: 'https://fernhillstudio.example/c' })).toBe('2 redirects to /c')
    expect(d('images-missing-alt', { imagesMissingAlt: 3, imagesTotal: 8 })).toBe('3 of 8 images')
    expect(d('deep-page', { crawlDepth: 6 })).toBe('6 clicks from the home page')
    expect(d('crawl-page-limit', { pagesCrawled: 100, pagesFound: 340 })).toBe('100 of 340 pages checked')
  })

  it('says nothing when there is nothing to add', () => {
    expect(d('missing-title', {})).toBeNull()
    expect(d('broken-internal-link', {})).toBeNull()
    expect(d('duplicate-title', { groupSize: 1 })).toBeNull()
  })
})

describe('a crawled page', () => {
  it('shows its answer: the code, or what stood in the way', () => {
    expect(pageStatus({ status_code: 200, fetch_class: 'ok' })).toEqual({ text: '200', tone: 'ok' })
    expect(pageStatus({ status_code: 301, fetch_class: 'ok' })).toEqual({ text: '301', tone: 'redirect' })
    expect(pageStatus({ status_code: 404, fetch_class: 'ok' })).toEqual({ text: '404', tone: 'error' })
    expect(pageStatus({ status_code: 403, fetch_class: 'blocked' })).toEqual({ text: 'Blocked', tone: 'error' })
    expect(pageStatus({ status_code: 429, fetch_class: 'rate_limited' })).toEqual({ text: 'Rate limited', tone: 'error' })
    expect(pageStatus({ status_code: null, fetch_class: 'error' })).toEqual({ text: 'Failed', tone: 'error' })
  })

  it('is shown by its path', () => {
    expect(pathOf('https://fernhillstudio.example/')).toBe('/')
    expect(pathOf('https://fernhillstudio.example/shop?tag=linen')).toBe('/shop?tag=linen')
    expect(pathOf('not a url')).toBe('not a url')
  })
})

describe('the start dialog’s page presets', () => {
  it('are held to the route’s bounds, the default among them', () => {
    expect(pagePresets({ min_pages: 10, default_pages: 100, max_pages: 1000 })).toEqual([50, 100, 250, 500, 1000])
    expect(pagePresets({ min_pages: 10, default_pages: 100, max_pages: 300 })).toEqual([50, 100, 250])
    expect(pagePresets({ min_pages: 10, default_pages: 150, max_pages: 300 })).toEqual([50, 100, 150, 250])
  })
})
