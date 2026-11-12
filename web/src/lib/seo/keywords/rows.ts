/**
 * Turning the provider's keyword payloads into our keyword rows, and the
 * pure rules of keyword research: how the auto mode blends two sources, when
 * it falls back to a third, and how a wildcard seed ("best * for dogs") is
 * searched.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type {
  AdsKeywordItem,
  KeywordMetricRow,
  LabsKeywordDataItem,
} from '@/lib/seo/dataforseo'
import { escapeLikeTerm, joinClauses } from '@/lib/seo/dataforseo/filters'
import { isLabsLocationCode } from '@/lib/seo/shared/keyword-locations'
import {
  normalizeIntent,
  normalizeKeyword,
  type KeywordRow,
  type KeywordTrendPoint,
} from './view'

type MonthlyEntry = {
  year?: number | null
  month?: number | null
  search_volume?: number | null
}

/** Monthly searches, oldest first; entries without a year and month are dropped. */
export function trendFrom(
  entries: readonly MonthlyEntry[] | null | undefined,
): KeywordTrendPoint[] {
  return (entries ?? [])
    .filter(
      (entry) =>
        typeof entry.year === 'number' &&
        typeof entry.month === 'number' &&
        entry.year > 0 &&
        entry.month > 0,
    )
    .map((entry) => ({
      year: entry.year as number,
      month: entry.month as number,
      search_volume: Math.max(0, Math.round(entry.search_volume ?? 0)),
    }))
    .sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month))
}

function roundOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : null
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Labs rows (suggestions, ideas, related): one per keyword, the first wins. */
export function mapKeywordDataItems(
  items: readonly LabsKeywordDataItem[],
): KeywordRow[] {
  const rows: KeywordRow[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.keyword) continue
    const keyword = normalizeKeyword(item.keyword)
    if (!keyword || seen.has(keyword)) continue
    seen.add(keyword)
    // The clickstream-refined block exists only when the caller opted in (it
    // doubles the price); prefer it when it is there.
    const info = item.keyword_info_normalized_with_clickstream?.search_volume
      ? item.keyword_info_normalized_with_clickstream
      : item.keyword_info
    rows.push({
      keyword,
      search_volume: roundOrNull(info?.search_volume),
      cpc: numberOrNull(item.keyword_info?.cpc),
      competition: numberOrNull(item.keyword_info?.competition),
      keyword_difficulty: roundOrNull(
        item.keyword_properties?.keyword_difficulty,
      ),
      intent: normalizeIntent(item.search_intent_info?.main_intent),
      trend: trendFrom(info?.monthly_searches),
    })
  }
  return rows
}

/** Google Ads rows (countries the main source does not cover): no difficulty, no intent. */
export function mapAdsKeywordItems(
  items: readonly AdsKeywordItem[],
): KeywordRow[] {
  const rows: KeywordRow[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.keyword) continue
    const keyword = normalizeKeyword(item.keyword)
    if (!keyword || seen.has(keyword)) continue
    seen.add(keyword)
    rows.push({
      keyword,
      search_volume: roundOrNull(item.search_volume),
      cpc: numberOrNull(item.cpc),
      // A 0-100 index there; a 0-1 ratio here.
      competition:
        item.competition_index != null ? item.competition_index / 100 : null,
      keyword_difficulty: null,
      intent: 'unknown',
      trend: trendFrom(item.monthly_searches),
    })
  }
  return rows
}

/** A metrics row of the shared metrics helper, as our keyword row. */
export function metricRowToKeywordRow(row: KeywordMetricRow): KeywordRow {
  return {
    keyword: normalizeKeyword(row.keyword),
    search_volume: roundOrNull(row.searchVolume),
    cpc: numberOrNull(row.cpc),
    competition: numberOrNull(row.competition),
    keyword_difficulty: roundOrNull(row.keywordDifficulty),
    intent: normalizeIntent(row.intent),
    trend: trendFrom(
      row.monthlySearches.map((entry) => ({
        year: entry.year,
        month: entry.month,
        search_volume: entry.searchVolume,
      })),
    ),
  }
}

/** True when a row carries no metric at all (the provider knew nothing about the keyword). */
export function isEmptyKeywordRow(row: KeywordRow): boolean {
  return (
    row.search_volume == null &&
    row.cpc == null &&
    row.keyword_difficulty == null &&
    row.competition == null
  )
}

/**
 * Alternates rows from two sources into one list, one per keyword, so a
 * volume-sorted source cannot crowd the other out before the limit.
 */
export function interleaveRows(
  first: readonly KeywordRow[],
  second: readonly KeywordRow[],
  limit: number,
): KeywordRow[] {
  const rows: KeywordRow[] = []
  const seen = new Set<string>()
  const longest = Math.max(first.length, second.length)
  for (let i = 0; i < longest && rows.length < limit; i++) {
    for (const source of [first, second]) {
      const row = source[i]
      if (!row || seen.has(row.keyword) || rows.length >= limit) continue
      seen.add(row.keyword)
      rows.push(row)
    }
  }
  return rows
}

/** Auto mode adds related searches when the blend has fewer keywords than this besides the seed. */
export const MIN_NON_SEED_FOR_AUTO = 5

export function countNonSeedKeywords(
  rows: readonly KeywordRow[],
  seed: string,
): number {
  const normalized = normalizeKeyword(seed)
  return rows.filter((row) => row.keyword !== normalized).length
}

// ---------------------------------------------------------------------------
// Wildcard seeds: "best * for dogs", where * stands for any word or words.
// ---------------------------------------------------------------------------

export function hasKeywordWildcard(seed: string): boolean {
  return seed.includes('*')
}

/** The longest literal stretch between wildcards ("for dogs"): what the provider is searched for. */
export function wildcardAnchor(seed: string): string {
  return seed
    .split('*')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .reduce(
      (longest, part) => (part.length > longest.length ? part : longest),
      '',
    )
}

/** Why a wildcard seed cannot be researched, or null when it can (also null for a seed with no wildcard). */
export function keywordWildcardError(
  seed: string,
  locationCode: number,
): string | null {
  if (!hasKeywordWildcard(seed)) return null
  if (!wildcardAnchor(seed))
    return 'Add at least one word besides *, like best * for dogs.'
  if (!isLabsLocationCode(locationCode))
    return 'Wildcard search isn’t available for this country.'
  return null
}

/**
 * The provider filter that keeps only keywords matching the whole pattern. A
 * bare % at either end would let "seo" match "seoul", so the pattern is
 * pinned to word boundaries with four `like` conditions.
 */
export function wildcardFilters(seed: string): unknown[] {
  const pattern = seed
    .replace(/\s+/g, ' ')
    .replace(/\*+/g, '*')
    .split('*')
    .map(escapeLikeTerm)
    .join('%')
  return joinClauses(
    [pattern, `${pattern} %`, `% ${pattern}`, `% ${pattern} %`].map((value) => [
      'keyword',
      'like',
      value,
    ]),
    'or',
  )
}
