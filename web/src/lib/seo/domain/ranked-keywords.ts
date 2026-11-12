/**
 * The keywords a domain, folder or page ranks for in one country, each with
 * its position, search volume, CPC, difficulty, estimated traffic and the
 * ranking URL: evidence for which keywords and pages earn a site its search
 * traffic. Paged (offset), sortable, filterable by minimum volume, best rank
 * and excluded terms (a brand name). Each page is stored (kind
 * ranked_keywords) for 12 hours.
 *
 * Scope: a bare domain covers its subdomains unless `scope` says "domain"; a
 * URL with a path covers that folder ("subfolder") or only that page
 * ("exact_url"). The provider always rolls a domain up with its subdomains,
 * so narrower scopes ride on filter conditions, which share the provider's
 * budget of 8 per request with the filters below.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import type { DomainRankedKeywordItem } from '@/lib/seo/dataforseo'
import { escapeLikeTerm } from '@/lib/seo/dataforseo/filters'
import {
  buildRankedKeywordsScopeFilter,
  type ScopeFilter,
} from '@/lib/seo/dataforseo/researchScopeFilters'
import { SeoInputError } from '@/lib/seo/input-error'
import { resolveDomainMarket } from '@/lib/seo/keywords/market'
import { describeMarket } from '@/lib/seo/keywords/view'
import { HOUR_MS, readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import { MAX_DATAFORSEO_FILTER_CONDITIONS } from '@/lib/seo/shared/domain'
import type { ResearchScope } from '@/lib/seo/shared/researchScope'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { resolveTarget } from './target'
import {
  DOMAIN_CAVEATS,
  RANKED_KEYWORD_SORTS,
  RANKED_KEYWORDS_OFFSET_MAX,
  RANKED_KEYWORDS_PAGE_MAX,
  toRelativePath,
  type DomainKeywordRow,
  type RankedKeywordSort,
  type RankedKeywordsPage,
} from './view'

export const RANKED_KEYWORDS_KIND = 'ranked_keywords'
export const RANKED_KEYWORDS_MAX_AGE_MS = 12 * HOUR_MS
const RANKED_VERSION = 1
const DEFAULT_PAGE = 50
const EXCLUDE_TERMS_MAX = 10

/** A provider ranked-keyword row as ours, or null without a keyword. */
export function mapRankedKeywordItem(
  item: DomainRankedKeywordItem,
): DomainKeywordRow | null {
  const data = item.keyword_data
  const info = data?.keyword_info
  const element = item.ranked_serp_element
  const serpItem = element?.serp_item
  const keyword = data?.keyword ?? item.keyword
  if (!keyword) return null
  const url = serpItem?.url ?? element?.url ?? null
  const position = serpItem?.rank_absolute ?? element?.rank_absolute ?? null
  const difficulty =
    data?.keyword_properties?.keyword_difficulty ??
    info?.keyword_difficulty ??
    null
  const traffic = serpItem?.etv ?? element?.etv ?? null
  return {
    keyword: keyword.toLowerCase(),
    position: position != null ? Math.round(position) : null,
    search_volume:
      info?.search_volume != null ? Math.round(info.search_volume) : null,
    traffic: traffic != null ? Math.round(traffic * 100) / 100 : null,
    cpc: info?.cpc ?? null,
    keyword_difficulty: difficulty != null ? Math.round(difficulty) : null,
    url,
    relative_url:
      serpItem?.relative_url ??
      element?.relative_url ??
      (url ? toRelativePath(url) : null),
  }
}

export function rankedOrderBy(sort: RankedKeywordSort): string[] {
  switch (sort) {
    case 'rank':
      return ['ranked_serp_element.serp_item.rank_absolute,asc']
    case 'traffic':
      return ['ranked_serp_element.serp_item.etv,desc']
    case 'cpc':
      return ['keyword_data.keyword_info.cpc,desc']
    case 'search_volume':
      return ['keyword_data.keyword_info.search_volume,desc']
  }
}

function pushAnd(filters: unknown[], condition: unknown[]) {
  if (filters.length > 0) filters.push('and')
  filters.push(condition)
}

/** The provider filter: scope first, then the person's filters, within the 8-condition budget. */
export function rankedFilters(
  args: { minSearchVolume?: number; maxRank?: number; excludeTerms?: string[] },
  scope?: ScopeFilter,
): unknown[] | undefined {
  const filters: unknown[] = []
  let conditions = 0
  if (scope) {
    for (const clause of scope.clauses) pushAnd(filters, clause)
    conditions += scope.conditionCount
  }
  if (args.minSearchVolume != null) {
    pushAnd(filters, [
      'keyword_data.keyword_info.search_volume',
      '>=',
      args.minSearchVolume,
    ])
    conditions += 1
  }
  if (args.maxRank != null) {
    pushAnd(filters, [
      'ranked_serp_element.serp_item.rank_absolute',
      '<=',
      args.maxRank,
    ])
    conditions += 1
  }
  for (const term of args.excludeTerms ?? []) {
    pushAnd(filters, [
      'keyword_data.keyword',
      'not_ilike',
      `%${escapeLikeTerm(term)}%`,
    ])
    conditions += 1
  }
  if (conditions > MAX_DATAFORSEO_FILTER_CONDITIONS) {
    throw new SeoInputError(
      `Too many filters at once: this lookup takes ${MAX_DATAFORSEO_FILTER_CONDITIONS - (scope?.conditionCount ?? 0)} here (a page or folder scope uses some). Drop an excluded term or a filter.`,
    )
  }
  return filters.length > 0 ? filters : undefined
}

export interface RankedKeywordsInput {
  /** A domain or URL; default the workspace's own site. */
  target?: string | null
  scope?: ResearchScope
  location_code?: number | null
  language_code?: string | null
  limit?: number
  offset?: number
  sort_by?: RankedKeywordSort
  min_search_volume?: number
  /** Only keywords ranking at this position or better. */
  max_rank?: number
  /** Leave out keywords containing any of these (brand terms). */
  exclude_terms?: string[]
  refresh?: boolean
}

type StoredRanked = Omit<
  RankedKeywordsPage,
  'lookup_id' | 'fetched_at' | 'from_cache' | 'is_own_site'
>

/** One page of the keywords a target ranks for: stored, or bought. */
export async function getRankedKeywords(
  svc: SupabaseClient,
  who: SeoWho,
  input: RankedKeywordsInput,
  deps: SeoPaidDeps = {},
): Promise<{ ok: true; result: RankedKeywordsPage } | SeoDataRefusal> {
  const market = resolveDomainMarket(input)
  const { target, isOwnSite } = await resolveTarget(svc, who.workspaceId, {
    domain: input.target,
    scope: input.scope,
  })
  const limit = Math.min(
    Math.max(Math.floor(input.limit ?? DEFAULT_PAGE), 1),
    RANKED_KEYWORDS_PAGE_MAX,
  )
  const offset = Math.min(
    Math.max(Math.floor(input.offset ?? 0), 0),
    RANKED_KEYWORDS_OFFSET_MAX,
  )
  const sort: RankedKeywordSort =
    input.sort_by &&
    (RANKED_KEYWORD_SORTS as readonly string[]).includes(input.sort_by)
      ? input.sort_by
      : 'search_volume'
  const excludeTerms = [
    ...new Set(
      (input.exclude_terms ?? [])
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  if (excludeTerms.length > EXCLUDE_TERMS_MAX)
    throw new SeoInputError(`Exclude at most ${EXCLUDE_TERMS_MAX} terms.`)
  const minSearchVolume =
    typeof input.min_search_volume === 'number' && input.min_search_volume > 0
      ? Math.floor(input.min_search_volume)
      : undefined
  const maxRank =
    typeof input.max_rank === 'number' && input.max_rank >= 1
      ? Math.min(Math.floor(input.max_rank), 100)
      : undefined
  // Validated here, before any lookup: too many conditions is the person's to fix.
  const filters = rankedFilters(
    { minSearchVolume, maxRank, excludeTerms },
    buildRankedKeywordsScopeFilter(target),
  )

  const key = {
    v: RANKED_VERSION,
    host: target.hostname,
    path: target.path,
    scope: target.scope,
    location_code: market.locationCode,
    language_code: market.languageCode,
    limit,
    offset,
    sort,
    min_search_volume: minSearchVolume ?? null,
    max_rank: maxRank ?? null,
    exclude_terms: [...excludeTerms].sort(),
  }
  const now = deps.now?.() ?? new Date()
  if (!input.refresh) {
    const hit = await readLookup<StoredRanked>(
      svc,
      who.workspaceId,
      RANKED_KEYWORDS_KIND,
      key,
      { maxAgeMs: RANKED_KEYWORDS_MAX_AGE_MS, now },
    )
    if (hit && Array.isArray(hit.result?.rows))
      return {
        ok: true,
        result: {
          ...hit.result,
          is_own_site: isOwnSite,
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        },
      }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const page = await opened.client.domain.rankedKeywords({
    target: target.hostname,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    limit,
    offset,
    orderBy: rankedOrderBy(sort),
    filters,
  })
  const rows = page.items
    .map(mapRankedKeywordItem)
    .filter((row): row is DomainKeywordRow => row !== null)
  const more =
    page.totalCount != null
      ? offset + page.items.length < page.totalCount
      : page.items.length === limit
  const nextOffset =
    more && offset + limit <= RANKED_KEYWORDS_OFFSET_MAX ? offset + limit : null
  const body: StoredRanked = {
    target: target.display,
    scope: target.scope,
    location_code: market.locationCode,
    language_code: market.languageCode,
    rows,
    total_count: page.totalCount,
    next_offset: nextOffset,
    caveats: [DOMAIN_CAVEATS.estimates, DOMAIN_CAVEATS.snapshot],
  }
  const label = `${target.display} · ${describeMarket(market.locationCode, market.languageCode)}${offset > 0 ? ` · from ${offset + 1}` : ''}`
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    { kind: RANKED_KEYWORDS_KIND, request: key, result: body, label },
    { now },
  )
  return {
    ok: true,
    result: {
      ...body,
      is_own_site: isOwnSite,
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    },
  }
}
