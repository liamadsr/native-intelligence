/**
 * What the SEO domain pages and the tools read: a domain's overview (its
 * estimated organic traffic, how many keywords it ranks for, its top
 * keywords and pages), the keywords a domain or page ranks for, and the
 * domains that compete in Google for a set of keywords. Safe to import from
 * client components (types and plain functions only).
 *
 * Every number here is the search-data provider's estimate from its own
 * crawl of Google, not the site's analytics: say so wherever it is shown.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { PartialAnswer } from '@/lib/seo/keywords/view'
import type { ResearchScope } from '@/lib/seo/shared/researchScope'

export {
  RESEARCH_SCOPE_DESCRIPTIONS,
  RESEARCH_SCOPE_LABELS,
  RESEARCH_SCOPES,
} from '@/lib/seo/shared/researchScope'
export type { ResearchScope } from '@/lib/seo/shared/researchScope'

/** The caveats every domain figure carries; the API returns the ones that apply in `caveats`. */
export const DOMAIN_CAVEATS = {
  estimates:
    'Traffic is an estimate of monthly organic visits from Google, worked out from rankings and search volumes in the provider’s own crawl. It is not the site’s analytics.',
  whole_domain: 'Overview figures cover the domain and all of its subdomains.',
  volumes: 'Search volumes are monthly averages over the last 12 months.',
  snapshot:
    'Rankings are a snapshot from the provider’s most recent crawl, which can be days or weeks old.',
} as const

/** A keyword a domain ranks for. */
export interface DomainKeywordRow {
  keyword: string
  /** Position on the results page (counts SERP features), null when unknown. */
  position: number | null
  search_volume: number | null
  /** Estimated monthly visits this keyword brings the domain. */
  traffic: number | null
  cpc: number | null
  keyword_difficulty: number | null
  /** The ranking page. */
  url: string | null
  relative_url: string | null
}

/** One of a domain's pages that earns organic traffic. */
export interface DomainPageRow {
  url: string
  relative_path: string | null
  /** Estimated monthly organic visits. */
  organic_traffic: number | null
  /** Keywords the page ranks for. */
  keywords: number | null
}

export interface DomainOverview {
  lookup_id: string | null
  /** The hostname looked up (bare, without "www."). */
  domain: string
  /** True when the domain was not named and the workspace's own site was used. */
  is_own_site: boolean
  location_code: number
  language_code: string
  /** Estimated monthly organic visits. */
  organic_traffic: number | null
  /** Keywords it ranks for in this market. */
  organic_keywords: number | null
  /** False when the provider has no rankings for it in this market (a new or small site, or the wrong market). */
  has_data: boolean
  /** The keywords bringing it the most traffic, at most 100. */
  top_keywords: DomainKeywordRow[]
  /** The pages bringing it the most traffic, at most 20. */
  top_pages: DomainPageRow[]
  caveats: string[]
  /**
   * Set when its top keywords or pages could not be read after the overview
   * was bought (missing: 'top_keywords', 'top_pages'); the caveats say so too.
   */
  partial?: PartialAnswer | null
  fetched_at: string
  from_cache: boolean
}

export const RANKED_KEYWORD_SORTS = [
  'search_volume',
  'traffic',
  'rank',
  'cpc',
] as const
export type RankedKeywordSort = (typeof RANKED_KEYWORD_SORTS)[number]
export const RANKED_KEYWORDS_PAGE_MAX = 100
export const RANKED_KEYWORDS_OFFSET_MAX = 1000

export interface RankedKeywordsPage {
  lookup_id: string | null
  /** What was looked up: a hostname, or hostname + path for a page or folder. */
  target: string
  scope: ResearchScope
  is_own_site: boolean
  location_code: number
  language_code: string
  rows: DomainKeywordRow[]
  /** How many keywords match in all, when the provider says. */
  total_count: number | null
  /** Pass as `offset` for the next page; null when this was the last. */
  next_offset: number | null
  caveats: string[]
  fetched_at: string
  from_cache: boolean
}

export const SERP_COMPETITOR_SORTS = [
  'visibility',
  'traffic',
  'avg_position',
  'keyword_count',
] as const
export type SerpCompetitorSort = (typeof SERP_COMPETITOR_SORTS)[number]
export const SERP_COMPETITOR_RESULT_TYPES = [
  'organic',
  'paid',
  'featured_snippet',
  'local_pack',
] as const
export type SerpCompetitorResultType =
  (typeof SERP_COMPETITOR_RESULT_TYPES)[number]
export const SERP_COMPETITOR_KEYWORDS_MAX = 100

export interface SerpCompetitorRow {
  domain: string
  /** How many of the keywords it ranks for. */
  keywords_count: number | null
  avg_position: number | null
  median_position: number | null
  /** Share of the keywords' clicks it is estimated to get, 0 to 1. */
  visibility: number | null
  /** Estimated monthly visits from these keywords. */
  etv: number | null
  /** The workspace's own site. */
  own_site: boolean
}

export interface SerpCompetitorsResult {
  lookup_id: string | null
  keywords: string[]
  location_code: number
  language_code: string
  /** The workspace's own site's domain, when it has one: its row is marked own_site. */
  own_domain: string | null
  rows: SerpCompetitorRow[]
  caveats: string[]
  fetched_at: string
  from_cache: boolean
}

/** A URL's path and query ("/blog/post?x=1"), or null when it isn't a URL. */
export function toRelativePath(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || '/'
  } catch {
    return null
  }
}

/** True when `host` is `domain` or one of its subdomains ("www." ignored on both). */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  const d = domain.toLowerCase().replace(/^www\./, '')
  return h === d || h.endsWith(`.${d}`)
}
