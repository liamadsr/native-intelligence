/**
 * What the SEO pages read about stored paid lookups (./lookup-cache.ts): the
 * "recent lookups" list and one stored lookup. Safe to import from client
 * components (types only).
 */

/** One row of the recent-lookups list: never the (heavy) result. */
export interface SeoLookupSummary {
  id: string
  /** keyword_research, keyword_metrics, serp_results, domain_overview, ranked_keywords, serp_competitors, … */
  kind: string
  /** A short line for the list ("running shoes · United States"). */
  label: string | null
  fetched_at: string
  fetched_by: string | null
}

/** One stored lookup with what was asked and what came back. */
export interface SeoLookupDetail<
  Req = unknown,
  Res = unknown,
> extends SeoLookupSummary {
  request: Req
  result: Res
}
