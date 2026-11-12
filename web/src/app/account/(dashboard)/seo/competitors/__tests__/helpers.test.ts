// @vitest-environment jsdom
/** The Competitors page's pure pieces: hosts, stored overviews, the market, the Keywords controls, the numbers. */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SeoMarketOptions } from '@/lib/seo/keywords/view'
import {
  DEFAULT_KEYWORD_CONTROLS,
  avgPosition,
  bareHost,
  excludeTerm,
  initialMarket,
  keywordPath,
  num,
  overviewFromLookup,
  overviewNextOffset,
  overviewServes,
  parseKeywords,
  percent,
  pinOwnSite,
  readStoredMarket,
  sameSite,
  siteOfLabel,
  writeStoredMarket,
} from '../helpers'

const loc = (code: number, domain_data: boolean, languages = ['en']) => ({
  code,
  label: `Country ${code}`,
  short_label: 'XX',
  default_language: languages[0],
  languages: languages.map((c) => ({ code: c, label: c })),
  keyword_data: domain_data ? ('labs' as const) : ('google_ads' as const),
  domain_data,
})
const MARKETS: SeoMarketOptions = { default_location_code: 2840, locations: [loc(2004, false), loc(2840, true), loc(2124, true, ['en', 'fr'])], serp_languages: [] }

describe('hosts', () => {
  it('reduces what was typed to a bare host', () => {
    expect(bareHost('https://www.Fernhill.example/shop?x=1')).toBe('fernhill.example')
    expect(bareHost('fernhill.example')).toBe('fernhill.example')
    expect(bareHost('  ')).toBe('')
    expect(sameSite('www.fernhill.example', 'https://fernhill.example')).toBe(true)
    expect(sameSite('', '')).toBe(false)
    expect(siteOfLabel('fernhill.example · Canada · French')).toBe('fernhill.example')
  })
})

describe('stored overviews', () => {
  it('are made whole the way the route answers from storage', () => {
    const o = overviewFromLookup(
      {
        id: 'l1',
        kind: 'domain_overview',
        label: 'fernhill.example · United States',
        fetched_at: '2026-11-10T00:00:00Z',
        fetched_by: null,
        request: {},
        result: { domain: 'fernhill.example', location_code: 2840, language_code: 'en', organic_traffic: 10, organic_keywords: 2, has_data: true, top_keywords: [], top_pages: [], caveats: [] },
      },
      'www.fernhill.example',
    )
    expect(o).toMatchObject({ lookup_id: 'l1', fetched_at: '2026-11-10T00:00:00Z', from_cache: true, is_own_site: true })
  })
})

describe('the market', () => {
  beforeEach(() => window.localStorage.clear())
  it('starts on the kept one when it is still offered, else the default covered country', () => {
    expect(initialMarket(MARKETS, null)).toEqual({ location_code: 2840, language_code: 'en' })
    expect(initialMarket(MARKETS, { location_code: 2124, language_code: 'fr' })).toEqual({ location_code: 2124, language_code: 'fr' })
    expect(initialMarket(MARKETS, { location_code: 2124, language_code: 'de' })).toEqual({ location_code: 2124, language_code: 'en' })
    // A country domain data does not cover is never kept.
    expect(initialMarket(MARKETS, { location_code: 2004, language_code: 'en' })).toEqual({ location_code: 2840, language_code: 'en' })
    expect(initialMarket(null, null)).toBeNull()
  })
  it('is kept per device', () => {
    expect(readStoredMarket()).toBeNull()
    writeStoredMarket({ location_code: 2124, language_code: 'fr' })
    expect(readStoredMarket()).toEqual({ location_code: 2124, language_code: 'fr' })
  })
})

describe('the Keywords controls', () => {
  it('serve the first page from the overview only by traffic with nothing filtered', () => {
    expect(overviewServes(DEFAULT_KEYWORD_CONTROLS)).toBe(true)
    expect(overviewServes({ ...DEFAULT_KEYWORD_CONTROLS, sort: 'rank' })).toBe(false)
    expect(overviewServes({ ...DEFAULT_KEYWORD_CONTROLS, exclude: ['x'] })).toBe(false)
    const rows = Array.from({ length: 100 }, () => ({}) as never)
    expect(overviewNextOffset({ top_keywords: rows, organic_keywords: 300 }, 100)).toBe(100)
    expect(overviewNextOffset({ top_keywords: rows, organic_keywords: 100 }, 100)).toBeNull()
    expect(overviewNextOffset({ top_keywords: rows.slice(0, 40), organic_keywords: 300 }, 100)).toBeNull()
  })
  it('take a word to leave out once, normalized', () => {
    expect(excludeTerm('  Fernhill  Studio ', [])).toBe('fernhill studio')
    expect(excludeTerm('fernhill', ['fernhill'])).toBeNull()
    expect(excludeTerm('   ', [])).toBeNull()
  })
})

describe('competitors', () => {
  it('reads typed searches one per line, deduplicated and capped', () => {
    expect(parseKeywords('Linen throw\nlinen  throw, oak table\n\n')).toEqual(['linen throw', 'oak table'])
    expect(parseKeywords(Array.from({ length: 120 }, (_, i) => `k${i}`).join('\n'))).toHaveLength(100)
  })
  it('pins the own site first', () => {
    const row = (domain: string, own_site = false) => ({ domain, own_site, keywords_count: 1, avg_position: 1, median_position: 1, visibility: 0, etv: 0 })
    expect(pinOwnSite([row('a'), row('me', true), row('b')]).map((r) => r.domain)).toEqual(['me', 'a', 'b'])
  })
})

describe('numbers', () => {
  it('never hide a number, and say a missing one with a dash', () => {
    expect(num(12480)).toBe('12,480')
    expect(num(null)).toBe('—')
    expect(avgPosition(4.26)).toBe('4.3')
    expect(avgPosition(null)).toBe('—')
    expect(percent(0.18)).toBe('18%')
    expect(percent(0.004)).toBe('0.4%')
    expect(percent(0)).toBe('0%')
    expect(keywordPath({ url: 'https://a.example/x?y=1', relative_url: null })).toBe('/x?y=1')
    expect(keywordPath({ url: null, relative_url: null })).toBe('—')
  })
})
