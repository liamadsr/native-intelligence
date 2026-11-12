/**
 * Client-side fetch layer for SEO's Competitors page: one place that knows
 * the domain routes' shapes (src/app/api/account/seo/domain/*), the stored
 * lookups (…/seo/lookups) and the market list (…/seo/locations).
 *
 * Errors come back as the Site audit page's SeoRequestError (../api.ts), so
 * the page branches on the same parsed codes: 402 SPEND_LIMIT_REACHED (a
 * neutral banner, the page stays usable), 503 SEO_NOT_CONFIGURED / 403
 * FREE_PLAN (lookups are off: the page's notice), 400 VALIDATION_ERROR (the
 * message is for the person: beside the field), anything else a "Could not …".
 *
 * What spends: overview, ranked keywords and competitors, unless the route
 * answers from its stored copy (`from_cache`). Lookups, one stored lookup,
 * the markets and the own site are free reads.
 */
import type { DomainOverview, RankedKeywordSort, RankedKeywordsPage, SerpCompetitorSort, SerpCompetitorsResult } from '@/lib/seo/domain/view'
import type { SeoMarketOptions } from '@/lib/seo/keywords/view'
import type { SeoLookupDetail, SeoLookupSummary } from '@/lib/seo/lookup-view'
import { SEO_DATA_OFF_CODES } from '@/lib/seo/spend-view'
import { SeoRequestError, errorCode } from '../api'

// ../api.ts keeps its JSON reader to itself, so this one mirrors it: the same
// envelope ({ error, code, details }) parsed into the same error class.
async function readJson<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const details = body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : null
  throw new SeoRequestError({
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    code: typeof body.code === 'string' ? body.code : 'UNKNOWN',
    details,
    status: res.status,
  })
}

const post = (path: string, body: Record<string, unknown>) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** A market as the routes take it. */
export interface Market {
  location_code: number
  language_code: string
}

// ── What an error means for the page ─────────────────────────────────────

/**
 * How the page treats a failed paid call:
 *   limit   402: the month's limit, said in a neutral banner
 *   off     503 SEO_NOT_CONFIGURED / 403 FREE_PLAN: lookups are off
 *   field   400: the person's to correct, beside the field
 *   failed  anything else: "Could not …" with a retry
 */
export type PaidFailure = 'limit' | 'off' | 'field' | 'failed'

export function paidFailure(err: unknown): PaidFailure {
  const code = errorCode(err)
  const status = err instanceof SeoRequestError ? err.apiError.status : 0
  if (code === 'SPEND_LIMIT_REACHED' || status === 402) return 'limit'
  if (code && SEO_DATA_OFF_CODES.has(code)) return 'off'
  if (status === 400) return 'field'
  return 'failed'
}

// ── Domain data (these spend unless stored) ──────────────────────────────

/** A site's overview; no domain means the workspace's own site. */
export async function fetchOverview(input: { domain?: string | null; market?: Market | null; refresh?: boolean }): Promise<DomainOverview> {
  const body: Record<string, unknown> = {}
  if (input.domain) body.domain = input.domain
  if (input.market) {
    body.location_code = input.market.location_code
    body.language_code = input.market.language_code
  }
  if (input.refresh) body.refresh = true
  return readJson<DomainOverview>(await post('/api/account/seo/domain/overview', body))
}

export interface RankedKeywordsQuery {
  target: string
  market: Market
  offset: number
  sort_by: RankedKeywordSort
  min_search_volume: number
  max_rank: number | null
  exclude_terms: readonly string[]
}

export const RANKED_PAGE = 100

/** One page of the keywords a site ranks for. */
export async function fetchRankedKeywords(query: RankedKeywordsQuery): Promise<RankedKeywordsPage> {
  const body: Record<string, unknown> = {
    target: query.target,
    location_code: query.market.location_code,
    language_code: query.market.language_code,
    limit: RANKED_PAGE,
    sort_by: query.sort_by,
  }
  if (query.offset > 0) body.offset = query.offset
  if (query.min_search_volume > 0) body.min_search_volume = query.min_search_volume
  if (query.max_rank) body.max_rank = query.max_rank
  if (query.exclude_terms.length > 0) body.exclude_terms = [...query.exclude_terms]
  return readJson<RankedKeywordsPage>(await post('/api/account/seo/domain/ranked-keywords', body))
}

/** The domains competing for these searches. A new sort or hidden domains are served from storage. */
export async function findCompetitors(input: {
  keywords: readonly string[]
  market: Market
  sort_by?: SerpCompetitorSort
  exclude_domains?: readonly string[]
  refresh?: boolean
}): Promise<SerpCompetitorsResult> {
  const body: Record<string, unknown> = {
    keywords: [...input.keywords],
    location_code: input.market.location_code,
    language_code: input.market.language_code,
  }
  if (input.sort_by) body.sort_by = input.sort_by
  if (input.exclude_domains && input.exclude_domains.length > 0) body.exclude_domains = [...input.exclude_domains]
  if (input.refresh) body.refresh = true
  return readJson<SerpCompetitorsResult>(await post('/api/account/seo/domain/competitors', body))
}

// ── Free reads ───────────────────────────────────────────────────────────

export const OVERVIEW_KIND = 'domain_overview'

/** The workspace's stored overviews, newest first. */
export async function fetchRecentOverviews(limit = 20): Promise<SeoLookupSummary[]> {
  const data = await readJson<{ lookups: SeoLookupSummary[] }>(await fetch(`/api/account/seo/lookups?kind=${OVERVIEW_KIND}&limit=${limit}`))
  return data.lookups ?? []
}

/** How an overview is stored: the route's answer without what is worked out per read. */
export type StoredOverview = Omit<DomainOverview, 'lookup_id' | 'fetched_at' | 'from_cache' | 'is_own_site'>

/** One stored overview, whole. */
export async function fetchStoredOverview(id: string): Promise<SeoLookupDetail<unknown, StoredOverview>> {
  return readJson<SeoLookupDetail<unknown, StoredOverview>>(await fetch(`/api/account/seo/lookups/${id}`))
}

/** The countries and languages, static and cacheable. */
export async function fetchMarkets(): Promise<SeoMarketOptions> {
  return readJson<SeoMarketOptions>(await fetch('/api/account/seo/locations'))
}

/**
 * The workspace's own site. No SEO route answers just this, so it is read
 * from the Site audit list's `default_url` (free, the same resolver the
 * domain routes use when no domain is named).
 */
export async function fetchOwnSite(): Promise<string | null> {
  const data = await readJson<{ default_url?: string | null }>(await fetch('/api/account/seo/audits'))
  return typeof data.default_url === 'string' && data.default_url ? data.default_url : null
}
