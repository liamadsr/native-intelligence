/**
 * Where an audit may start and where it really starts (../start-url.ts).
 * Cases adapted from OpenSEO's url-policy tests (MIT): the address checks are
 * the link preview's (checkPublicUrl), the probes go through an injected
 * fetch, and a redirect into a refused target falls back to the last good
 * URL instead of failing the audit.
 */
import { describe, expect, it } from 'vitest'
import {
  isCrawlableUrl,
  normalizeStartUrl,
  resolveStartUrlRedirects,
  StartUrlError,
} from '../start-url'
import { fakeSite, redirect } from './fake-site'

function refusal(input: string): string {
  try {
    normalizeStartUrl(input)
  } catch (err) {
    expect(err).toBeInstanceOf(StartUrlError)
    return (err as StartUrlError).code
  }
  throw new Error(`expected ${input} to be refused`)
}

describe('normalizeStartUrl', () => {
  it('adds https when the scheme is missing and drops the fragment', () => {
    expect(normalizeStartUrl('example.com/path#section')).toBe(
      'https://example.com/path',
    )
    expect(normalizeStartUrl('  Example.COM  ')).toBe('https://example.com/')
  })

  it('keeps http when the person typed it, and keeps the path and query', () => {
    expect(normalizeStartUrl('http://example.com/blog?page=2')).toBe(
      'http://example.com/blog?page=2',
    )
    expect(normalizeStartUrl('HTTPS://www.example.org/')).toBe(
      'https://www.example.org/',
    )
  })

  it.each([
    '',
    '   ',
    'intranet',
    'https://',
    'ftp://example.com',
    'not a url at all',
  ])('refuses %j as not a website address', (input) => {
    expect(refusal(input)).toBe('INVALID_URL')
  })

  it('refuses an address that is too long', () => {
    expect(refusal(`https://example.com/${'a'.repeat(2048)}`)).toBe(
      'INVALID_URL',
    )
  })

  // 1,020 characters as typed; every '"' becomes %22 in the address the
  // audit would store, 3,020 characters long.
  it('refuses an address that only passes the limit once normalised', () => {
    const typed = `example.com/${'"'.repeat(1_000)}`
    expect(typed.length).toBeLessThan(2048)
    expect(refusal(typed)).toBe('INVALID_URL')
  })

  it.each(['example.com:8080', 'https://example.com:8443/', 'http://example.com:443/'])(
    'refuses %s: an audit reads the standard web ports only',
    (input) => {
      expect(() => normalizeStartUrl(input)).toThrow(
        expect.objectContaining({
          code: 'INVALID_URL',
          message: 'Leave the port number out: an audit reads a site on its standard address only.',
        }),
      )
    },
  )

  it('accepts a default port written out, and drops it', () => {
    expect(normalizeStartUrl('https://example.com:443/a')).toBe(
      'https://example.com/a',
    )
    expect(normalizeStartUrl('http://example.com:80/')).toBe(
      'http://example.com/',
    )
  })

  it.each([
    'localhost:3000',
    'http://localhost:3000',
    'http://192.168.0.10',
    '10.0.0.1',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'printer.local',
    'metadata.google.internal',
  ])('refuses %s as not public', (input) => {
    expect(refusal(input)).toBe('NOT_PUBLIC')
  })

  it.each(['https://user:secret@example.com/', 'user@example.com'])(
    'refuses %s as an address with a user name or password, and says to leave them out',
    (input) => {
      expect(() => normalizeStartUrl(input)).toThrow(
        expect.objectContaining({
          code: 'INVALID_URL',
          message: 'Leave the user name and password out of the address.',
        }),
      )
    },
  )
})

describe('isCrawlableUrl', () => {
  it.each([
    ['https://example.com/a', true],
    ['http://example.org/b?c=d', true],
    ['https://93.184.216.34/', true],
    ['http://127.0.0.1/', false],
    ['http://10.1.2.3/admin', false],
    ['http://localhost/', false],
    ['ftp://example.com/file', false],
    ['mailto:someone@example.com', false],
    ['not a url', false],
    [`https://example.com/${'a'.repeat(2048)}`, false],
    ['https://example.com:8443/', false],
    ['http://example.com:8080/a', false],
    ['http://example.com:443/', false],
    ['https://example.com:443/', true],
  ])('isCrawlableUrl(%s) is %s', (url, expected) => {
    expect(isCrawlableUrl(url)).toBe(expected)
  })
})

describe('resolveStartUrlRedirects', () => {
  it('does not follow a redirect to another port', async () => {
    const site = fakeSite({
      'https://example.com/': redirect('https://example.com:8443/'),
    })
    expect(await resolveStartUrlRedirects('https://example.com/', site.fetch)).toBe(
      'https://example.com/',
    )
    expect(site.count('https://example.com:8443/')).toBe(0)
  })

  it('follows a cross-domain redirect to the site’s real origin', async () => {
    const site = fakeSite({
      'https://example.net/': redirect('https://example.com/'),
      'https://example.com/': { status: 200 },
    })
    expect(
      await resolveStartUrlRedirects('https://example.net/', site.fetch),
    ).toBe('https://example.com/')
  })

  it('follows a relative Location and stops at the first answer that is not a redirect', async () => {
    const site = fakeSite({
      'https://example.com/': redirect('/en/', 302),
      'https://example.com/en/': { status: 404 },
    })
    expect(
      await resolveStartUrlRedirects('https://example.com/', site.fetch),
    ).toBe('https://example.com/en/')
  })

  it('probes without reading a body, with its own timeout', async () => {
    const site = fakeSite({
      'https://example.com/': { status: 200, body: 'x' },
    })
    await resolveStartUrlRedirects('https://example.com/', site.fetch)
    const [probe] = site.requests
    expect(probe.opts.timeoutMs).toBe(10_000)
    expect(probe.opts.wantBody?.(200, 'text/html')).toBe(false)
    expect(probe.bodyRead).toBe(false)
  })

  it('returns the last URL when the probe fails', async () => {
    const site = fakeSite({}, 'fail')
    expect(
      await resolveStartUrlRedirects('https://example.com/', site.fetch),
    ).toBe('https://example.com/')
  })

  it('stays put on a redirect without a Location', async () => {
    const site = fakeSite({ 'https://example.com/': { status: 301 } })
    expect(
      await resolveStartUrlRedirects('https://example.com/', site.fetch),
    ).toBe('https://example.com/')
  })

  it('stops after five hops on a redirect loop', async () => {
    const site = fakeSite({
      'https://example.com/': redirect('https://example.org/'),
      'https://example.org/': redirect('https://example.com/'),
    })
    const resolved = await resolveStartUrlRedirects(
      'https://example.com/',
      site.fetch,
    )
    expect(['https://example.com/', 'https://example.org/']).toContain(resolved)
    expect(site.requests).toHaveLength(5)
  })

  it.each([
    'http://192.168.0.10/',
    'http://localhost:8080/',
    'http://169.254.169.254/',
    'file:///etc/passwd',
  ])(
    'never follows a redirect into %s: it keeps the last good URL',
    async (location) => {
      const site = fakeSite({ 'https://example.com/': redirect(location) })
      expect(
        await resolveStartUrlRedirects('https://example.com/', site.fetch),
      ).toBe('https://example.com/')
      expect(site.urls()).toEqual(['https://example.com/'])
    },
  )
})
