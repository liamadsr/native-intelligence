/**
 * The address customers really use (roadmap track E): from a host's own
 * address to the business's domain the site names as canonical, only when it
 * is the same site; a domain of the business's own is never swapped.
 */
import { describe, expect, it } from 'vitest'
import { canonicalOf, liveAddress, samePage } from '../address'

/** A Next.js page: the framework's own chunks every site on its version shares, and this build's page chunk. */
const SITE = (title: string, build = '9f8e7d6c5b') =>
  `<html><head><title>${title}</title><link rel="canonical" href="https://janescleaning.com"/><script src="/_next/static/chunks/polyfills-42372ed130431b0a.js" noModule></script><script src="/_next/static/chunks/main-app-1a2b3c4d5e.js" async></script><script src="/_next/static/chunks/app/page-${build}1234.js" async></script></head><body></body></html>`

/** A fake web: each URL answers with a page, a redirect, or an error. */
function web(pages: Record<string, { status?: number; html?: string; location?: string }>) {
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)
    const page = pages[url]
    if (!page) return new Response('no', { status: 404 })
    if (page.location) return new Response(null, { status: 308, headers: { location: page.location } })
    return new Response(page.html ?? '', { status: page.status ?? 200 })
  }) as typeof fetch
  return { fetchImpl, asked }
}

describe('canonicalOf', () => {
  it('reads the canonical link, else og:url, in any attribute order', () => {
    expect(canonicalOf('<link href="https://janescleaning.com/" rel="canonical">', 'https://x.vercel.app/')).toBe('https://janescleaning.com/')
    expect(canonicalOf('<meta content="https://janescleaning.com" property="og:url">', 'https://x.vercel.app/')).toBe('https://janescleaning.com/')
    expect(canonicalOf('<link rel="canonical" href="/about">', 'https://x.vercel.app/')).toBe('https://x.vercel.app/about')
  })

  it("never a template's placeholder, a plain http address or a local one", () => {
    expect(canonicalOf('<link rel="canonical" href="https://example.com">', 'https://x.vercel.app/')).toBeNull()
    expect(canonicalOf('<link rel="canonical" href="https://www.yourdomain.com">', 'https://x.vercel.app/')).toBeNull()
    expect(canonicalOf('<link rel="canonical" href="https://website.com">', 'https://x.vercel.app/')).toBeNull()
    expect(canonicalOf('<link rel="canonical" href="http://janescleaning.com">', 'https://x.vercel.app/')).toBeNull()
    expect(canonicalOf('<link rel="canonical" href="https://localhost:3000">', 'https://x.vercel.app/')).toBeNull()
    expect(canonicalOf('<p>no canonical</p>', 'https://x.vercel.app/')).toBeNull()
  })
})

describe('samePage', () => {
  it('the same title AND an asset only that build has', () => {
    expect(samePage(SITE("Jane's Cleaning"), SITE("Jane's Cleaning"))).toBe(true)
    expect(samePage('<title>J</title><script src="/_next/static/AbC123xyz_9/_buildManifest.js">', '<title>J</title><script src="/_next/static/AbC123xyz_9/_buildManifest.js">')).toBe(true)
    expect(samePage('<title>J</title><script src="/assets/index-4f3a2b1c.js">', '<title>J</title><script src="https://cdn.janescleaning.com/assets/index-4f3a2b1c.js">')).toBe(true)
  })

  it('never on a title alone, an asset alone, or files every site on a framework version shares', () => {
    expect(samePage(SITE('One'), SITE('Two'))).toBe(false)
    expect(samePage(SITE("Jane's Cleaning", 'aaaaaaaaaa'), SITE("Jane's Cleaning", 'bbbbbbbbbb'))).toBe(false)
    expect(samePage('<title>Home</title>', '<title>Home</title>')).toBe(false)
    // Another business's site on the same Next.js version: the same polyfills and main chunks, its own page chunk.
    const other = SITE('Home', 'cccccccccc')
    expect(samePage(SITE('Home', 'dddddddddd'), other)).toBe(false)
  })
})

describe('liveAddress', () => {
  it("from the host's own address to the business's domain it names, keeping every origin it answers at", async () => {
    const { fetchImpl } = web({
      'https://janes-cleaning.vercel.app/': { html: SITE("Jane's Cleaning") },
      'https://janescleaning.com/': { location: 'https://www.janescleaning.com/' },
      'https://www.janescleaning.com/': { html: SITE("Jane's Cleaning") },
    })
    expect(await liveAddress('https://janes-cleaning.vercel.app', { fetchImpl })).toEqual({
      siteUrl: 'https://janescleaning.com',
      alsoUrls: ['https://janes-cleaning.vercel.app', 'https://www.janescleaning.com'],
    })
  })

  it("never follows a canonical to another site (a template's vendor)", async () => {
    const { fetchImpl } = web({
      'https://janes-cleaning.vercel.app/': { html: '<title>Jane</title><link rel="canonical" href="https://tailwindui.com">' },
      'https://tailwindui.com/': { html: '<title>Tailwind UI</title>' },
    })
    expect(await liveAddress('https://janes-cleaning.vercel.app', { fetchImpl })).toEqual({ siteUrl: 'https://janes-cleaning.vercel.app', alsoUrls: [] })
  })

  it('never follows a canonical that does not answer, or one on another host address', async () => {
    const dead = web({ 'https://janes-cleaning.vercel.app/': { html: SITE('Jane') } })
    expect((await liveAddress('https://janes-cleaning.vercel.app', dead)).siteUrl).toBe('https://janes-cleaning.vercel.app')
    const host = web({ 'https://janes-cleaning.vercel.app/': { html: '<title>J</title><link rel="canonical" href="https://janes.netlify.app">' }, 'https://janes.netlify.app/': { html: '<title>J</title>' } })
    expect((await liveAddress('https://janes-cleaning.vercel.app', host)).siteUrl).toBe('https://janes-cleaning.vercel.app')
  })

  it("the host's address redirecting to the business's domain: that domain", async () => {
    const { fetchImpl } = web({
      'https://janes-cleaning.vercel.app/': { location: 'https://www.janescleaning.com/' },
      'https://www.janescleaning.com/': { html: '<title>J</title>' },
    })
    expect(await liveAddress('https://janes-cleaning.vercel.app', { fetchImpl })).toEqual({ siteUrl: 'https://www.janescleaning.com', alsoUrls: ['https://janes-cleaning.vercel.app'] })
  })

  it('an address the owner said is never swapped', async () => {
    const { fetchImpl, asked } = web({
      'https://janes-cleaning.vercel.app/': { html: SITE("Jane's Cleaning") },
      'https://janescleaning.com/': { html: SITE("Jane's Cleaning") },
    })
    expect(await liveAddress('https://janes-cleaning.vercel.app', { fetchImpl, stated: true })).toEqual({ siteUrl: 'https://janes-cleaning.vercel.app', alsoUrls: [] })
    expect(asked).not.toContain('https://janescleaning.com/')
  })

  it("a domain of the business's own is never swapped, and its redirect's origin is kept", async () => {
    const { fetchImpl, asked } = web({
      'https://janescleaning.com/': { location: 'https://www.janescleaning.com/' },
      'https://www.janescleaning.com/': { html: '<title>J</title><link rel="canonical" href="https://other.com">' },
    })
    expect(await liveAddress('https://janescleaning.com', { fetchImpl })).toEqual({ siteUrl: 'https://janescleaning.com', alsoUrls: ['https://www.janescleaning.com'] })
    expect(asked).not.toContain('https://other.com/')
  })

  it('an address that does not answer stays as it is', async () => {
    expect(await liveAddress('https://janescleaning.com', web({}))).toEqual({ siteUrl: 'https://janescleaning.com', alsoUrls: [] })
  })
})
