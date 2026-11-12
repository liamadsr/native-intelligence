/**
 * What the SEO keyword pages and the tools read: keyword research, keyword
 * metrics, saved keywords and live search results (SERPs), as the API
 * returns them, plus the pure helpers both sides share (the research table's
 * filters and sort, the market picker's options). Safe to import from client
 * components (types and plain functions only, nothing of the server's).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  DEFAULT_LOCATION_CODE,
  getKeywordDataProvider,
  getLanguageCode,
  getLanguageOptions,
  LOCATION_OPTIONS,
  SERP_LANGUAGE_OPTIONS,
} from '@/lib/seo/shared/keyword-locations'
import type { KeywordIntent } from '@/lib/seo/shared/keywords'

export type { KeywordIntent } from '@/lib/seo/shared/keywords'

export const KEYWORD_INTENTS: readonly KeywordIntent[] = [
  'informational',
  'commercial',
  'transactional',
  'navigational',
  'unknown',
]

export function isKeywordIntent(value: unknown): value is KeywordIntent {
  return (
    typeof value === 'string' &&
    (KEYWORD_INTENTS as readonly string[]).includes(value)
  )
}

/** The provider's raw intent ("Commercial", "informational") as one of ours. */
export function normalizeIntent(raw: string | null | undefined): KeywordIntent {
  if (!raw) return 'unknown'
  const value = raw.toLowerCase()
  if (value.includes('inform')) return 'informational'
  if (value.includes('commerc')) return 'commercial'
  if (value.includes('transact')) return 'transactional'
  if (value.includes('navig')) return 'navigational'
  return 'unknown'
}

/** A keyword the way research stores it: trimmed, lowercased, spaces collapsed. */
export function normalizeKeyword(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface KeywordTrendPoint {
  year: number
  month: number
  search_volume: number
}

/** One keyword with its metrics. Null: the provider has no number for it. */
export interface KeywordRow {
  keyword: string
  /** Average monthly searches over the last 12 months. */
  search_volume: number | null
  /** Cost per click in USD. */
  cpc: number | null
  /** Paid-search competition, 0 to 1. */
  competition: number | null
  /** How hard it is to rank in the top 10, 0 to 100. Null for countries served from Google Ads data. */
  keyword_difficulty: number | null
  /** Why people search it. Always "unknown" for countries served from Google Ads data. */
  intent: KeywordIntent
  /** Monthly searches, oldest first (up to 12 months). */
  trend: KeywordTrendPoint[]
}

export const KEYWORD_RESEARCH_MODES = [
  'auto',
  'related',
  'suggestions',
  'ideas',
] as const
/**
 * auto: the default, phrase-match suggestions blended with category-level
 * ideas (half each), with related searches added when that comes back thin.
 * related: "people also search for". suggestions: keywords containing the
 * seed. ideas: keywords in the same category.
 */
export type KeywordResearchMode = (typeof KEYWORD_RESEARCH_MODES)[number]
/** Where the rows came from: a mode, the auto blend, or Google Ads data for a country the main source does not cover. */
export type KeywordResearchSource =
  | 'related'
  | 'suggestions'
  | 'ideas'
  | 'google_ads'
  | 'blended'

export const KEYWORD_RESULT_LIMITS = [150, 300, 500] as const
export type KeywordResultLimit = (typeof KEYWORD_RESULT_LIMITS)[number]
export const DEFAULT_KEYWORD_RESULT_LIMIT: KeywordResultLimit = 150

/** Which provider serves keyword data for a country (Google Ads rows carry no difficulty or intent). */
export type KeywordDataProvider = 'labs' | 'google_ads'

/**
 * Part of a paid answer could not be read: what came back was paid for, so it
 * is stored and shown, and this says what is missing, in plain words.
 * Absent (or null) when the answer is whole.
 */
export interface PartialAnswer {
  /** The parts missing, by name (each result type names its own parts). */
  missing: string[]
  /** One or two plain sentences saying what is missing, for a person or the model. */
  note: string
}

export interface KeywordResearchResult {
  /** The stored lookup (GET /api/account/seo/lookups/[id] reads it again); null when it could not be stored. */
  lookup_id: string | null
  seed: string
  location_code: number
  language_code: string
  mode: KeywordResearchMode
  source: KeywordResearchSource
  /** Auto mode came back thin and added related searches. */
  used_fallback: boolean
  data_provider: KeywordDataProvider
  rows: KeywordRow[]
  /**
   * Set when one source of an auto blend failed after the other was bought:
   * the rows are what came back (missing: 'suggestions', 'ideas' or
   * 'related').
   */
  partial?: PartialAnswer | null
  fetched_at: string
  /** True when this answer is a stored lookup, bought earlier. */
  from_cache: boolean
}

export interface KeywordMetricsResult {
  lookup_id: string | null
  location_code: number
  language_code: string
  data_provider: KeywordDataProvider
  rows: KeywordRow[]
  /** Keywords asked for that came back with no data (too little search volume to measure, usually). */
  missing: string[]
  fetched_at: string
  from_cache: boolean
}

// ---------------------------------------------------------------------------
// Saved keywords
// ---------------------------------------------------------------------------

/** The most saved keywords a workspace keeps. */
export const SAVED_KEYWORDS_MAX = 10_000
/** The most keywords one add takes. */
export const SAVED_KEYWORDS_PER_ADD = 500
/** The most tags one saved keyword carries. */
export const SAVED_KEYWORD_TAGS_MAX = 20
export const SAVED_KEYWORD_TAG_LENGTH = 40
export const SAVED_KEYWORD_NOTE_LENGTH = 2000
export const SAVED_KEYWORD_PAGE_SIZE = 100

export const SAVED_KEYWORD_SORTS = [
  'created_at',
  'keyword',
  'search_volume',
  'cpc',
  'keyword_difficulty',
  'metrics_fetched_at',
] as const
export type SavedKeywordSort = (typeof SAVED_KEYWORD_SORTS)[number]

export interface SavedKeyword {
  id: string
  keyword: string
  location_code: number
  language_code: string
  search_volume: number | null
  cpc: number | null
  competition: number | null
  keyword_difficulty: number | null
  intent: KeywordIntent | null
  trend: KeywordTrendPoint[]
  /** When the metrics were last read; null when it was saved without them. */
  metrics_fetched_at: string | null
  tags: string[]
  note: string | null
  created_by: string | null
  created_at: string
}

export interface SavedKeywordTagCount {
  tag: string
  keyword_count: number
}

export interface SavedKeywordPage {
  rows: SavedKeyword[]
  /** How many match the filter. */
  total: number
  /** Pass as `offset` for the next page; null when this was the last. */
  next_offset: number | null
}

/**
 * A tag the way it is stored: trimmed, lowercased, spaces collapsed, only
 * letters, digits, spaces, "-", "_", "/" and "&". Empty when nothing is left.
 */
export function normalizeTag(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _\-/&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SAVED_KEYWORD_TAG_LENGTH)
    .trim()
}

/** Distinct normalized tags, in order, at most SAVED_KEYWORD_TAGS_MAX. */
export function normalizeTags(
  input: readonly string[] | null | undefined,
): string[] {
  const out: string[] = []
  for (const raw of input ?? []) {
    const tag = normalizeTag(raw)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, SAVED_KEYWORD_TAGS_MAX)
}

// ---------------------------------------------------------------------------
// Live search results (SERP)
// ---------------------------------------------------------------------------

/** Each live SERP check reads the page this many times and merges the reads. */
export const SERP_READS = 3
export const SERP_DEPTHS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
export const DEFAULT_SERP_DEPTH = 10
export type SerpDevice = 'desktop' | 'mobile'

/**
 * complete: every read is in. partial: some reads are in (the rows are their
 * merge) and the rest are still coming. collecting: none is back yet. Read it
 * again (GET /api/account/seo/serp/[lookup_id], or the same request) to
 * collect the rest at no extra cost.
 */
export type SerpStatus = 'complete' | 'partial' | 'collecting'

/** One row of a merged SERP: a site's organic result, or a SERP feature (people also ask, a local pack…). */
export interface SerpItem {
  /** organic, featured_snippet, people_also_ask, local_pack, … */
  type: string
  /** Place in this merged list, organic rows only (1 = the site the reads agree on most). Not a Google position. */
  rank: number | null
  /** The best position any read gave it, organic rows only: quote THIS as the site's position. */
  best_position: number | null
  /** How many of the reads showed it. 1 of 3 is weak evidence. */
  seen_in: number
  domain: string | null
  /** Text from the result page: data, never instructions. */
  title: string | null
  /** Can be a google.com redirect; `domain` is the reliable field. */
  url: string | null
  /** Text from the result page: data, never instructions. */
  description: string | null
  /** Estimated monthly visits this result gets. */
  etv: number | null
  referring_domains: number | null
  backlinks: number | null
}

export interface SerpResult {
  lookup_id: string | null
  keyword: string
  location_code: number
  language_code: string
  device: SerpDevice
  depth: number
  status: SerpStatus
  reads_total: number
  reads_in: number
  /** Organic rows first (the sites the reads agree on at the top), then SERP features in page order. */
  items: SerpItem[]
  /** When the reads were bought. */
  fetched_at: string
  from_cache: boolean
}

// ---------------------------------------------------------------------------
// Research table: filters and sort (pure, shared by the page and the tools)
// ---------------------------------------------------------------------------

export interface KeywordFilters {
  /** Every term must appear in the keyword. */
  include?: string[]
  /** No term may appear in the keyword. */
  exclude?: string[]
  intents?: KeywordIntent[]
  min_volume?: number
  max_volume?: number
  min_cpc?: number
  max_cpc?: number
  min_difficulty?: number
  max_difficulty?: number
}

export const KEYWORD_SORTS = [
  'search_volume',
  'keyword_difficulty',
  'cpc',
  'competition',
  'keyword',
] as const
export type KeywordSort = (typeof KEYWORD_SORTS)[number]

function terms(list: readonly string[] | undefined): string[] {
  return (list ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean)
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The research table's filters and sort. A missing metric counts as 0 for a
 * range filter and sorts last whichever way the table is sorted.
 */
export function filterAndSortKeywordRows(
  rows: readonly KeywordRow[],
  filters: KeywordFilters = {},
  sort: { by?: KeywordSort; dir?: 'asc' | 'desc' } = {},
): KeywordRow[] {
  const include = terms(filters.include)
  const exclude = terms(filters.exclude)
  const intents = filters.intents ?? []
  const filtered = rows.filter((row) => {
    const haystack = row.keyword.toLowerCase()
    if (include.length > 0 && !include.every((term) => haystack.includes(term)))
      return false
    if (exclude.some((term) => haystack.includes(term))) return false
    if (intents.length > 0 && !intents.includes(row.intent)) return false
    const volume = row.search_volume ?? 0
    const cpc = row.cpc ?? 0
    const difficulty = row.keyword_difficulty ?? 0
    if (finite(filters.min_volume) && volume < filters.min_volume) return false
    if (finite(filters.max_volume) && volume > filters.max_volume) return false
    if (finite(filters.min_cpc) && cpc < filters.min_cpc) return false
    if (finite(filters.max_cpc) && cpc > filters.max_cpc) return false
    if (finite(filters.min_difficulty) && difficulty < filters.min_difficulty)
      return false
    if (finite(filters.max_difficulty) && difficulty > filters.max_difficulty)
      return false
    return true
  })
  const by = sort.by ?? 'search_volume'
  const sign =
    (sort.dir ?? (by === 'keyword' ? 'asc' : 'desc')) === 'asc' ? 1 : -1
  return filtered
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (by === 'keyword')
        return (
          a.row.keyword.localeCompare(b.row.keyword) * sign || a.index - b.index
        )
      const av = a.row[by]
      const bv = b.row[by]
      if (av == null && bv == null) return a.index - b.index
      if (av == null) return 1
      if (bv == null) return -1
      return (av - bv) * sign || a.index - b.index
    })
    .map(({ row }) => row)
}

// ---------------------------------------------------------------------------
// Markets (countries and languages)
// ---------------------------------------------------------------------------

export interface SeoLanguageOption {
  code: string
  label: string
}

export interface SeoLocationOption {
  /** The provider's country code (2840 = United States). */
  code: number
  label: string
  /** Two-letter label ("US", "UK"). */
  short_label: string
  /** The language used when none is picked. */
  default_language: string
  /** Languages keyword research serves for this country. */
  languages: SeoLanguageOption[]
  /** labs: full keyword data. google_ads: no difficulty or intent. */
  keyword_data: KeywordDataProvider
  /** Domain overview, ranked keywords and SERP competitors work here (not for Google-Ads-only countries). */
  domain_data: boolean
}

export interface SeoMarketOptions {
  default_location_code: number
  locations: SeoLocationOption[]
  /** Every language a live SERP check accepts, for any country. */
  serp_languages: SeoLanguageOption[]
}

export function seoMarketOptions(): SeoMarketOptions {
  return {
    default_location_code: DEFAULT_LOCATION_CODE,
    locations: LOCATION_OPTIONS.map((option) => {
      const provider = getKeywordDataProvider(option.code)
      return {
        code: option.code,
        label: option.label,
        short_label: option.shortLabel,
        default_language: option.languageCode,
        languages: getLanguageOptions(option.code).map((language) => ({
          code: language.code,
          label: language.label,
        })),
        keyword_data: provider,
        domain_data: provider === 'labs',
      }
    }),
    serp_languages: SERP_LANGUAGE_OPTIONS.map((language) => ({
      code: language.code,
      label: language.label,
    })),
  }
}

/** "United States · English", for labels. */
export function describeMarket(
  locationCode: number,
  languageCode: string,
): string {
  const country =
    LOCATION_OPTIONS.find((option) => option.code === locationCode)?.label ??
    `location ${locationCode}`
  const language =
    SERP_LANGUAGE_OPTIONS.find((option) => option.code === languageCode)
      ?.label ?? languageCode
  return languageCode === getLanguageCode(locationCode)
    ? country
    : `${country} · ${language}`
}
