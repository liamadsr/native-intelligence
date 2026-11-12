/**
 * robots.txt and sitemap discovery for the site audit crawler.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { XMLParser } from 'fast-xml-parser'
import 'server-only'
import { createRateLimitWait, type RateLimitWait } from './crawl-throttle'
import { AuditFailure } from './failure'
import { crawlFetch, type CrawlFetch, type CrawlResponse } from './fetch'
import { frontierCapFor } from './limits'
import { dropPartialLastLine, parseRobotsTxt } from './robots'
import { isCrawlableUrl } from './start-url'
import { isSameOrigin, normalizeUrl } from './url-utils'

export { parseRobotsTxt, type RobotsResult } from './robots'

const ROBOTS_FETCH_TIMEOUT_MS = 10_000
const SITEMAP_FETCH_TIMEOUT_MS = 15_000
// robots.txt is saved on the audit row and parsed again by every crawl chunk.
// RFC 9309 requires parsers to handle at least 500 KiB and permits ignoring
// anything beyond it (Google does exactly that), so this cap is standard
// crawler behavior and keeps a misbehaving server (HTML at /robots.txt) small.
const MAX_ROBOTS_TXT_BYTES = 500 * 1024
const MAX_SITEMAP_DEPTH = 3
/** Sitemap documents one discovery may read, or hold in its queue to read. */
export const MAX_SITEMAP_DOCS = 300
/** Entries read from one sitemap document: the sitemap protocol's own limit. */
const MAX_SITEMAP_ENTRIES = 50_000
/** All of discovery (robots.txt and sitemaps): past it, the audit goes on with what was found. */
export const DISCOVERY_DEADLINE_MS = 5 * 60_000
const SITEMAP_CONCURRENCY = 5
const SITEMAP_RETRIES = 1
// Sitemap shards can legally reach 50 MB and SITEMAP_CONCURRENCY of them are
// read at once. Oversized shards are skipped whole: truncated XML would not
// parse anyway, and real generators shard far below this.
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024
const MAX_DISCOVERY_REDIRECT_HOPS = 5

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === 'sitemap' || name === 'url',
})

/**
 * Redirects are followed by hand so each hop is checked against the crawl's
 * rules again, before it is fetched: a hop to another site (or to anything
 * the crawl may not read) is never requested. Null = a redirect that was not
 * followed. One time budget covers the whole chain, held to `deadlineAt`.
 */
async function fetchFollowingRedirects(
  url: string,
  origin: string,
  options: {
    timeoutMs: number
    maxBytes: number
    accept: string
    deadlineAt: number
  },
  fetchImpl: CrawlFetch,
): Promise<{ response: CrawlResponse; finalUrl: string } | null> {
  const deadline = Math.min(Date.now() + options.timeoutMs, options.deadlineAt)
  let current = url
  for (let hop = 0; hop <= MAX_DISCOVERY_REDIRECT_HOPS; hop++) {
    const response = await fetchImpl(current, {
      timeoutMs: Math.max(1, deadline - Date.now()),
      maxBytes: options.maxBytes,
      accept: options.accept,
    })
    if (response.status < 300 || response.status >= 400)
      return { response, finalUrl: current }

    const location = response.header('location')
    if (!location) return null
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      return null
    }
    if (!isSameOrigin(next, origin) || !isCrawlableUrl(next)) return null
    current = next
  }
  return null
}

type RobotsFetch =
  | { kind: 'found'; text: string }
  /** Not there (a 4xx): everything is allowed. */
  | { kind: 'missing' }
  /**
   * Could not be read: the server or the network failed (RFC 9309 says
   * assume everything is disallowed), or it redirects somewhere we won't
   * follow (another site, another port, a private address, too many hops, no
   * Location), where rules for this site may well be.
   */
  | { kind: 'unreachable' }

/** The raw robots.txt body, kept apart from parsing so the text can be saved and parsed the same way by every chunk. */
async function fetchRobotsTxtText(
  origin: string,
  waitForRateLimit: RateLimitWait,
  fetchImpl: CrawlFetch,
  deadlineAt: number,
): Promise<RobotsFetch> {
  try {
    const fetchRobots = () =>
      fetchFollowingRedirects(
        `${origin}/robots.txt`,
        origin,
        {
          timeoutMs: ROBOTS_FETCH_TIMEOUT_MS,
          maxBytes: MAX_ROBOTS_TXT_BYTES,
          accept: 'text/plain,*/*;q=0.5',
          deadlineAt,
        },
        fetchImpl,
      )
    let fetched = await fetchRobots()
    if (
      fetched?.response.status === 429 &&
      (await waitForRateLimit(fetched.response.header('retry-after')))
    ) {
      fetched = await fetchRobots()
    }
    // A redirect not followed: robots.txt moved where we won't read it. Its
    // rules may still be this site's (`Disallow: /`): fail closed.
    if (!fetched) return { kind: 'unreachable' }
    const { status } = fetched.response
    if (status >= 200 && status < 300) {
      const { body, truncated } = fetched.response
      // Cut at the size cap: the last line may be half a rule.
      return { kind: 'found', text: truncated ? dropPartialLastLine(body) : body }
    }
    if (status >= 400 && status < 500 && status !== 429)
      return { kind: 'missing' }
    // 5xx, a 429 still there after its one retry, anything else.
    return { kind: 'unreachable' }
  } catch {
    // A timeout or a network failure.
    return { kind: 'unreachable' }
  }
}

function isProbablySitemapXml(contentType: string, body: string): boolean {
  if (contentType.includes('xml')) return true
  const trimmed = body.trimStart().toLowerCase()
  return (
    trimmed.startsWith('<?xml') ||
    trimmed.startsWith('<urlset') ||
    trimmed.startsWith('<sitemapindex')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function getSitemapLocations(input: unknown): string[] {
  if (!input) return []
  const entries = (Array.isArray(input) ? input : [input]).slice(
    0,
    MAX_SITEMAP_ENTRIES,
  )
  return entries
    .map((entry) => {
      if (!isRecord(entry)) return null
      const loc = entry['loc']
      // fast-xml-parser reads <loc>https://…</loc> as a string; a loc with
      // attributes becomes an object whose text is under "#text".
      if (typeof loc === 'string') return loc
      if (isRecord(loc) && typeof loc['#text'] === 'string') return loc['#text']
      return null
    })
    .filter((loc): loc is string => typeof loc === 'string')
}

function getParsedSitemapSections(parsed: unknown): {
  sitemap: unknown
  url: unknown
} {
  if (!isRecord(parsed)) return { sitemap: undefined, url: undefined }
  const root = parsed as {
    sitemapindex?: { sitemap?: unknown }
    urlset?: { url?: unknown }
  }
  return { sitemap: root.sitemapindex?.sitemap, url: root.urlset?.url }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message)
}

async function fetchSitemapDocumentWithRetry(
  sitemapUrl: string,
  origin: string,
  waitForRateLimit: RateLimitWait,
  fetchImpl: CrawlFetch,
  deadlineAt: number,
): Promise<{ nestedSitemaps: string[]; pageUrls: string[] }> {
  const empty = { nestedSitemaps: [], pageUrls: [] }
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl)
  if (!normalizedSitemapUrl) return empty

  for (let attempt = 0; attempt <= SITEMAP_RETRIES; attempt++) {
    if (Date.now() >= deadlineAt) return empty
    try {
      const fetched = await fetchFollowingRedirects(
        normalizedSitemapUrl,
        origin,
        {
          timeoutMs: SITEMAP_FETCH_TIMEOUT_MS,
          maxBytes: MAX_SITEMAP_BYTES,
          accept: 'application/xml,text/xml,*/*;q=0.5',
          deadlineAt,
        },
        fetchImpl,
      )
      if (!fetched) return empty
      const { response } = fetched

      const finalUrl = normalizeUrl(fetched.finalUrl, normalizedSitemapUrl)
      if (!finalUrl || !isSameOrigin(finalUrl, origin)) return empty

      if (
        response.status === 429 &&
        attempt < SITEMAP_RETRIES &&
        (await waitForRateLimit(response.header('retry-after')))
      ) {
        continue
      }
      if (response.status < 200 || response.status >= 300) return empty
      // Truncated XML would not parse; an oversized shard is skipped whole.
      if (
        response.truncated ||
        !isProbablySitemapXml(response.contentType, response.body)
      )
        return empty

      const sections = getParsedSitemapSections(
        xmlParser.parse(response.body) as unknown,
      )
      const toUrls = (input: unknown) =>
        getSitemapLocations(input)
          .map((loc) => normalizeUrl(loc.trim(), finalUrl))
          .filter((loc): loc is string => loc !== null)
      return {
        nestedSitemaps: toUrls(sections.sitemap),
        pageUrls: toUrls(sections.url),
      }
    } catch (error) {
      if (!isTimeout(error) || attempt === SITEMAP_RETRIES) return empty
    }
  }
  return empty
}

/**
 * Every page URL the site's robots.txt and sitemaps list for an origin (the
 * default /sitemap.xml is tried even when robots.txt does not name it), and
 * the robots.txt text itself.
 *
 * All of them are returned, not just the first `maxPages`: seeding is also
 * what records each page's in-sitemap flag, so cutting here would make every
 * sitemap URL past the budget read as "not in the sitemap" once a link
 * reached it. The set is bounded by the queue's own cap.
 *
 * Bounded however the site answers: at most MAX_SITEMAP_DOCS documents are
 * ever queued (each once), at most 50,000 entries are read from one, and
 * the whole run ends at its deadline (`timedOut`), going on with what it
 * found. A robots.txt that could not be read fails the audit
 * (ROBOTS_UNREACHABLE); one that does not exist allows everything.
 */
export async function discoverUrls(
  origin: string,
  maxPages: number,
  fetchImpl: CrawlFetch = crawlFetch,
  deadlineAt: number = Date.now() + DISCOVERY_DEADLINE_MS,
): Promise<{
  urls: string[]
  robotsText: string | null
  /** Sitemap entries that point at another site: how many, and the host most of them name. */
  otherSite: { count: number; host: string; sitemapUrl: string } | null
  /** The deadline ended the reading of sitemaps. */
  timedOut: boolean
}> {
  const waitForRateLimit = createRateLimitWait()
  const fetchedRobots = await fetchRobotsTxtText(
    origin,
    waitForRateLimit,
    fetchImpl,
    deadlineAt,
  )
  if (fetchedRobots.kind === 'unreachable') {
    throw new AuditFailure(
      'ROBOTS_UNREACHABLE',
      'The site’s robots.txt didn’t answer, so we couldn’t tell what we may read. Try again later.',
    )
  }
  const robotsText =
    fetchedRobots.kind === 'found' ? fetchedRobots.text : null
  const robots = parseRobotsTxt(origin, robotsText)

  const sitemapSources = new Set(robots.sitemapUrls)
  sitemapSources.add(`${origin}/sitemap.xml`)

  const maxDiscoveredUrls = frontierCapFor(maxPages)
  const allUrls = new Set<string>()

  // Every sitemap document ever queued, fetched or still waiting: it is
  // checked when a URL is pushed, so the queue never holds a document twice,
  // and its size caps what is fetched plus what waits.
  const queuedSitemapDocs = new Set<string>()
  const queue: Array<{ url: string; depth: number }> = []
  const enqueue = (url: string, depth: number) => {
    if (queuedSitemapDocs.has(url)) return
    if (queuedSitemapDocs.size >= MAX_SITEMAP_DOCS) return
    queuedSitemapDocs.add(url)
    queue.push({ url, depth })
  }
  for (const source of sitemapSources) {
    const url = normalizeUrl(source, origin)
    if (url && isSameOrigin(url, origin) && isCrawlableUrl(url))
      enqueue(url, MAX_SITEMAP_DEPTH)
  }
  const otherHosts = new Map<string, number>()
  let otherSiteSitemap: string | null = null
  const site = new URL(origin)

  while (
    queue.length > 0 &&
    allUrls.size < maxDiscoveredUrls &&
    Date.now() < deadlineAt
  ) {
    const batch = queue.splice(0, SITEMAP_CONCURRENCY)
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        if (depth <= 0) return

        const result = await fetchSitemapDocumentWithRetry(
          url,
          origin,
          waitForRateLimit,
          fetchImpl,
          deadlineAt,
        )
        for (const pageUrl of result.pageUrls) {
          if (allUrls.size >= maxDiscoveredUrls) break
          if (isSameOrigin(pageUrl, origin)) {
            allUrls.add(pageUrl)
            continue
          }
          const entry = parseUrl(pageUrl)
          if (!entry) continue
          if (sameHost(entry.hostname, site.hostname)) {
            // This site's own page under another scheme (an http entry in an
            // https site's sitemap, common after a move to https): read it
            // as the page it is, not as another site's.
            entry.protocol = site.protocol
            entry.port = site.port
            const own = normalizeUrl(entry.toString())
            if (own && isSameOrigin(own, origin)) allUrls.add(own)
            continue
          }
          otherHosts.set(entry.host, (otherHosts.get(entry.host) ?? 0) + 1)
          otherSiteSitemap ??= url
        }
        if (depth <= 1) return
        for (const nestedUrl of result.nestedSitemaps) {
          if (queuedSitemapDocs.size >= MAX_SITEMAP_DOCS) break
          if (!isSameOrigin(nestedUrl, origin) || !isCrawlableUrl(nestedUrl))
            continue
          enqueue(nestedUrl, depth - 1)
        }
      }),
    )
  }
  const timedOut = Date.now() >= deadlineAt

  let otherSite: { count: number; host: string; sitemapUrl: string } | null =
    null
  if (otherHosts.size > 0 && otherSiteSitemap) {
    const [host] = [...otherHosts].sort((a, b) => b[1] - a[1])[0]
    otherSite = {
      count: [...otherHosts.values()].reduce((sum, n) => sum + n, 0),
      host,
      sitemapUrl: otherSiteSitemap,
    }
  }
  return { urls: Array.from(allUrls), robotsText, otherSite, timedOut }
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** The same site by name: www and no-www are one host. */
function sameHost(a: string, b: string): boolean {
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, '')
  return bare(a) === bare(b)
}
