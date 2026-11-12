/**
 * Keyword metrics for a list of keywords someone already has (a page's
 * target keywords, a saved list, a client's spreadsheet): volume, CPC,
 * competition, difficulty, intent and the 12-month trend for up to 700
 * keywords in one call. Routed like research: the main keyword source for
 * the countries it covers, Google Ads data (no difficulty, no intent) for the
 * rest. Stored (kind keyword_metrics) for 24 hours; saved keywords in the
 * same market pick up the fresh numbers.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import {
  dataforseoPricing,
  fetchKeywordMetricsForList,
} from '@/lib/seo/dataforseo'
import { SeoInputError } from '@/lib/seo/input-error'
import { HOUR_MS, readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import { getKeywordDataProvider } from '@/lib/seo/shared/keyword-locations'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { resolveKeywordMarket, type Market } from './market'
import { isEmptyKeywordRow, metricRowToKeywordRow } from './rows'
import { normalizeSavedKeywords, syncSavedKeywordMetrics } from './saved'
import {
  describeMarket,
  type KeywordMetricsResult,
  type KeywordRow,
} from './view'

export const KEYWORD_METRICS_KIND = 'keyword_metrics'
export const KEYWORD_METRICS_MAX_AGE_MS = 24 * HOUR_MS
/** The most keywords one metrics lookup takes (one provider request). */
export const KEYWORD_METRICS_MAX = 700
const METRICS_VERSION = 1

export interface MetricsInput {
  keywords: string[]
  location_code?: number | null
  language_code?: string | null
  /** Clickstream-refined volumes: doubles the price. No effect for Google-Ads-only countries. */
  clickstream?: boolean
  refresh?: boolean
}

export interface ResolvedMetrics extends Market {
  keywords: string[]
  clickstream: boolean
}

export function resolveMetrics(input: MetricsInput): ResolvedMetrics {
  const keywords = normalizeSavedKeywords(input.keywords ?? [])
  if (keywords.length === 0)
    throw new SeoInputError('Give at least one keyword.')
  if (keywords.length > KEYWORD_METRICS_MAX)
    throw new SeoInputError(
      `Ask for at most ${KEYWORD_METRICS_MAX} keywords at a time.`,
    )
  const market = resolveKeywordMarket(input)
  const clickstream =
    input.clickstream === true &&
    getKeywordDataProvider(market.locationCode) === 'labs'
  return { ...market, keywords, clickstream }
}

export function metricsRequestKey(r: ResolvedMetrics) {
  return {
    v: METRICS_VERSION,
    keywords: [...r.keywords].sort(),
    location_code: r.locationCode,
    language_code: r.languageCode,
    clickstream: r.clickstream,
  }
}

export function estimateMetricsUsd(r: ResolvedMetrics): number {
  return getKeywordDataProvider(r.locationCode) === 'google_ads'
    ? dataforseoPricing.keywords.adsSearchVolume({
        keywords: r.keywords,
        locationCode: r.locationCode,
        languageCode: r.languageCode,
      })
    : dataforseoPricing.labs.keywordOverview({
        keywords: r.keywords,
        locationCode: r.locationCode,
        languageCode: r.languageCode,
        includeClickstreamData: r.clickstream,
      })
}

type StoredMetrics = Omit<
  KeywordMetricsResult,
  'lookup_id' | 'fetched_at' | 'from_cache'
>

/** Metrics for these keywords: a fresh stored lookup for free, else bought. */
export async function getKeywordMetrics(
  svc: SupabaseClient,
  who: SeoWho,
  input: MetricsInput,
  deps: SeoPaidDeps = {},
): Promise<{ ok: true; result: KeywordMetricsResult } | SeoDataRefusal> {
  const r = resolveMetrics(input)
  const now = deps.now?.() ?? new Date()
  const key = metricsRequestKey(r)
  if (!input.refresh) {
    const hit = await readLookup<StoredMetrics>(
      svc,
      who.workspaceId,
      KEYWORD_METRICS_KIND,
      key,
      { maxAgeMs: KEYWORD_METRICS_MAX_AGE_MS, now },
    )
    if (hit && Array.isArray(hit.result?.rows)) {
      // A stored answer still brings the saved keywords it covers up to
      // date: these are the newest numbers we hold, and using them is free.
      // (Without this, "refresh my saved keywords" could only ever buy.)
      const stored = new Map(hit.result.rows.map((row) => [row.keyword, row]))
      await syncSavedKeywordMetrics(
        svc,
        who.workspaceId,
        r,
        r.keywords.map((keyword) => stored.get(keyword) ?? emptyKeywordRow(keyword)),
        hit.fetched_at,
      )
      return {
        ok: true,
        result: {
          ...hit.result,
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        },
      }
    }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const metricRows = await fetchKeywordMetricsForList(opened.client, {
    keywords: r.keywords,
    locationCode: r.locationCode,
    languageCode: r.languageCode,
    includeClickstreamData: r.clickstream,
    feature: 'keywords',
  })
  const byKeyword = new Map<string, KeywordRow>()
  for (const row of metricRows.map(metricRowToKeywordRow))
    if (!byKeyword.has(row.keyword)) byKeyword.set(row.keyword, row)
  const rows = r.keywords.flatMap((keyword) => {
    const row = byKeyword.get(keyword)
    return row && !isEmptyKeywordRow(row) ? [row] : []
  })
  const missing = r.keywords.filter(
    (keyword) => !rows.some((row) => row.keyword === keyword),
  )
  const body: StoredMetrics = {
    location_code: r.locationCode,
    language_code: r.languageCode,
    data_provider: getKeywordDataProvider(r.locationCode),
    rows,
    missing,
  }
  const first = r.keywords[0] ?? ''
  const label =
    r.keywords.length === 1
      ? first
      : `${first} and ${r.keywords.length - 1} more`
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: KEYWORD_METRICS_KIND,
      request: key,
      result: body,
      label: `${label} · ${describeMarket(r.locationCode, r.languageCode)}`,
    },
    { now },
  )
  const fetchedAt = saved?.fetched_at ?? now.toISOString()
  // Every asked keyword gets a row on the saved list, empty ones too, so
  // stale numbers there do not outlive a lookup that found none.
  const syncRows = r.keywords.map(
    (keyword) => byKeyword.get(keyword) ?? emptyKeywordRow(keyword),
  )
  await syncSavedKeywordMetrics(svc, who.workspaceId, r, syncRows, fetchedAt)
  return {
    ok: true,
    result: {
      ...body,
      lookup_id: saved?.id ?? null,
      fetched_at: fetchedAt,
      from_cache: false,
    },
  }
}


/** A keyword the lookup found nothing for: every number unknown. */
function emptyKeywordRow(keyword: string): KeywordRow {
  return {
    keyword,
    search_volume: null,
    cpc: null,
    competition: null,
    keyword_difficulty: null,
    intent: 'unknown',
    trend: [],
  }
}
