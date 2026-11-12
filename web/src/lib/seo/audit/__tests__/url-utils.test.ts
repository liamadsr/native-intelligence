/**
 * URL normalization and the crawl boundary (../url-utils.ts). Cases ported
 * from OpenSEO's url-utils tests (MIT), less the Shopify-only paths our port
 * dropped.
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalUrlKey,
  detectUrlTemplate,
  getOrigin,
  isAuditablePageUrl,
  isSameOrigin,
  normalizeUrl,
} from '../url-utils'

describe('normalizeUrl', () => {
  it('lowercases the host, sorts the query, drops the fragment and keeps a trailing slash', () => {
    expect(
      normalizeUrl(
        'https://Example.COM/path/?b=2&a=1#section',
        'https://example.org',
      ),
    ).toBe('https://example.com/path/?a=1&b=2')
  })

  it('keeps a trailing slash on a path (stripping it would turn /path/ into its own redirect source)', () => {
    expect(normalizeUrl('https://example.com/services/')).toBe(
      'https://example.com/services/',
    )
    expect(normalizeUrl('https://example.com/services')).toBe(
      'https://example.com/services',
    )
  })

  it('resolves a relative link against its page', () => {
    expect(normalizeUrl('../about', 'https://example.com/blog/post')).toBe(
      'https://example.com/about',
    )
    expect(normalizeUrl('/x', 'https://example.com/a/b')).toBe(
      'https://example.com/x',
    )
  })

  it('drops click and campaign tracking params so tagged links dedupe to the page', () => {
    expect(
      normalizeUrl(
        'https://example.com/products/skis?_pos=3&_sid=6744e5c60&_ss=r&utm_source=mail&srsltid=abc',
      ),
    ).toBe('https://example.com/products/skis')
    expect(
      normalizeUrl(
        'https://example.com/collections/skis?page=2&fbclid=xyz&gclid=1&msclkid=2',
      ),
    ).toBe('https://example.com/collections/skis?page=2')
    expect(
      normalizeUrl('https://example.com/p?utm_source=mail', undefined, {
        keepTrackingParams: true,
      }),
    ).toBe('https://example.com/p?utm_source=mail')
  })

  it('returns null for another scheme or something that is not a URL', () => {
    expect(normalizeUrl('mailto:test@example.com')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('ftp://example.com/file')).toBeNull()
    expect(normalizeUrl('not a url')).toBeNull()
  })
})

describe('canonicalUrlKey', () => {
  it.each([
    'https://www.example.com/',
    'http://example.com/',
    'https://EXAMPLE.com/#top',
  ])('treats %s as the same page as https://example.com/', (url) => {
    expect(canonicalUrlKey(url)).toBe(canonicalUrlKey('https://example.com/'))
  })

  it('keeps a trailing slash apart and falls back to lowercase on a non-URL', () => {
    expect(canonicalUrlKey('https://example.com/a')).not.toBe(
      canonicalUrlKey('https://example.com/a/'),
    )
    expect(canonicalUrlKey('Not A URL')).toBe('not a url')
  })
})

describe('isSameOrigin', () => {
  it.each([
    ['https://www.example.com/products', 'https://example.com', true],
    ['https://example.com/products', 'https://www.example.com', true],
    ['https://example.com/page', 'http://example.com', true],
    ['http://example.com/page', 'https://example.com', false],
    ['https://example.com:8443/page', 'https://example.com', false],
    ['https://example.com:443/page', 'https://example.com', true],
    ['https://example.org', 'https://example.com', false],
    ['https://shop.example.com/', 'https://example.com', false],
    ['not a url', 'https://example.com', false],
  ])('isSameOrigin(%s, %s) is %s', (url, origin, expected) => {
    expect(isSameOrigin(url, origin)).toBe(expected)
  })
})

describe('detectUrlTemplate', () => {
  it('maps ids, uuids, dates and long slugs to parameters', () => {
    expect(detectUrlTemplate('/blog/2026-03-01/my-great-post')).toBe(
      '/blog/:date/:slug',
    )
    expect(detectUrlTemplate('/products/12345')).toBe('/products/:id')
    expect(
      detectUrlTemplate('/orders/0b6f1e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b/items'),
    ).toBe('/orders/:uuid/items')
    expect(detectUrlTemplate('/my-account/settings')).toBe(
      '/my-account/settings',
    )
    expect(detectUrlTemplate('/')).toBe('/')
  })
})

describe('getOrigin', () => {
  it('is the scheme, host and port', () => {
    expect(getOrigin('https://example.com:8443/a?b=c')).toBe(
      'https://example.com:8443',
    )
  })
})

describe('isAuditablePageUrl', () => {
  it.each([
    ['https://example.com/products/hat', true],
    ['https://example.com/cdn/shop/files/hat.jpg?v=1&width=1000', false],
    ['https://example.com/products/hat.json', false],
    ['https://example.com/assets/site.css', false],
    ['https://example.com/fonts/body.woff2', false],
    ['https://example.com/sitemap.xml', false],
    ['https://example.com/IMAGE.PNG', false],
    ['https://example.com/report.pdf', true],
    ['https://example.com/discount/SAVE10', true],
    ['https://example.com/cdn-cgi/l/email-protection', false],
    ['not a url', false],
  ] as const)('isAuditablePageUrl(%s) is %s', (url, expected) => {
    expect(isAuditablePageUrl(url)).toBe(expected)
  })
})
