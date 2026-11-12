/**
 * A domain's overview in one country: its estimated monthly organic traffic,
 * how many keywords it ranks for, the 100 keywords bringing it the most
 * traffic and its 20 best pages. The first look at any domain, the
 * workspace's own (the default) or a competitor's.
 *
 * The rank overview is bought first; only a domain that ranks for something
 * has its keywords and pages bought too (an empty domain costs one small
 * call). Whatever was bought is stored (kind domain_overview): an overview
 * with data answers for 12 hours, also when its top keywords or pages could
 * not be read (marked `partial`); one without data (a new site, the wrong
 * market) answers for DOMAIN_OVERVIEW_EMPTY_MAX_AGE_MS only, so a new site is
 * looked at again within hours without being bought on every ask. `refresh`
 * buys again on the person's ask.
 *
 * The overview always covers the hostname and all its subdomains (the
 * provider has no narrower overview); ranked keywords take a narrower scope.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import type { RelevantPagesItem } from '@/lib/seo/dataforseo'
import { resolveDomainMarket } from '@/lib/seo/keywords/market'
import { describeMarket, type PartialAnswer } from '@/lib/seo/keywords/view'
import { HOUR_MS, readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { mapRankedKeywordItem, rankedOrderBy } from './ranked-keywords'
import { resolveTarget } from './target'
import {
  DOMAIN_CAVEATS,
  toRelativePath,
  type DomainKeywordRow,
  type DomainOverview,
  type DomainPageRow,
} from './view'

export const DOMAIN_OVERVIEW_KIND = 'domain_overview'
export const DOMAIN_OVERVIEW_MAX_AGE_MS = 12 * HOUR_MS
/** How long an overview that found no rankings answers the same question. */
export const DOMAIN_OVERVIEW_EMPTY_MAX_AGE_MS = 3 * HOUR_MS
const OVERVIEW_VERSION = 1
const TOP_KEYWORDS = 100
const TOP_PAGES = 20

export function mapPageItem(item: RelevantPagesItem): DomainPageRow | null {
  const url = item.page_address ?? null
  if (!url) return null
  const organic = item.metrics?.organic ?? null
  return {
    url,
    relative_path: toRelativePath(url),
    organic_traffic: organic?.etv != null ? Math.round(organic.etv) : null,
    keywords: organic?.count != null ? Math.round(organic.count) : null,
  }
}

export interface DomainOverviewInput {
  /** A domain or URL (only its hostname is used); default the workspace's own site. */
  domain?: string | null
  location_code?: number | null
  language_code?: string | null
  refresh?: boolean
}

type StoredOverview = Omit<
  DomainOverview,
  'lookup_id' | 'fetched_at' | 'from_cache' | 'is_own_site'
>

export async function getDomainOverview(
  svc: SupabaseClient,
  who: SeoWho,
  input: DomainOverviewInput,
  deps: SeoPaidDeps = {},
): Promise<{ ok: true; result: DomainOverview } | SeoDataRefusal> {
  const market = resolveDomainMarket(input)
  const { target, isOwnSite } = await resolveTarget(svc, who.workspaceId, {
    domain: input.domain,
    scope: 'subdomains',
  })
  const domain = target.hostname
  const key = {
    v: OVERVIEW_VERSION,
    domain,
    location_code: market.locationCode,
    language_code: market.languageCode,
  }
  const now = deps.now?.() ?? new Date()
  if (!input.refresh) {
    const hit = await readLookup<StoredOverview>(
      svc,
      who.workspaceId,
      DOMAIN_OVERVIEW_KIND,
      key,
      { maxAgeMs: DOMAIN_OVERVIEW_MAX_AGE_MS, now },
    )
    if (
      hit &&
      typeof hit.result?.domain === 'string' &&
      (hit.result.has_data ||
        now.getTime() - Date.parse(hit.fetched_at) <=
          DOMAIN_OVERVIEW_EMPTY_MAX_AGE_MS)
    )
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
  const client = opened.client
  const base = {
    target: domain,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
  }

  const metrics = (await client.domain.rankOverview(base))[0]?.metrics?.organic
  const organicTraffic = metrics?.etv != null ? Math.round(metrics.etv) : null
  const organicKeywords =
    metrics?.count != null ? Math.round(metrics.count) : null
  const hasData = organicKeywords != null && organicKeywords > 0

  let topKeywords: DomainKeywordRow[] = []
  let topPages: DomainPageRow[] = []
  const missing: string[] = []
  const missingWords: string[] = []
  const caveats: string[] = [
    DOMAIN_CAVEATS.estimates,
    DOMAIN_CAVEATS.whole_domain,
    DOMAIN_CAVEATS.volumes,
    DOMAIN_CAVEATS.snapshot,
  ]
  if (hasData) {
    // Settled: each call is metered on its own, and one failing must not
    // lose the other (or the overview already paid for).
    const [keywords, pages] = await Promise.allSettled([
      client.domain.rankedKeywords({
        ...base,
        limit: TOP_KEYWORDS,
        orderBy: rankedOrderBy('traffic'),
      }),
      client.domain.relevantPages({
        ...base,
        limit: TOP_PAGES,
        orderBy: ['metrics.organic.etv,desc'],
      }),
    ])
    if (keywords.status === 'fulfilled')
      topKeywords = keywords.value.items
        .map(mapRankedKeywordItem)
        .filter((row): row is DomainKeywordRow => row !== null)
    else {
      console.warn('[seo-domain] overview keywords failed', keywords.reason)
      missing.push('top_keywords')
      missingWords.push(
        'Its top keywords couldn’t be read just now: ask for its ranked keywords to see them.',
      )
    }
    if (pages.status === 'fulfilled')
      topPages = pages.value.items
        .map(mapPageItem)
        .filter((row): row is DomainPageRow => row !== null)
    else {
      console.warn('[seo-domain] overview pages failed', pages.reason)
      missing.push('top_pages')
      missingWords.push('Its top pages couldn’t be read just now.')
    }
    caveats.push(...missingWords)
  }
  const partial: PartialAnswer | null =
    missing.length > 0 ? { missing, note: missingWords.join(' ') } : null

  const body: StoredOverview = {
    domain,
    location_code: market.locationCode,
    language_code: market.languageCode,
    organic_traffic: organicTraffic,
    organic_keywords: organicKeywords,
    has_data: hasData,
    top_keywords: topKeywords,
    top_pages: topPages,
    caveats,
    ...(partial ? { partial } : {}),
  }
  // Everything bought is kept: an empty overview answers for a few hours
  // only (see the read above), a partial one like a whole one.
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: DOMAIN_OVERVIEW_KIND,
      request: key,
      result: body,
      label: `${domain} · ${describeMarket(market.locationCode, market.languageCode)}`,
    },
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
