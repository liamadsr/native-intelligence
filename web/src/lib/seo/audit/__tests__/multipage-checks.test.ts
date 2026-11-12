/**
 * Cross-page checks that need no database (../multipage-checks.ts):
 * duplicate groups and redirect chains and loops. Cases ported from OpenSEO's
 * page-reporters tests (MIT).
 */
import { describe, expect, it } from 'vitest'
import {
  findDuplicates,
  findRedirectChainsAndLoops,
  type SlimPage,
} from '../multipage-checks'

function makeSlimPage(overrides: Partial<SlimPage>): SlimPage {
  return {
    id: overrides.url ?? 'page',
    url: 'https://example.com/a',
    statusCode: 200,
    fetchClass: 'ok',
    title: null,
    metaDescription: null,
    contentHash: null,
    redirectUrl: null,
    wordCount: 100,
    isIndexable: true,
    canonicalUrl: null,
    headerCanonicalUrl: null,
    ...overrides,
  }
}

const byType = (issues: ReturnType<typeof findDuplicates>, type: string) =>
  issues.filter((issue) => issue.issueType === type)

describe('findDuplicates', () => {
  it('flags every page of a duplicate-title group and names the others', () => {
    const issues = findDuplicates([
      makeSlimPage({ url: 'https://example.com/a', title: 'Same' }),
      makeSlimPage({ url: 'https://example.com/b', title: 'Same' }),
      makeSlimPage({ url: 'https://example.com/c', title: 'Different' }),
    ])
    const titles = byType(issues, 'duplicate-title')
    expect(titles.map((issue) => issue.pageUrl)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ])
    expect(titles[0].details).toEqual({
      groupSize: 2,
      otherUrls: ['https://example.com/b'],
    })
    expect(titles[0].pageId).toBe('https://example.com/a')
  })

  it('names at most three other pages of a large group', () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      makeSlimPage({ url: `https://example.com/${i}`, title: 'Same' }),
    )
    const [first] = byType(findDuplicates(pages), 'duplicate-title')
    expect(first.details?.groupSize).toBe(6)
    expect(first.details?.otherUrls).toHaveLength(3)
  })

  it('groups duplicate meta descriptions', () => {
    const issues = findDuplicates([
      makeSlimPage({
        url: 'https://example.com/a',
        metaDescription: 'Same words',
      }),
      makeSlimPage({
        url: 'https://example.com/b',
        metaDescription: 'Same words',
      }),
    ])
    expect(byType(issues, 'duplicate-meta-description')).toHaveLength(2)
  })

  it('leaves out noindexed, canonicalized, blocked, redirected and broken pages', () => {
    const issues = findDuplicates([
      makeSlimPage({ url: 'https://example.com/a', title: 'Same' }),
      makeSlimPage({
        url: 'https://example.com/b',
        title: 'Same',
        canonicalUrl: 'https://example.com/a',
      }),
      makeSlimPage({
        url: 'https://example.com/b2',
        title: 'Same',
        headerCanonicalUrl: 'https://example.com/a',
      }),
      makeSlimPage({
        url: 'https://example.com/c',
        title: 'Same',
        isIndexable: false,
      }),
      makeSlimPage({
        url: 'https://example.com/d',
        title: 'Same',
        fetchClass: 'blocked',
        statusCode: 403,
      }),
      makeSlimPage({
        url: 'https://example.com/e',
        title: 'Same',
        statusCode: 301,
      }),
      makeSlimPage({
        url: 'https://example.com/f',
        title: 'Same',
        statusCode: 404,
      }),
      makeSlimPage({
        url: 'https://example.com/g',
        title: 'Same',
        statusCode: null,
      }),
    ])
    expect(issues).toHaveLength(0)
  })

  it('keeps a page whose canonical is itself', () => {
    const issues = findDuplicates([
      makeSlimPage({
        url: 'https://example.com/a',
        title: 'Same',
        canonicalUrl: 'https://example.com/a',
      }),
      makeSlimPage({ url: 'https://example.com/b', title: 'Same' }),
    ])
    expect(byType(issues, 'duplicate-title')).toHaveLength(2)
  })

  it('groups duplicate content by hash only when there is text', () => {
    const issues = findDuplicates([
      makeSlimPage({ url: 'https://example.com/a', contentHash: 'h1' }),
      makeSlimPage({ url: 'https://example.com/b', contentHash: 'h1' }),
      makeSlimPage({
        url: 'https://example.com/empty-1',
        contentHash: 'h2',
        wordCount: 0,
      }),
      makeSlimPage({
        url: 'https://example.com/empty-2',
        contentHash: 'h2',
        wordCount: 0,
      }),
    ])
    expect(byType(issues, 'duplicate-content').map((i) => i.pageUrl)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ])
  })

  it('does not group empty titles', () => {
    expect(
      findDuplicates([
        makeSlimPage({ url: 'https://example.com/a', title: '' }),
        makeSlimPage({ url: 'https://example.com/b', title: '' }),
      ]),
    ).toEqual([])
  })
})

describe('findRedirectChainsAndLoops', () => {
  const redirect = (url: string, target: string, statusCode = 301) =>
    makeSlimPage({ url, statusCode, redirectUrl: target })

  it('ignores single redirects', () => {
    expect(
      findRedirectChainsAndLoops([
        redirect('https://example.com/a', 'https://example.com/b'),
        makeSlimPage({ url: 'https://example.com/b' }),
      ]),
    ).toHaveLength(0)
  })

  it('flags a chain once, on its head, with every hop', () => {
    const issues = findRedirectChainsAndLoops([
      redirect('https://example.com/a', 'https://example.com/b'),
      redirect('https://example.com/b', 'https://example.com/c', 302),
      redirect('https://example.com/c', 'https://example.com/d', 308),
      makeSlimPage({ url: 'https://example.com/d' }),
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      issueType: 'redirect-chain',
      pageUrl: 'https://example.com/a',
      pageId: 'https://example.com/a',
      details: {
        hops: [
          'https://example.com/a',
          'https://example.com/b',
          'https://example.com/c',
          'https://example.com/d',
        ],
        finalUrl: 'https://example.com/d',
      },
    })
  })

  it('counts a chain to a page the crawl never saved', () => {
    const issues = findRedirectChainsAndLoops([
      redirect('https://example.com/a', 'https://example.com/b'),
      redirect('https://example.com/b', 'https://example.org/elsewhere'),
    ])
    expect(issues.map((i) => i.issueType)).toEqual(['redirect-chain'])
  })

  it.each([
    [
      'a two-page loop',
      [
        redirect('https://example.com/a', 'https://example.com/b'),
        redirect('https://example.com/b', 'https://example.com/a'),
      ],
    ],
    [
      'a self-loop',
      [redirect('https://example.com/a', 'https://example.com/a')],
    ],
    [
      'a three-page loop',
      [
        redirect('https://example.com/a', 'https://example.com/b'),
        redirect('https://example.com/b', 'https://example.com/c'),
        redirect('https://example.com/c', 'https://example.com/a'),
      ],
    ],
  ])('flags %s once', (_case, pages) => {
    const issues = findRedirectChainsAndLoops(pages)
    expect(issues).toHaveLength(1)
    expect(issues[0].issueType).toBe('redirect-loop')
  })

  it('flags a chain that runs into a loop as a loop, on its head', () => {
    const issues = findRedirectChainsAndLoops([
      redirect('https://example.com/a', 'https://example.com/b'),
      redirect('https://example.com/b', 'https://example.com/c'),
      redirect('https://example.com/c', 'https://example.com/b'),
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      issueType: 'redirect-loop',
      pageUrl: 'https://example.com/a',
      details: {
        hops: [
          'https://example.com/a',
          'https://example.com/b',
          'https://example.com/c',
          'https://example.com/b',
        ],
      },
    })
  })

  it('ignores 3xx rows without a target', () => {
    expect(
      findRedirectChainsAndLoops([
        makeSlimPage({ url: 'https://example.com/a', statusCode: 301 }),
      ]),
    ).toEqual([])
  })
})
