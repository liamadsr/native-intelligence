/**
 * The domains that compete in Google for a set of keywords (1 to 100) in one
 * country: how many of the keywords each ranks for, its average and median
 * position, its visibility and estimated traffic from them. Who a site's real
 * search competitors are for a topic, as opposed to who it thinks they are.
 *
 * Stored (kind serp_competitors) for 12 hours, keyed by what changes the
 * provider's answer (keywords, market, result types, subdomains, how many);
 * the sort and the excluded domains are applied to the stored rows, so
 * re-sorting or hiding a domain costs nothing. The workspace's own site is
 * marked (`own_site`) rather than hidden.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import { SeoInputError } from '@/lib/seo/input-error'
import { resolveDomainMarket } from '@/lib/seo/keywords/market'
import { normalizeSavedKeywords } from '@/lib/seo/keywords/saved'
import { describeMarket } from '@/lib/seo/keywords/view'
import { HOUR_MS, readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { ownSiteHost } from './target'
import {
  DOMAIN_CAVEATS,
  hostMatchesDomain,
  SERP_COMPETITOR_KEYWORDS_MAX,
  SERP_COMPETITOR_RESULT_TYPES,
  SERP_COMPETITOR_SORTS,
  type SerpCompetitorResultType,
  type SerpCompetitorRow,
  type SerpCompetitorSort,
  type SerpCompetitorsResult,
} from './view'

export const SERP_COMPETITORS_KIND = 'serp_competitors'
export const SERP_COMPETITORS_MAX_AGE_MS = 12 * HOUR_MS
const COMPETITORS_VERSION = 1
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const EXCLUDE_MAX = 50

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Sorted copy: visibility, traffic and keyword count high first; average position low first; missing numbers last. */
export function sortCompetitors(
  rows: readonly SerpCompetitorRow[],
  sort: SerpCompetitorSort,
): SerpCompetitorRow[] {
  const field =
    sort === 'avg_position'
      ? 'avg_position'
      : sort === 'keyword_count'
        ? 'keywords_count'
        : sort === 'traffic'
          ? 'etv'
          : 'visibility'
  const direction = sort === 'avg_position' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = a[field]
    const bv = b[field]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return (av - bv) * direction
  })
}

export interface SerpCompetitorsInput {
  keywords: string[]
  location_code?: number | null
  language_code?: string | null
  /** Which results count (default organic and local pack). */
  result_types?: SerpCompetitorResultType[]
  /** Count a domain's subdomains as the domain. */
  include_subdomains?: boolean
  /** Domains to leave out (applied to the stored rows: free). */
  exclude_domains?: string[]
  sort_by?: SerpCompetitorSort
  limit?: number
  refresh?: boolean
}

type StoredCompetitors = {
  keywords: string[]
  location_code: number
  language_code: string
  rows: Array<Omit<SerpCompetitorRow, 'own_site'>>
}

export async function findSerpCompetitors(
  svc: SupabaseClient,
  who: SeoWho,
  input: SerpCompetitorsInput,
  deps: SeoPaidDeps = {},
): Promise<{ ok: true; result: SerpCompetitorsResult } | SeoDataRefusal> {
  const keywords = normalizeSavedKeywords(input.keywords ?? [])
  if (keywords.length === 0)
    throw new SeoInputError('Give at least one keyword.')
  if (keywords.length > SERP_COMPETITOR_KEYWORDS_MAX)
    throw new SeoInputError(
      `Compare at most ${SERP_COMPETITOR_KEYWORDS_MAX} keywords at a time.`,
    )
  const market = resolveDomainMarket(input)
  const resultTypes = [
    ...new Set(
      (input.result_types ?? ['organic', 'local_pack']).filter((type) =>
        (SERP_COMPETITOR_RESULT_TYPES as readonly string[]).includes(type),
      ),
    ),
  ].sort() as SerpCompetitorResultType[]
  if (resultTypes.length === 0)
    throw new SeoInputError(
      'Pick at least one kind of result: organic, paid, featured_snippet or local_pack.',
    )
  const limit = Math.min(
    Math.max(Math.floor(input.limit ?? DEFAULT_LIMIT), 1),
    MAX_LIMIT,
  )
  const includeSubdomains = input.include_subdomains !== false
  const sort: SerpCompetitorSort =
    input.sort_by &&
    (SERP_COMPETITOR_SORTS as readonly string[]).includes(input.sort_by)
      ? input.sort_by
      : 'visibility'
  const exclude = (input.exclude_domains ?? [])
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, EXCLUDE_MAX)
  const ownDomain = await ownSiteHost(svc, who.workspaceId)

  const finish = (
    stored: StoredCompetitors,
    meta: { lookup_id: string | null; fetched_at: string; from_cache: boolean },
  ): SerpCompetitorsResult => ({
    ...meta,
    keywords: stored.keywords,
    location_code: stored.location_code,
    language_code: stored.language_code,
    own_domain: ownDomain,
    rows: sortCompetitors(
      stored.rows
        .filter(
          (row) =>
            !exclude.some((domain) => hostMatchesDomain(row.domain, domain)),
        )
        .map((row) => ({
          ...row,
          own_site:
            ownDomain !== null && hostMatchesDomain(row.domain, ownDomain),
        })),
      sort,
    ),
    caveats: [DOMAIN_CAVEATS.estimates, DOMAIN_CAVEATS.snapshot],
  })

  const key = {
    v: COMPETITORS_VERSION,
    keywords: [...keywords].sort(),
    location_code: market.locationCode,
    language_code: market.languageCode,
    result_types: resultTypes,
    include_subdomains: includeSubdomains,
    limit,
  }
  const now = deps.now?.() ?? new Date()
  if (!input.refresh) {
    const hit = await readLookup<StoredCompetitors>(
      svc,
      who.workspaceId,
      SERP_COMPETITORS_KIND,
      key,
      { maxAgeMs: SERP_COMPETITORS_MAX_AGE_MS, now },
    )
    if (hit && Array.isArray(hit.result?.rows))
      return {
        ok: true,
        result: finish(hit.result, {
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        }),
      }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const items = await opened.client.labs.serpCompetitors({
    keywords,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    itemTypes: resultTypes,
    includeSubdomains,
    limit,
    feature: 'domain',
  })
  const rows = items.flatMap((item) => {
    const domain =
      typeof item.domain === 'string' ? item.domain.toLowerCase() : ''
    if (!domain) return []
    return [
      {
        domain,
        keywords_count: num(item.keywords_count),
        avg_position: num(item.avg_position),
        median_position: num(item.median_position),
        visibility: num(item.visibility),
        etv: num(item.etv),
      },
    ]
  })
  const stored: StoredCompetitors = {
    keywords,
    location_code: market.locationCode,
    language_code: market.languageCode,
    rows,
  }
  const first = keywords[0] ?? ''
  const label = `${keywords.length === 1 ? first : `${first} and ${keywords.length - 1} more`} · ${describeMarket(market.locationCode, market.languageCode)}`
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    { kind: SERP_COMPETITORS_KIND, request: key, result: stored, label },
    { now },
  )
  return {
    ok: true,
    result: finish(stored, {
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    }),
  }
}
