/**
 * Keyword research: one seed keyword in, the keywords people search around
 * it out, each with volume, CPC, competition, difficulty, intent and a
 * 12-month trend.
 *
 * Where the rows come from (docs: keyword data source routing):
 *
 *   - A country the main keyword source (Labs) covers:
 *       auto         phrase-match suggestions blended with category-level
 *                    ideas, half the limit each. Neither works alone:
 *                    suggestions miss sibling head terms ("respite care" for
 *                    "caregiving"), ideas drift toward generic category
 *                    terms. When the blend has fewer than 5 keywords besides
 *                    the seed (an obscure seed), related searches are added.
 *       related / suggestions / ideas   that one source.
 *       a wildcard seed ("best * for dogs")   one suggestions call for the
 *                    longest literal stretch, filtered by the provider to the
 *                    whole pattern, whatever mode was asked.
 *   - A country only Google Ads data covers (Iceland and about 47 others):
 *     one keyword-ideas call, whatever mode was asked; those rows carry no
 *     difficulty and no intent, and clickstream and grouping do not apply.
 *
 * Clickstream-refined volumes double the price and are off unless asked for.
 * `group_keywords` keeps close variants that share one volume (off by
 * default: only core keywords). A result is stored (./../lookup-cache.ts,
 * kind keyword_research) and answers the same question for 24 hours; saved
 * keywords in the same market pick up the fresh metrics.
 *
 * Every call is paid for on its own, so what came back is never thrown away:
 * when one source of an auto blend fails after the other was bought (or the
 * related-searches top-up fails), the rows bought are stored and returned
 * with `partial` saying what is missing. No further source is bought once
 * one failed. Only when nothing came back at all does the research fail.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import { dataforseoPricing, type DataforseoClient } from '@/lib/seo/dataforseo'
import { SeoInputError } from '@/lib/seo/input-error'
import { HOUR_MS, readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import { getKeywordDataProvider } from '@/lib/seo/shared/keyword-locations'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { resolveKeywordMarket } from './market'
import {
  countNonSeedKeywords,
  hasKeywordWildcard,
  interleaveRows,
  keywordWildcardError,
  mapAdsKeywordItems,
  mapKeywordDataItems,
  MIN_NON_SEED_FOR_AUTO,
  wildcardAnchor,
  wildcardFilters,
} from './rows'
import { syncSavedKeywordMetrics } from './saved'
import {
  DEFAULT_KEYWORD_RESULT_LIMIT,
  describeMarket,
  KEYWORD_RESULT_LIMITS,
  normalizeKeyword,
  type KeywordDataProvider,
  type KeywordResearchMode,
  type KeywordResearchResult,
  type KeywordResearchSource,
  type KeywordResultLimit,
  type KeywordRow,
  type PartialAnswer,
} from './view'

export const KEYWORD_RESEARCH_KIND = 'keyword_research'
/** How long a stored research answers the same question. */
export const KEYWORD_RESEARCH_MAX_AGE_MS = 24 * HOUR_MS
/** Bump when the stored result's shape changes. */
const RESEARCH_VERSION = 1
const SEED_MAX_LENGTH = 120

export interface ResearchInput {
  seed: string
  location_code?: number | null
  language_code?: string | null
  mode?: KeywordResearchMode
  result_limit?: number
  /** Clickstream-refined volumes: doubles the price. */
  clickstream?: boolean
  /** Keep close variants that share one volume. */
  group_keywords?: boolean
  /** Buy again even when a stored result is fresh. */
  refresh?: boolean
}

/** A research request after validation, with the source routing applied. */
export interface ResolvedResearch {
  seed: string
  locationCode: number
  languageCode: string
  mode: KeywordResearchMode
  resultLimit: KeywordResultLimit
  clickstream: boolean
  groupKeywords: boolean
  provider: KeywordDataProvider
  wildcard: boolean
}

/**
 * Validates a research request and applies the routing: a Google-Ads-only
 * country has no modes, clickstream or grouping, and a wildcard seed always
 * runs one filtered suggestions call, so equivalent requests share a stored
 * result. Throws VALIDATION_ERROR before anything is bought.
 */
export function resolveResearch(input: ResearchInput): ResolvedResearch {
  const seed = normalizeKeyword(input.seed ?? '')
  if (!seed) throw new SeoInputError('Give a keyword to research.')
  if (seed.length > SEED_MAX_LENGTH)
    throw new SeoInputError(
      `Keep the keyword under ${SEED_MAX_LENGTH} characters.`,
    )
  const market = resolveKeywordMarket(input)
  const wildcardError = keywordWildcardError(seed, market.locationCode)
  if (wildcardError) throw new SeoInputError(wildcardError)
  const resultLimit = (KEYWORD_RESULT_LIMITS as readonly number[]).includes(
    input.result_limit ?? -1,
  )
    ? (input.result_limit as KeywordResultLimit)
    : DEFAULT_KEYWORD_RESULT_LIMIT
  const provider = getKeywordDataProvider(market.locationCode)
  const wildcard = hasKeywordWildcard(seed)
  if (provider === 'google_ads') {
    return {
      seed,
      ...market,
      mode: 'auto',
      resultLimit,
      clickstream: false,
      groupKeywords: false,
      provider,
      wildcard: false,
    }
  }
  return {
    seed,
    ...market,
    mode: wildcard ? 'suggestions' : (input.mode ?? 'auto'),
    resultLimit,
    clickstream: input.clickstream === true,
    groupKeywords: input.group_keywords === true,
    provider,
    wildcard,
  }
}

/** The stored-lookup key: exactly what changes the answer. */
export function researchRequestKey(r: ResolvedResearch) {
  return {
    v: RESEARCH_VERSION,
    seed: r.seed,
    location_code: r.locationCode,
    language_code: r.languageCode,
    mode: r.mode,
    result_limit: r.resultLimit,
    clickstream: r.clickstream,
    group_keywords: r.groupKeywords,
  }
}

type StoredResearch = Omit<
  KeywordResearchResult,
  'lookup_id' | 'fetched_at' | 'from_cache'
>

/** The stored research for this request when it is fresh, or null. Free. */
export async function readStoredResearch(
  svc: SupabaseClient,
  workspaceId: string,
  r: ResolvedResearch,
  now: Date = new Date(),
): Promise<KeywordResearchResult | null> {
  const hit = await readLookup<StoredResearch>(
    svc,
    workspaceId,
    KEYWORD_RESEARCH_KIND,
    researchRequestKey(r),
    { maxAgeMs: KEYWORD_RESEARCH_MAX_AGE_MS, now },
  )
  if (!hit || !Array.isArray(hit.result?.rows)) return null
  return {
    ...hit.result,
    lookup_id: hit.id,
    fetched_at: hit.fetched_at,
    from_cache: true,
  }
}

/** The most this research can cost, in provider USD (the meter's own estimates, summed over every call it may make). */
export function estimateResearchUsd(r: ResolvedResearch): number {
  const base = {
    keyword: r.seed,
    locationCode: r.locationCode,
    languageCode: r.languageCode,
    includeClickstreamData: r.clickstream,
  }
  const p = dataforseoPricing.keywords
  if (r.provider === 'google_ads')
    return p.adsIdeas({ ...base, limit: r.resultLimit })
  if (r.wildcard) return p.suggestions({ ...base, limit: r.resultLimit })
  if (r.mode === 'auto') {
    const half = Math.ceil(r.resultLimit / 2)
    return (
      p.suggestions({ ...base, limit: half }) +
      p.ideas({ ...base, limit: half }) +
      p.related({ ...base, limit: r.resultLimit })
    )
  }
  return p[r.mode]({ ...base, limit: r.resultLimit })
}

type KeywordsClient = Pick<DataforseoClient, 'keywords'>
type Source = 'related' | 'suggestions' | 'ideas'

async function fetchFromSource(
  client: KeywordsClient,
  source: Source,
  r: ResolvedResearch,
  seed: string,
  opts: { limit?: number; filters?: unknown[] } = {},
): Promise<KeywordRow[]> {
  const params = {
    keyword: seed,
    locationCode: r.locationCode,
    languageCode: r.languageCode,
    limit: opts.limit ?? r.resultLimit,
    includeClickstreamData: r.clickstream,
    ignoreSynonyms: !r.groupKeywords,
    feature: 'keywords' as const,
  }
  if (source === 'related') {
    const items = await client.keywords.related({ ...params, depth: 3 })
    // Related rows wrap the keyword payload one level deeper.
    return mapKeywordDataItems(
      items
        .map((item) => item.keyword_data)
        .filter((data): data is NonNullable<typeof data> => data != null),
    )
  }
  if (source === 'suggestions')
    return mapKeywordDataItems(
      await client.keywords.suggestions({ ...params, filters: opts.filters }),
    )
  return mapKeywordDataItems(await client.keywords.ideas(params))
}

const MISSING_SOURCE_WORDS: Record<Source, string> = {
  suggestions: 'Keywords containing the seed could not be read just now.',
  ideas: 'Keywords from the same topic could not be read just now.',
  related: 'Related searches could not be added just now.',
}

/** The partial marker for these missing sources, in plain words. */
export function researchPartial(missing: Source[]): PartialAnswer | null {
  if (missing.length === 0) return null
  return {
    missing,
    note: `${missing.map((source) => MISSING_SOURCE_WORDS[source]).join(' ')} The keywords that did come back are shown; a refresh looks the whole research up again.`,
  }
}

async function fetchAuto(
  client: KeywordsClient,
  r: ResolvedResearch,
): Promise<{
  rows: KeywordRow[]
  usedFallback: boolean
  missing: Source[]
}> {
  const half = Math.ceil(r.resultLimit / 2)
  // Settled, not Promise.all: each call is metered on its own, and one leg's
  // failure must not abandon the other mid-flight before its spend is written.
  const [suggestions, ideas] = await Promise.allSettled([
    fetchFromSource(client, 'suggestions', r, r.seed, { limit: half }),
    fetchFromSource(client, 'ideas', r, r.seed, { limit: half }),
  ])
  // Nothing came back: the research fails, as before.
  if (suggestions.status === 'rejected' && ideas.status === 'rejected')
    throw suggestions.reason
  const missing: Source[] = []
  if (suggestions.status === 'rejected') {
    console.warn(
      '[seo-keywords] research: suggestions failed',
      suggestions.reason,
    )
    missing.push('suggestions')
  }
  if (ideas.status === 'rejected') {
    console.warn('[seo-keywords] research: ideas failed', ideas.reason)
    missing.push('ideas')
  }
  const blended = interleaveRows(
    suggestions.status === 'fulfilled' ? suggestions.value : [],
    ideas.status === 'fulfilled' ? ideas.value : [],
    r.resultLimit,
  )
  // A leg already failed: keep what was bought, buy nothing more.
  if (
    missing.length > 0 ||
    countNonSeedKeywords(blended, r.seed) >= MIN_NON_SEED_FOR_AUTO
  )
    return { rows: blended, usedFallback: false, missing }
  try {
    const related = await fetchFromSource(client, 'related', r, r.seed)
    return {
      rows: interleaveRows(blended, related, r.resultLimit),
      usedFallback: true,
      missing,
    }
  } catch (err) {
    // The blend is paid for: keep it.
    console.warn('[seo-keywords] research: related fallback failed', err)
    return { rows: blended, usedFallback: false, missing: ['related'] }
  }
}

/** Buys the rows for a resolved request. Exposed for tests; callers use researchKeywords. */
export async function fetchResearchRows(
  client: KeywordsClient,
  r: ResolvedResearch,
): Promise<{
  rows: KeywordRow[]
  source: KeywordResearchSource
  usedFallback: boolean
  partial: PartialAnswer | null
}> {
  if (r.provider === 'google_ads') {
    const items = await client.keywords.adsIdeas({
      keyword: r.seed,
      locationCode: r.locationCode,
      languageCode: r.languageCode,
      limit: r.resultLimit,
      feature: 'keywords',
    })
    return {
      rows: mapAdsKeywordItems(items),
      source: 'google_ads',
      usedFallback: false,
      partial: null,
    }
  }
  if (r.wildcard) {
    const rows = await fetchFromSource(
      client,
      'suggestions',
      r,
      wildcardAnchor(r.seed),
      { filters: wildcardFilters(r.seed) },
    )
    return {
      rows,
      source: 'suggestions',
      usedFallback: false,
      partial: null,
    }
  }
  if (r.mode === 'auto') {
    const { rows, usedFallback, missing } = await fetchAuto(client, r)
    return {
      rows,
      source: 'blended',
      usedFallback,
      partial: researchPartial(missing),
    }
  }
  return {
    rows: await fetchFromSource(client, r.mode, r, r.seed),
    source: r.mode,
    usedFallback: false,
    partial: null,
  }
}

/**
 * Research one seed. A fresh stored result answers for free; otherwise the
 * access check runs, the rows are bought and stored, and saved keywords in
 * the same market get the new metrics. Answers the refusal when search data
 * may not be bought now; provider failures throw a SeoError.
 */
export async function researchKeywords(
  svc: SupabaseClient,
  who: SeoWho,
  input: ResearchInput,
  deps: SeoPaidDeps = {},
): Promise<{ ok: true; result: KeywordResearchResult } | SeoDataRefusal> {
  const r = resolveResearch(input)
  const now = deps.now?.() ?? new Date()
  if (!input.refresh) {
    const stored = await readStoredResearch(svc, who.workspaceId, r, now)
    if (stored) return { ok: true, result: stored }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const { rows, source, usedFallback, partial } = await fetchResearchRows(
    opened.client,
    r,
  )
  const body: StoredResearch = {
    seed: r.seed,
    location_code: r.locationCode,
    language_code: r.languageCode,
    mode: r.mode,
    source,
    used_fallback: usedFallback,
    data_provider: r.provider,
    rows,
    ...(partial ? { partial } : {}),
  }
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: KEYWORD_RESEARCH_KIND,
      request: researchRequestKey(r),
      result: body,
      label: `${r.seed} · ${describeMarket(r.locationCode, r.languageCode)}`,
    },
    { now },
  )
  const fetchedAt = saved?.fetched_at ?? now.toISOString()
  await syncSavedKeywordMetrics(
    svc,
    who.workspaceId,
    { locationCode: r.locationCode, languageCode: r.languageCode },
    rows,
    fetchedAt,
  )
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
