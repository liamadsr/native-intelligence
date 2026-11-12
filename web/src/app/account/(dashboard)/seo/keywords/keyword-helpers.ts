/**
 * The Keywords page's words, colours and small decisions, pure, so the views
 * and their tests read the same strings (house style as ../ui-helpers.ts:
 * sentence case, plural-aware counts, ` · ` between clauses).
 */
import {
  describeMarket,
  filterAndSortKeywordRows,
  type KeywordFilters,
  type KeywordIntent,
  type KeywordResearchMode,
  type KeywordResultLimit,
  type KeywordRow,
  type KeywordTrendPoint,
  type SavedKeywordSort,
  type SeoMarketOptions,
  type SerpItem,
} from '@/lib/seo/keywords/view'
import type { SeoLookupDetail } from '@/lib/seo/lookup-view'
import type { KeywordResearchResult } from '@/lib/seo/keywords/view'
import type { ResearchAsk, StoredResearchRequest, StoredResearchResult } from './api'
import { count, pathOf } from '../ui-helpers'

// ── Markets ──────────────────────────────────────────────────────────────

export interface Market {
  location_code: number
  language_code: string
}

export const MARKET_STORAGE_KEY = 'ni.seo.keywords.market'

/** A market the options know, else the default country in its own language. */
export function validMarket(options: SeoMarketOptions, wanted: Partial<Market> | null | undefined): Market {
  const fallback = options.locations.find((l) => l.code === options.default_location_code) ?? options.locations[0]
  const location = options.locations.find((l) => l.code === wanted?.location_code) ?? fallback
  const language = location.languages.some((l) => l.code === wanted?.language_code) ? wanted!.language_code! : location.default_language
  return { location_code: location.code, language_code: language }
}

/** The market this browser picked last (try/catch: storage can be off). */
export function readStoredMarket(options: SeoMarketOptions): Market {
  let stored: Partial<Market> | null = null
  try {
    const raw = window.localStorage.getItem(MARKET_STORAGE_KEY)
    if (raw) stored = JSON.parse(raw) as Partial<Market>
  } catch {
    stored = null
  }
  return validMarket(options, stored)
}

export function writeStoredMarket(market: Market): void {
  try {
    window.localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify(market))
  } catch {
    /* storage off: the pick lasts this visit */
  }
}

export const marketLabel = (m: Market) => describeMarket(m.location_code, m.language_code)
export const sameMarket = (a: Market, b: Market) => a.location_code === b.location_code && a.language_code === b.language_code

// ── Research options ─────────────────────────────────────────────────────

export const MODE_OPTIONS: ReadonlyArray<{ value: KeywordResearchMode; label: string; hint: string }> = [
  { value: 'auto', label: 'Mix', hint: 'Searches that contain your words, plus searches on the same topic' },
  { value: 'suggestions', label: 'Contain the words', hint: 'Only searches that contain what you typed' },
  { value: 'ideas', label: 'Same topic', hint: 'Searches on the same topic, with or without your words' },
  { value: 'related', label: 'Also searched', hint: 'What people also search for around it' },
]

export const LIMIT_OPTIONS: readonly KeywordResultLimit[] = [150, 300, 500]

export interface ResearchOptions {
  mode: KeywordResearchMode
  result_limit: KeywordResultLimit
  group_keywords: boolean
}
export const DEFAULT_OPTIONS: ResearchOptions = { mode: 'auto', result_limit: 150, group_keywords: false }

export function changedOptions(o: ResearchOptions): number {
  return (o.mode !== 'auto' ? 1 : 0) + (o.result_limit !== 150 ? 1 : 0) + (o.group_keywords ? 1 : 0)
}

/** A stored research reopened: the result as the route answers it, and what was asked. */
export function storedToResult(detail: SeoLookupDetail<StoredResearchRequest, StoredResearchResult>): {
  result: KeywordResearchResult
  ask: ResearchAsk
} {
  const r = detail.result
  const q = detail.request ?? {}
  const limit = q.result_limit === 300 || q.result_limit === 500 ? q.result_limit : 150
  return {
    result: { ...r, rows: Array.isArray(r.rows) ? r.rows : [], lookup_id: detail.id, fetched_at: detail.fetched_at, from_cache: true },
    ask: {
      seed: r.seed ?? q.seed ?? '',
      location_code: r.location_code ?? q.location_code ?? 0,
      language_code: r.language_code ?? q.language_code ?? '',
      mode: q.mode ?? r.mode ?? 'auto',
      result_limit: limit,
      group_keywords: q.group_keywords === true,
    },
  }
}

// ── Filters and sort ─────────────────────────────────────────────────────

export type MinVolume = 'any' | '100' | '1000' | '10000'
export type MaxDifficulty = 'any' | '29' | '59'
export type IntentFilter = 'any' | Exclude<KeywordIntent, 'unknown'>
export type ResearchSort = 'search_volume' | 'keyword_difficulty' | 'cpc' | 'relevance'

export interface ResearchFilterState {
  text: string
  minVolume: MinVolume
  maxDifficulty: MaxDifficulty
  intent: IntentFilter
  sort: ResearchSort
}
export const NO_FILTERS: ResearchFilterState = { text: '', minVolume: 'any', maxDifficulty: 'any', intent: 'any', sort: 'search_volume' }

export const MIN_VOLUME_OPTIONS: ReadonlyArray<{ value: MinVolume; label: string }> = [
  { value: 'any', label: 'Any searches' },
  { value: '100', label: '100+ a month' },
  { value: '1000', label: '1,000+ a month' },
  { value: '10000', label: '10,000+ a month' },
]
export const MAX_DIFFICULTY_OPTIONS: ReadonlyArray<{ value: MaxDifficulty; label: string }> = [
  { value: 'any', label: 'Any difficulty' },
  { value: '29', label: 'Easy only' },
  { value: '59', label: 'Easy or medium' },
]
export const INTENT_FILTER_OPTIONS: ReadonlyArray<{ value: IntentFilter; label: string }> = [
  { value: 'any', label: 'Any intent' },
  { value: 'informational', label: 'Informational' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'transactional', label: 'Transactional' },
  { value: 'navigational', label: 'Navigational' },
]
export const RESEARCH_SORT_OPTIONS: ReadonlyArray<{ value: ResearchSort; label: string; needsDifficulty?: boolean }> = [
  { value: 'search_volume', label: 'Most searched' },
  { value: 'keyword_difficulty', label: 'Easiest first', needsDifficulty: true },
  { value: 'cpc', label: 'Highest cost per click' },
  { value: 'relevance', label: 'Closest to your words' },
]

export function filtersActive(f: ResearchFilterState): boolean {
  return f.text.trim() !== '' || f.minVolume !== 'any' || f.maxDifficulty !== 'any' || f.intent !== 'any'
}

/** The research rows as the table shows them: filtered by the helper the tools share, in the order picked. */
export function visibleRows(rows: readonly KeywordRow[], f: ResearchFilterState): KeywordRow[] {
  const filters: KeywordFilters = {}
  const words = f.text.trim().split(/\s+/).filter(Boolean)
  if (words.length > 0) filters.include = words
  if (f.minVolume !== 'any') filters.min_volume = Number(f.minVolume)
  if (f.maxDifficulty !== 'any') filters.max_difficulty = Number(f.maxDifficulty)
  if (f.intent !== 'any') filters.intents = [f.intent]
  if (f.sort !== 'relevance') return filterAndSortKeywordRows(rows, filters, { by: f.sort, dir: f.sort === 'keyword_difficulty' ? 'asc' : 'desc' })
  // "Closest to your words": the order the source gave them.
  const kept = new Set(filterAndSortKeywordRows(rows, filters))
  return rows.filter((row) => kept.has(row))
}

export const SAVED_SORT_OPTIONS: ReadonlyArray<{ value: string; label: string; sort: SavedKeywordSort; dir: 'asc' | 'desc' }> = [
  { value: 'newest', label: 'Newest saved', sort: 'created_at', dir: 'desc' },
  { value: 'volume', label: 'Most searched', sort: 'search_volume', dir: 'desc' },
  { value: 'easiest', label: 'Easiest first', sort: 'keyword_difficulty', dir: 'asc' },
  { value: 'cpc', label: 'Highest cost per click', sort: 'cpc', dir: 'desc' },
  { value: 'az', label: 'A to Z', sort: 'keyword', dir: 'asc' },
]

// ── Numbers and chips ────────────────────────────────────────────────────

export type DifficultyBand = 'easy' | 'medium' | 'hard'

/** Under 30 easy, under 60 medium, else hard (0 to 100: how hard the first page of Google is to reach). */
export function difficultyBand(score: number): DifficultyBand {
  if (score < 30) return 'easy'
  if (score < 60) return 'medium'
  return 'hard'
}

export const DIFFICULTY_WORD: Record<DifficultyBand, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }

/** The difficulty chip's colours (../ui-helpers.ts SEVERITY_CHIP's treatment). */
export const DIFFICULTY_CHIP: Record<DifficultyBand, string> = {
  easy: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  medium: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  hard: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
}

export const INTENT_LABEL: Record<KeywordIntent, string | null> = {
  informational: 'Informational',
  commercial: 'Commercial',
  transactional: 'Transactional',
  navigational: 'Navigational',
  unknown: null,
}

/** What each intent means, in plain words, for its chip's `title`. */
export const INTENT_HINT: Record<KeywordIntent, string> = {
  informational: 'People want to learn something',
  commercial: 'People are comparing before they buy',
  transactional: 'People are ready to buy or sign up',
  navigational: 'People are looking for one particular site',
  unknown: 'Not known for this keyword',
}

export function formatCpc(cpc: number | null): string {
  return cpc === null ? '—' : `$${cpc.toFixed(2)}`
}

export function formatVolume(volume: number | null): string {
  return volume === null ? '—' : volume.toLocaleString()
}

/** The trend's values oldest first, and the sentence that goes with the picture. */
export function trendOf(trend: readonly KeywordTrendPoint[]): { values: number[]; summary: string } | null {
  const points = [...trend].sort((a, b) => a.year - b.year || a.month - b.month)
  if (points.length < 2) return null
  const values = points.map((p) => p.search_volume)
  const first = values[0]
  const last = values[values.length - 1]
  const peak = Math.max(...values)
  return {
    values,
    summary: `Searches a month over the last ${count(points.length, 'month')}: ${first.toLocaleString()} at the start, ${last.toLocaleString()} at the end, ${peak.toLocaleString()} at the most`,
  }
}

// ── Lines ────────────────────────────────────────────────────────────────

/** "150 keywords for “linen throw” · United States", "40 of 150 keywords for …" while filtered. */
export function resultLine(result: Pick<KeywordResearchResult, 'seed' | 'location_code' | 'language_code' | 'rows'>, shown: number): string {
  const total = result.rows.length
  const n = shown === total ? count(total, 'keyword') : `${shown.toLocaleString()} of ${count(total, 'keyword')}`
  return `${n} for “${result.seed}” · ${describeMarket(result.location_code, result.language_code)}`
}

/** "Saved 3 keywords" · "1 was already saved". */
export function savedToast(added: number, already: number): string {
  if (added === 0) return already === 1 ? 'It was already saved.' : `All ${already.toLocaleString()} were already saved.`
  const head = `Saved ${count(added, 'keyword')}`
  if (already === 0) return `${head}.`
  return `${head} · ${already.toLocaleString()} ${already === 1 ? 'was' : 'were'} already saved.`
}

// ── Live results ─────────────────────────────────────────────────────────

/** A result's place on the page as "domain/path" (the URL can be a google.com redirect: the domain is the reliable part). */
export function resultWhere(item: Pick<SerpItem, 'domain' | 'url'>): string {
  const domain = item.domain ?? ''
  if (!item.url) return domain
  try {
    const u = new URL(item.url)
    const host = u.hostname.replace(/^www\./, '')
    if (domain && host !== domain.replace(/^www\./, '')) return domain
    const path = pathOf(item.url)
    return `${host}${path === '/' ? '' : path}`
  } catch {
    return domain
  }
}

/** Where a result links: its URL, else its domain. */
export function resultHref(item: Pick<SerpItem, 'domain' | 'url'>): string | null {
  if (item.url && /^https?:\/\//i.test(item.url)) return item.url
  return item.domain ? `https://${item.domain}` : null
}

/** "People also ask" for "people_also_ask". */
export function featureLabel(type: string): string {
  const words = type.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other'
}

/** "seen in 2 of 3 reads" for a result's position. */
export function seenIn(item: Pick<SerpItem, 'seen_in'>, reads: number): string {
  return `Seen in ${item.seen_in} of ${count(reads, 'read')}`
}
