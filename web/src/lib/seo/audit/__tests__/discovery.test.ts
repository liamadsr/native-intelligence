/**
 * robots.txt and sitemap discovery (../discovery.ts) against a made-up site
 * answered from a table. Cases ported from OpenSEO's discovery tests (MIT),
 * plus the rules our port adds: our own robots.txt token, one origin only,
 * and sitemaps that are not sitemaps or are too big to read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_DEADLINE_MS,
  discoverUrls,
  MAX_SITEMAP_DOCS,
  parseRobotsTxt,
} from '../discovery'
import type { CrawlFetch } from '../fetch'
import { CRAWLER_TOKEN } from '../limits'
import {
  drive,
  fakeSite,
  html,
  sitemapIndex,
  text,
  urlset,
  xml,
  type FakeAnswer,
  type FakeRoute,
} from './fake-site'

const ORIGIN = 'https://example.com'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-12T09:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('parseRobotsTxt', () => {
  it('lets a group for our own token win over the * group', () => {
    const robots = parseRobotsTxt(
      ORIGIN,
      `User-agent: *\nAllow: /\n\nUser-agent: ${CRAWLER_TOKEN}\nDisallow: /private/\n`,
    )
    expect(robots.isAllowed('https://example.com/private/page')).toBe(false)
    expect(robots.isAllowed('https://example.com/public')).toBe(true)
  })

  it('lets our group allow what * forbids', () => {
    const robots = parseRobotsTxt(
      ORIGIN,
      `User-agent: *\nDisallow: /\n\nUser-agent: ${CRAWLER_TOKEN}\nAllow: /\n`,
    )
    expect(robots.isAllowed('https://example.com/anything')).toBe(true)
  })

  it('matches our token whatever its case, and falls back to * without one', () => {
    expect(
      parseRobotsTxt(
        ORIGIN,
        `User-agent: ${CRAWLER_TOKEN.toLowerCase()}\nDisallow: /a\n`,
      ).isAllowed('https://example.com/a'),
    ).toBe(false)
    const star = parseRobotsTxt(
      ORIGIN,
      'User-agent: SomeOtherBot\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp/\n',
    )
    expect(star.isAllowed('https://example.com/tmp/x')).toBe(false)
    expect(star.isAllowed('https://example.com/ok')).toBe(true)
  })

  it('allows everything when there is no robots.txt', () => {
    const robots = parseRobotsTxt(ORIGIN, null)
    expect(robots.isAllowed('https://example.com/anything')).toBe(true)
    expect(robots.sitemapUrls).toEqual([])
  })

  it('lists the sitemaps robots.txt names', () => {
    expect(
      parseRobotsTxt(
        ORIGIN,
        'User-agent: *\nAllow: /\nSitemap: https://example.com/a.xml\nSitemap: https://example.com/b.xml\n',
      ).sitemapUrls,
    ).toEqual(['https://example.com/a.xml', 'https://example.com/b.xml'])
  })
})

describe('discoverUrls', () => {
  it('reads the default /sitemap.xml even when robots.txt names none, and returns the robots.txt text', async () => {
    const robotsTxt = 'User-agent: *\nDisallow: /tmp/\n'
    const site = fakeSite({
      'https://example.com/robots.txt': text(robotsTxt),
      'https://example.com/sitemap.xml': xml(
        urlset(['https://example.com/', 'https://example.com/about']),
      ),
    })
    const result = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(result).toMatchObject({
      urls: ['https://example.com/', 'https://example.com/about'],
      robotsText: robotsTxt,
    })
    const robotsRequest = site.requests.find((r) =>
      r.url.endsWith('/robots.txt'),
    )
    expect(robotsRequest?.opts.maxBytes).toBe(500 * 1024)
  })

  it('reads robots.txt as missing when it is not there', async () => {
    const site = fakeSite({})
    const result = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(result).toMatchObject({ urls: [], robotsText: null })
  })

  it('follows a sitemap index down three levels, and no further', async () => {
    const site = fakeSite({
      'https://example.com/robots.txt': text(
        'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap_index.xml\n',
      ),
      'https://example.com/sitemap_index.xml': xml(
        sitemapIndex([
          'https://example.com/sitemaps/pages.xml',
          'https://example.com/sitemaps/posts.xml',
        ]),
      ),
      'https://example.com/sitemaps/pages.xml': xml(
        urlset(['https://example.com/', 'https://example.com/about']),
      ),
      'https://example.com/sitemaps/posts.xml': xml(
        sitemapIndex([
          'https://example.com/sitemaps/posts-2026.xml',
          'https://example.com/sitemaps/archive.xml',
        ]),
      ),
      'https://example.com/sitemaps/posts-2026.xml': xml(
        urlset(['https://example.com/blog/first-post']),
      ),
      // The third level: read, but the index inside it is not followed.
      'https://example.com/sitemaps/archive.xml': xml(
        sitemapIndex(['https://example.com/sitemaps/too-deep.xml']),
      ),
      'https://example.com/sitemaps/too-deep.xml': xml(
        urlset(['https://example.com/blog/too-deep']),
      ),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls.sort()).toEqual([
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/blog/first-post',
    ])
    expect(site.count('https://example.com/sitemaps/too-deep.xml')).toBe(0)
  })

  it('reads each sitemap once, however often it is listed', async () => {
    const site = fakeSite({
      'https://example.com/robots.txt': text(
        'Sitemap: https://example.com/sitemap.xml\nSitemap: https://EXAMPLE.com/sitemap.xml\n',
      ),
      'https://example.com/sitemap.xml': xml(
        sitemapIndex([
          'https://example.com/sitemap.xml',
          'https://example.com/pages.xml',
        ]),
      ),
      'https://example.com/pages.xml': xml(
        sitemapIndex(['https://example.com/sitemap.xml']),
      ),
    })
    await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(site.count('https://example.com/sitemap.xml')).toBe(1)
    expect(site.count('https://example.com/pages.xml')).toBe(1)
  })

  it('ignores sitemaps and pages on another origin', async () => {
    const site = fakeSite({
      'https://example.com/robots.txt': text(
        'Sitemap: https://cdn.example.org/sitemap.xml\n',
      ),
      'https://example.com/sitemap.xml': xml(
        sitemapIndex([
          'https://example.org/sitemap-elsewhere.xml',
          'https://example.com/sitemap-pages.xml',
        ]),
      ),
      'https://example.com/sitemap-pages.xml': xml(
        urlset([
          'https://example.com/kept',
          'https://example.org/not-ours',
          'https://shop.example.com/not-ours-either',
        ]),
      ),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toEqual(['https://example.com/kept'])
    const hosts = new Set(site.urls().map((url) => new URL(url).host))
    expect(hosts).toEqual(new Set(['example.com']))
  })

  it('drops a sitemap that redirects to another origin', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': {
        status: 301,
        headers: { location: 'https://example.org/sitemap.xml' },
      },
      'https://example.org/sitemap.xml': xml(urlset(['https://example.com/a'])),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toEqual([])
    expect(site.count('https://example.org/sitemap.xml')).toBe(0)
  })

  it('follows a same-origin sitemap redirect', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': {
        status: 301,
        headers: { location: '/sitemap_index.xml' },
      },
      'https://example.com/sitemap_index.xml': xml(
        urlset(['https://example.com/a']),
      ),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toEqual(['https://example.com/a'])
  })

  it('reads nothing from an HTML page served at /sitemap.xml', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': html(
        '<!doctype html><html><body><a href="/about">About</a><url><loc>https://example.com/x</loc></url></body></html>',
      ),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toEqual([])
  })

  it('reads a sitemap served without an XML media type when it looks like one', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': text(
        urlset(['https://example.com/a']),
      ),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toEqual(['https://example.com/a'])
  })

  it('skips an oversized sitemap whole instead of reading part of it', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': {
        ...xml(urlset(['https://example.com/a', 'https://example.com/b'])),
        truncated: true,
      },
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toEqual([])
    expect(site.requests.at(-1)?.opts.maxBytes).toBe(10 * 1024 * 1024)
  })

  it('skips a sitemap that answers with an error', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': {
        ...xml(urlset(['https://example.com/a'])),
        status: 500,
      },
    })
    expect((await drive(discoverUrls(ORIGIN, 10, site.fetch))).urls).toEqual([])
  })

  it('returns sitemap URLs listed past the crawl’s page budget (seeding records the in-sitemap flag)', async () => {
    const posts = Array.from(
      { length: 5 },
      (_, i) => `https://example.com/blog/post-${i}/`,
    )
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(
        urlset([...posts, 'https://example.com/']),
      ),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 2, site.fetch))
    expect(urls).toContain('https://example.com/')
    expect(urls).toHaveLength(6)
  })

  it('normalizes sitemap URLs (fragments and tracking params dropped)', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(
        urlset([
          ' https://Example.com/a?utm_source=x#top ',
          'https://example.com/b?z=1&a=2',
        ]),
      ),
    })
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toEqual([
      'https://example.com/a',
      'https://example.com/b?a=2&z=1',
    ])
  })

  // A sitemap shard refused at first contact used to take every URL in it
  // out of the audit.
  it('retries a sitemap refused with 429 after its Retry-After', async () => {
    const site = fakeSite({
      'https://example.com/robots.txt': text('User-agent: *\nAllow: /\n'),
      'https://example.com/sitemap.xml': (call): FakeAnswer =>
        call === 1
          ? {
              ...text('local_rate_limited', 429),
              headers: { 'retry-after': '5' },
            }
          : xml(urlset(['https://example.com/a'])),
    })
    const discovery = discoverUrls(ORIGIN, 10, site.fetch)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(site.count('https://example.com/sitemap.xml')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const { urls } = await discovery
    expect(urls).toEqual(['https://example.com/a'])
    expect(site.count('https://example.com/sitemap.xml')).toBe(2)
  })

  it('waits out a 429 on robots.txt once, then reads it', async () => {
    const robotsTxt = `User-agent: ${CRAWLER_TOKEN}\nDisallow: /private/\n`
    const site = fakeSite({
      'https://example.com/robots.txt': (call): FakeAnswer =>
        call === 1
          ? { status: 429, headers: { 'retry-after': '5' } }
          : text(robotsTxt),
    })
    const discovery = discoverUrls(ORIGIN, 10, site.fetch)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(site.count('https://example.com/robots.txt')).toBe(1)
    expect(site.count('https://example.com/sitemap.xml')).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    const { robotsText } = await discovery
    expect(robotsText).toBe(robotsTxt)
    expect(site.count('https://example.com/robots.txt')).toBe(2)
  })

  // RFC 9309 2.3.1.4: a robots.txt the server could not serve means
  // "assume complete disallow", so the audit stops instead of reading all.
  it('fails ROBOTS_UNREACHABLE after a second 429, without a third try', async () => {
    const site = fakeSite({
      'https://example.com/robots.txt': { status: 429 },
    })
    const discovery = discoverUrls(ORIGIN, 10, site.fetch)
    discovery.catch(() => {})
    await vi.advanceTimersByTimeAsync(59_999)
    expect(site.count('https://example.com/robots.txt')).toBe(1)
    await expect(drive(discovery)).rejects.toMatchObject({
      code: 'ROBOTS_UNREACHABLE',
    })
    expect(site.count('https://example.com/robots.txt')).toBe(2)
    expect(site.count('https://example.com/sitemap.xml')).toBe(0)
  })

  it.each([
    ['a network failure', 'fail' as const],
    ['a server error', text('down', 503)],
    ['a server error after a redirect', { status: 302, headers: { location: '/robots-live.txt' } }],
  ])('fails ROBOTS_UNREACHABLE on %s', async (_, answer) => {
    const site = fakeSite({
      'https://example.com/robots.txt': answer,
      'https://example.com/robots-live.txt': text('down', 500),
    })
    await expect(
      drive(discoverUrls(ORIGIN, 10, site.fetch)),
    ).rejects.toMatchObject({ code: 'ROBOTS_UNREACHABLE' })
    expect(site.count('https://example.com/sitemap.xml')).toBe(0)
  })

  it('fails ROBOTS_UNREACHABLE when robots.txt never answers (a timeout)', async () => {
    const hanging: CrawlFetch = (url, opts = {}) =>
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${opts.timeoutMs} ms`)),
          opts.timeoutMs ?? 30_000,
        ),
      )
    await expect(
      drive(discoverUrls(ORIGIN, 10, hanging)),
    ).rejects.toMatchObject({ code: 'ROBOTS_UNREACHABLE' })
  })

  it.each([403, 404, 410])(
    'reads a robots.txt answered %s as missing: everything allowed',
    async (status) => {
      const site = fakeSite({
        'https://example.com/robots.txt': text('no', status),
        'https://example.com/sitemap.xml': xml(urlset(['https://example.com/a'])),
      })
      const result = await drive(discoverUrls(ORIGIN, 10, site.fetch))
      expect(result).toMatchObject({
        robotsText: null,
        urls: ['https://example.com/a'],
      })
    },
  )

  it('caps the URLs it returns at the queue’s own cap', async () => {
    const many = Array.from(
      { length: 600 },
      (_, i) => `https://example.com/p/${i}`,
    )
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(urlset(many)),
    })
    // maxPages 10 -> a queue of at most 500.
    const { urls } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(urls).toHaveLength(500)
  })
})

describe('discoverUrls on robots.txt that redirects', () => {
  const foreignRobots = text(
    'User-agent: *\nDisallow: /\nSitemap: https://example.org/sitemap.xml\n',
  )

  it('reads a robots.txt whose redirects end on another site as missing: everything allowed, its sitemaps never read', async () => {
    const site = fakeSite({
      'https://example.com/robots.txt': {
        status: 301,
        headers: { location: 'https://example.org/robots.txt' },
      },
      'https://example.org/robots.txt': foreignRobots,
      'https://example.org/sitemap.xml': xml(
        urlset(['https://example.org/elsewhere']),
      ),
      'https://example.com/sitemap.xml': xml(urlset(['https://example.com/a'])),
    })
    const { robotsText, urls } = await drive(
      discoverUrls(ORIGIN, 10, site.fetch),
    )
    expect(robotsText).toBeNull()
    expect(parseRobotsTxt(ORIGIN, robotsText).isAllowed(`${ORIGIN}/a`)).toBe(
      true,
    )
    expect(urls).toEqual(['https://example.com/a'])
    expect(site.count('https://example.org/sitemap.xml')).toBe(0)
    // The other site is never asked at all: the hop is refused before it is fetched.
    expect(site.count('https://example.org/robots.txt')).toBe(0)
  })

  it('also when the other site is reached after a hop on this one', async () => {
    const site = fakeSite({
      'https://example.com/robots.txt': {
        status: 301,
        headers: { location: '/robots-live.txt' },
      },
      'https://example.com/robots-live.txt': {
        status: 302,
        headers: { location: 'https://example.org/robots.txt' },
      },
      'https://example.org/robots.txt': foreignRobots,
    })
    expect(
      (await drive(discoverUrls(ORIGIN, 10, site.fetch))).robotsText,
    ).toBeNull()
    expect(site.count('https://example.org/robots.txt')).toBe(0)
  })

  it('reads a robots.txt that redirects within the site, www included', async () => {
    const robotsTxt = 'User-agent: *\nDisallow: /tmp/\n'
    for (const location of [
      '/robots-live.txt',
      'https://www.example.com/robots.txt',
    ]) {
      const site = fakeSite({
        'https://example.com/robots.txt': {
          status: 301,
          headers: { location },
        },
        [new URL(location, ORIGIN).toString()]: text(robotsTxt),
      })
      expect(
        (await drive(discoverUrls(ORIGIN, 10, site.fetch))).robotsText,
        location,
      ).toBe(robotsTxt)
    }
  })
})

describe('discoverUrls on sitemap entries for another site', () => {
  it('counts every entry naming another site, and names the host most of them use', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(
        urlset([
          'https://example.com/a',
          'https://example.org/x',
          'https://example.org/y',
          'https://example.net/z',
        ]),
      ),
    })
    const result = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(result.urls).toEqual(['https://example.com/a'])
    expect(result.otherSite).toMatchObject({ count: 3, host: 'example.org' })
  })

  it('counts entries across every sitemap of an index', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(
        sitemapIndex([
          'https://example.com/one.xml',
          'https://example.com/two.xml',
        ]),
      ),
      'https://example.com/one.xml': xml(urlset(['https://example.org/x'])),
      'https://example.com/two.xml': xml(urlset(['https://example.org/y'])),
    })
    expect(
      (await drive(discoverUrls(ORIGIN, 10, site.fetch))).otherSite,
    ).toMatchObject({ count: 2, host: 'example.org' })
  })

  it('is null when every entry is this site’s, www or not', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(
        urlset(['https://example.com/a', 'https://www.example.com/b']),
      ),
    })
    const result = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(result.otherSite).toBeNull()
    expect(result.urls).toHaveLength(2)
  })

  it('counts a subdomain as another site', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(
        urlset(['https://shop.example.com/a']),
      ),
    })
    expect(
      (await drive(discoverUrls(ORIGIN, 10, site.fetch))).otherSite,
    ).toMatchObject({ count: 1, host: 'shop.example.com' })
  })

  // BUG (discovery.ts, discoverUrls, the `isSameOrigin(pageUrl, origin)` test
  // that decides what counts toward otherHosts): on an https site whose
  // sitemap still lists its pages as http:// (common after a move to https),
  // isSameOrigin('http://example.com/a', 'https://example.com') is false (only
  // an http -> https upgrade is allowed), so every entry is counted as
  // "another site" whose host is this site's own host. runDiscovery then
  // stores sitemapOtherSite and finalizeAudit raises sitemap-other-site with
  // otherHost "example.com", telling the person their sitemap lists "a
  // different domain" when it lists their own domain under http. Those
  // entries should not count as another site (compare hosts with
  // www-equivalence, not origins); whether to seed them, or to raise a
  // separate "sitemap lists http URLs" finding, is a product choice.
  it('does not count this site’s own host under http as another site', async () => {
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(
        urlset(['http://example.com/a', 'http://example.com/b']),
      ),
    })
    const { otherSite } = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(otherSite).toBeNull()
  })
})

describe('discoverUrls on a site built to exhaust it', () => {
  // A sitemap index lists far more sitemaps than discovery may read: each was
  // queued in full before, so an index of indexes grew the queue without bound.
  it('never reads, or holds, more sitemaps than its cap, however many an index lists', async () => {
    const children = Array.from(
      { length: 1_000 },
      (_, i) => `https://example.com/sitemaps/${i}.xml`,
    )
    const routes: Record<string, FakeRoute> = {
      'https://example.com/robots.txt': text(
        'Sitemap: https://example.com/index.xml\n',
      ),
      'https://example.com/index.xml': xml(sitemapIndex(children)),
    }
    // Every child is itself an index of every child: each read used to
    // queue the whole list again.
    const everyChild = xml(sitemapIndex(children))
    for (const url of children) routes[url] = everyChild
    const site = fakeSite(routes, xml(urlset(['https://example.com/a'])))
    await drive(discoverUrls(ORIGIN, 10, site.fetch))
    const sitemapRequests = site.urls().filter((url) => url.endsWith('.xml'))
    expect(sitemapRequests.length).toBeLessThanOrEqual(MAX_SITEMAP_DOCS)
    expect(new Set(sitemapRequests).size).toBe(sitemapRequests.length)
  })

  it('reads at most 50,000 entries from one sitemap (the protocol’s own limit)', async () => {
    const entries = Array.from(
      { length: 60_000 },
      (_, i) => `https://example.org/p/${i}`,
    )
    const site = fakeSite({
      'https://example.com/sitemap.xml': xml(urlset(entries)),
    })
    const result = await drive(discoverUrls(ORIGIN, 10, site.fetch))
    expect(result.otherSite?.count).toBe(50_000)
  })

  it('stops reading sitemaps at its deadline and goes on with what it found', async () => {
    const children = Array.from(
      { length: 200 },
      (_, i) => `https://example.com/slow/${i}.xml`,
    )
    const site = fakeSite({
      'https://example.com/robots.txt': text('User-agent: *\nAllow: /\n'),
      'https://example.com/sitemap.xml': xml(
        sitemapIndex(['https://example.com/pages.xml', ...children]),
      ),
      'https://example.com/pages.xml': xml(urlset(['https://example.com/a'])),
    })
    // Every slow sitemap holds its request open until the fetch's own timeout.
    const fetch: CrawlFetch = (url, opts = {}) =>
      url.includes('/slow/')
        ? new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`timed out after ${opts.timeoutMs} ms`)),
              opts.timeoutMs ?? 30_000,
            ),
          )
        : site.fetch(url, opts)
    const startedAt = Date.now()
    const result = await drive(discoverUrls(ORIGIN, 10, fetch))
    expect(Date.now() - startedAt).toBeLessThanOrEqual(DISCOVERY_DEADLINE_MS)
    expect(result).toMatchObject({
      urls: ['https://example.com/a'],
      timedOut: true,
    })
  })
})
