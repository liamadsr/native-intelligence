/**
 * Per-page issues (../page-reporters.ts). Cases ported from OpenSEO's
 * page-reporters tests (MIT).
 */
import { describe, expect, it } from 'vitest'
import { runPageReporters } from '../page-reporters'
import type { CrawledPageResult, PageLink } from '../types'

const HEALTHY_LINK: PageLink = {
  targetUrl: 'https://example.com/catalog',
  anchor: 'Catalog',
  isInternal: true,
  isNofollow: false,
}

function makePage(overrides: Partial<CrawledPageResult>): CrawledPageResult {
  return {
    id: 'page-1',
    url: 'https://example.com/a',
    statusCode: 200,
    fetchClass: 'ok',
    redirectUrl: null,
    title: 'A perfectly reasonable page title',
    metaDescription:
      'A reasonable meta description that says something useful about the page.',
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
    headingOrder: [1, 2, 3],
    wordCount: 500,
    contentHash: 'abc123',
    isHtml: true,
    rateLimited: false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    links: [HEALTHY_LINK],
    hasStructuredData: false,
    hreflangTags: [],
    isIndexable: true,
    responseTimeMs: 200,
    crawlDepth: 1,
    inSitemap: true,
    ...overrides,
  }
}

function issueTypes(page: CrawledPageResult): string[] {
  return runPageReporters(page).map((issue) => issue.issueType)
}

describe('runPageReporters', () => {
  it('reports nothing for a healthy page', () => {
    expect(issueTypes(makePage({}))).toEqual([])
  })

  it('names the page on every issue', () => {
    const [issue] = runPageReporters(makePage({ title: '' }))
    expect(issue).toMatchObject({
      issueType: 'missing-title',
      pageId: 'page-1',
      pageUrl: 'https://example.com/a',
    })
  })

  it('keeps the known signals on an unread app shell without inventing missing-content issues', () => {
    expect(
      issueTypes(
        makePage({
          javascriptShell: true,
          title: '',
          metaDescription: '',
          h1Count: 0,
          wordCount: 1,
          links: [],
          isIndexable: false,
          robotsMeta: 'noindex',
          canonicalUrl: 'https://example.com/canonical',
          headerCanonicalUrl: 'https://example.com/header-canonical',
          responseTimeMs: 2000,
          crawlDepth: 5,
        }),
      ),
    ).toEqual([
      'slow-response',
      'noindex-page',
      'canonical-conflict',
      'canonicalized-page',
      'deep-page',
      'javascript-rendering-suspected',
    ])
  })

  // A fetch that never produced a page yields exactly its fetch issue, and
  // none of the content checks.
  it.each([
    [{ fetchClass: 'blocked', statusCode: 403 }, ['blocked-page']],
    [{ fetchClass: 'rate_limited', statusCode: 429 }, ['rate-limited-page']],
    [{ fetchClass: 'error', statusCode: 0 }, []],
  ] as const)('reports %o as %j', (overrides, expected) => {
    expect(issueTypes(makePage({ ...overrides, title: '' }))).toEqual(expected)
  })

  it('classifies error statuses by range, and a lone redirect as nothing', () => {
    expect(issueTypes(makePage({ statusCode: 500 }))).toEqual(['server-error'])
    expect(issueTypes(makePage({ statusCode: 503 }))).toEqual(['server-error'])
    expect(issueTypes(makePage({ statusCode: 404 }))).toEqual(['broken-page'])
    expect(issueTypes(makePage({ statusCode: 410 }))).toEqual(['broken-page'])
    expect(
      issueTypes(
        makePage({ statusCode: 301, redirectUrl: 'https://example.com/b' }),
      ),
    ).toEqual([])
  })

  it.each<[Partial<CrawledPageResult>, string]>([
    [{ title: '' }, 'missing-title'],
    [{ title: 'x'.repeat(70) }, 'title-too-long'],
    [{ title: 'Tiny' }, 'title-too-short'],
    [{ metaDescription: '' }, 'missing-meta-description'],
    [{ metaDescription: 'x'.repeat(200) }, 'meta-description-too-long'],
    [{ metaDescription: 'x'.repeat(69) }, 'meta-description-too-short'],
    [{ h1Count: 0 }, 'missing-h1'],
    [{ h1Count: 3 }, 'multiple-h1'],
    [{ headingOrder: [1, 2, 4] }, 'heading-order-skip'],
    [{ wordCount: 50 }, 'thin-content'],
    [{ responseTimeMs: 3000 }, 'slow-response'],
    [{ crawlDepth: 6 }, 'deep-page'],
    [{ crawlDepth: 5 }, 'deep-page'],
    [{ links: [] }, 'no-outgoing-links'],
    [{ imagesMissingAlt: 2, imagesTotal: 3 }, 'images-missing-alt'],
    [{ isIndexable: false, xRobotsTag: 'noindex' }, 'noindex-page'],
    [{ canonicalUrl: 'https://example.com/other' }, 'canonicalized-page'],
    [{ headerCanonicalUrl: 'https://example.com/other' }, 'canonicalized-page'],
  ])('flags %o as %s', (overrides, issueType) => {
    expect(issueTypes(makePage(overrides))).toContain(issueType)
  })

  it.each<[Partial<CrawledPageResult>, string]>([
    [{ metaDescription: 'x'.repeat(70) }, 'meta-description-too-short'],
    [{ metaDescription: 'x'.repeat(160) }, 'meta-description-too-long'],
    [{ title: 'x'.repeat(60) }, 'title-too-long'],
    [{ title: 'x'.repeat(10) }, 'title-too-short'],
    [
      { wordCount: 50, isIndexable: false, robotsMeta: 'noindex' },
      'thin-content',
    ],
    [{ crawlDepth: null }, 'deep-page'],
    [{ crawlDepth: 4 }, 'deep-page'],
    [{ links: [], isIndexable: false }, 'no-outgoing-links'],
    [{ responseTimeMs: 1500 }, 'slow-response'],
    [{ headingOrder: [1, 2, 3, 2, 1, 2] }, 'heading-order-skip'],
    [{ canonicalUrl: 'https://example.com/a' }, 'canonicalized-page'],
  ])('does not flag %o as %s', (overrides, issueType) => {
    expect(issueTypes(makePage(overrides))).not.toContain(issueType)
  })

  it('reports the offending meta description with its length and the guideline', () => {
    expect(
      runPageReporters(makePage({ metaDescription: 'x'.repeat(69) })).find(
        (issue) => issue.issueType === 'meta-description-too-short',
      )?.details,
    ).toEqual({ length: 69, min: 70, description: 'x'.repeat(69) })
  })

  it('cuts a long flagged title to 100 characters in the details', () => {
    expect(
      runPageReporters(makePage({ title: 'y'.repeat(300) })).find(
        (issue) => issue.issueType === 'title-too-long',
      )?.details,
    ).toEqual({ length: 300, max: 60, title: `${'y'.repeat(100)}…` })
  })

  it('cuts a flagged title by characters, never through the middle of one', () => {
    const title = `${'y'.repeat(99)}${'😀'.repeat(50)}`
    const details = runPageReporters(makePage({ title })).find(
      (issue) => issue.issueType === 'title-too-long',
    )?.details
    expect(details?.title).toBe(`${'y'.repeat(99)}😀…`)
  })

  // The same empty shell: a PDF gets no content checks, an HTML page all of them.
  it.each([
    [false, []],
    [
      true,
      [
        'missing-title',
        'missing-meta-description',
        'missing-h1',
        'thin-content',
      ],
    ],
  ])('with isHtml %s an empty page reports %j', (isHtml, expected) => {
    expect(
      issueTypes(
        makePage({
          isHtml,
          title: '',
          metaDescription: '',
          h1Count: 0,
          headingOrder: [],
          wordCount: 0,
          contentHash: null,
        }),
      ),
    ).toEqual(expected)
  })

  it('reports a slow PDF as slow, and nothing else', () => {
    expect(
      issueTypes(makePage({ isHtml: false, responseTimeMs: 4000, title: '' })),
    ).toEqual(['slow-response'])
  })

  it('flags conflicting canonicals, and none when the canonical is the page itself', () => {
    const conflicted = issueTypes(
      makePage({
        canonicalUrl: 'https://example.com/canonical-a',
        headerCanonicalUrl: 'https://example.com/canonical-b',
      }),
    )
    expect(conflicted).toContain('canonical-conflict')
    expect(conflicted).toContain('canonicalized-page')

    expect(
      issueTypes(
        makePage({
          canonicalUrl: 'https://example.com/a',
          headerCanonicalUrl: 'https://example.com/a',
        }),
      ),
    ).toEqual([])
  })
})
