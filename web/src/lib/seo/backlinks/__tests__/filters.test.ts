/**
 * The backlinks profile's filters as provider expressions (../filters.ts),
 * with the source project's cases.
 */
import { describe, expect, it } from 'vitest'
import {
  buildBacklinksRowsApiFilters,
  buildBacklinksRowsOrderBy,
  buildReferringDomainsApiFilters,
  buildTopPagesApiFilters,
  buildTopPagesOrderBy,
} from '../filters'

describe('buildBacklinksRowsApiFilters', () => {
  it('ORs include terms in one group and ANDs everything else', () => {
    expect(
      buildBacklinksRowsApiFilters({
        include: 'blog, news',
        exclude: 'spam',
        minDomainRank: 30,
        linkType: 'dofollow',
        hideLost: true,
      }),
    ).toEqual([
      [['url_from', 'ilike', '%blog%'], 'or', ['url_from', 'ilike', '%news%']],
      'and',
      ['url_from', 'not_ilike', '%spam%'],
      'and',
      ['domain_from_rank', '>=', 30],
      'and',
      ['dofollow', '=', true],
      'and',
      ['is_lost', '=', false],
    ])
  })

  it('emits a single include term as a plain condition', () => {
    expect(buildBacklinksRowsApiFilters({ include: 'blog' })).toEqual([
      ['url_from', 'ilike', '%blog%'],
    ])
  })

  it('escapes LIKE wildcards in terms', () => {
    expect(buildBacklinksRowsApiFilters({ exclude: '100%_off' })).toEqual([
      ['url_from', 'not_ilike', '%100\\%\\_off%'],
    ])
  })

  it('refuses more than eight conditions before anything is bought', () => {
    expect(() =>
      buildBacklinksRowsApiFilters({
        include: 'a, b, c, d, e',
        exclude: 'f, g, h, i',
      }),
    ).toThrowError(/Too many filter conditions/)
  })
})

describe('per-list filter builders', () => {
  it.each([
    {
      name: 'referring domains',
      build: () =>
        buildReferringDomainsApiFilters({
          include: 'edu',
          minBacklinks: 5,
          maxSpamScore: 30,
        }),
      expected: [
        ['domain', 'ilike', '%edu%'],
        'and',
        ['backlinks', '>=', 5],
        'and',
        ['backlinks_spam_score', '<=', 30],
      ],
    },
    {
      name: 'top pages',
      build: () =>
        buildTopPagesApiFilters({ include: '/blog', minReferringDomains: 2 }),
      expected: [
        ['url', 'ilike', '%/blog%'],
        'and',
        ['referring_domains', '>=', 2],
      ],
    },
  ])('$name uses its own field names', ({ build, expected }) => {
    expect(build()).toEqual(expected)
  })

  it('maps sort fields to the provider’s names', () => {
    expect(buildBacklinksRowsOrderBy('domainRank', 'desc')).toEqual([
      'domain_from_rank,desc',
    ])
    expect(buildTopPagesOrderBy('referringDomains', 'asc')).toEqual([
      'referring_domains,asc',
    ])
  })
})
