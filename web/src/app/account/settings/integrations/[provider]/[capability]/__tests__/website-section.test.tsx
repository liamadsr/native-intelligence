// @vitest-environment jsdom
/**
 * "Website" on the GitHub connector page (roadmap track E): pick which repo
 * is the business's website from the person's own repos, see what was found,
 * and connect its form. Rendered standalone with createRoot/act (no
 * @testing-library in this repo); fetch is stubbed per route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { WebsiteView } from '@/lib/website/view'
import { WebsiteSection } from '../website-section'

vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let calls: Array<{ url: string; method: string; body: unknown }>
let routes: Record<string, (body: unknown) => { status?: number; json: unknown }>

const SITE_VIEW: WebsiteView = {
  githubConnected: true,
  canConnect: true,
  site: {
    repo: 'jane/site',
    siteUrl: 'https://janescleaning.com',
    found: "It's built with Next.js and hosted on Vercel. I found your quote form (app/quote/page.tsx): today it sends each one to Formspree, which emails you.",
    wired: false,
    hasForm: true,
    hostAddress: false,
    connectedByYou: true,
    canRepoint: true,
  },
  change: null,
}

const NO_SITE = { githubConnected: true, canConnect: true, site: null, change: null }

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

function text(): string {
  return container.textContent ?? ''
}

function button(label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  expect(btn, `button "${label}"`).toBeTruthy()
  return btn as HTMLButtonElement
}

async function click(el: HTMLElement) {
  await act(async () => el.click())
  await flush()
}

async function render() {
  await act(async () => root.render(h(WebsiteSection)))
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  routes = {}
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, method, body })
    const route = routes[`${method} ${url}`]
    const out = route ? route(body) : { status: 404, json: { error: 'unrouted' } }
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200 })
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('WebsiteSection', () => {
  it('with no site, lists their repos likeliest first, and picking one connects it', async () => {
    routes['GET /api/account/website'] = () => ({ json: NO_SITE })
    routes['GET /api/account/website/repos'] = () => ({ json: { repos: [{ fullName: 'jane/site', private: true, homepage: 'https://janescleaning.com', likely: true }, { fullName: 'jane/api', private: false, homepage: null, likely: true }] } })
    routes['POST /api/account/website'] = () => ({ json: SITE_VIEW })
    await render()
    expect(text()).toContain('Which repository is your website?')
    expect(text()).toContain('Nothing on your site changes without your yes.')
    const names = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(names.indexOf('jane/site')).toBeLessThan(names.indexOf('jane/api'))
    await click(button('jane/site'))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/account/website', body: { repo: 'jane/site' } })
    expect(text()).toContain('I found your quote form (app/quote/page.tsx)')
    expect(text()).toContain('Live at')
    expect(text()).toContain('janescleaning.com')
  })

  it('searches the list', async () => {
    routes['GET /api/account/website'] = () => ({ json: NO_SITE })
    routes['GET /api/account/website/repos'] = () => ({ json: { repos: [{ fullName: 'jane/site', private: true, homepage: null, likely: true }, { fullName: 'jane/api', private: false, homepage: null, likely: true }] } })
    await render()
    const input = container.querySelector('input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'api')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(text()).toContain('jane/api')
    expect(text()).not.toContain('jane/site')
  })

  it("says why a repo couldn't be connected", async () => {
    routes['GET /api/account/website'] = () => ({ json: NO_SITE })
    routes['GET /api/account/website/repos'] = () => ({ json: { repos: [{ fullName: 'jane/site', private: true, homepage: null, likely: true }] } })
    routes['POST /api/account/website'] = () => ({ status: 403, json: { error: 'Your GitHub account can read that repository but can’t change it.' } })
    await render()
    await click(button('jane/site'))
    expect(text()).toContain('can read that repository but can’t change it')
  })

  it('connects the form, then shows the change in flight', async () => {
    let wired = false
    routes['GET /api/account/website'] = () => ({ json: wired ? { ...SITE_VIEW, change: { kind: 'wire_form', state: 'preparing', open: true, prUrl: null, previewUrl: null, status: 'Making the change. You’ll get a text when it’s ready to look at.' } } : SITE_VIEW })
    routes['POST /api/account/website/wire'] = () => {
      wired = true
      return { json: { started: true } }
    }
    await render()
    expect(text()).toContain('It goes live only when you say yes.')
    await click(button('Connect the form'))
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/account/website/wire')).toBe(true)
    expect(text()).toContain('Making the change.')
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Connect the form')).toBe(false)
  })

  it('a wired site says so, and a change waiting for a yes links its preview', async () => {
    routes['GET /api/account/website'] = () => ({ json: { ...SITE_VIEW, site: { ...SITE_VIEW.site!, wired: true } } })
    await render()
    expect(text()).toContain('Your form sends customers’ requests to you.')
    await act(async () => root.unmount())
    root = createRoot(container)
    routes['GET /api/account/website'] = () => ({ json: { ...SITE_VIEW, change: { kind: 'edit', state: 'awaiting_yes', open: true, prUrl: 'https://github.com/jane/site/pull/8', previewUrl: 'https://site-git.vercel.app', status: 'Ready for your yes.' } } })
    await render()
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toContain('https://site-git.vercel.app')
    expect(links).toContain('https://github.com/jane/site/pull/8')
  })

  it("on the host's own address, nudges for their domain, and saving one reconnects with it", async () => {
    routes['GET /api/account/website'] = () => ({ json: { ...SITE_VIEW, site: { ...SITE_VIEW.site!, siteUrl: 'https://janes-cleaning.vercel.app', hostAddress: true } } })
    routes['POST /api/account/website'] = () => ({ json: SITE_VIEW })
    await render()
    expect(text()).toContain('This is your host’s own address.')
    await click(container.querySelector('button[aria-label="Edit the address"]') as HTMLButtonElement)
    const input = container.querySelector('input[aria-label="Website address"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'janescleaning.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Save'))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ body: { repo: 'jane/site', site_url: 'janescleaning.com' } })
  })

  it("a member who isn't an owner or admin sees the site but can't connect or change it", async () => {
    routes['GET /api/account/website'] = () => ({ json: { ...NO_SITE, canConnect: false } })
    await render()
    expect(text()).toContain('An owner or admin of your workspace picks which repository is its website.')
    expect(calls.some((c) => c.url === '/api/account/website/repos')).toBe(false)
    await act(async () => root.unmount())
    root = createRoot(container)
    routes['GET /api/account/website'] = () => ({ json: { ...SITE_VIEW, canConnect: false, site: { ...SITE_VIEW.site!, connectedByYou: false, canRepoint: false } } })
    await render()
    expect(text()).toContain('Whoever connected the website connects its form')
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'))
    expect(labels).not.toContain('Connect the form')
    expect(labels).not.toContain('Change')
    expect(labels).not.toContain('Edit the address')
  })

  it('a change in flight keeps the repo and the address where they are', async () => {
    routes['GET /api/account/website'] = () => ({ json: { ...SITE_VIEW, change: { kind: 'wire_form', state: 'preparing', open: true, prUrl: null, previewUrl: null, status: 'Making the change.' } } })
    await render()
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'))
    expect(labels).not.toContain('Change')
    expect(labels).not.toContain('Edit the address')
  })

  it('picking the repo it already is does nothing; a repo typed in full can be picked past the list', async () => {
    routes['GET /api/account/website'] = () => ({ json: SITE_VIEW })
    routes['GET /api/account/website/repos'] = () => ({ json: { repos: [{ fullName: 'jane/site', private: true, homepage: null, likely: true }] } })
    routes['POST /api/account/website'] = () => ({ json: { ...SITE_VIEW, site: { ...SITE_VIEW.site!, repo: 'janes-org/website' } } })
    await render()
    await click(button('Change'))
    await click(button('jane/site'))
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(text()).not.toContain('Pick another repository')
    await click(button('Change'))
    const input = container.querySelector('input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'janes-org/website')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Use janes-org/website'))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ body: { repo: 'janes-org/website' } })
  })

  it('Change opens the picker under the site', async () => {
    routes['GET /api/account/website'] = () => ({ json: SITE_VIEW })
    routes['GET /api/account/website/repos'] = () => ({ json: { repos: [{ fullName: 'jane/new-site', private: false, homepage: null, likely: true }] } })
    await render()
    await click(button('Change'))
    expect(text()).toContain('Pick another repository')
    expect(text()).toContain('jane/new-site')
    await click(button('Cancel'))
    expect(text()).not.toContain('Pick another repository')
  })
})
