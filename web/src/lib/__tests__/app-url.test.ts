import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_DOMAINS, APP_PAGE_HOSTS, APP_PAGE_ORIGINS, APP_RELAY_HOSTS, DEFAULT_APP_URL, appDomainOf, appHost, appUrl, appUrlOnHost, isAppPageHost, isWithinAppDomain } from '../app-url'

afterEach(() => vi.unstubAllEnvs())

describe('the app address', () => {
  it('is NEXT_PUBLIC_APP_URL, without a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai/')
    expect(appUrl()).toBe('https://dial8.ai')
    expect(appHost()).toBe('dial8.ai')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    expect(appUrl()).toBe('http://localhost:3000')
    expect(appHost()).toBe('localhost:3000')
  })

  it('defaults to the new domain when the setting is unset or empty', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(DEFAULT_APP_URL).toBe('https://nativeintelligence.dev')
    expect(appUrl()).toBe('https://nativeintelligence.dev')
    expect(appHost()).toBe('nativeintelligence.dev')
  })

  it('names the new domain when the setting is not a URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a url')
    expect(appHost()).toBe('nativeintelligence.dev')
  })
})

describe('the hosts the app is served on', () => {
  it('lists both domains, each with www and a relay host', () => {
    expect(APP_DOMAINS).toEqual(['nativeintelligence.dev', 'dial8.ai'])
    expect(APP_PAGE_HOSTS).toEqual(['nativeintelligence.dev', 'www.nativeintelligence.dev', 'dial8.ai', 'www.dial8.ai'])
    expect(APP_PAGE_ORIGINS).toEqual(['https://nativeintelligence.dev', 'https://www.nativeintelligence.dev', 'https://dial8.ai', 'https://www.dial8.ai'])
    expect(APP_RELAY_HOSTS).toEqual(['browser-relay.nativeintelligence.dev', 'browser-relay.dial8.ai'])
  })

  it.each(['nativeintelligence.dev', 'dial8.ai'])('a page host is exactly %s or its www, in any case', (domain) => {
    expect(isAppPageHost(domain)).toBe(true)
    expect(isAppPageHost(`www.${domain}`)).toBe(true)
    expect(isAppPageHost(` WWW.${domain.toUpperCase()}. `)).toBe(true)
    for (const other of [`evil.${domain}`, `browser-relay.${domain}`, `a.www.${domain}`, `${domain}.evil.com`, `not${domain}`, `${domain.replace('.', '')}.com`, `${domain}:443`, '']) {
      expect(isAppPageHost(other), other).toBe(false)
    }
  })

  it.each(['nativeintelligence.dev', 'dial8.ai'])('anything under %s is within it, and a look-alike is not', (domain) => {
    for (const ours of [domain, `www.${domain}`, `docs.${domain}`, `browser-relay.${domain}`, `a.b.${domain}`]) expect(isWithinAppDomain(ours), ours).toBe(true)
    for (const other of [`${domain}.evil.com`, `not${domain}`, `evil-${domain}`, `${domain.replace('.', '')}.com`, 'example.com', '']) expect(isWithinAppDomain(other), other).toBe(false)
  })

  it('names the domain a page host belongs to', () => {
    expect(appDomainOf('www.dial8.ai')).toBe('dial8.ai')
    expect(appDomainOf('NativeIntelligence.dev')).toBe('nativeintelligence.dev')
    expect(appDomainOf('browser-relay.dial8.ai')).toBeNull()
    expect(appDomainOf('evil.nativeintelligence.dev')).toBeNull()
    expect(appDomainOf('example.com')).toBeNull()
  })

  it.each(['nativeintelligence.dev', 'dial8.ai'])('the address on a page host of %s is that host; on any other host it is the fallback', (domain) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://setting.example')
    expect(appUrlOnHost(domain)).toBe(`https://${domain}`)
    expect(appUrlOnHost(`WWW.${domain}`)).toBe(`https://www.${domain}`)
    for (const other of [`evil.${domain}`, `${domain}:8443`, `not${domain}`, `${domain}.evil.example`, 'localhost:3000', '', null, undefined]) {
      expect(appUrlOnHost(other), String(other)).toBe('https://setting.example')
    }
    expect(appUrlOnHost('localhost:3000', 'http://localhost:3000')).toBe('http://localhost:3000')
  })
})
