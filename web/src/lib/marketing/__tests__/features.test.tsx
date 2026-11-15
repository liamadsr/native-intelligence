/**
 * The feature deep dives (/features/<slug>) and the side panel that lists
 * them.
 *
 * What carries weight:
 *   1. The side panel and the content agree: every feature link has a page,
 *      every page has a link, in the same order.
 *   2. Every page keeps the shape the template and search results rely on
 *      (lengths, unique section ids, related features that exist).
 *   3. The copy keeps the house rules: no em dashes, no exclamation marks, no
 *      claim of what is not here (Windows capture, certifications).
 *   4. A page renders on the server with exactly one h1 and its sections, and
 *      shows a player only once a video is set.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/features/mail',
}))
vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }))

import { FEATURES, getFeature } from '../features'
import { FEATURE_NAV, SITE_NAV } from '../site-nav'
import { filterNav } from '@/components/site/site-shell'
import { FeaturePageView } from '@/components/site/feature-page-view'
import { FeatureVideo } from '@/components/site/feature-video'

const everyString = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(everyString)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(everyString)
        : []

describe('the side panel and the feature pages', () => {
  it('list the same features in the same order', () => {
    expect(FEATURE_NAV.map((item) => item.href)).toEqual(FEATURES.map((feature) => `/features/${feature.slug}`))
    for (const [i, feature] of FEATURES.entries()) expect(FEATURE_NAV[i].name).toBe(feature.name)
  })

  it('has no two links to the same place', () => {
    const hrefs = SITE_NAV.flatMap((group) => group.items.map((item) => item.href))
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('narrows to the pages whose name matches the search', () => {
    expect(filterNav(SITE_NAV, '')).toBe(SITE_NAV)
    const found = filterNav(SITE_NAV, ' mEet ').flatMap((group) => group.items.map((item) => item.name))
    expect(found).toEqual(['Meetings'])
    expect(filterNav(SITE_NAV, 'zzz')).toEqual([])
  })
})

describe.each(FEATURES.map((feature) => [feature.slug, feature] as const))('/features/%s', (_slug, feature) => {
  it('keeps the shape the template relies on', () => {
    expect(feature.slug).toMatch(/^[a-z]+(-[a-z]+)*$/)
    expect(feature.metaTitle.length).toBeLessThanOrEqual(60)
    expect(feature.metaDescription.length).toBeLessThanOrEqual(160)
    expect(feature.intro.length).toBe(2)
    expect(feature.sections.length).toBeGreaterThanOrEqual(5)
    expect(feature.sections.length).toBeLessThanOrEqual(8)
    expect(feature.faq.length).toBeGreaterThanOrEqual(3)
    const ids = feature.sections.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(ids).not.toContain('faq')
  })

  it('names related features that exist, and not itself', () => {
    expect(feature.related.length).toBeGreaterThanOrEqual(2)
    for (const slug of feature.related) {
      expect(slug).not.toBe(feature.slug)
      expect(getFeature(slug), slug).toBeDefined()
    }
  })

  it('uses each demo at most once', () => {
    const demos = [feature.demo, ...feature.sections.map((section) => section.demo)].filter(Boolean)
    expect(new Set(demos).size).toBe(demos.length)
  })

  it('keeps the house rules for copy', () => {
    for (const text of everyString(feature)) {
      expect(text, text).not.toMatch(/[—–!]/)
      expect(text, text).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|\bGDPR\b/i)
      expect(text, text).not.toMatch(/revolution|seamless|supercharg|effortless|game.chang/i)
    }
  })

  it('renders with one h1 and every section', () => {
    const markup = renderToStaticMarkup(createElement(FeaturePageView, { slug: feature.slug }))
    expect(markup.match(/<h1[\s>]/g) ?? []).toHaveLength(1)
    for (const section of feature.sections) expect(markup).toContain(`id="${section.id}"`)
    expect(markup).toContain('id="faq"')
    // No recorded walkthrough yet: no player, and no empty frame for one.
    if (!feature.video) expect(markup).not.toContain('Watch the ')
  })
})

describe('the walkthrough player', () => {
  it('shows the still and its length, and fetches no video before play', () => {
    const markup = renderToStaticMarkup(
      createElement(FeatureVideo, { name: 'Mail', video: { src: '/videos/features/mail.mp4', poster: '/videos/features/mail.jpg', length: '1:42' } })
    )
    expect(markup).toContain('Watch the Mail walkthrough')
    expect(markup).toContain('1:42')
    expect(markup).toContain('/videos/features/mail.jpg')
    expect(markup).not.toContain('<video')
  })
})
