/**
 * The site audit's bounds, in one place so the start form, the tool's input
 * schema, the server check and the issue texts all read the same numbers.
 */

/** The name a site's robots.txt and firewall rules can address this crawler by. */
export const CRAWLER_TOKEN = 'NativeIntelligenceBot'

/** What the crawler says it is on every request. */
export const CRAWL_USER_AGENT = `Mozilla/5.0 (compatible; ${CRAWLER_TOKEN}/1.0; site audit)`

/** Audits one workspace may start in any 24 hours (the start function counts its rows by created_at). */
export const AUDIT_STARTS_PER_DAY = 20

export const MIN_AUDIT_PAGES = 10
export const DEFAULT_AUDIT_PAGES = 100
export const MAX_AUDIT_PAGES = 1000

/** Longest URL the crawl follows or stores (the sitemap protocol's own limit; also the columns' CHECK in 589). */
export const MAX_URL_CHARS = 2048

/** Most HTML read from one page: the first 1 MiB holds the SEO metadata and navigation of a normal document. */
export const MAX_HTML_BYTES = 1024 * 1024

/** An audit stops crawling after this long, whatever is left. */
export const AUDIT_CRAWL_TIME_LIMIT_HOURS = 2

/** URLs leased per crawl chunk (one background step). */
export const CHUNK_TARGET_PAGES = 40
/** A chunk stops starting new fetches after this long; what it still holds goes back to the queue. */
export const CHUNK_SOFT_DEADLINE_MS = 60_000
/** Fetches in flight at once inside a chunk. The throttle still spaces their starts a second apart. */
export const CRAWL_CONCURRENCY = 4
/** Crawled pages are saved in batches of this size. */
export const PERSIST_BATCH_SIZE = 10

/** Internal link targets kept per page for the broken-link and orphan checks. */
export const MAX_STORED_LINKS_PER_PAGE = 500
/** New URLs one saved batch may add to the queue. */
export const MAX_DISCOVERED_PER_BATCH = 2_000
/** Broken-link findings kept per audit. */
export const MAX_BROKEN_LINK_ISSUES = 1_000

/** How many URLs the queue may hold for a page budget: enough to choose from, bounded against crawler traps. */
export function frontierCapFor(maxPages: number): number {
  return Math.min(Math.max(maxPages * 20, 500), 50_000)
}

/** The page budget a request asked for, held to the bounds. */
export function clampAuditPages(value: unknown): number {
  const n =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_AUDIT_PAGES
  return Math.min(MAX_AUDIT_PAGES, Math.max(MIN_AUDIT_PAGES, n))
}
