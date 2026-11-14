/**
 * The homepage at `/`: the whole-workspace pitch (../workspace-page.tsx)
 * behind the signed-in redirect (../page.tsx).
 *
 * What carries weight:
 *   1. Signed-in visitors go to /account before any landing HTML renders.
 *   2. The page renders on the server (what crawlers get) with exactly one h1,
 *      every section the rail lists, and the navbar's Features links landing
 *      on real section ids.
 *   3. Its signup CTAs carry no edition, so a homepage signup gets the
 *      default edition (the whole app).
 *   4. Title, description and structured data say the workspace position,
 *      and nothing on the page pitches the retired sales positioning.
 *
 * Rendered with renderToStaticMarkup, as the server does: the demos are
 * client-only chunks, so the server emits their placeholders.
 */
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUser = vi.hoisted(() => vi.fn())
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`)
  })
)

vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
}))
vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}))
// The roadmap slot reads GitHub on the server; its own test covers it.
vi.mock('@/components/roadmap/home-roadmap', () => ({
  HomeRoadmapSlot: () => createElement('section', { id: 'roadmap-slot' }),
}))

import Home, { metadata } from '../page'
import WorkspacePage, { FAQ_ITEMS, sections } from '../workspace-page'
import { HOME_DESCRIPTION, HOME_TITLE } from '../home-meta'
import { AREAS } from '@/components/landing/workspace-grid'
import { FEATURES } from '@/components/navbar'
import { organizationSchema, softwareApplicationSchema, websiteSchema } from '@/components/structured-data'

const html = () => renderToStaticMarkup(createElement(WorkspacePage, { roadmap: createElement('section', { id: 'roadmap-slot' }) }))

beforeEach(() => {
  getUser.mockReset()
  redirect.mockClear()
})

describe('/ (page.tsx)', () => {
  it('sends a signed-in visitor to /account before rendering anything', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u-1' } } })
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT:/account')
    expect(redirect).toHaveBeenCalledWith('/account')
  })

  it('renders the workspace page with its structured data for a signed-out visitor', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const tree = await Home()
    expect(redirect).not.toHaveBeenCalled()
    const markup = renderToStaticMarkup(tree as ReactElement)
    expect(markup).toContain('id="roadmap-slot"')
    const scripts = [...markup.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/g)]
    expect(scripts).toHaveLength(3)
    const types = scripts.map((m) => JSON.parse(m[1])['@type'])
    expect(types).toEqual(['Organization', 'WebSite', 'SoftwareApplication'])
  })

  it('carries the workspace title and description', () => {
    expect(metadata.title).toEqual({ absolute: HOME_TITLE })
    expect(metadata.description).toBe(HOME_DESCRIPTION)
    expect(HOME_TITLE).toMatch(/workspace/i)
    expect(HOME_DESCRIPTION).toMatch(/workspace/i)
    // Inside what search results show without cutting.
    expect(HOME_DESCRIPTION.length).toBeLessThanOrEqual(160)
  })
})

describe('the workspace page', () => {
  it('has exactly one h1, the headline', () => {
    const h1s = html().match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? []
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toContain('The workspace that remembers everything and does the busywork')
  })

  it('renders every section the rail lists, in order', () => {
    const markup = html()
    const positions = sections.map(({ id }) => markup.indexOf(`id="${id}"`))
    for (const [i, pos] of positions.entries()) expect(pos, sections[i].id).toBeGreaterThan(-1)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('places the roadmap after the FAQ and before the closing CTA', () => {
    const markup = html()
    const faq = markup.indexOf('id="faq"')
    const roadmap = markup.indexOf('id="roadmap-slot"')
    const cta = markup.indexOf('id="cta"')
    expect(faq).toBeLessThan(roadmap)
    expect(roadmap).toBeLessThan(cta)
  })

  it('points every navbar Features link at a section on this page', () => {
    // The dropdown only renders when opened, so its list is read directly.
    const markup = html()
    expect(FEATURES.length).toBeGreaterThanOrEqual(5)
    for (const { href } of FEATURES) {
      expect(href).toMatch(/^\/#[a-z-]+$/)
      expect(markup, href).toContain(`id="${href.slice(2)}"`)
    }
  })

  it('sends signups with no edition, so they get the whole app', () => {
    const hrefs = [...html().matchAll(/href="(\/login\?mode=signup[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(href).toBe('/login?mode=signup')
  })

  it('shows every workspace area and every FAQ question', () => {
    const markup = html()
    for (const area of AREAS) expect(markup).toContain(area.name)
    for (const item of FAQ_ITEMS) expect(markup).toContain(item.q.replace(/'/g, '&#x27;'))
  })

  it('no longer pitches the retired sales positioning', () => {
    const text = html().replace(/<[^>]+>/g, ' ')
    expect(text).not.toMatch(/sales platform|best rep|every rep|\breps?\b|hello and closed|Gong/i)
  })
})

describe('structured data', () => {
  it('describes the workspace, not a sales platform', () => {
    for (const schema of [organizationSchema, softwareApplicationSchema]) {
      expect(schema.description).toMatch(/workspace/i)
      expect(schema.description).not.toMatch(/sales/i)
    }
    expect(websiteSchema['@type']).toBe('WebSite')
  })

  it('offers the free trial the pricing page sells', () => {
    expect(softwareApplicationSchema.offers).toMatchObject({ price: '0', description: '7-day free trial' })
  })

  it('is plain JSON-LD that survives a round trip', () => {
    for (const schema of [organizationSchema, websiteSchema, softwareApplicationSchema]) {
      const parsed = JSON.parse(JSON.stringify(schema))
      expect(parsed['@context']).toBe('https://schema.org')
      expect(parsed.name).toBe('Native Intelligence')
    }
  })
})
