/**
 * The audit engine (../engine.ts) end to end: runDiscovery, runCrawlChunk in
 * a loop, finalizeAudit, over the in-memory store (./memory-store.ts, which
 * mirrors migration 590's functions) and a made-up website answered from a
 * table. The throttle spaces requests a second apart on real timers, so every
 * test runs on fake timers and steps the clock (drive) instead of waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuditFailure,
  failAudit,
  finalizeAudit,
  runCrawlChunk,
  runDiscovery,
  type AuditRecord,
} from '../engine'
import type { CrawlFetch } from '../fetch'
import { pageRowId } from '../ids'
import { AUDIT_ISSUE_TYPES } from '../issues'
import { CRAWLER_TOKEN } from '../limits'
import type { CrawledPageResult } from '../types'
import {
  crawlRequests,
  drive,
  fakeSite,
  html,
  page,
  redirect,
  text,
  urlset,
  xml,
  type FakeAnswer,
  type FakeRoute,
} from './fake-site'
import { MemoryAuditStore } from './memory-store'

const START = 'https://example.com/'
const at = (path: string) => `https://example.com${path}`
const HOUR = 3_600_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-12T09:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Driving an audit the way the background lane does
// ---------------------------------------------------------------------------

/** runCrawlChunk from `firstChunk` until it says done, sleeping through any pause it asks for. */
async function crawl(
  store: MemoryAuditStore,
  auditId: string,
  fetch: CrawlFetch,
  firstChunk = 0,
): Promise<number> {
  for (let chunkNo = firstChunk; chunkNo < firstChunk + 300; chunkNo++) {
    const outcome = await drive(
      runCrawlChunk(store, auditId, chunkNo, { fetch }),
    )
    if (outcome.done) return chunkNo + 1
    if (outcome.resumeAt !== null) {
      await vi.advanceTimersByTimeAsync(
        Math.max(0, outcome.resumeAt - Date.now()),
      )
    }
  }
  throw new Error('the crawl never finished')
}

async function runAudit(
  store: MemoryAuditStore,
  auditId: string,
  fetch: CrawlFetch,
) {
  await drive(runDiscovery(store, auditId, { fetch }))
  const chunks = await crawl(store, auditId, fetch)
  const { issues } = await drive(finalizeAudit(store, auditId))
  return { chunks, issues }
}

/** "type url" for each saved issue, sorted. */
function issueKeys(store: MemoryAuditStore, auditId: string): string[] {
  return store
    .issueList(auditId)
    .map((issue) => `${issue.issueType} ${issue.pageUrl}`)
    .sort()
}

function auditRow(store: MemoryAuditStore, auditId: string) {
  const row = store.audits.get(auditId)
  if (!row) throw new Error('no audit')
  return row
}

// ---------------------------------------------------------------------------
// The made-up site
// ---------------------------------------------------------------------------

/**
 * Example Studio, ten URLs: a sitemap (/, /about, /services, /orphan), a
 * redirect chain (/old -> /older -> /about), a 404 linked from the home page
 * (/missing), two pages sharing a title (/team, /careers), a page only the
 * sitemap lists (/orphan) and a noindex page (/notes, linked from /about).
 */
function studioSite(overrides: Record<string, FakeRoute> = {}) {
  return fakeSite({
    [at('/robots.txt')]: text(
      'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n',
    ),
    [at('/sitemap.xml')]: xml(
      urlset([START, at('/about'), at('/services'), at('/orphan')]),
    ),
    [START]: html(
      page({
        title: 'Example Studio | Calm websites',
        h1: 'Calm websites for small teams',
        links: [
          '/about',
          '/services',
          '/team',
          '/careers',
          '/old',
          '/missing',
          'https://example.org/partner',
        ],
      }),
    ),
    [at('/about')]: html(
      page({
        title: 'About | Example Studio',
        h1: 'About the studio',
        links: ['/', '/notes'],
      }),
    ),
    [at('/services')]: html(
      page({
        title: 'Services | Example Studio',
        h1: 'What we do',
        links: ['/', '/about'],
      }),
    ),
    [at('/team')]: html(
      page({
        title: 'Join the Example Studio team',
        h1: 'Meet the team',
        links: ['/', '/careers'],
      }),
    ),
    [at('/careers')]: html(
      page({
        title: 'Join the Example Studio team',
        h1: 'Open roles',
        links: ['/', '/team'],
      }),
    ),
    [at('/old')]: redirect('/older'),
    [at('/older')]: redirect('https://example.com/about'),
    [at('/orphan')]: html(
      page({
        title: 'A page only the sitemap lists',
        h1: 'A quiet corner',
        links: ['/'],
      }),
    ),
    [at('/notes')]: html(
      page({
        title: 'Internal notes | Example Studio',
        h1: 'Internal notes',
        links: ['/'],
        robots: 'noindex',
      }),
    ),
    ...overrides,
  })
}

const STUDIO_PAGES = [
  START,
  at('/about'),
  at('/services'),
  at('/team'),
  at('/careers'),
  at('/old'),
  at('/older'),
  at('/missing'),
  at('/orphan'),
  at('/notes'),
]

/** Home links to /p1../p15; each /pN (no meta description) links to /qN. 31 pages. */
function wideSite() {
  const routes: Record<string, FakeRoute> = {
    [START]: html(
      page({
        title: 'Example Studio | Index',
        h1: 'Index of everything',
        links: Array.from({ length: 15 }, (_, i) => `/p${i + 1}`),
      }),
    ),
  }
  for (let i = 1; i <= 15; i++) {
    routes[at(`/p${i}`)] = html(
      page({
        title: `Project ${i} | Example Studio`,
        h1: `Project number ${i}`,
        description: null,
        links: ['/', `/q${i}`],
      }),
    )
    routes[at(`/q${i}`)] = html(
      page({
        title: `Project ${i} notes | Example Studio`,
        h1: `Notes for project ${i}`,
        links: ['/'],
      }),
    )
  }
  return fakeSite(routes)
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

describe('a full audit', () => {
  it('crawls the whole site and reports what is wrong with it, on the right pages', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()

    await runAudit(store, id, site.fetch)

    const audit = auditRow(store, id)
    expect(audit).toMatchObject({
      status: 'completed',
      phase: 'done',
      startUrl: START,
      origin: 'https://example.com',
      pagesCrawled: STUDIO_PAGES.length,
      errorCode: null,
    })
    expect(Date.parse(audit.completedAt ?? '')).not.toBeNaN()
    // Read while the crawl ran, and not kept once it is over.
    expect(audit.robotsTxt).toBeNull()

    expect(
      store
        .pageList(id)
        .map((p) => p.url)
        .sort(),
    ).toEqual([...STUDIO_PAGES].sort())
    expect(issueKeys(store, id)).toEqual([
      `broken-internal-link ${START}`,
      `broken-page ${at('/missing')}`,
      `duplicate-title ${at('/careers')}`,
      `duplicate-title ${at('/team')}`,
      `noindex-page ${at('/notes')}`,
      `orphan-page ${at('/orphan')}`,
      `redirect-chain ${at('/old')}`,
    ])

    const issues = store.issueList(id)
    expect(
      issues.find((i) => i.issueType === 'broken-internal-link'),
    ).toMatchObject({
      pageId: pageRowId(id, START),
      details: { targetUrl: at('/missing'), targetStatus: 404 },
    })
    expect(
      issues.find((i) => i.issueType === 'redirect-chain')?.details,
    ).toEqual({
      hops: [at('/old'), at('/older'), at('/about')],
      finalUrl: at('/about'),
    })

    // The tally is the saved issues, by severity.
    const tally = { critical: 0, warning: 0, info: 0 }
    for (const issue of issues) {
      expect(issue.severity).toBe(AUDIT_ISSUE_TYPES[issue.issueType].severity)
      tally[issue.severity] += 1
    }
    expect(tally).toEqual({ critical: 1, warning: 5, info: 1 })
    expect(audit).toMatchObject({
      criticalCount: tally.critical,
      warningCount: tally.warning,
      infoCount: tally.info,
    })

    // The crawl's own tables are gone; the report stays.
    expect(store.frontier.has(id)).toBe(false)
    expect(store.links.has(id)).toBe(false)
  })

  it('fetches every page once, follows redirects through the queue, and never leaves the site', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()

    await runAudit(store, id, site.fetch)

    // The start page twice: the probe for redirects, then the crawl.
    expect(site.count(START)).toBe(2)
    for (const url of STUDIO_PAGES.filter((u) => u !== START)) {
      expect(site.count(url), url).toBe(1)
    }
    expect(
      site.urls().filter((u) => !u.startsWith('https://example.com/')),
    ).toEqual([])
    // One page fetch per URL, their starts at least a second apart.
    const fetches = crawlRequests(site.requests)
    expect(fetches).toHaveLength(STUDIO_PAGES.length)
    for (let i = 1; i < fetches.length; i++) {
      expect(fetches[i].at - fetches[i - 1].at).toBeGreaterThanOrEqual(1_000)
    }
  })

  it('records click depth and the in-sitemap flag on each page', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    await runAudit(store, id, studioSite().fetch)

    const at_ = (path: string) => store.pageByUrl(id, at(path))!
    expect(store.pageByUrl(id, START)).toMatchObject({
      crawlDepth: 0,
      inSitemap: true,
    })
    expect(at_('/team')).toMatchObject({ crawlDepth: 1, inSitemap: false })
    // A redirect target continues the same path: the depth of the redirect.
    expect(at_('/older')).toMatchObject({ crawlDepth: 1, inSitemap: false })
    // Seeded from the sitemap and leased before a link reached it: no depth.
    expect(at_('/about')).toMatchObject({ crawlDepth: null, inSitemap: true })
    // Found only through a page with no depth.
    expect(at_('/notes')).toMatchObject({ crawlDepth: null, inSitemap: false })
  })

  it('anchors to where the start URL redirects', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: 'http://example.com/' })
    const site = studioSite({ 'http://example.com/': redirect(START) })

    await runAudit(store, id, site.fetch)

    expect(auditRow(store, id)).toMatchObject({
      status: 'completed',
      startUrl: START,
      origin: 'https://example.com',
    })
    expect(site.count('http://example.com/')).toBe(1)
    expect(store.pageList(id)).toHaveLength(STUDIO_PAGES.length)
  })

  it('is a no-op when finalize runs again', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    await runAudit(store, id, studioSite().fetch)
    const before = issueKeys(store, id)

    expect(await drive(finalizeAudit(store, id))).toEqual({ issues: 0 })
    expect(issueKeys(store, id)).toEqual(before)
  })
})

describe('robots.txt', () => {
  it('keeps a section our token is disallowed from out of the crawl', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({
      [at('/robots.txt')]: text(
        `User-agent: *\nAllow: /\n\nUser-agent: ${CRAWLER_TOKEN}\nDisallow: /private/\n`,
      ),
      [at('/sitemap.xml')]: xml(urlset([START, at('/private/listed')])),
      [START]: html(
        page({
          title: 'Example Studio | Calm websites',
          h1: 'Home',
          links: ['/public', '/private/linked'],
        }),
      ),
      [at('/public')]: html(
        page({ title: 'Public | Example Studio', h1: 'Public', links: ['/'] }),
      ),
      [at('/private/linked')]: html(
        page({
          title: 'Private | Example Studio',
          h1: 'Private',
          links: ['/'],
        }),
      ),
      [at('/private/listed')]: html(
        page({ title: 'Listed | Example Studio', h1: 'Listed', links: ['/'] }),
      ),
    })

    await runAudit(store, id, site.fetch)

    expect(site.urls().filter((u) => u.includes('/private/'))).toEqual([])
    expect(
      store
        .pageList(id)
        .map((p) => p.url)
        .sort(),
    ).toEqual([START, at('/public')])
    // A link into the disallowed section is not a broken link.
    expect(issueKeys(store, id)).toEqual([])
    expect(auditRow(store, id).status).toBe('completed')
  })

  it('fails discovery when robots.txt disallows the start page and the sitemap is empty', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({
      [at('/robots.txt')]: text('User-agent: *\nDisallow: /\n'),
      [at('/sitemap.xml')]: xml(urlset([])),
    })

    const failure = await drive(
      runDiscovery(store, id, { fetch: site.fetch }),
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(AuditFailure)
    expect(failure).toMatchObject({ code: 'ROBOTS_DISALLOWED' })
    expect(store.frontierRows(id)).toEqual([])
    expect(auditRow(store, id).phase).toBe('discovery')
    expect(crawlRequests(site.requests)).toEqual([])
  })

  it('fails ROBOTS_UNREACHABLE on a robots.txt that redirects to another site, which may say Disallow: /', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite({
      [at('/robots.txt')]: redirect('https://files.example.org/robots.txt'),
      'https://files.example.org/robots.txt': text(
        'User-agent: *\nDisallow: /\n',
      ),
    })

    const failure = await drive(
      runDiscovery(store, id, { fetch: site.fetch }),
    ).catch((err: unknown) => err)

    expect(failure).toMatchObject({ code: 'ROBOTS_UNREACHABLE' })
    expect(store.frontierRows(id)).toEqual([])
    expect(crawlRequests(site.requests)).toEqual([])
    expect(site.count('https://files.example.org/robots.txt')).toBe(0)
  })

  it('checks a link against robots.txt as the crawl would fetch it (its query re-encoded)', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({
      [at('/robots.txt')]: text('User-agent: *\nDisallow: /*?*return_to=/\n'),
      [START]: html(
        page({
          title: 'Example Studio | Calm websites',
          h1: 'Home',
          links: ['/login?return_to=/account', '/public'],
        }),
      ),
      [at('/public')]: html(
        page({ title: 'Public | Example Studio', h1: 'Public', links: ['/'] }),
      ),
    })

    await runAudit(store, id, site.fetch)

    expect(site.urls().filter((u) => u.includes('/login'))).toEqual([])
    expect(store.pageList(id).map((p) => p.url).sort()).toEqual([START, at('/public')])
  })

  it('applies the rules to the www form of the site’s address too', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({
      [at('/robots.txt')]: text('User-agent: *\nDisallow: /private/\n'),
      [START]: html(
        page({
          title: 'Example Studio | Calm websites',
          h1: 'Home',
          links: ['https://www.example.com/private/linked', '/public'],
        }),
      ),
      [at('/public')]: html(
        page({ title: 'Public | Example Studio', h1: 'Public', links: ['/'] }),
      ),
    })

    await runAudit(store, id, site.fetch)

    expect(site.urls().filter((u) => u.includes('/private/'))).toEqual([])
    expect(auditRow(store, id).status).toBe('completed')
  })

  it.each([
    ['answers 503', text('down', 503)],
    ['cannot be reached', 'fail' as const],
  ])(
    'fails discovery with ROBOTS_UNREACHABLE when robots.txt %s, before any page is read',
    async (_, answer) => {
      const store = new MemoryAuditStore()
      const { id } = store.createAudit({ startUrl: START })
      const site = studioSite({ [at('/robots.txt')]: answer })

      const failure = await drive(
        runDiscovery(store, id, { fetch: site.fetch }),
      ).catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(AuditFailure)
      expect(failure).toMatchObject({ code: 'ROBOTS_UNREACHABLE' })
      expect(store.frontierRows(id)).toEqual([])
      expect(crawlRequests(site.requests)).toEqual([])
    },
  )

  it('fails discovery with ROBOTS_TOO_COMPLEX when our group has more rules than it can follow', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const rules = Array.from(
      { length: 5_001 },
      (_, i) => `Disallow: /r${i}/`,
    ).join('\n')
    const site = studioSite({
      [at('/robots.txt')]: text(`User-agent: *\n${rules}\n`),
    })

    const failure = await drive(
      runDiscovery(store, id, { fetch: site.fetch }),
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(AuditFailure)
    expect(failure).toMatchObject({ code: 'ROBOTS_TOO_COMPLEX' })
    expect(store.frontierRows(id)).toEqual([])
  })

  it('starts from the sitemap when only the start page is disallowed', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({
      [at('/robots.txt')]: text(`User-agent: ${CRAWLER_TOKEN}\nDisallow: /$\n`),
      [at('/sitemap.xml')]: xml(urlset([START, at('/about')])),
      [at('/about')]: html(
        page({ title: 'About | Example Studio', h1: 'About', links: ['/'] }),
      ),
    })

    const { seeded } = await drive(
      runDiscovery(store, id, { fetch: site.fetch }),
    )
    expect(seeded).toBe(1)
    expect(store.frontierRows(id).map((r) => [r.url, r.source])).toEqual([
      [at('/about'), 'sitemap'],
    ])
  })
})

describe('a sitemap that lists another site', () => {
  async function auditWithSitemap(entries: string[]) {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite({ [at('/sitemap.xml')]: xml(urlset(entries)) })
    await drive(runDiscovery(store, id, { fetch: site.fetch }))
    const afterDiscovery = auditRow(store, id).crawlState.sitemapOtherSite
    await crawl(store, id, site.fetch)
    await drive(finalizeAudit(store, id))
    return { store, id, site, afterDiscovery }
  }

  it('reports sitemap-other-site when most entries name another host', async () => {
    const { store, id, site, afterDiscovery } = await auditWithSitemap([
      START,
      at('/about'),
      'https://example.org/',
      'https://example.org/about',
      'https://example.org/services',
    ])
    expect(afterDiscovery).toEqual({
      host: 'example.org',
      count: 3,
      listed: 2,
      sitemapUrl: 'https://example.com/sitemap.xml',
    })
    const issue = store
      .issueList(id)
      .find((i) => i.issueType === 'sitemap-other-site')
    expect(issue).toMatchObject({
      pageId: null,
      pageUrl: 'https://example.com/sitemap.xml',
      severity: 'warning',
      details: {
        otherHost: 'example.org',
        entriesForOtherSite: 3,
        entriesForThisSite: 2,
      },
    })
    expect(auditRow(store, id).status).toBe('completed')
    // The other site's pages are never fetched.
    expect(site.urls().filter((u) => u.includes('example.org'))).toEqual([])
  })

  it.each([
    [
      'this site’s entries are the majority',
      [START, at('/about'), at('/services'), 'https://example.org/'],
    ],
    [
      'the two are even',
      [START, at('/about'), 'https://example.org/', 'https://example.org/a'],
    ],
    ['no entry names another site', [START, at('/about'), at('/services')]],
  ])('does not report it when %s', async (_case, entries) => {
    const { store, id, afterDiscovery } = await auditWithSitemap(entries)
    expect(afterDiscovery).toBeUndefined()
    expect(
      issueKeys(store, id).filter((k) => k.startsWith('sitemap-other-site')),
    ).toEqual([])
  })
})

describe('the page budget', () => {
  it('stops at the budget, says so, and skips the orphan check', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START, maxPages: 3 })
    const site = studioSite({
      [at('/sitemap.xml')]: xml(
        urlset([START, at('/orphan'), at('/about'), at('/services')]),
      ),
    })

    await runAudit(store, id, site.fetch)

    // The start page, then sitemap pages in sitemap order.
    expect(store.pageList(id).map((p) => p.url)).toEqual([
      START,
      at('/orphan'),
      at('/about'),
    ])
    const requested = new Set(site.urls())
    for (const url of [
      at('/services'),
      at('/team'),
      at('/careers'),
      at('/notes'),
    ]) {
      expect(requested.has(url), url).toBe(false)
    }
    const audit = auditRow(store, id)
    expect(audit).toMatchObject({ status: 'completed', pagesCrawled: 3 })

    const limit = store
      .issueList(id)
      .find((i) => i.issueType === 'crawl-page-limit')
    expect(limit).toMatchObject({
      pageId: null,
      pageUrl: START,
      details: { pagesCrawled: 3, maxPages: 3 },
    })
    // Everything the crawl had queued: 4 seeds, 4 new links from the home page, /notes from /about.
    expect(limit?.details.pagesFound).toBe(9)
    // /orphan would be one on a full crawl; here the pages linking to it may just not have been read.
    expect(
      issueKeys(store, id).filter((k) => k.startsWith('orphan-page')),
    ).toEqual([])
    expect(
      issueKeys(store, id).filter((k) => k.startsWith('broken-internal-link')),
    ).toEqual([])
  })
})

describe('a chunk that crashes and is retried', () => {
  it('gets its unsaved URLs back under the same number, without duplicating pages or issues', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = wideSite()

    await drive(runDiscovery(store, id, { fetch: site.fetch }))
    expect(
      (await drive(runCrawlChunk(store, id, 0, { fetch: site.fetch }))).done,
    ).toBe(false)

    // Chunk 1 leases /p1../p15 and saves them in two batches (10, then 5).
    // The second batch writes its rows, then dies before settling its URLs.
    store.failSaveBatch({ skip: 1, afterRows: true })
    await expect(
      drive(runCrawlChunk(store, id, 1, { fetch: site.fetch })),
    ).rejects.toThrow('simulated crash')

    const held = store
      .frontierRows(id)
      .filter((r) => r.state === 'leased')
      .map((r) => r.url)
    expect(held).toHaveLength(5)
    expect(
      store
        .frontierRows(id)
        .filter((r) => r.state === 'leased' && r.chunkNo !== 1),
    ).toEqual([])
    expect(store.pageList(id)).toHaveLength(16)
    const issuesAfterCrash = issueKeys(store, id)

    // The retry: the same chunk number gets exactly those five back.
    const retried = await drive(
      runCrawlChunk(store, id, 1, { fetch: site.fetch }),
    )
    expect(retried.done).toBe(false)
    for (const url of held) expect(site.count(url), url).toBe(2)
    expect(store.pageList(id)).toHaveLength(16)
    expect(issueKeys(store, id)).toEqual(issuesAfterCrash)
    expect(store.frontierRows(id).filter((r) => r.state === 'leased')).toEqual(
      [],
    )

    await crawl(store, id, site.fetch, 2)
    await drive(finalizeAudit(store, id))

    // The same report a run without the crash makes.
    const clean = new MemoryAuditStore()
    const cleanAudit = clean.createAudit({ startUrl: START })
    await runAudit(clean, cleanAudit.id, wideSite().fetch)

    const urls = store.pageList(id).map((p) => p.url)
    expect(urls).toHaveLength(31)
    expect(new Set(urls).size).toBe(31)
    expect(urls.sort()).toEqual(
      clean
        .pageList(cleanAudit.id)
        .map((p) => p.url)
        .sort(),
    )
    expect(issueKeys(store, id)).toEqual(issueKeys(clean, cleanAudit.id))
    expect(
      issueKeys(store, id).filter((k) =>
        k.startsWith('missing-meta-description'),
      ),
    ).toHaveLength(15)
    expect(auditRow(store, id)).toMatchObject({
      status: 'completed',
      pagesCrawled: 31,
      warningCount: auditRow(clean, cleanAudit.id).warningCount,
    })
  })

  it('leaves the URLs of a chunk that died before saving anything leased under its number', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()
    await drive(runDiscovery(store, id, { fetch: site.fetch }))

    store.failSaveBatch()
    await expect(
      drive(runCrawlChunk(store, id, 0, { fetch: site.fetch })),
    ).rejects.toThrow('simulated crash')

    expect(
      store.frontierRows(id).map((r) => [r.url, r.state, r.chunkNo]),
    ).toEqual([
      [START, 'leased', 0],
      [at('/about'), 'leased', 0],
      [at('/services'), 'leased', 0],
      [at('/orphan'), 'leased', 0],
    ])
    expect(store.pageList(id)).toEqual([])
  })

  // Once a bug: counts().pending counted only waiting rows, so the retry of a
  // chunk that had leased every waiting URL saw "nothing pending" and ended
  // the crawl without fetching them. A leased URL now counts as owed.
  it('retrying a chunk that had leased every waiting URL still crawls them', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()
    await drive(runDiscovery(store, id, { fetch: site.fetch }))

    store.failSaveBatch()
    await expect(
      drive(runCrawlChunk(store, id, 0, { fetch: site.fetch })),
    ).rejects.toThrow('simulated crash')

    const retried = await drive(
      runCrawlChunk(store, id, 0, { fetch: site.fetch }),
    )
    expect(
      store
        .pageList(id)
        .map((p) => p.url)
        .sort(),
    ).toEqual([START, at('/about'), at('/services'), at('/orphan')].sort())
    expect(retried.done).toBe(false)
    expect(store.frontierRows(id).filter((r) => r.state === 'leased')).toEqual(
      [],
    )

    await crawl(store, id, site.fetch, 1)
    await drive(finalizeAudit(store, id))
    expect(auditRow(store, id).status).toBe('completed')
    expect(store.pageList(id)).toHaveLength(STUDIO_PAGES.length)
    expect(
      issueKeys(store, id).filter((k) => k.startsWith('crawl-page-limit')),
    ).toEqual([])
  })

  it('a later chunk takes over the URLs an earlier chunk lost, and the audit completes in full', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()
    await drive(runDiscovery(store, id, { fetch: site.fetch }))

    store.failSaveBatch()
    await expect(
      drive(runCrawlChunk(store, id, 0, { fetch: site.fetch })),
    ).rejects.toThrow('simulated crash')
    // Chunk 0 is never retried; chunk 1 runs next.
    const next = await drive(runCrawlChunk(store, id, 1, { fetch: site.fetch }))
    expect(next.done).toBe(false)
    expect(
      store
        .frontierRows(id)
        .filter((r) =>
          [START, at('/about'), at('/services'), at('/orphan')].includes(r.url),
        )
        .map((r) => [r.url, r.state, r.chunkNo]),
    ).toEqual([
      [START, 'crawled', 1],
      [at('/about'), 'crawled', 1],
      [at('/services'), 'crawled', 1],
      [at('/orphan'), 'crawled', 1],
    ])

    await crawl(store, id, site.fetch, 2)
    await drive(finalizeAudit(store, id))
    expect(auditRow(store, id).status).toBe('completed')
    expect(
      store
        .pageList(id)
        .map((p) => p.url)
        .sort(),
    ).toEqual([...STUDIO_PAGES].sort())
    // Each URL fetched once by the crawl: the lost chunk never saved, but did fetch.
    for (const url of STUDIO_PAGES) {
      const fetches = crawlRequests(site.requests).filter((r) => r.url === url)
      expect(fetches.length, url).toBeLessThanOrEqual(2)
    }
  })
})

describe('a site that rate limits the crawler', () => {
  const tooMany: FakeAnswer = {
    status: 429,
    headers: { 'content-type': 'text/html' },
    body: 'Too many requests',
  }

  it('stops with crawl-rate-limited when every page answers 429', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const pages = ['a', 'b', 'c', 'd', 'e'].map((p) => at(`/${p}`))
    const site = fakeSite(
      {
        [at('/robots.txt')]: text('User-agent: *\nAllow: /\n'),
        [at('/sitemap.xml')]: xml(urlset([START, ...pages])),
      },
      tooMany,
    )
    const startedAt = Date.now()

    await runAudit(store, id, site.fetch)

    const audit = auditRow(store, id)
    expect(audit.status).toBe('completed')
    expect(audit.crawlState.stop).toBe('crawl-rate-limited')
    const keys = issueKeys(store, id)
    expect(keys).toContain(`crawl-rate-limited ${START}`)
    expect(
      store.issueList(id).find((i) => i.issueType === 'crawl-rate-limited')
        ?.pageId,
    ).toBeNull()
    expect(keys.filter((k) => k.startsWith('crawl-page-limit'))).toEqual([])
    expect(keys.filter((k) => k.startsWith('orphan-page'))).toEqual([])
    // Three URLs given up on in a row is the stop; each was tried twice.
    const saved = store.pageList(id)
    expect(saved).toHaveLength(3)
    // (Not `rateLimited`: that flag counts attempts inside one fetch, and
    // these retries came in later chunks, after the first pause outlasted
    // the chunk. Nothing reads the flag.)
    for (const p of saved) {
      expect(p).toMatchObject({ fetchClass: 'rate_limited', statusCode: 429 })
    }
    expect(keys.filter((k) => k.startsWith('rate-limited-page'))).toHaveLength(
      3,
    )
    for (const url of [START, ...pages]) {
      expect(
        crawlRequests(site.requests).filter((r) => r.url === url).length,
        url,
      ).toBeLessThanOrEqual(2)
    }
    // Inside the hour of waiting one audit may spend on 429s.
    expect(Date.now() - startedAt).toBeLessThan(HOUR)
  })

  // A robots.txt still refused after its one retry can't be read, and a
  // robots.txt that can't be read means "assume complete disallow".
  it('fails with ROBOTS_UNREACHABLE when even robots.txt answers 429 twice', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({}, tooMany)

    const failure = await drive(
      runDiscovery(store, id, { fetch: site.fetch }),
    ).catch((err: unknown) => err)

    expect(failure).toMatchObject({ code: 'ROBOTS_UNREACHABLE' })
    expect(site.count(at('/robots.txt'))).toBe(2)
    expect(site.count(at('/sitemap.xml'))).toBe(0)
  })

  // Not crawl-rate-limited: only one URL was ever known, and it was refused
  // once (the stop needs three URLs given up in a row).
  it('finishes with its one known page marked rate limited when the sitemap and the pages answer 429', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({ [at('/robots.txt')]: text('no', 404) }, tooMany)

    await runAudit(store, id, site.fetch)

    expect(auditRow(store, id).status).toBe('completed')
    expect(issueKeys(store, id)).toEqual([`rate-limited-page ${START}`])
    expect(site.count(at('/sitemap.xml'))).toBe(2)
  })
})

describe('a site that cannot be reached', () => {
  it('fails in finalize with SITE_UNREACHABLE, and failAudit records it', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    // robots.txt answers (missing); nothing else does.
    const site = fakeSite({ [at('/robots.txt')]: text('no', 404) }, 'fail')

    await drive(runDiscovery(store, id, { fetch: site.fetch }))
    await crawl(store, id, site.fetch)
    expect(
      store.pageList(id).map((p) => [p.url, p.fetchClass, p.statusCode]),
    ).toEqual([[START, 'error', 0]])

    const failure = await drive(finalizeAudit(store, id)).catch(
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(AuditFailure)
    expect(failure).toMatchObject({ code: 'SITE_UNREACHABLE' })
    expect(auditRow(store, id).status).toBe('running')

    const { code, message } = failure as AuditFailure
    await failAudit(store, id, code, message)
    expect(auditRow(store, id)).toMatchObject({
      status: 'failed',
      errorCode: 'SITE_UNREACHABLE',
      errorDetail: message,
    })
    expect(auditRow(store, id).completedAt).not.toBeNull()
    expect(auditRow(store, id).robotsTxt).toBeNull()
    expect(store.frontier.has(id)).toBe(false)
    // What it saved stays readable.
    expect(store.pageList(id)).toHaveLength(1)

    // Failing a finished audit again changes nothing.
    await failAudit(store, id, 'OTHER', 'other')
    expect(auditRow(store, id).errorCode).toBe('SITE_UNREACHABLE')
  })
})

describe('discovery that never ends', () => {
  /** A request that holds on until the fetch's own timeout, as a hung server does. */
  const hang = (opts: { timeoutMs?: number } = {}) =>
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`timed out after ${opts.timeoutMs} ms`)),
        opts.timeoutMs ?? 30_000,
      ),
    )

  it('fails with SITE_UNREACHABLE when its deadline passes and the start page never answered', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const slow = Array.from(
      { length: 200 },
      (_, i) => `Sitemap: https://example.com/slow/${i}.xml`,
    ).join('\n')
    const site = fakeSite({
      [at('/robots.txt')]: text(`User-agent: *\nAllow: /\n${slow}\n`),
    })
    const fetch: CrawlFetch = (url, opts = {}) =>
      url.endsWith('/robots.txt') ? site.fetch(url, opts) : hang(opts)
    const startedAt = Date.now()

    const failure = await drive(runDiscovery(store, id, { fetch })).catch(
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(AuditFailure)
    expect(failure).toMatchObject({ code: 'SITE_UNREACHABLE' })
    expect(store.frontierRows(id)).toEqual([])
    // The probe's hops, then five minutes of sitemaps, then one last timeout.
    expect(Date.now() - startedAt).toBeLessThan(8 * 60_000)
  })
})

describe('an address that grows past the limit', () => {
  it('fails with START_URL_TOO_LONG when the start URL passes 2,048 characters once normalised', async () => {
    const store = new MemoryAuditStore()
    // 1,524 characters as stored; every "(" becomes "%28" once the query is sorted.
    const long = `https://example.com/?q=${'('.repeat(1_500)}`
    const { id } = store.createAudit({ startUrl: long })
    const site = fakeSite({ [at('/robots.txt')]: text('no', 404) })

    const failure = await drive(
      runDiscovery(store, id, { fetch: site.fetch }),
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(AuditFailure)
    expect(failure).toMatchObject({ code: 'START_URL_TOO_LONG' })
    expect(auditRow(store, id).startUrl).toBe(long)
    expect(store.frontierRows(id)).toEqual([])
  })
})

describe('a cancel while a step is running', () => {
  /** What cancelSiteAudit does: the status first, then the crawl's tables. */
  async function cancel(store: MemoryAuditStore, id: string) {
    await store.updateAudit(id, { status: 'canceled', robotsTxt: null })
    await store.clearCrawlTables(id)
  }

  it('a chunk in flight saves nothing more and leaves no queue or link rows behind', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()
    await drive(runDiscovery(store, id, { fetch: site.fetch }))

    let pageFetches = 0
    const fetch: CrawlFetch = async (url, opts) => {
      const response = await site.fetch(url, opts)
      if (opts?.wantBody && (pageFetches += 1) === 2) await cancel(store, id)
      return response
    }
    const outcome = await drive(runCrawlChunk(store, id, 0, { fetch }))

    expect(outcome.done).toBe(true)
    expect(store.frontierRows(id)).toEqual([])
    expect(store.linkRows(id)).toEqual([])
    expect(store.pageList(id)).toEqual([])
    expect(auditRow(store, id)).toMatchObject({
      status: 'canceled',
      robotsTxt: null,
    })
  })

  it('a discovery in flight seeds nothing and writes no robots.txt back', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()
    const fetch: CrawlFetch = async (url, opts) => {
      const response = await site.fetch(url, opts)
      if (url === at('/sitemap.xml')) await cancel(store, id)
      return response
    }

    await drive(runDiscovery(store, id, { fetch }))

    expect(store.frontierRows(id)).toEqual([])
    expect(auditRow(store, id)).toMatchObject({
      status: 'canceled',
      phase: 'discovery',
      robotsTxt: null,
    })
  })
})

describe('what a page’s links may store', () => {
  it('keeps no link target longer than the URL limit', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const long = `/${'a'.repeat(2_100)}`
    const site = fakeSite({
      [at('/robots.txt')]: text('User-agent: *\nAllow: /\n'),
      [START]: html(
        page({ title: 'Example Studio | Calm websites', h1: 'Home', links: [long, '/public'] }),
      ),
    })
    await drive(runDiscovery(store, id, { fetch: site.fetch }))
    await drive(runCrawlChunk(store, id, 0, { fetch: site.fetch }))

    const targets = store.linkRows(id).flatMap((row) => row.targets)
    expect(targets).toEqual([at('/public')])
  })
})

describe('what a finding may carry', () => {
  it('stores a page’s own text in a finding cut to 300 characters', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = fakeSite({
      [at('/robots.txt')]: text('User-agent: *\nAllow: /\n'),
      [START]: html(
        page({
          title: 'Example Studio | Calm websites',
          h1: 'Home',
          robots: `noindex, ${'x'.repeat(50_000)}`,
          links: ['/'],
        }),
        { headers: { 'x-robots-tag': `noindex, ${'y'.repeat(50_000)}` } },
      ),
    })

    await runAudit(store, id, site.fetch)

    const noindex = store
      .issueList(id)
      .find((issue) => issue.issueType === 'noindex-page')
    expect(noindex).toBeDefined()
    expect(String(noindex?.details.robotsMeta)).toHaveLength(300)
    expect(String(noindex?.details.xRobotsTag)).toHaveLength(300)
  })
})

describe('stopping early', () => {
  it('a canceled audit fetches nothing more, and finalize only cleans up', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()

    await drive(runDiscovery(store, id, { fetch: site.fetch }))
    expect(
      (await drive(runCrawlChunk(store, id, 0, { fetch: site.fetch }))).done,
    ).toBe(false)
    const pagesBefore = store.pageList(id).length
    const issuesBefore = issueKeys(store, id)

    await store.updateAudit(id, { status: 'canceled' })
    const requestsBefore = site.requests.length
    const outcome = await drive(
      runCrawlChunk(store, id, 1, { fetch: site.fetch }),
    )

    expect(outcome.done).toBe(true)
    expect(site.requests).toHaveLength(requestsBefore)
    expect(store.pageList(id)).toHaveLength(pagesBefore)

    expect(await drive(finalizeAudit(store, id))).toEqual({ issues: 0 })
    expect(issueKeys(store, id)).toEqual(issuesBefore)
    expect(store.frontier.has(id)).toBe(false)
    expect(auditRow(store, id).status).toBe('canceled')

    await failAudit(store, id, 'X', 'y')
    expect(auditRow(store, id).status).toBe('canceled')
  })

  it('stops at the audit’s time limit and reports crawl-time-limit', async () => {
    const store = new MemoryAuditStore()
    const { id } = store.createAudit({ startUrl: START })
    const site = studioSite()

    await drive(runDiscovery(store, id, { fetch: site.fetch }))
    expect(
      (await drive(runCrawlChunk(store, id, 0, { fetch: site.fetch }))).done,
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * HOUR + 1)
    const requestsBefore = site.requests.length

    expect(
      (await drive(runCrawlChunk(store, id, 1, { fetch: site.fetch }))).done,
    ).toBe(true)
    expect(site.requests).toHaveLength(requestsBefore)
    await drive(finalizeAudit(store, id))

    expect(auditRow(store, id).crawlState.stop).toBe('crawl-time-limit')
    const keys = issueKeys(store, id)
    expect(keys).toContain(`crawl-time-limit ${START}`)
    expect(keys.filter((k) => k.startsWith('orphan-page'))).toEqual([])
  })

  it('answers AUDIT_NOT_FOUND for an audit that does not exist', async () => {
    const store = new MemoryAuditStore()
    const site = studioSite()
    const steps: Array<() => Promise<unknown>> = [
      () => runDiscovery(store, 'missing', { fetch: site.fetch }),
      () => runCrawlChunk(store, 'missing', 0, { fetch: site.fetch }),
      () => finalizeAudit(store, 'missing'),
    ]
    for (const step of steps) {
      await expect(drive(step())).rejects.toMatchObject({
        code: 'AUDIT_NOT_FOUND',
      })
    }
    await expect(failAudit(store, 'missing', 'X', 'y')).resolves.toBeUndefined()
    expect(site.requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The in-memory store itself: it must answer as migration 590's functions do
// ---------------------------------------------------------------------------

function slimCrawled(
  audit: AuditRecord,
  url: string,
  overrides: Partial<CrawledPageResult> = {},
): CrawledPageResult {
  return {
    id: pageRowId(audit.id, url),
    url,
    statusCode: 200,
    fetchClass: 'ok',
    redirectUrl: null,
    title: url,
    metaDescription: '',
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1],
    wordCount: 200,
    contentHash: null,
    isHtml: true,
    rateLimited: false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    links: [],
    hasStructuredData: false,
    hreflangTags: [],
    isIndexable: true,
    responseTimeMs: 10,
    crawlDepth: null,
    inSitemap: false,
    ...overrides,
  }
}

async function seededStore() {
  const store = new MemoryAuditStore()
  const row = store.createAudit({ startUrl: START })
  const audit = (await store.getAudit(row.id))!
  await store.seedFrontier(audit, [
    { url: START, depth: 0, source: 'start', inSitemap: true },
    { url: at('/s1'), depth: null, source: 'sitemap', inSitemap: true },
    { url: at('/s2'), depth: null, source: 'sitemap', inSitemap: true },
  ])
  return { store, audit }
}

describe('MemoryAuditStore mirrors migration 590', () => {
  // seo_audit_start: one live audit per workspace, and a daily limit counted
  // in a log that deleting audits does not touch.
  it('start: hands back the live audit, and refuses the 21st start of a day even after audits were deleted', async () => {
    const store = new MemoryAuditStore()
    const ws = '00000000-0000-4000-8000-0000000000bb'
    const first = store.startAudit(ws, { startUrl: START }, 20)
    expect(first.outcome).toBe('started')
    expect(store.startAudit(ws, { startUrl: START }, 20)).toEqual({
      outcome: 'live',
      auditId: first.auditId,
    })
    // Start, cancel, delete, again and again: the audits go, the log stays.
    for (let n = 1; n <= 20; n++) {
      const live = [...store.audits.values()].find(
        (row) => row.workspaceId === ws && (row.status === 'queued' || row.status === 'running'),
      )!
      await store.updateAudit(live.id, { status: 'canceled' })
      store.deleteAudit(live.id)
      const next = store.startAudit(ws, { startUrl: START }, 20)
      expect(next.outcome, `start ${n + 1}`).toBe(n < 20 ? 'started' : 'limit')
    }
    expect([...store.audits.values()].filter((row) => row.workspaceId === ws)).toHaveLength(0)
    // A day later the log has room again, and rows older than two days are gone.
    await vi.advanceTimersByTimeAsync(49 * HOUR)
    expect(store.startAudit(ws, { startUrl: START }, 20).outcome).toBe('started')
    expect(store.startLog.filter((row) => row.workspaceId === ws)).toHaveLength(1)
  })

  it('seeds each URL once: a seed already queued stays as it is', async () => {
    const { store, audit } = await seededStore()
    await store.seedFrontier(audit, [
      { url: at('/s1'), depth: 0, source: 'start', inSitemap: false },
    ])
    expect(
      store.frontierRows(audit.id).find((r) => r.url === at('/s1')),
    ).toMatchObject({
      depth: null,
      source: 'sitemap',
      inSitemap: true,
    })
  })

  it('skips a seed longer than 2,048 characters and keeps the rest of the batch', async () => {
    const { store, audit } = await seededStore()
    const long = at(`/${'x'.repeat(2048)}`)
    const edge = START + 'y'.repeat(2048 - START.length)
    expect(edge).toHaveLength(2048)
    await store.seedFrontier(audit, [
      { url: long, depth: null, source: 'sitemap', inSitemap: true },
      { url: edge, depth: null, source: 'sitemap', inSitemap: true },
      { url: at('/after'), depth: null, source: 'sitemap', inSitemap: true },
    ])
    const urls = store.frontierRows(audit.id).map((r) => r.url)
    expect(urls).not.toContain(long)
    expect(urls).toContain(edge)
    expect(urls).toContain(at('/after'))
  })

  it('counts a leased URL as still owed: pending is every row not crawled', async () => {
    const { store, audit } = await seededStore()
    await store.claimChunk(audit.id, 0, 2, 100)
    expect(await store.counts(audit.id)).toEqual({
      crawled: 0,
      pending: 3,
      queued: 3,
    })
    await store.saveBatch(audit, {
      pages: [slimCrawled(audit, START)],
      issues: [],
      links: [],
    })
    expect(await store.counts(audit.id)).toEqual({
      crawled: 1,
      pending: 2,
      queued: 3,
    })
  })

  it('lets a later chunk take over rows an earlier chunk still holds, but never a later one’s', async () => {
    const { store, audit } = await seededStore()
    expect(
      (await store.claimChunk(audit.id, 3, 2, 100)).map((l) => l.url),
    ).toEqual([START, at('/s1')])
    // Chunk 2 is not later than 3: it may only take what is waiting.
    expect(
      (await store.claimChunk(audit.id, 2, 10, 100)).map((l) => l.url),
    ).toEqual([at('/s2')])
    // Chunk 5 takes over both leases.
    expect(
      (await store.claimChunk(audit.id, 5, 10, 100)).map((l) => l.url),
    ).toEqual([START, at('/s1'), at('/s2')])
    expect(
      store.frontierRows(audit.id).map((r) => [r.url, r.state, r.chunkNo]),
    ).toEqual([
      [START, 'leased', 5],
      [at('/s1'), 'leased', 5],
      [at('/s2'), 'leased', 5],
    ])
    // Chunk 3 no longer holds anything: a retry of it claims fresh, finding nothing.
    expect(await store.claimChunk(audit.id, 3, 10, 100)).toEqual([])
  })

  it('counts stale-leased sitemap rows as waiting when gating unlisted URLs', async () => {
    const { store, audit } = await seededStore()
    await store.discover(audit, [{ url: at('/l1'), depth: 1 }])
    // Chunk 0 leases START, /l1 and /s1, hands back the first two, and loses /s1.
    await store.claimChunk(audit.id, 0, 3, 100)
    await store.releaseLeases(audit.id, [START, at('/l1')])
    // For chunk 1, /s1 (a stale lease) and /s2 are two waiting sitemap rows,
    // more than the one page left after it: /l1 must wait.
    expect(
      (await store.claimChunk(audit.id, 1, 2, 1)).map((l) => l.url),
    ).toEqual([START, at('/s1')])
  })

  it('returns a claim in claim order whatever the table’s own order, in both branches', async () => {
    const { store, audit } = await seededStore()
    await store.discover(audit, [
      { url: at('/l1'), depth: 1 },
      { url: at('/l2'), depth: 2 },
    ])
    store.scrambleFrontier(audit.id)
    const order = [START, at('/l1'), at('/l2'), at('/s1'), at('/s2')]
    expect(
      (await store.claimChunk(audit.id, 0, 10, 100)).map((l) => l.url),
    ).toEqual(order)
    // The retry branch: the older sitemap rows still come after the link-reached ones.
    store.scrambleFrontier(audit.id)
    expect(
      (await store.claimChunk(audit.id, 0, 10, 100)).map((l) => l.url),
    ).toEqual(order)
  })

  it('claims link-reached URLs before sitemap-only ones, oldest first', async () => {
    const { store, audit } = await seededStore()
    await store.discover(audit, [
      { url: at('/l1'), depth: 1 },
      { url: at('/l2'), depth: 1 },
    ])
    expect(
      (await store.claimChunk(audit.id, 0, 3, 100)).map((l) => l.url),
    ).toEqual([START, at('/l1'), at('/l2')])
    await store.saveBatch(audit, {
      pages: [START, at('/l1'), at('/l2')].map((u) => slimCrawled(audit, u)),
      issues: [],
      links: [],
    })
    expect(await store.claimChunk(audit.id, 1, 10, 100)).toEqual([
      { url: at('/s1'), depth: null, inSitemap: true },
      { url: at('/s2'), depth: null, inSitemap: true },
    ])
    await store.saveBatch(audit, {
      pages: [at('/s1'), at('/s2')].map((u) => slimCrawled(audit, u)),
      issues: [],
      links: [],
    })
    expect(await store.claimChunk(audit.id, 2, 10, 100)).toEqual([])
  })

  it('hands a chunk number that already ran only what it still holds, and claims nothing new for it', async () => {
    const { store, audit } = await seededStore()
    await store.claimChunk(audit.id, 0, 2, 100)
    await store.saveBatch(audit, {
      pages: [slimCrawled(audit, START)],
      issues: [],
      links: [],
    })
    expect(
      (await store.claimChunk(audit.id, 0, 10, 100)).map((l) => l.url),
    ).toEqual([at('/s1')])
    expect(
      store.frontierRows(audit.id).find((r) => r.url === at('/s2'))?.state,
    ).toBe('pending')
  })

  it('claims a URL the sitemap does not list only while the budget after the chunk covers every waiting sitemap URL', async () => {
    const { store, audit } = await seededStore()
    await store.discover(audit, [
      { url: at('/l1'), depth: 1 },
      { url: at('/unknown-depth'), depth: null },
    ])
    // Two sitemap URLs wait; one page left after this chunk: links wait.
    expect(
      (await store.claimChunk(audit.id, 0, 2, 1)).map((l) => l.url),
    ).toEqual([START, at('/s1')])
    await store.saveBatch(audit, {
      pages: [START, at('/s1')].map((u) => slimCrawled(audit, u)),
      issues: [],
      links: [],
    })
    // One sitemap URL waits; one page left after: links may go.
    expect(
      (await store.claimChunk(audit.id, 1, 2, 1)).map((l) => l.url),
    ).toEqual([at('/l1'), at('/unknown-depth')])
  })

  it('always claims the start page, and nothing for a limit of zero', async () => {
    const { store, audit } = await seededStore()
    expect(await store.claimChunk(audit.id, 0, 0, 0)).toEqual([])
    expect(
      (await store.claimChunk(audit.id, 1, 1, -5)).map((l) => l.url),
    ).toEqual([START])
  })

  it('discover: counts new URLs, keeps existing rows, and gives a waiting row without depth the link’s depth', async () => {
    const { store, audit } = await seededStore()
    await store.claimChunk(audit.id, 0, 1, 100) // START leased
    const added = await store.discover(audit, [
      { url: at('/s1'), depth: 2 },
      { url: START, depth: 5 },
      { url: at('/new'), depth: 3 },
      { url: at('/new'), depth: 1 },
      { url: at('/new'), depth: null },
      { url: at('/also-new'), depth: null },
      { url: at(`/${'x'.repeat(2048)}`), depth: 1 },
    ])
    expect(added).toBe(2)
    const rows = Object.fromEntries(
      store.frontierRows(audit.id).map((r) => [r.url, r]),
    )
    expect(rows[at('/s1')]).toMatchObject({
      depth: 2,
      source: 'link',
      inSitemap: true,
      state: 'pending',
    })
    expect(rows[START]).toMatchObject({
      depth: 0,
      source: 'start',
      state: 'leased',
    })
    expect(rows[at('/new')]).toMatchObject({
      depth: 1,
      source: 'link',
      inSitemap: false,
    })
    expect(rows[at('/also-new')]).toMatchObject({ depth: null, source: 'link' })

    // A row that already has a depth keeps it; a null depth changes nothing.
    expect(
      await store.discover(audit, [
        { url: at('/new'), depth: 0 },
        { url: at('/s2'), depth: null },
      ]),
    ).toBe(0)
    expect(
      store.frontierRows(audit.id).find((r) => r.url === at('/new'))?.depth,
    ).toBe(1)
    expect(
      store.frontierRows(audit.id).find((r) => r.url === at('/s2')),
    ).toMatchObject({ depth: null, source: 'sitemap' })
  })

  it('saveBatch marks URLs crawled; releaseLeases hands back only leased ones', async () => {
    const { store, audit } = await seededStore()
    await store.claimChunk(audit.id, 0, 3, 100)
    await store.saveBatch(audit, {
      pages: [slimCrawled(audit, START)],
      issues: [],
      links: [],
    })
    await store.releaseLeases(audit.id, [START, at('/s1'), at('/s2')])
    expect(
      store.frontierRows(audit.id).map((r) => [r.url, r.state, r.chunkNo]),
    ).toEqual([
      [START, 'crawled', 0],
      [at('/s1'), 'pending', null],
      [at('/s2'), 'pending', null],
    ])
    expect(await store.counts(audit.id)).toEqual({
      crawled: 1,
      pending: 2,
      queued: 3,
    })
  })

  it('refuses an issue whose page was never saved (the foreign key)', async () => {
    const { store, audit } = await seededStore()
    await expect(
      store.saveIssues(audit, [
        {
          issueType: 'missing-title',
          pageId: pageRowId(audit.id, START),
          pageUrl: START,
        },
      ]),
    ).rejects.toThrow('page_id_fkey')
    await store.saveIssues(audit, [
      { issueType: 'crawl-page-limit', pageId: null, pageUrl: START },
    ])
    expect(await store.issueTally(audit.id)).toEqual({
      critical: 0,
      warning: 1,
      info: 0,
    })
  })

  it('brokenLinks: stored targets that are saved ok pages with a status of 400 or more', async () => {
    const { store, audit } = await seededStore()
    await store.saveBatch(audit, {
      pages: [
        slimCrawled(audit, START),
        slimCrawled(audit, at('/gone'), { statusCode: 404 }),
        slimCrawled(audit, at('/down'), { statusCode: 500 }),
        slimCrawled(audit, at('/walled'), {
          statusCode: 403,
          fetchClass: 'blocked',
        }),
        slimCrawled(audit, at('/moved'), {
          statusCode: 301,
          redirectUrl: at('/gone'),
        }),
      ],
      issues: [],
      links: [
        {
          pageId: pageRowId(audit.id, START),
          url: START,
          targets: [
            at('/gone'),
            at('/down'),
            at('/walled'),
            at('/moved'),
            at('/never-crawled'),
          ],
        },
      ],
    })
    expect(await store.brokenLinks(audit.id, 10)).toEqual([
      {
        sourcePageId: pageRowId(audit.id, START),
        sourceUrl: START,
        targetUrl: at('/down'),
        targetStatus: 500,
      },
      {
        sourcePageId: pageRowId(audit.id, START),
        sourceUrl: START,
        targetUrl: at('/gone'),
        targetStatus: 404,
      },
    ])
    expect(await store.brokenLinks(audit.id, 1)).toHaveLength(1)
  })

  it('orphanPages: ok 2xx pages no other page links to, but never the start page or a redirect target', async () => {
    const { store, audit } = await seededStore()
    await store.saveBatch(audit, {
      pages: [
        slimCrawled(audit, START),
        slimCrawled(audit, at('/linked')),
        slimCrawled(audit, at('/self-only'), { links: [] }),
        slimCrawled(audit, at('/alone')),
        slimCrawled(audit, at('/redirect-target')),
        slimCrawled(audit, at('/hop'), {
          statusCode: 301,
          redirectUrl: at('/redirect-target'),
        }),
        slimCrawled(audit, at('/gone'), { statusCode: 404 }),
        slimCrawled(audit, at('/walled'), {
          statusCode: 403,
          fetchClass: 'blocked',
        }),
      ],
      issues: [],
      links: [
        {
          pageId: pageRowId(audit.id, START),
          url: START,
          targets: [at('/linked'), START],
        },
        {
          pageId: pageRowId(audit.id, at('/self-only')),
          url: at('/self-only'),
          targets: [at('/self-only')],
        },
      ],
    })
    expect(
      (await store.orphanPages(audit.id, START)).map((o) => o.url).sort(),
    ).toEqual([at('/alone'), at('/self-only')])
  })
})
