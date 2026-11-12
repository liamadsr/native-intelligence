/**
 * The pure rules of keyword research: payload mapping, the auto blend's
 * interleave, the wildcard search, and the research table's filters and sort.
 *
 * Adapted from OpenSEO (MIT, see ../../THIRD_PARTY_NOTICES.md).
 */
import { describe, expect, it } from 'vitest'
import {
  countNonSeedKeywords,
  interleaveRows,
  keywordWildcardError,
  mapAdsKeywordItems,
  mapKeywordDataItems,
  trendFrom,
  wildcardAnchor,
  wildcardFilters,
} from '../rows'
import {
  filterAndSortKeywordRows,
  normalizeIntent,
  normalizeTag,
  normalizeTags,
  seoMarketOptions,
  type KeywordRow,
} from '../view'

const row = (keyword: string, extra: Partial<KeywordRow> = {}): KeywordRow => ({
  keyword,
  search_volume: 1000,
  cpc: 1.5,
  competition: 0.4,
  keyword_difficulty: 20,
  intent: 'informational',
  trend: [{ year: 2026, month: 7, search_volume: 1000 }],
  ...extra,
})

describe('interleaveRows', () => {
  it.each([
    {
      name: 'alternates sources, dedupes by keyword, and respects the limit',
      first: ['a', 'b', 'c'],
      second: ['x', 'a', 'y'],
      limit: 4,
      expected: ['a', 'x', 'b', 'c'],
    },
    {
      name: 'drains the longer source when the other runs out',
      first: ['a'],
      second: ['x', 'y', 'z'],
      limit: 10,
      expected: ['a', 'x', 'y', 'z'],
    },
  ])('$name', ({ first, second, limit, expected }) => {
    expect(
      interleaveRows(
        first.map((k) => row(k)),
        second.map((k) => row(k)),
        limit,
      ).map((r) => r.keyword),
    ).toEqual(expected)
  })

  it('counts keywords besides the seed', () => {
    expect(
      countNonSeedKeywords(
        [row('caregiving'), row('caregiver'), row('respite care')],
        ' Caregiving ',
      ),
    ).toBe(2)
  })
})

describe('mapping provider rows', () => {
  it('dedupes case variants of Google Ads rows, skips empty ones, and turns the 0-100 index into a ratio', () => {
    const rows = mapAdsKeywordItems([
      {
        keyword: 'northern lights tour',
        search_volume: 320,
        competition_index: 45,
      },
      { keyword: 'Northern Lights Tour', search_volume: 320 },
      { keyword: undefined },
    ])
    expect(rows).toEqual([
      {
        keyword: 'northern lights tour',
        search_volume: 320,
        cpc: null,
        competition: 0.45,
        keyword_difficulty: null,
        intent: 'unknown',
        trend: [],
      },
    ])
  })

  it('prefers clickstream volumes when present and keeps the first row of a keyword', () => {
    const rows = mapKeywordDataItems([
      {
        keyword: 'Trail Shoes',
        keyword_info: {
          search_volume: 9000,
          cpc: 2,
          competition: 0.5,
          monthly_searches: [{ year: 2026, month: 9, search_volume: 9000 }],
        },
        keyword_info_normalized_with_clickstream: {
          search_volume: 7100,
          monthly_searches: [{ year: 2026, month: 9, search_volume: 7100 }],
        },
        keyword_properties: { keyword_difficulty: 41.6 },
        search_intent_info: { main_intent: 'Commercial' },
      },
      { keyword: 'trail shoes', keyword_info: { search_volume: 1 } },
    ])
    expect(rows).toEqual([
      {
        keyword: 'trail shoes',
        search_volume: 7100,
        cpc: 2,
        competition: 0.5,
        keyword_difficulty: 42,
        intent: 'commercial',
        trend: [{ year: 2026, month: 9, search_volume: 7100 }],
      },
    ])
  })

  it('orders a trend oldest first and drops entries without a month', () => {
    expect(
      trendFrom([
        { year: 2026, month: 2, search_volume: 20 },
        { year: 2025, month: 12, search_volume: 10 },
        { year: null, month: 1, search_volume: 5 },
      ]),
    ).toEqual([
      { year: 2025, month: 12, search_volume: 10 },
      { year: 2026, month: 2, search_volume: 20 },
    ])
  })

  it('maps the provider’s intents onto ours', () => {
    expect(
      [
        'Informational',
        'commercial',
        'TRANSACTIONAL',
        'navigational',
        'other',
        null,
      ].map(normalizeIntent),
    ).toEqual([
      'informational',
      'commercial',
      'transactional',
      'navigational',
      'unknown',
      'unknown',
    ])
  })
})

describe('wildcard seeds', () => {
  it('searches the longest literal stretch, filtered on word boundaries', () => {
    expect(wildcardAnchor('best * for dogs')).toBe('for dogs')
    expect(wildcardFilters('best * for dogs')).toEqual([
      ['keyword', 'like', 'best % for dogs'],
      'or',
      ['keyword', 'like', 'best % for dogs %'],
      'or',
      ['keyword', 'like', '% best % for dogs'],
      'or',
      ['keyword', 'like', '% best % for dogs %'],
    ])
  })

  it('escapes like wildcards the person typed', () => {
    expect(JSON.stringify(wildcardFilters('100% * cotton'))).toContain(
      '100\\\\% % cotton',
    )
  })

  it('refuses a bare * and a country served from Google Ads data', () => {
    expect(keywordWildcardError('*', 2840)).toMatch(/at least one word/)
    expect(keywordWildcardError('best * for dogs', 2352)).toBe(
      'Wildcard search isn’t available for this country.',
    )
    expect(keywordWildcardError('best * for dogs', 2840)).toBeNull()
    expect(keywordWildcardError('running shoes', 2352)).toBeNull()
  })
})

describe('the research table’s filters and sort', () => {
  const seed = row('caregiving', {
    search_volume: 110000,
    keyword_difficulty: 60,
    intent: 'informational',
  })
  const opportunity = row('caregiver', {
    search_volume: 110000,
    keyword_difficulty: 20,
    intent: 'commercial',
  })
  const siblings = ['respite care', 'elder care', 'adult day care'].map(
    (keyword) => row(keyword, { search_volume: 500, keyword_difficulty: null }),
  )
  const rows = [seed, opportunity, ...siblings]

  it('keeps a low-difficulty commercial keyword that shares its volume with the seed', () => {
    expect(
      filterAndSortKeywordRows(
        rows,
        { max_difficulty: 30, intents: ['commercial'] },
        { by: 'keyword' },
      ),
    ).toEqual([opportunity])
  })

  it('requires every include term and drops any exclude term', () => {
    expect(
      filterAndSortKeywordRows(
        rows,
        { include: ['care', ' DAY'], exclude: ['elder', 'giv'] },
        { by: 'keyword' },
      ).map((r) => r.keyword),
    ).toEqual(['adult day care'])
    expect(
      filterAndSortKeywordRows(
        rows,
        { include: ['care'], exclude: ['elder', 'giv'] },
        { by: 'keyword' },
      ).map((r) => r.keyword),
    ).toEqual(['adult day care', 'respite care'])
  })

  it('sorts by volume high first by default, keeping missing numbers last whichever way', () => {
    const withNull = [...rows, row('unknown volume', { search_volume: null })]
    expect(
      filterAndSortKeywordRows(withNull)
        .map((r) => r.keyword)
        .slice(-1),
    ).toEqual(['unknown volume'])
    expect(
      filterAndSortKeywordRows(
        withNull,
        {},
        { by: 'search_volume', dir: 'asc' },
      )
        .map((r) => r.keyword)
        .slice(-1),
    ).toEqual(['unknown volume'])
    expect(
      filterAndSortKeywordRows(
        rows,
        {},
        { by: 'keyword_difficulty', dir: 'asc' },
      )
        .map((r) => r.keyword)
        .slice(0, 2),
    ).toEqual(['caregiver', 'caregiving'])
  })
})

describe('tags and markets', () => {
  it('normalizes tags to a safe, short, lowercase form', () => {
    expect(normalizeTag('  Pricing  Page! ')).toBe('pricing page')
    expect(normalizeTag('{"x"},y')).toBe('x y')
    expect(normalizeTags(['Blog', 'blog', '', '  ', 'how-to'])).toEqual([
      'blog',
      'how-to',
    ])
    expect(
      normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)),
    ).toHaveLength(20)
  })

  it('offers every country with its languages, and says where domain data works', () => {
    const options = seoMarketOptions()
    const us = options.locations.find((location) => location.code === 2840)
    const iceland = options.locations.find((location) => location.code === 2352)
    expect(options.default_location_code).toBe(2840)
    expect(us).toMatchObject({
      keyword_data: 'labs',
      domain_data: true,
      default_language: 'en',
    })
    expect(us?.languages.map((language) => language.code)).toEqual(
      expect.arrayContaining(['en', 'es']),
    )
    expect(iceland).toMatchObject({
      keyword_data: 'google_ads',
      domain_data: false,
    })
  })
})
