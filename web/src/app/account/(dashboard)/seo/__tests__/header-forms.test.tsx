// @vitest-environment jsdom
/**
 * The SEO pages' lookups in a card's header (Liam, 11-23: "all the SEO
 * pages"): Competitors' and Backlinks' start controls are a 24px form in
 * the card header's right slot (a field named for the old label, the
 * market's choices, "Look up"), nothing of it in the page; outside a card
 * the page's own form, label and all, as before. Either way a lookup asks
 * the same route with the same body, and a correctable address is said in
 * the page, at its top.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import { stubAppFetch } from '@/test/app-fetch-stub'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

const { CompetitorsPage } = await import('../competitors/competitors-view')
const { BacklinksPage } = await import('../backlinks/backlinks-view')
const { MARKET_STORAGE_KEY } = await import('../competitors/helpers')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWN = 'fernhillstudio.example'
const SPEND: SeoSpendView = { spent_dollars: 3.4, cap_dollars: 20, resets_at: '2026-12-01T00:00:00Z', configured: true, can_buy: true, refusal: null }
const MARKETS = {
  default_location_code: 2840,
  locations: [
    { code: 2840, label: 'United States', short_label: 'US', default_language: 'en', languages: [{ code: 'en', label: 'English' }], keyword_data: 'labs', domain_data: true },
    {
      code: 2756,
      label: 'Switzerland',
      short_label: 'CH',
      default_language: 'de',
      languages: [
        { code: 'de', label: 'German' },
        { code: 'fr', label: 'French' },
      ],
      keyword_data: 'labs',
      domain_data: true,
    },
  ],
  serp_languages: [{ code: 'en', label: 'English' }],
}

let container: HTMLDivElement
let right: HTMLDivElement
let trail: HTMLDivElement
let root: Root
let posts: Array<{ path: string; body: unknown }>

beforeEach(() => {
  window.localStorage.clear()
  posts = []
  const fetchMock = stubAppFetch({
    '/api/account/seo/spend': SPEND,
    '/api/account/seo/locations': MARKETS,
    '/api/account/seo/audits': { audits: [], default_url: `https://${OWN}`, limits: { min_pages: 10, default_pages: 100, max_pages: 1000 } },
    '/api/account/seo/lookups*': { lookups: [] },
  })
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return get(input, init)
    posts.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    // Every lookup here is refused as a correctable address: what was asked is what counts.
    return new Response(JSON.stringify({ error: 'That address could not be read.', code: 'VALIDATION_ERROR' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  })
  container = document.createElement('div')
  right = document.createElement('div')
  trail = document.createElement('div')
  document.body.append(right, trail, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  trail.remove()
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}
const inCard = (node: React.ReactNode) => <CardHeaderSlotsProvider value={{ left: null, right, trail, setBack: () => {} }}>{node}</CardHeaderSlotsProvider>
const type = async (input: HTMLInputElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const pressEnter = async (input: HTMLInputElement) => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await settle()
}
const submit = async (form: HTMLFormElement) => {
  await act(async () => form.requestSubmit())
  await settle()
}

describe('Competitors: the lookup', () => {
  it('in a card: a 24px form in the header’s right slot, before the spend line; none of it in the page', async () => {
    await act(async () => root.render(inCard(<CompetitorsPage onTab={() => {}} />)))
    await settle()
    const form = right.querySelector<HTMLFormElement>('[data-seo-start-control="header"]')!
    expect(form.tagName).toBe('FORM')
    const site = form.querySelector<HTMLInputElement>('[data-seo-site]')!
    expect(site.value).toBe(OWN)
    expect(site.placeholder).toBe('example.com')
    expect(site.getAttribute('aria-label')).toBe('Website address')
    expect(site.className).toContain('h-6')
    const country = form.querySelector<HTMLElement>('[data-seo-country]')!
    expect(country.className).toContain('h-6')
    // Short of room, the country gives way (its value still applies), never the field or the press.
    expect(country.className).toContain('hidden')
    expect(country.className).toContain('@[36rem]:inline-flex')
    const press = form.querySelector<HTMLButtonElement>('[data-seo-look-up]')!
    expect(press.type).toBe('submit')
    expect(press.textContent).toBe('Look up')
    expect(press.className).toContain('h-6')
    // The press stands before the spend line, in one row.
    const spend = right.querySelector('[data-seo-spend]')!
    expect(form.compareDocumentPosition(spend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('[data-seo-start-control], [data-seo-site], label')).toBeNull()
    expect(container.querySelector('[data-seo-first-run]')).not.toBeNull()
  })

  it('in a card, the language choice gives way first where a country has several', async () => {
    window.localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify({ location_code: 2756, language_code: 'fr' }))
    await act(async () => root.render(inCard(<CompetitorsPage onTab={() => {}} />)))
    await settle()
    const language = right.querySelector<HTMLElement>('[data-seo-language]')!
    expect(language.className).toContain('h-6')
    expect(language.className).toContain('hidden')
    expect(language.className).toContain('@[44rem]:inline-flex')
  })

  it('outside a card: the page’s own labelled form, nothing in a header', async () => {
    await act(async () => root.render(<CompetitorsPage onTab={() => {}} />))
    await settle()
    const control = container.querySelector('[data-seo-start-control]')!
    expect(control.getAttribute('data-seo-start-control')).toBe('')
    expect(control.querySelector('label')!.textContent).toBe('Website address')
    expect(control.querySelector('[data-seo-look-up]')!.textContent).toBe('Look up site')
    expect(right.childElementCount).toBe(0)
  })

  it('asks the same lookup from the header as from the page, and says a correctable site at the page’s top', async () => {
    await act(async () => root.render(<CompetitorsPage onTab={() => {}} />))
    await settle()
    await type(container.querySelector<HTMLInputElement>('[data-seo-site]')!, 'oakandloom.example')
    await pressEnter(container.querySelector<HTMLInputElement>('[data-seo-site]')!)
    const outside = posts.splice(0)
    expect(outside).toHaveLength(1)
    expect(outside[0].path).toBe('/api/account/seo/domain/overview')

    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(inCard(<CompetitorsPage onTab={() => {}} />)))
    await settle()
    const site = right.querySelector<HTMLInputElement>('[data-seo-site]')!
    await type(site, 'oakandloom.example')
    await submit(right.querySelector<HTMLFormElement>('[data-seo-start-control="header"]')!)
    expect(posts).toEqual(outside)
    expect(container.querySelector('[data-seo-site-error]')!.textContent).toBe('That address could not be read.')
    expect(right.querySelector('[data-seo-site-error]')).toBeNull()
    expect(right.querySelector('[data-seo-site]')!.getAttribute('aria-invalid')).toBe('true')
    // Typing again clears it.
    await type(right.querySelector<HTMLInputElement>('[data-seo-site]')!, 'oakandloom.example/')
    expect(container.querySelector('[data-seo-site-error]')).toBeNull()
  })

  it('an empty field: the header’s press is off and a submit asks nothing', async () => {
    await act(async () => root.render(inCard(<CompetitorsPage onTab={() => {}} />)))
    await settle()
    await type(right.querySelector<HTMLInputElement>('[data-seo-site]')!, '  ')
    expect(right.querySelector<HTMLButtonElement>('[data-seo-look-up]')!.disabled).toBe(true)
    await submit(right.querySelector<HTMLFormElement>('[data-seo-start-control="header"]')!)
    expect(posts).toEqual([])
  })
})

describe('Backlinks: the lookup', () => {
  it('in a card: the field and "Look up" in the header’s right slot; none of it in the page', async () => {
    await act(async () => root.render(inCard(<BacklinksPage onTab={() => {}} />)))
    await settle()
    const form = right.querySelector<HTMLFormElement>('[data-seo-start-control="header"]')!
    expect(form.tagName).toBe('FORM')
    const site = form.querySelector<HTMLInputElement>('[data-seo-site]')!
    expect(site.value).toBe(OWN)
    expect(site.getAttribute('aria-label')).toBe('Website or page address')
    expect(site.className).toContain('h-6')
    expect(form.querySelector('[data-seo-look-up]')!.textContent).toBe('Look up')
    expect(container.querySelector('[data-seo-start-control], [data-seo-site], label')).toBeNull()
  })

  it('in a card, an address naming a page shows how far it reaches at the page’s top, and the header asks with that reach', async () => {
    await act(async () => root.render(<BacklinksPage onTab={() => {}} />))
    await settle()
    await type(container.querySelector<HTMLInputElement>('[data-seo-site]')!, `${OWN}/blog`)
    await pressEnter(container.querySelector<HTMLInputElement>('[data-seo-site]')!)
    const outside = posts.splice(0)
    expect(outside).toEqual([{ path: '/api/account/seo/backlinks/overview', body: { target: `${OWN}/blog`, scope: 'exact_url' } }])

    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(inCard(<BacklinksPage onTab={() => {}} />)))
    await settle()
    await type(right.querySelector<HTMLInputElement>('[data-seo-site]')!, `${OWN}/blog`)
    expect(container.querySelector('[data-seo-page-scope]')).not.toBeNull()
    expect(right.querySelector('[data-seo-page-scope]')).toBeNull()
    await submit(right.querySelector<HTMLFormElement>('[data-seo-start-control="header"]')!)
    expect(posts).toEqual(outside)
    expect(container.querySelector('[data-seo-site-error]')!.textContent).toBe('That address could not be read.')
  })

  it('outside a card: the page’s own labelled form, as before', async () => {
    await act(async () => root.render(<BacklinksPage onTab={() => {}} />))
    await settle()
    const control = container.querySelector('[data-seo-start-control]')!
    expect(control.querySelector('label')!.textContent).toBe('Website or page address')
    expect(control.querySelector('[data-seo-look-up]')!.textContent).toBe('Look up links')
    expect(right.childElementCount).toBe(0)
  })
})
