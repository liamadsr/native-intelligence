/**
 * The site audit, as three kinds of step the background lane runs in order
 * (src/lib/inngest/seo-audit-functions.ts):
 *
 *   runDiscovery     where the site really starts (its own redirects
 *                    followed), its robots.txt and sitemaps, and the first
 *                    URLs in the queue.
 *   runCrawlChunk    one bounded slice of the crawl, again and again: lease
 *                    some URLs, fetch them politely, read each page, save
 *                    pages, per-page issues and link targets, queue the new
 *                    URLs their links found.
 *   finalizeAudit    the checks that need the whole crawl (duplicates,
 *                    redirect chains, broken internal links, orphan pages),
 *                    the tally, and the cleanup of the crawl's own tables.
 *
 * Every step is safe to run twice. A retried chunk gets back the URLs its
 * failed attempt still holds (the lease is keyed by chunk number), and page
 * and issue rows have ids derived from what they are about, so a second
 * write lands on the first.
 *
 * Nothing here knows the database: it talks to an AuditStore (store.ts in
 * production, an in-memory one in tests), and the network is the injected
 * fetch.
 */
import 'server-only'
import { crawlPage } from './crawl-page'
import { createCrawlThrottle, type CrawlThrottleState } from './crawl-throttle'
import { discoverUrls, parseRobotsTxt } from './discovery'
import { AuditFailure } from './failure'
import { crawlFetch, type CrawlFetch } from './fetch'
import { CRAWL_STOP_ISSUE_TYPES, type AuditIssueType } from './issues'
import {
  AUDIT_CRAWL_TIME_LIMIT_HOURS,
  CHUNK_SOFT_DEADLINE_MS,
  CHUNK_TARGET_PAGES,
  CRAWL_CONCURRENCY,
  frontierCapFor,
  MAX_BROKEN_LINK_ISSUES,
  MAX_DISCOVERED_PER_BATCH,
  MAX_STORED_LINKS_PER_PAGE,
  MAX_URL_CHARS,
  PERSIST_BATCH_SIZE,
} from './limits'
import {
  findDuplicates,
  findRedirectChainsAndLoops,
  type SlimPage,
} from './multipage-checks'
import { runPageReporters, type DetectedIssue } from './page-reporters'
import { createRobotsGate } from './robots'
import { isCrawlableUrl, resolveStartUrlRedirects } from './start-url'
import type { CrawledPageResult } from './types'
import { isAuditablePageUrl, isSameOrigin, normalizeUrl } from './url-utils'

export type AuditStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
export type AuditPhase = 'discovery' | 'crawl' | 'analysis' | 'done'
export type CrawlStopReason = (typeof CRAWL_STOP_ISSUE_TYPES)[number]

/** What the crawl carries between chunks (seo_audit.crawl_state). */
export interface CrawlState {
  /** When the first chunk began, for the audit's time limit. */
  crawlStartedAt?: number
  throttle?: CrawlThrottleState
  /** Why the crawl ended with URLs left unvisited, when it did. */
  stop?: CrawlStopReason
  /** Chunks in a row that found nothing to do. */
  idleChunks?: number
  /** The site's sitemap mostly lists pages of another site (found at discovery, reported at the end). */
  sitemapOtherSite?: {
    host: string
    count: number
    listed: number
    /** The sitemap file those entries were found in. */
    sitemapUrl?: string
  }
}

export interface AuditRecord {
  id: string
  workspaceId: string
  startUrl: string
  origin: string
  status: AuditStatus
  phase: AuditPhase
  maxPages: number
  robotsTxt: string | null
  crawlState: CrawlState
}

export interface FrontierSeed {
  url: string
  depth: number | null
  source: 'start' | 'sitemap'
  inSitemap: boolean
}

export interface FrontierLease {
  url: string
  depth: number | null
  inSitemap: boolean
}

export interface PageLinksRow {
  pageId: string
  url: string
  targets: string[]
}

export interface AuditCounts {
  /** Page rows saved. */
  crawled: number
  /** URLs not crawled yet: waiting in the queue, or leased by a chunk that has not saved them. */
  pending: number
  /** Every URL the queue has seen. */
  queued: number
}

export interface AuditPatch {
  startUrl?: string
  origin?: string
  status?: AuditStatus
  phase?: AuditPhase
  pagesCrawled?: number
  pagesQueued?: number
  robotsTxt?: string | null
  crawlState?: CrawlState
  criticalCount?: number
  warningCount?: number
  infoCount?: number
  errorCode?: string | null
  errorDetail?: string | null
  completedAt?: string
}

/** Everything the audit reads and writes. Each method is safe to repeat. */
export interface AuditStore {
  getAudit(auditId: string): Promise<AuditRecord | null>
  updateAudit(auditId: string, patch: AuditPatch): Promise<void>
  /** Add URLs to the queue; ones already there are left as they are. Writes nothing once the audit is no longer running. */
  seedFrontier(audit: AuditRecord, seeds: FrontierSeed[]): Promise<void>
  claimChunk(
    auditId: string,
    chunkNo: number,
    limit: number,
    pagesLeftAfter: number,
  ): Promise<FrontierLease[]>
  /** Queue link-discovered URLs; returns how many were new. Writes nothing once the audit is no longer running. */
  discover(
    audit: AuditRecord,
    rows: Array<{ url: string; depth: number | null }>,
  ): Promise<number>
  /** Save crawled pages with their issues and link targets, and mark their URLs done. */
  saveBatch(
    audit: AuditRecord,
    batch: {
      pages: CrawledPageResult[]
      issues: DetectedIssue[]
      links: PageLinksRow[]
    },
  ): Promise<void>
  /** Hand leased URLs the chunk never fetched back to the queue. */
  releaseLeases(auditId: string, urls: string[]): Promise<void>
  counts(auditId: string): Promise<AuditCounts>
  /** Every saved page, the few columns the cross-page checks read. */
  slimPages(auditId: string): Promise<SlimPage[]>
  /** Ids of pages already flagged with an issue type. */
  pageIdsWithIssue(
    auditId: string,
    issueType: AuditIssueType,
  ): Promise<Set<string>>
  brokenLinks(
    auditId: string,
    limit: number,
  ): Promise<
    Array<{
      sourcePageId: string
      sourceUrl: string
      targetUrl: string
      targetStatus: number
    }>
  >
  orphanPages(
    auditId: string,
    startUrl: string,
  ): Promise<Array<{ pageId: string; url: string }>>
  saveIssues(audit: AuditRecord, issues: DetectedIssue[]): Promise<void>
  issueTally(
    auditId: string,
  ): Promise<{ critical: number; warning: number; info: number }>
  /** Delete the queue and the link targets: the audit no longer needs them. */
  clearCrawlTables(auditId: string): Promise<void>
}

export interface EngineDeps {
  fetch?: CrawlFetch
  now?: () => number
}

/** A failure the audit can't recover from by trying again. */
export { AuditFailure } from './failure'

/** Whether robots.txt lets the crawler fetch a URL: a gate of createRobotsGate, held to the step's robots time. */
type RobotsAllowed = (url: string) => Promise<boolean>

async function shouldQueue(
  url: string,
  origin: string,
  allowed: RobotsAllowed,
): Promise<boolean> {
  return (
    isSameOrigin(url, origin) &&
    isCrawlableUrl(url) &&
    isAuditablePageUrl(url) &&
    (await allowed(url))
  )
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function runDiscovery(
  store: AuditStore,
  auditId: string,
  deps: EngineDeps = {},
): Promise<{ seeded: number }> {
  const fetchImpl = deps.fetch ?? crawlFetch
  const now = deps.now ?? Date.now
  const audit = await store.getAudit(auditId)
  if (!audit)
    throw new AuditFailure('AUDIT_NOT_FOUND', 'The audit no longer exists.')

  // The start page is probed (a few requests at most, one per redirect hop,
  // no body read) before robots.txt is read: robots.txt belongs to the
  // site's real address, and only following the start URL's redirects tells
  // us what that is. Every page fetch comes after robots.txt.
  // Whether the start page answered anything at all, for when discovery runs out of time.
  let startAnswered = false
  const resolved = await resolveStartUrlRedirects(
    audit.startUrl,
    async (url, opts) => {
      const response = await fetchImpl(url, opts)
      startAnswered = true
      return response
    },
  )
  const startUrl = normalizeUrl(resolved) ?? resolved
  // Normalising can lengthen an address (a query is re-encoded when sorted):
  // check the address the audit would really store.
  if (startUrl.length > MAX_URL_CHARS) {
    throw new AuditFailure(
      'START_URL_TOO_LONG',
      'The site’s address is too long to audit. Start from a shorter one, like its home page.',
    )
  }
  const origin = new URL(startUrl).origin

  const {
    urls: sitemapUrls,
    robotsText,
    otherSite,
    timedOut,
  } = await discoverUrls(origin, audit.maxPages, fetchImpl)
  if (timedOut && !startAnswered) {
    throw new AuditFailure(
      'SITE_UNREACHABLE',
      'The site did not answer any request, so there is nothing to report. Check the address and that the site is up.',
    )
  }
  // A sitemap whose entries mostly name another site (a domain move left it
  // behind, or it is generated from the wrong address) is, to a search
  // engine, no sitemap for this site at all.
  const sitemapOtherSite =
    otherSite && otherSite.count > sitemapUrls.length
      ? {
          host: otherSite.host,
          count: otherSite.count,
          listed: sitemapUrls.length,
          sitemapUrl: otherSite.sitemapUrl,
        }
      : undefined
  const allowed = createRobotsGate(parseRobotsTxt(origin, robotsText))

  const listed = new Set(sitemapUrls)
  const seeds: FrontierSeed[] = []
  if (await allowed(startUrl)) {
    seeds.push({
      url: startUrl,
      depth: 0,
      source: 'start',
      inSitemap: listed.has(startUrl),
    })
  }
  const cap = frontierCapFor(audit.maxPages)
  for (const url of sitemapUrls) {
    if (seeds.length >= cap) break
    if (url === startUrl) continue
    if (await shouldQueue(url, origin, allowed))
      seeds.push({ url, depth: null, source: 'sitemap', inSitemap: true })
  }

  if (seeds.length === 0) {
    throw new AuditFailure(
      'ROBOTS_DISALLOWED',
      'The site’s robots.txt does not allow this crawler to read it, and its sitemap lists nothing it may read.',
    )
  }

  // Canceled while discovery ran: write nothing back (the seed below is
  // refused by the store too, so a cancel landing after this check still
  // leaves no queue behind).
  const current = await store.getAudit(auditId)
  if (!current || current.status !== 'running') return { seeded: 0 }

  const located: AuditRecord = {
    ...audit,
    startUrl,
    origin,
    robotsTxt: robotsText,
  }
  await store.updateAudit(auditId, {
    startUrl,
    origin,
    robotsTxt: robotsText,
    phase: 'crawl',
    pagesQueued: Math.min(seeds.length, audit.maxPages),
    crawlState: {
      ...audit.crawlState,
      crawlStartedAt: audit.crawlState.crawlStartedAt ?? now(),
      ...(sitemapOtherSite ? { sitemapOtherSite } : {}),
    },
  })
  await store.seedFrontier(located, seeds)
  return { seeded: seeds.length }
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export interface ChunkOutcome {
  /** True when the crawl is over: the budget is spent, the queue is empty, or it had to stop. */
  done: boolean
  /** The site asked for a pause: no request may start before this (epoch ms). */
  resumeAt: number | null
  crawled: number
  pending: number
}

/**
 * One slice of the crawl. `chunkNo` is the caller's loop counter: it names
 * the lease, so the same number always works on the same URLs.
 */
export async function runCrawlChunk(
  store: AuditStore,
  auditId: string,
  chunkNo: number,
  deps: EngineDeps = {},
): Promise<ChunkOutcome> {
  const fetchImpl = deps.fetch ?? crawlFetch
  const now = deps.now ?? Date.now
  const audit = await store.getAudit(auditId)
  if (!audit)
    throw new AuditFailure('AUDIT_NOT_FOUND', 'The audit no longer exists.')

  const before = await store.counts(auditId)
  const over = (stop?: CrawlStopReason): Promise<ChunkOutcome> =>
    endCrawl(
      store,
      audit,
      before,
      stop ? { ...audit.crawlState, stop } : audit.crawlState,
    )

  // Canceled (or already finished) between chunks: nothing more to fetch.
  if (audit.status !== 'running')
    return {
      done: true,
      resumeAt: null,
      crawled: before.crawled,
      pending: before.pending,
    }
  if (audit.crawlState.stop) return over()

  const budgetLeft = audit.maxPages - before.crawled
  if (budgetLeft <= 0 || before.pending === 0) return over()

  const startedAt = audit.crawlState.crawlStartedAt ?? now()
  if (now() - startedAt > AUDIT_CRAWL_TIME_LIMIT_HOURS * 3_600_000)
    return over('crawl-time-limit')

  let crawlState: CrawlState = {
    ...audit.crawlState,
    crawlStartedAt: startedAt,
  }
  const deadlineAt = now() + CHUNK_SOFT_DEADLINE_MS
  const throttle = createCrawlThrottle(
    deadlineAt,
    crawlState.throttle,
    async (state) => {
      // Saved the moment a site asks for a pause, so a chunk that dies right
      // after still leaves the next one knowing not to knock again yet.
      crawlState = { ...crawlState, throttle: state }
      await store.updateAudit(auditId, { crawlState })
    },
  )
  if (throttle.stopped) return over('crawl-rate-limited')

  // A pause that outlasts this chunk: sleep through it instead of leasing URLs only to hand them back.
  const pausedUntil = throttle.state.pausedUntil
  if (pausedUntil >= deadlineAt) {
    return {
      done: false,
      resumeAt: pausedUntil,
      crawled: before.crawled,
      pending: before.pending,
    }
  }

  const limit = Math.min(CHUNK_TARGET_PAGES, budgetLeft)
  const leased = await store.claimChunk(
    auditId,
    chunkNo,
    limit,
    budgetLeft - limit,
  )
  if (leased.length === 0) {
    // Normal once (a retry of a chunk whose first attempt saved everything);
    // twice in a row means nothing in the queue can be claimed: stop with
    // what there is instead of spinning.
    const idleChunks = (crawlState.idleChunks ?? 0) + 1
    if (idleChunks >= 2) return endCrawl(store, audit, before, crawlState)
    await store.updateAudit(auditId, {
      crawlState: { ...crawlState, idleChunks },
    })
    return {
      done: false,
      resumeAt: null,
      crawled: before.crawled,
      pending: before.pending,
    }
  }
  crawlState = { ...crawlState, idleChunks: 0 }

  const allowed = createRobotsGate(
    parseRobotsTxt(audit.origin, audit.robotsTxt),
  )
  const depthByUrl = new Map(leased.map((entry) => [entry.url, entry.depth]))
  const frontierCap = frontierCapFor(audit.maxPages)
  let queued = before.queued

  // Saving runs alongside fetching but one batch at a time, so the database
  // sees steady small writes and unsaved pages never pile up.
  const fetched = new Set<string>()
  let buffer: CrawledPageResult[] = []
  let saving: Promise<void> = Promise.resolve()
  // Canceled while this chunk ran: it saves nothing more and stops fetching.
  let canceled = false
  const persist = (pages: CrawledPageResult[]) => {
    saving = saving.then(async () => {
      if (canceled) return
      const room = Math.max(0, frontierCap - queued)
      const batch = await buildBatch(
        pages,
        depthByUrl,
        audit.origin,
        allowed,
        Math.min(room, MAX_DISCOVERED_PER_BATCH),
      )
      const current = await store.getAudit(auditId)
      if (!current || current.status !== 'running') {
        canceled = true
        return
      }
      await store.saveBatch(audit, batch)
      if (batch.discovered.length > 0)
        queued += await store.discover(audit, batch.discovered)
    })
    return saving
  }

  const queue = [...leased]
  const worker = async () => {
    for (;;) {
      if (now() >= deadlineAt || throttle.stopped || canceled) return
      const entry = queue.shift()
      if (!entry) return
      const page = await crawlPage(
        {
          auditId,
          url: entry.url,
          crawlDepth: entry.depth,
          inSitemap: entry.inSitemap,
        },
        throttle,
        fetchImpl,
      )
      // Null: the throttle would not start this request (out of time, or a pause). It stays leased and is released below.
      if (!page) return
      fetched.add(entry.url)
      buffer.push(page)
      if (buffer.length >= PERSIST_BATCH_SIZE) {
        const pages = buffer
        buffer = []
        void persist(pages).catch(() => {})
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CRAWL_CONCURRENCY, leased.length) }, worker),
  )
  if (buffer.length > 0) void persist(buffer).catch(() => {})
  // A failed save fails the chunk: its retry gets the same lease back.
  await saving
  if (canceled) {
    return {
      done: true,
      resumeAt: null,
      crawled: before.crawled,
      pending: before.pending,
    }
  }

  const unfetched = leased
    .map((entry) => entry.url)
    .filter((url) => !fetched.has(url))
  if (unfetched.length > 0) await store.releaseLeases(auditId, unfetched)

  const after = await store.counts(auditId)
  crawlState = { ...crawlState, throttle: throttle.state }
  if (throttle.stopped)
    return endCrawl(store, audit, after, {
      ...crawlState,
      stop: 'crawl-rate-limited',
    })

  const finished = after.crawled >= audit.maxPages || after.pending === 0
  if (finished) return endCrawl(store, audit, after, crawlState)

  await store.updateAudit(auditId, {
    pagesCrawled: after.crawled,
    pagesQueued: Math.min(after.queued, audit.maxPages),
    crawlState,
  })
  const resumeAt =
    throttle.state.pausedUntil > now() ? throttle.state.pausedUntil : null
  return {
    done: false,
    resumeAt,
    crawled: after.crawled,
    pending: after.pending,
  }
}

async function endCrawl(
  store: AuditStore,
  audit: AuditRecord,
  counts: AuditCounts,
  crawlState: CrawlState,
): Promise<ChunkOutcome> {
  await store.updateAudit(audit.id, {
    pagesCrawled: counts.crawled,
    pagesQueued: Math.min(counts.queued, audit.maxPages),
    phase: 'analysis',
    crawlState,
  })
  return {
    done: true,
    resumeAt: null,
    crawled: counts.crawled,
    pending: counts.pending,
  }
}

/** What one batch of crawled pages becomes: rows to save, and the URLs their links found. */
async function buildBatch(
  pages: CrawledPageResult[],
  depthByUrl: Map<string, number | null>,
  origin: string,
  allowed: RobotsAllowed,
  discoverLimit: number,
): Promise<{
  pages: CrawledPageResult[]
  issues: DetectedIssue[]
  links: PageLinksRow[]
  discovered: Array<{ url: string; depth: number | null }>
}> {
  const issues = pages.flatMap((page) => runPageReporters(page))
  const links: PageLinksRow[] = []
  const discovered = new Map<string, number | null>()

  for (const page of pages) {
    const pageDepth = depthByUrl.get(page.url) ?? null
    const childDepth = pageDepth === null ? null : pageDepth + 1

    const targets: string[] = []
    for (const link of page.links) {
      if (!link.isInternal) continue
      // A target the crawl would never fetch is not worth storing either.
      if (
        targets.length < MAX_STORED_LINKS_PER_PAGE &&
        link.targetUrl.length <= MAX_URL_CHARS
      )
        targets.push(link.targetUrl)
      if (
        discovered.size < discoverLimit &&
        !discovered.has(link.targetUrl) &&
        (await shouldQueue(link.targetUrl, origin, allowed))
      ) {
        discovered.set(link.targetUrl, childDepth)
      }
    }
    if (targets.length > 0)
      links.push({ pageId: page.id, url: page.url, targets })

    // A redirect's target continues the same path: same depth.
    if (
      page.redirectUrl &&
      discovered.size < discoverLimit &&
      !discovered.has(page.redirectUrl) &&
      (await shouldQueue(page.redirectUrl, origin, allowed))
    ) {
      discovered.set(page.redirectUrl, pageDepth)
    }
  }

  return {
    pages,
    issues,
    links,
    discovered: Array.from(discovered, ([url, depth]) => ({ url, depth })),
  }
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

export async function finalizeAudit(
  store: AuditStore,
  auditId: string,
): Promise<{ issues: number }> {
  const audit = await store.getAudit(auditId)
  if (!audit)
    throw new AuditFailure('AUDIT_NOT_FOUND', 'The audit no longer exists.')
  // Finished by an earlier attempt of this step, or canceled meanwhile (a
  // chunk that was mid-flight at the cancel may have written to the queue
  // again after the cancel cleared it).
  if (audit.status !== 'running') {
    if (audit.status === 'canceled') await store.clearCrawlTables(auditId)
    return { issues: 0 }
  }

  const counts = await store.counts(auditId)
  if (counts.crawled === 0) {
    throw new AuditFailure(
      'NOTHING_TO_CRAWL',
      'The site did not answer any request, so there is nothing to report.',
    )
  }

  // An unrendered app shell already carries its own coverage warning. Its
  // placeholder title and loading text must not become duplicate findings.
  const shells = await store.pageIdsWithIssue(
    auditId,
    'javascript-rendering-suspected',
  )
  const allPages = await store.slimPages(auditId)
  // No request got an answer at all (the site is down, or its name does not
  // resolve): a report with zero findings would read as a clean bill of health.
  if (allPages.every((page) => page.fetchClass === 'error')) {
    throw new AuditFailure(
      'SITE_UNREACHABLE',
      'The site did not answer any request, so there is nothing to report. Check the address and that the site is up.',
    )
  }
  const pages = allPages.filter((page) => !shells.has(page.id))
  const issues: DetectedIssue[] = [
    ...findDuplicates(pages),
    ...findRedirectChainsAndLoops(pages),
  ]

  for (const link of await store.brokenLinks(auditId, MAX_BROKEN_LINK_ISSUES)) {
    issues.push({
      issueType: 'broken-internal-link',
      pageId: link.sourcePageId,
      pageUrl: link.sourceUrl,
      details: { targetUrl: link.targetUrl, targetStatus: link.targetStatus },
      dedupeKey: link.targetUrl,
    })
  }

  // URLs left unvisited: say why, and skip the orphan check, which would
  // call a page an orphan only because the page linking to it wasn't read.
  const partial = counts.pending > 0
  const stop: CrawlStopReason | null =
    audit.crawlState.stop ?? (partial ? 'crawl-page-limit' : null)
  if (stop) {
    issues.push({
      issueType: stop,
      pageId: null,
      pageUrl: audit.startUrl,
      details: {
        pagesCrawled: counts.crawled,
        pagesFound: counts.queued,
        maxPages: audit.maxPages,
      },
    })
  }
  const otherSite = audit.crawlState.sitemapOtherSite
  if (otherSite) {
    issues.push({
      issueType: 'sitemap-other-site',
      pageId: null,
      pageUrl: otherSite.sitemapUrl ?? `${audit.origin}/sitemap.xml`,
      details: {
        otherHost: otherSite.host,
        entriesForOtherSite: otherSite.count,
        entriesForThisSite: otherSite.listed,
      },
    })
  }
  if (!partial && !stop) {
    for (const orphan of await store.orphanPages(auditId, audit.startUrl)) {
      issues.push({
        issueType: 'orphan-page',
        pageId: orphan.pageId,
        pageUrl: orphan.url,
      })
    }
  }

  await store.saveIssues(audit, issues)
  const tally = await store.issueTally(auditId)
  await store.updateAudit(auditId, {
    status: 'completed',
    phase: 'done',
    pagesCrawled: counts.crawled,
    criticalCount: tally.critical,
    warningCount: tally.warning,
    infoCount: tally.info,
    // Only the crawl read it: the site's own text is not kept past the audit.
    robotsTxt: null,
    completedAt: new Date().toISOString(),
  })
  await store.clearCrawlTables(auditId)
  return { issues: issues.length }
}

/**
 * Stop crawling for a reason other than the page budget, when the caller
 * (not a chunk) decides to: the report then names the real reason instead
 * of "page limit". Leaves an earlier reason as it is.
 */
export async function stopCrawl(
  store: AuditStore,
  auditId: string,
  reason: CrawlStopReason,
): Promise<void> {
  const audit = await store.getAudit(auditId)
  if (!audit || audit.status !== 'running' || audit.crawlState.stop) return
  await store.updateAudit(auditId, {
    phase: 'analysis',
    crawlState: { ...audit.crawlState, stop: reason },
  })
}

/** End an audit that can't go on. What it already saved stays readable. */
export async function failAudit(
  store: AuditStore,
  auditId: string,
  code: string,
  detail: string,
): Promise<void> {
  const audit = await store.getAudit(auditId)
  if (
    !audit ||
    audit.status === 'completed' ||
    audit.status === 'canceled' ||
    audit.status === 'failed'
  )
    return
  await store.updateAudit(auditId, {
    status: 'failed',
    errorCode: code.slice(0, 80),
    errorDetail: detail.slice(0, 500),
    robotsTxt: null,
    completedAt: new Date().toISOString(),
  })
  await store.clearCrawlTables(auditId)
}
