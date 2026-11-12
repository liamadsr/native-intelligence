/**
 * Crawl one URL: fetch it (waiting out a 429 once), classify what came back,
 * and read the page's SEO signals from its HTML.
 *
 * Redirects are not followed here. Each hop is recorded as its own page and
 * its target is queued by the caller, so redirect chains and loops can be
 * found from the recorded rows. Trailing-slash redirects (/docs to /docs/)
 * need no special handling: normalizeUrl keeps trailing slashes, so the two
 * are different URLs and the redirect resolves to its target instead of
 * cycling back to its source.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'
import { classifyFetch } from './classify-fetch'
import type { CrawlThrottle } from './crawl-throttle'
import { crawlFetch, type CrawlFetch, type CrawlResponse } from './fetch'
import { pageRowId, sha256Hex } from './ids'
import { MAX_URL_CHARS } from './limits'
import { analyzeHtml } from './page-analyzer'
import type { CrawledPageResult, PageFetchClass } from './types'
import { normalizeUrl } from './url-utils'

/**
 * A canonical as the audit keeps it: an http(s) address, normalised, within
 * the URL limit. Anything else is null, never the page's raw text: a
 * canonical is handed to the model as a plain URL, so text the page's author
 * chose must not pass for one.
 */
function canonicalAddress(href: string, pageUrl: string): string | null {
  const url = normalizeUrl(href.trim(), pageUrl, { keepTrackingParams: true })
  return url && url.length <= MAX_URL_CHARS ? url : null
}

/** Parse `Link: <url>; rel="canonical"` response headers. */
export function parseLinkHeaderCanonical(
  linkHeader: string | null,
  pageUrl: string,
): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    // No "<" inside the brackets: the match fails at the next "<" instead of
    // scanning to the end of the header from every one (quadratic).
    const match = part.match(/<([^<>]*)>\s*;(.*)/)
    if (!match) continue
    if (/rel\s*=\s*"?canonical"?/i.test(match[2])) {
      return canonicalAddress(match[1], pageUrl)
    }
  }
  return null
}

/**
 * Fetch one URL, pausing the whole crawl and retrying once while the site
 * answers 429 (see crawl-throttle.ts). Null when the throttle says this
 * chunk can't start another request.
 */
async function fetchPage(
  url: string,
  throttle: CrawlThrottle,
  fetchImpl: CrawlFetch,
): Promise<{ response: CrawlResponse; rateLimited: boolean } | null> {
  for (let attempt = 1; ; attempt++) {
    if (!(await throttle.ready())) return null
    const response = await fetchImpl(url, {
      // A crawl reads HTML, and nothing else: a PDF or an image behind a link is never downloaded.
      wantBody: (status, contentType) =>
        (status < 300 || status >= 400) && contentType.includes('text/html'),
    })
    // A retry means an earlier attempt was refused; a 429 handed back after
    // the last retry is already classified rate_limited and needs no flag.
    const result = { response, rateLimited: attempt > 1 }
    if (response.status !== 429) {
      await throttle.recovered(url)
      return result
    }
    const retry = await throttle.backoff(url, response.header('retry-after'))
    // The shared pause applies even when this URL has no retries left.
    if (!retry) return result
  }
}

export interface CrawlPageInput {
  auditId: string
  url: string
  crawlDepth: number | null
  inSitemap: boolean
}

/** Null leaves this URL waiting when the crawl's pause stops its fetch. */
export async function crawlPage(
  input: CrawlPageInput,
  throttle: CrawlThrottle,
  fetchImpl: CrawlFetch = crawlFetch,
): Promise<CrawledPageResult | null> {
  const { auditId, url, crawlDepth, inSitemap } = input
  const startedAt = Date.now()
  const base = { auditId, url, crawlDepth, inSitemap }

  try {
    const fetched = await fetchPage(url, throttle, fetchImpl)
    if (!fetched) return null
    const { response, rateLimited } = fetched
    const statusCode = response.status
    const responseTimeMs = response.responseTimeMs
    const xRobotsTag = response.header('x-robots-tag')
    const headerCanonicalUrl = parseLinkHeaderCanonical(
      response.header('link'),
      url,
    )

    if (statusCode >= 300 && statusCode < 400) {
      const location = response.header('location')
      return emptyPageResult({
        ...base,
        statusCode,
        fetchClass: 'ok',
        redirectUrl: location ? normalizeUrl(location, url) : null,
        responseTimeMs,
        xRobotsTag,
        headerCanonicalUrl,
        rateLimited,
      })
    }

    const isHtml = response.contentType.includes('text/html')
    const body = response.body
    const fetchClass = classifyFetch(
      statusCode,
      Boolean(response.header('cf-mitigated')),
      body.slice(0, 4_000),
    )

    if (!isHtml || fetchClass !== 'ok' || statusCode >= 400) {
      return emptyPageResult({
        ...base,
        statusCode,
        fetchClass,
        redirectUrl: null,
        responseTimeMs,
        xRobotsTag,
        headerCanonicalUrl,
        rateLimited,
      })
    }

    const analysis = analyzeHtml(body, url, statusCode, responseTimeMs)
    const javascriptShell = analysis.javascriptShell === true
    const robotsDirectives = [analysis.robotsMeta, xRobotsTag]
      .filter(Boolean)
      .join(',')
      .toLowerCase()
    const headingCount = (level: number) =>
      analysis.headingOrder.filter((h) => h === level).length

    // Parser strings can be slices that keep the whole HTML body alive.
    // Detach the finished result before the save queue holds on to it:
    // otherwise a few KB of metadata can pin a megabyte of HTML per page.
    return structuredClone({
      id: pageRowId(auditId, url),
      url,
      statusCode,
      fetchClass,
      redirectUrl: null,
      title: analysis.title,
      metaDescription: analysis.metaDescription,
      canonicalUrl: analysis.canonical
        ? canonicalAddress(analysis.canonical, url)
        : null,
      robotsMeta: analysis.robotsMeta,
      xRobotsTag,
      headerCanonicalUrl,
      ogTitle: analysis.ogTitle,
      ogDescription: analysis.ogDescription,
      ogImage: analysis.ogImage,
      h1Count: analysis.h1s.filter((h) => h.length > 0).length,
      h2Count: headingCount(2),
      h3Count: headingCount(3),
      h4Count: headingCount(4),
      h5Count: headingCount(5),
      h6Count: headingCount(6),
      headingOrder: analysis.headingOrder,
      wordCount: analysis.wordCount,
      contentHash:
        analysis.bodyText && !javascriptShell
          ? sha256Hex(analysis.bodyText)
          : null,
      isHtml: true,
      javascriptShell,
      rateLimited,
      imagesTotal: analysis.images.length,
      // Only a truly absent alt attribute counts: alt="" is the right markup
      // for a decorative image.
      imagesMissingAlt: analysis.images.filter((img) => img.alt === null)
        .length,
      links: analysis.links,
      hasStructuredData: analysis.hasStructuredData,
      hreflangTags: analysis.hreflangTags,
      isIndexable: !robotsDirectives.includes('noindex'),
      responseTimeMs,
      crawlDepth,
      inSitemap,
    } satisfies CrawledPageResult)
  } catch (error) {
    // Losing the saved pause must fail the chunk, not become a page error
    // that lets the crawl keep making requests the site asked it not to.
    if (throttle.checkpointFailed) throw error
    return emptyPageResult({
      ...base,
      statusCode: 0,
      fetchClass: 'error',
      redirectUrl: null,
      responseTimeMs: Date.now() - startedAt,
      xRobotsTag: null,
      headerCanonicalUrl: null,
    })
  }
}

function emptyPageResult(input: {
  auditId: string
  url: string
  statusCode: number
  fetchClass: PageFetchClass
  redirectUrl: string | null
  responseTimeMs: number
  xRobotsTag: string | null
  headerCanonicalUrl: string | null
  crawlDepth: number | null
  inSitemap: boolean
  rateLimited?: boolean
}): CrawledPageResult {
  return {
    id: pageRowId(input.auditId, input.url),
    url: input.url,
    statusCode: input.statusCode,
    fetchClass: input.fetchClass,
    redirectUrl: input.redirectUrl,
    title: '',
    metaDescription: '',
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: input.xRobotsTag,
    headerCanonicalUrl: input.headerCanonicalUrl,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 0,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [],
    wordCount: 0,
    contentHash: null,
    isHtml: false,
    rateLimited: input.rateLimited ?? false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    links: [],
    hasStructuredData: false,
    hreflangTags: [],
    isIndexable: false,
    responseTimeMs: input.responseTimeMs,
    crawlDepth: input.crawlDepth,
    inSitemap: input.inSitemap,
  }
}
