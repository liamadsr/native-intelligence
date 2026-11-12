/**
 * The Competitors page's pure pieces, so the views and their tests read the
 * same strings and make the same requests: a typed site as a bare host, a
 * stored overview made whole again, the market kept per device, the
 * Keywords tab's controls, and the numbers as the rows show them.
 */
import type { DomainKeywordRow, DomainOverview, RankedKeywordSort, SerpCompetitorRow } from '@/lib/seo/domain/view'
import type { SeoLocationOption, SeoMarketOptions } from '@/lib/seo/keywords/view'
import type { SeoLookupDetail } from '@/lib/seo/lookup-view'
import type { Market, StoredOverview } from './api'

/** "https://www.Example.com/shop" → "example.com"; "" when nothing usable was typed. */
export function bareHost(input: string | null | undefined): string {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(withScheme).hostname.replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return raw.replace(/^www\./, '').replace(/[/?#].*$/, '')
  }
}

/** True when the two name the same site ("www." and scheme ignored). */
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = bareHost(a)
  return !!x && x === bareHost(b)
}

/** The site a stored lookup's label names ("example.com · United States" → "example.com"). */
export function siteOfLabel(label: string | null | undefined): string {
  return (label ?? '').split(' · ')[0]?.trim() ?? ''
}

/** A stored overview as the route would have answered it from storage. */
export function overviewFromLookup(detail: SeoLookupDetail<unknown, StoredOverview>, ownHost: string | null): DomainOverview {
  const r = detail.result
  return {
    ...r,
    top_keywords: Array.isArray(r.top_keywords) ? r.top_keywords : [],
    top_pages: Array.isArray(r.top_pages) ? r.top_pages : [],
    caveats: Array.isArray(r.caveats) ? r.caveats : [],
    is_own_site: !!ownHost && sameSite(r.domain, ownHost),
    lookup_id: detail.id,
    fetched_at: detail.fetched_at,
    from_cache: true,
  }
}

// ── The market, kept per device ──────────────────────────────────────────

export const MARKET_STORAGE_KEY = 'seo-competitors-market'

export function readStoredMarket(): Market | null {
  try {
    const raw = window.localStorage.getItem(MARKET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Market>
    return typeof parsed.location_code === 'number' && typeof parsed.language_code === 'string'
      ? { location_code: parsed.location_code, language_code: parsed.language_code }
      : null
  } catch {
    return null
  }
}

export function writeStoredMarket(market: Market): void {
  try {
    window.localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify(market))
  } catch {
    /* private window: the picker just forgets */
  }
}

/** The countries domain data covers. */
export function domainLocations(options: SeoMarketOptions | null): SeoLocationOption[] {
  return (options?.locations ?? []).filter((l) => l.domain_data)
}

/**
 * The market to start on: the one kept, when it is still offered; else the
 * default country (when it is covered), else the first covered one.
 */
export function initialMarket(options: SeoMarketOptions | null, kept: Market | null): Market | null {
  const locations = domainLocations(options)
  if (locations.length === 0) return kept
  const keptLocation = kept ? locations.find((l) => l.code === kept.location_code) : undefined
  if (keptLocation && kept) {
    const language = keptLocation.languages.some((l) => l.code === kept.language_code) ? kept.language_code : keptLocation.default_language
    return { location_code: keptLocation.code, language_code: language }
  }
  const fallback = locations.find((l) => l.code === options?.default_location_code) ?? locations[0]
  return { location_code: fallback.code, language_code: fallback.default_language }
}

// ── The Keywords tab's controls ──────────────────────────────────────────

export type KeywordSortChoice = Extract<RankedKeywordSort, 'traffic' | 'rank' | 'search_volume'>

export const KEYWORD_SORT_OPTIONS: ReadonlyArray<{ value: KeywordSortChoice; label: string }> = [
  { value: 'traffic', label: 'Traffic' },
  { value: 'rank', label: 'Position' },
  { value: 'search_volume', label: 'Searches' },
]

export type RankChoice = 'any' | '10' | '3'

export const RANK_OPTIONS: ReadonlyArray<{ value: RankChoice; label: string }> = [
  { value: 'any', label: 'Any position' },
  { value: '10', label: 'Top 10 only' },
  { value: '3', label: 'Top 3 only' },
]

export const MIN_SEARCH_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Any searches' },
  { value: 100, label: '100+ a month' },
  { value: 1000, label: '1,000+ a month' },
  { value: 10000, label: '10,000+ a month' },
]

export const EXCLUDE_TERMS_MAX = 10

export interface KeywordControls {
  sort: KeywordSortChoice
  rank: RankChoice
  minSearches: number
  exclude: readonly string[]
}

export const DEFAULT_KEYWORD_CONTROLS: KeywordControls = { sort: 'traffic', rank: 'any', minSearches: 0, exclude: [] }

/**
 * True when the overview's own top keywords are the first page of what the
 * controls ask for (by traffic, nothing filtered): shown without a call.
 */
export function overviewServes(controls: KeywordControls): boolean {
  return controls.sort === 'traffic' && controls.rank === 'any' && controls.minSearches === 0 && controls.exclude.length === 0
}

/** Where the next page starts after the overview's top keywords, or null when there is no more. */
export function overviewNextOffset(overview: Pick<DomainOverview, 'top_keywords' | 'organic_keywords'>, pageSize: number): number | null {
  const shown = overview.top_keywords.length
  if (shown < pageSize) return null
  return (overview.organic_keywords ?? 0) > shown ? shown : null
}

export function maxRankOf(rank: RankChoice): number | null {
  return rank === 'any' ? null : Number(rank)
}

/** A typed word to leave out, normalized; null when it adds nothing. */
export function excludeTerm(input: string, current: readonly string[]): string | null {
  const term = input.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80)
  if (!term || current.includes(term)) return null
  return term
}

// ── Competitors ──────────────────────────────────────────────────────────

/** Searches typed one per line (or comma separated), deduplicated, at most `max`. */
export function parseKeywords(text: string, max = 100): string[] {
  const out: string[] = []
  for (const part of text.split(/[\n,]/)) {
    const k = part.trim().toLowerCase().replace(/\s+/g, ' ')
    if (k && !out.includes(k)) out.push(k)
  }
  return out.slice(0, max)
}

/** The own site's row first, the rest in the route's order. */
export function pinOwnSite(rows: readonly SerpCompetitorRow[]): SerpCompetitorRow[] {
  const own = rows.filter((r) => r.own_site)
  return [...own, ...rows.filter((r) => !r.own_site)]
}

// ── Numbers ──────────────────────────────────────────────────────────────

/** A whole number with separators, or the dash. */
export function num(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString() : '—'
}

/** An average position, one decimal ("4.3"). */
export function avgPosition(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—'
}

/** A share 0 to 1 as a percentage: "12%", "0.4%" under one percent. */
export function percent(share: number | null | undefined): string {
  if (typeof share !== 'number' || !Number.isFinite(share)) return '—'
  const p = share * 100
  if (p > 0 && p < 1) return `${p.toFixed(1)}%`
  return `${Math.round(p)}%`
}

/** A keyword row's page as its path ("/shop"), or the dash. */
export function keywordPath(row: Pick<DomainKeywordRow, 'url' | 'relative_url'>): string {
  if (row.relative_url) return row.relative_url
  if (!row.url) return '—'
  try {
    const u = new URL(row.url)
    return `${u.pathname || '/'}${u.search}`
  } catch {
    return row.url
  }
}
