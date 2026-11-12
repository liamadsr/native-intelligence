/**
 * Shared types for the site audit: what one page's HTML yields, and what one
 * crawled URL becomes before it is saved.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */

/**
 * How a page fetch resolved. "blocked" = a firewall or bot challenge stood in
 * the way; "rate_limited" = a 429 the crawl could not get past; "error" = no
 * response at all. The same list is the CHECK on seo_audit_page.fetch_class
 * (migration 590).
 */
export const PAGE_FETCH_CLASSES = [
  'ok',
  'blocked',
  'rate_limited',
  'error',
] as const

export type PageFetchClass = (typeof PAGE_FETCH_CLASSES)[number]

/** One outgoing link edge, deduped by target URL within a page. */
export interface PageLink {
  targetUrl: string
  anchor: string | null
  isInternal: boolean
  isNofollow: boolean
}

/** Data extracted from a single page's HTML. */
export interface PageAnalysis {
  url: string
  statusCode: number
  redirectUrl: string | null
  responseTimeMs: number

  // Head metadata
  title: string
  metaDescription: string
  canonical: string | null
  robotsMeta: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null

  // Headings
  h1s: string[]
  headingOrder: number[]

  // Content
  wordCount: number
  bodyText: string
  /** Conservative signal of an app shell, not proof of missing content. */
  javascriptShell?: boolean

  // Images
  images: Array<{ src: string | null; alt: string | null }>

  // Links (normalized, deduped by target)
  links: PageLink[]

  // Structured data
  hasStructuredData: boolean

  // Hreflang
  hreflangTags: string[]
}

/**
 * Full result of crawling one page. Saved inside the crawl chunk that
 * fetched it; never accumulated across chunks.
 */
export interface CrawledPageResult {
  /** Derived from (audit, url): see pageRowId in ids.ts. */
  id: string
  url: string
  statusCode: number
  fetchClass: PageFetchClass
  redirectUrl: string | null
  title: string
  metaDescription: string
  canonicalUrl: string | null
  robotsMeta: string | null
  xRobotsTag: string | null
  headerCanonicalUrl: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null
  h1Count: number
  h2Count: number
  h3Count: number
  h4Count: number
  h5Count: number
  h6Count: number
  headingOrder: number[]
  wordCount: number
  contentHash: string | null
  /**
   * True when an HTML document was fetched and analyzed. Gates the content
   * checks in the page reporters (an empty-shell HTML page must still be
   * checked; a PDF must not). Not saved.
   */
  isHtml: boolean
  /** An app shell with no readable content; a signal for the page reporters. Not saved. */
  javascriptShell?: boolean
  /** True when a 429 was retried for this URL (whatever the retry returned). Not saved. */
  rateLimited: boolean
  imagesTotal: number
  imagesMissingAlt: number
  links: PageLink[]
  hasStructuredData: boolean
  hreflangTags: string[]
  isIndexable: boolean
  responseTimeMs: number
  /** null = not reached via links (a sitemap seed). */
  crawlDepth: number | null
  inSitemap: boolean
}
