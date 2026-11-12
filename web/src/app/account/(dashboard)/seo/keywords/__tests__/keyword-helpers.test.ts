// @vitest-environment jsdom
/**
 * The Keywords page's pure pieces: difficulty bands, the market kept per
 * browser (and a stale one put right), the rows the table shows for each
 * filter and sort, a stored research reopened, the words of a save, where a
 * live result points, the trend's sentence, and the saved list's query.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { seoMarketOptions, type KeywordRow } from '@/lib/seo/keywords/view'
import { savedQueryString } from '../api'
import {
  DEFAULT_OPTIONS,
  MARKET_STORAGE_KEY,
  NO_FILTERS,
  changedOptions,
  difficultyBand,
  featureLabel,
  readStoredMarket,
  resultHref,
  resultLine,
  resultWhere,
  savedToast,
  storedToResult,
  trendOf,
  validMarket,
  visibleRows,
} from '../keyword-helpers'

const markets = seoMarketOptions()
const row = (keyword: string, extra: Partial<KeywordRow> = {}): KeywordRow => ({
  keyword,
  search_volume: 100,
  cpc: 1,
  competition: 0.5,
  keyword_difficulty: 40,
  intent: 'commercial',
  trend: [],
  ...extra,
})
const ROWS = [
  row('linen throw', { search_volume: 2400, keyword_difficulty: 18, cpc: 1.2 }),
  row('linen throw blanket', { search_volume: 880, keyword_difficulty: 44, intent: 'transactional', cpc: null }),
  row('how to wash a linen throw', { search_volume: 12100, keyword_difficulty: 71, intent: 'informational', cpc: 0.3 }),
]

describe('difficultyBand', () => {
  it('under 30 easy, under 60 medium, else hard', () => {
    expect([0, 29, 30, 59, 60, 100].map(difficultyBand)).toEqual(['easy', 'easy', 'medium', 'medium', 'hard', 'hard'])
  })
})

describe('markets', () => {
  afterEach(() => window.localStorage.clear())

  it('keeps a market the options know, and puts a stale one right', () => {
    expect(validMarket(markets, { location_code: 2124, language_code: 'fr' })).toEqual({ location_code: 2124, language_code: 'fr' })
    // A language the country doesn't serve: its own.
    expect(validMarket(markets, { location_code: 2124, language_code: 'de' })).toEqual({ location_code: 2124, language_code: 'en' })
    // A country that isn't there: the default.
    expect(validMarket(markets, { location_code: 1, language_code: 'en' })).toEqual({ location_code: 2840, language_code: 'en' })
    expect(validMarket(markets, null)).toEqual({ location_code: 2840, language_code: 'en' })
  })

  it('reads what this browser kept, and survives junk', () => {
    window.localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify({ location_code: 2826, language_code: 'en' }))
    expect(readStoredMarket(markets)).toEqual({ location_code: 2826, language_code: 'en' })
    window.localStorage.setItem(MARKET_STORAGE_KEY, '{not json')
    expect(readStoredMarket(markets)).toEqual({ location_code: 2840, language_code: 'en' })
  })
})

describe('visibleRows', () => {
  const words = (rows: KeywordRow[]) => rows.map((r) => r.keyword)

  it('sorts most searched by default, easiest first ascending, highest cost first with a missing one last', () => {
    expect(words(visibleRows(ROWS, NO_FILTERS))).toEqual(['how to wash a linen throw', 'linen throw', 'linen throw blanket'])
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, sort: 'keyword_difficulty' }))).toEqual(['linen throw', 'linen throw blanket', 'how to wash a linen throw'])
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, sort: 'cpc' }))).toEqual(['linen throw', 'how to wash a linen throw', 'linen throw blanket'])
  })

  it('"closest to your words" keeps the order the source gave', () => {
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, sort: 'relevance', minVolume: '1000' }))).toEqual(['linen throw', 'how to wash a linen throw'])
  })

  it('every word typed must appear; volume, difficulty and intent narrow', () => {
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, text: 'throw  blanket' }))).toEqual(['linen throw blanket'])
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, maxDifficulty: '29' }))).toEqual(['linen throw'])
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, maxDifficulty: '59' }))).toEqual(['linen throw', 'linen throw blanket'])
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, intent: 'informational' }))).toEqual(['how to wash a linen throw'])
    expect(words(visibleRows(ROWS, { ...NO_FILTERS, minVolume: '10000' }))).toEqual(['how to wash a linen throw'])
  })
})

describe('lines', () => {
  it('the result line: how many, of how many while filtered, for what and where', () => {
    const r = { seed: 'linen throw', location_code: 2840, language_code: 'en', rows: ROWS }
    expect(resultLine(r, 3)).toBe('3 keywords for “linen throw” · United States')
    expect(resultLine(r, 1)).toBe('1 of 3 keywords for “linen throw” · United States')
    expect(resultLine({ ...r, location_code: 2124, language_code: 'fr' }, 3)).toBe('3 keywords for “linen throw” · Canada · French')
  })

  it('a save says what was added and what was already there', () => {
    expect(savedToast(3, 0)).toBe('Saved 3 keywords.')
    expect(savedToast(1, 1)).toBe('Saved 1 keyword · 1 was already saved.')
    expect(savedToast(2, 4)).toBe('Saved 2 keywords · 4 were already saved.')
    expect(savedToast(0, 1)).toBe('It was already saved.')
    expect(savedToast(0, 5)).toBe('All 5 were already saved.')
  })

  it('options changed are counted', () => {
    expect(changedOptions(DEFAULT_OPTIONS)).toBe(0)
    expect(changedOptions({ mode: 'ideas', result_limit: 500, group_keywords: true })).toBe(3)
  })
})

describe('storedToResult', () => {
  it('reopens a stored research as a stored answer, with what it asked', () => {
    const out = storedToResult({
      id: 'l1',
      kind: 'keyword_research',
      label: 'linen throw · United States',
      fetched_at: '2026-11-10T09:00:00Z',
      fetched_by: null,
      request: { seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'related', result_limit: 500, group_keywords: true },
      result: { seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'related', source: 'related', used_fallback: false, data_provider: 'labs', rows: ROWS },
    })
    expect(out.result).toMatchObject({ lookup_id: 'l1', fetched_at: '2026-11-10T09:00:00Z', from_cache: true, rows: ROWS })
    expect(out.ask).toEqual({ seed: 'linen throw', location_code: 2840, language_code: 'en', mode: 'related', result_limit: 500, group_keywords: true })
  })
})

describe('live results', () => {
  it('where a result is: its host and path, or its domain when the URL is a redirect', () => {
    expect(resultWhere({ domain: 'fernhillstudio.example', url: 'https://www.fernhillstudio.example/shop/linen?x=1' })).toBe('fernhillstudio.example/shop/linen?x=1')
    expect(resultWhere({ domain: 'fernhillstudio.example', url: 'https://fernhillstudio.example/' })).toBe('fernhillstudio.example')
    expect(resultWhere({ domain: 'fernhillstudio.example', url: 'https://www.google.com/url?q=x' })).toBe('fernhillstudio.example')
    expect(resultWhere({ domain: 'fernhillstudio.example', url: null })).toBe('fernhillstudio.example')
    expect(resultHref({ domain: 'fernhillstudio.example', url: null })).toBe('https://fernhillstudio.example')
    expect(resultHref({ domain: null, url: 'javascript:alert(1)' })).toBeNull()
    expect(featureLabel('people_also_ask')).toBe('People also ask')
  })
})

describe('trendOf', () => {
  it('oldest first, with a sentence; under two points, nothing', () => {
    const t = trendOf([
      { year: 2026, month: 2, search_volume: 300 },
      { year: 2025, month: 12, search_volume: 100 },
      { year: 2026, month: 1, search_volume: 1200 },
    ])!
    expect(t.values).toEqual([100, 1200, 300])
    expect(t.summary).toBe('Searches a month over the last 3 months: 100 at the start, 300 at the end, 1,200 at the most')
    expect(trendOf([{ year: 2026, month: 1, search_volume: 5 }])).toBeNull()
  })
})

describe('savedQueryString', () => {
  it('drops what is empty, repeats tags', () => {
    expect(savedQueryString({})).toBe('')
    expect(savedQueryString({ offset: 0, limit: 50, search: '  ', tags: ['a', 'b c'], sort: 'keyword', dir: 'asc' })).toBe('?limit=50&tag=a&tag=b+c&sort=keyword&dir=asc')
  })
})
