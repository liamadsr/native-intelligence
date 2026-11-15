/**
 * The /replace-apps calculator: the sum is right, it is shown as it comes
 * out (a stack cheaper than we are says so), and the list keeps its rules.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/replace-apps',
}))
vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }))

import { DEFAULT_SELECTION, NI_PRICE_PER_SEAT, REPLACED_APPS, REPLACED_CATEGORIES, stackCost } from '../replace-apps'
import { SITE_NAV } from '../site-nav'
import { ReplaceAppsView } from '@/components/site/replace-apps-view'

describe('stackCost', () => {
  it('adds the selected apps per seat and over a year, to the cent', () => {
    const cost = stackCost(new Set(['Slack', 'Jira', 'Confluence']), 10)
    expect(cost.appsPerSeat).toBe(21.51)
    expect(cost.appsPerYear).toBe(2581.2)
    expect(cost.niPerYear).toBe(NI_PRICE_PER_SEAT * 10 * 12)
  })

  it('reports a stack cheaper than we are as a negative saving, not a zero', () => {
    const cost = stackCost(new Set(['Slack']), 5)
    expect(cost.savingPerYear).toBeLessThan(0)
    expect(cost.savingPerYear).toBe(7.25 * 5 * 12 - NI_PRICE_PER_SEAT * 5 * 12)
  })

  it('counts nothing for no apps or a name it does not know', () => {
    expect(stackCost(new Set(), 5).appsPerYear).toBe(0)
    expect(stackCost(new Set(['Nope']), 5).appsPerSeat).toBe(0)
  })
})

describe('the list of apps', () => {
  it('has one entry per app, in a known category, with a price and its vendor’s page', () => {
    const names = REPLACED_APPS.map((app) => app.name)
    expect(new Set(names).size).toBe(names.length)
    for (const app of REPLACED_APPS) {
      expect(REPLACED_CATEGORIES).toContain(app.category)
      expect(app.price).toBeGreaterThan(0)
      expect(app.source).toMatch(/^https:\/\//)
    }
    for (const category of REPLACED_CATEGORIES) expect(REPLACED_APPS.some((app) => app.category === category), category).toBe(true)
  })

  it('leaves out what the workspace does not replace', () => {
    const names = REPLACED_APPS.map((app) => app.name).join(' ')
    expect(names).not.toMatch(/Google Workspace|Microsoft 365|Zoom|Loom|Dropbox|Semrush|Ahrefs|Claude|ChatGPT/)
  })

  it('opens on apps that exist, one per category at most', () => {
    const picked = DEFAULT_SELECTION.map((name) => REPLACED_APPS.find((app) => app.name === name))
    for (const app of picked) expect(app).toBeDefined()
    const categories = picked.map((app) => app!.category)
    expect(new Set(categories).size).toBe(categories.length)
  })
})

describe('/replace-apps', () => {
  it('renders with one h1, every app, our price and the day the prices were read', () => {
    const markup = renderToStaticMarkup(createElement(ReplaceAppsView))
    expect(markup.match(/<h1[\s>]/g) ?? []).toHaveLength(1)
    for (const app of REPLACED_APPS) expect(markup).toContain(app.name)
    expect(markup).toContain('$99')
    expect(markup).toContain('14 November 2026')
    expect(markup).toContain('Estimated savings')
    expect(markup).toContain('Selected apps / seat')
    expect(markup).toContain('aria-label="Add a seat"')
  })

  it('is in the side panel', () => {
    expect(SITE_NAV.flatMap((group) => group.items.map((item) => item.href))).toContain('/replace-apps')
  })
})
