import { describe, it, expect } from 'vitest'
import { blockedSiteForUrl, cleanBlockedSites, normalizeBlockedSite, siteForUrl } from '../blocked-sites'

describe('blocked sites', () => {
  it('a Block on a page stores its host without www', () => {
    expect(siteForUrl('https://www.linkedin.com/feed/')).toBe('linkedin.com')
    expect(siteForUrl('https://mail.google.com/mail/u/0/')).toBe('mail.google.com')
    expect(siteForUrl('http://LOCALHOST:3000/x')).toBe('localhost')
    expect(siteForUrl('https://www.linkedin.com./')).toBe('linkedin.com')
  })

  it('never strips www down to a bare suffix', () => {
    expect(siteForUrl('https://www.com/')).toBe('www.com')
  })

  it('pages that are no site have no entry', () => {
    expect(siteForUrl('about:blank')).toBeNull()
    expect(siteForUrl('data:text/html,hi')).toBeNull()
    expect(siteForUrl('not a url')).toBeNull()
    expect(siteForUrl(null)).toBeNull()
  })

  it('matches the entry and every subdomain, any scheme or port', () => {
    const sites = ['linkedin.com']
    expect(blockedSiteForUrl('https://linkedin.com/', sites)).toBe('linkedin.com')
    expect(blockedSiteForUrl('https://www.linkedin.com/in/me', sites)).toBe('linkedin.com')
    expect(blockedSiteForUrl('http://m.linkedin.com:8443/', sites)).toBe('linkedin.com')
    expect(blockedSiteForUrl('https://LinkedIn.COM./', sites)).toBe('linkedin.com')
  })

  it('does not match a look-alike or a parent domain', () => {
    expect(blockedSiteForUrl('https://notlinkedin.com/', ['linkedin.com'])).toBeNull()
    expect(blockedSiteForUrl('https://linkedin.com.evil.test/', ['linkedin.com'])).toBeNull()
    expect(blockedSiteForUrl('https://www.google.com/search', ['mail.google.com'])).toBeNull()
  })

  it('a blob: URL is judged by the page it belongs to', () => {
    expect(blockedSiteForUrl('blob:https://www.linkedin.com/1f2e', ['linkedin.com'])).toBe('linkedin.com')
  })

  it('an origin string works as a URL (frame origins)', () => {
    expect(blockedSiteForUrl('https://platform.linkedin.com', ['linkedin.com'])).toBe('linkedin.com')
  })

  it('normalizes what the user types', () => {
    expect(normalizeBlockedSite('linkedin.com')).toBe('linkedin.com')
    expect(normalizeBlockedSite('  https://www.LinkedIn.com/in/me?x=1 ')).toBe('linkedin.com')
    expect(normalizeBlockedSite('mail.google.com/mail')).toBe('mail.google.com')
    expect(normalizeBlockedSite('localhost')).toBe('localhost')
    expect(normalizeBlockedSite('192.168.1.5')).toBe('192.168.1.5')
  })

  it('refuses a single word, junk and non-web schemes', () => {
    expect(normalizeBlockedSite('linkedin')).toBeNull()
    expect(normalizeBlockedSite('')).toBeNull()
    expect(normalizeBlockedSite('two words.com')).toBeNull()
    expect(normalizeBlockedSite('ftp://files.example.com')).toBeNull()
  })

  it('cleans a stored list', () => {
    expect(cleanBlockedSites(['LinkedIn.com', 'linkedin.com', 7, '', 'www.example.org'])).toEqual(['linkedin.com', 'example.org'])
    expect(cleanBlockedSites('nope')).toEqual([])
  })
})

describe("Dial8's own app is off-limits to the agent (A5)", () => {
  it('blocks dial8.ai and its subdomains, local dev on any port, and the configured app origin', async () => {
    const { appOwnSites, blockedSiteForUrl } = await import('../blocked-sites')
    const sites = appOwnSites('https://app.example-staging.com')
    expect(blockedSiteForUrl('https://dial8.ai/account/chat', sites)).toBe('dial8.ai')
    expect(blockedSiteForUrl('https://www.dial8.ai/account', sites)).toBe('dial8.ai')
    expect(blockedSiteForUrl('http://localhost:3000/account', sites)).toBe('localhost')
    expect(blockedSiteForUrl('http://127.0.0.1:3001/', sites)).toBe('127.0.0.1')
    expect(blockedSiteForUrl('https://app.example-staging.com/x', sites)).toBe('app.example-staging.com')
    expect(blockedSiteForUrl('https://linkedin.com', sites)).toBeNull()
  })
})
