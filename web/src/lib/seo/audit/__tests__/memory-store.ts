/**
 * An in-memory AuditStore that behaves like the Supabase one (../store.ts)
 * over migration 590, for the engine's tests and for scripts that want to run
 * a whole audit without a database.
 *
 * The five SQL functions, and store.ts's own rules, are mirrored rule for
 * rule:
 *
 *   seedFrontier   seo_audit_seed: writes nothing unless the audit is running;
 *                  otherwise inserts ignoring duplicates. A URL over 2,048
 *                  characters is skipped (store.ts filters it so the batch is
 *                  not refused).
 *   claimChunk     seo_audit_claim_chunk: a chunk number that already ran gets
 *                  back what it still holds (state leased) and claims nothing
 *                  new. Otherwise it claims the claimable rows: pending, or
 *                  still leased under an EARLIER chunk number (a lease that
 *                  chunk lost; chunks run strictly in order). A row the
 *                  sitemap does not list only while the claimable sitemap
 *                  rows fit in `pagesLeftAfter` (the start page, depth 0,
 *                  always). Both branches return rows in claim order:
 *                  link-reached (source start or link) before sitemap-only,
 *                  then oldest (seq) first, whatever the table's own order.
 *   counts         pending = every queue row not crawled (waiting or leased):
 *                  a leased URL is still owed.
 *   discover       seo_audit_discover: nothing (0) unless the audit is
 *                  running; otherwise new URLs go in as source link, not in
 *                  the sitemap; an existing row is left alone, except that a
 *                  pending row with no depth takes a link's depth (and source
 *                  link). Returns how many rows were new.
 *   saveBatch      upserts pages, link rows and issues (details clipped as
 *                  store.ts clips them, ../clip.ts), then
 *                  seo_audit_settle_urls(crawled): every saved URL becomes
 *                  crawled, whatever its state.
 *   releaseLeases  seo_audit_settle_urls(released): leased rows go back to
 *                  pending with no chunk number.
 *   brokenLinks    seo_audit_broken_links: a stored link target that is a
 *                  saved page with fetch class ok and a status of 400 or more.
 *   orphanPages    seo_audit_orphan_pages: an ok 2xx page, not the start page,
 *                  no other page links to it (self-links don't count), and no
 *                  saved redirect points at it.
 *
 * The tables' own checks are held too (URL length, fetch class, the issue's
 * page foreign key, one page row per URL), so a test fails where the database
 * would refuse a write.
 */
import type {
  AuditCounts,
  AuditPatch,
  AuditRecord,
  AuditStatus,
  AuditStore,
  FrontierLease,
  FrontierSeed,
  PageLinksRow,
} from '../engine'
import { clipDetails } from '../clip'
import { issueRowId } from '../ids'
import {
  AUDIT_ISSUE_TYPES,
  type AuditIssueType,
  type IssueSeverity,
} from '../issues'
import type { SlimPage } from '../multipage-checks'
import type { DetectedIssue } from '../page-reporters'
import { PAGE_FETCH_CLASSES, type CrawledPageResult } from '../types'

const MAX_URL_CHARS = 2048

export interface MemoryAuditRow extends AuditRecord {
  pagesCrawled: number
  pagesQueued: number
  criticalCount: number
  warningCount: number
  infoCount: number
  errorCode: string | null
  errorDetail: string | null
  completedAt: string | null
}

export interface MemoryFrontierRow {
  url: string
  depth: number | null
  source: 'start' | 'link' | 'sitemap'
  inSitemap: boolean
  state: 'pending' | 'leased' | 'crawled'
  chunkNo: number | null
  seq: number
}

export interface MemoryIssueRow {
  id: string
  auditId: string
  pageId: string | null
  pageUrl: string
  issueType: AuditIssueType
  severity: IssueSeverity
  details: Record<string, unknown>
}

export interface SaveFault {
  /** saveBatch calls to let through before this one fails. */
  skip: number
  /** Write the batch's pages, links and issues first, then fail before its URLs are settled. */
  afterRows: boolean
}

let auditCounter = 0

export class MemoryAuditStore implements AuditStore {
  readonly audits = new Map<string, MemoryAuditRow>()
  /** auditId -> url -> row */
  readonly frontier = new Map<string, Map<string, MemoryFrontierRow>>()
  /** auditId -> page id -> page */
  readonly pages = new Map<string, Map<string, CrawledPageResult>>()
  /** auditId -> issue id -> issue */
  readonly issues = new Map<string, Map<string, MemoryIssueRow>>()
  /** auditId -> page id -> link row */
  readonly links = new Map<string, Map<string, PageLinksRow>>()
  /** saveBatch calls so far, failed ones included. */
  saveBatchCalls = 0

  private seq = 0
  private faults: SaveFault[] = []

  /** A new audit row, as the start route would insert it (status running unless given). */
  createAudit(input: {
    startUrl: string
    maxPages?: number
    id?: string
    workspaceId?: string
    status?: AuditStatus
  }): MemoryAuditRow {
    auditCounter += 1
    const id =
      input.id ??
      `00000000-0000-4000-8000-${String(auditCounter).padStart(12, '0')}`
    const row: MemoryAuditRow = {
      id,
      workspaceId: input.workspaceId ?? '00000000-0000-4000-8000-0000000000aa',
      startUrl: input.startUrl,
      origin: new URL(input.startUrl).origin,
      status: input.status ?? 'running',
      phase: 'discovery',
      maxPages: input.maxPages ?? 100,
      robotsTxt: null,
      crawlState: {},
      pagesCrawled: 0,
      pagesQueued: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      errorCode: null,
      errorDetail: null,
      completedAt: null,
    }
    this.audits.set(id, row)
    return row
  }

  /** Make a later saveBatch call throw once, as a crash mid-chunk would. */
  failSaveBatch(fault: Partial<SaveFault> = {}): void {
    this.faults.push({
      skip: fault.skip ?? 0,
      afterRows: fault.afterRows ?? false,
    })
  }

  frontierRows(auditId: string): MemoryFrontierRow[] {
    return [...this.table(this.frontier, auditId).values()].sort(
      (a, b) => a.seq - b.seq,
    )
  }

  pageList(auditId: string): CrawledPageResult[] {
    return [...this.table(this.pages, auditId).values()]
  }

  pageByUrl(auditId: string, url: string): CrawledPageResult | undefined {
    return this.pageList(auditId).find((page) => page.url === url)
  }

  issueList(auditId: string): MemoryIssueRow[] {
    return [...this.table(this.issues, auditId).values()]
  }

  linkRows(auditId: string): PageLinksRow[] {
    return [...this.table(this.links, auditId).values()]
  }

  // -------------------------------------------------------------------------
  // AuditStore
  // -------------------------------------------------------------------------

  async getAudit(auditId: string): Promise<AuditRecord | null> {
    const row = this.audits.get(auditId)
    if (!row) return null
    // What a read hands back is a copy, as a row from the database would be.
    return structuredClone({
      id: row.id,
      workspaceId: row.workspaceId,
      startUrl: row.startUrl,
      origin: row.origin,
      status: row.status,
      phase: row.phase,
      maxPages: row.maxPages,
      robotsTxt: row.robotsTxt,
      crawlState: row.crawlState ?? {},
    })
  }

  async updateAudit(auditId: string, patch: AuditPatch): Promise<void> {
    const row = this.audits.get(auditId)
    if (!row) return
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      ;(row as unknown as Record<string, unknown>)[key] = structuredClone(value)
    }
  }

  async seedFrontier(audit: AuditRecord, seeds: FrontierSeed[]): Promise<void> {
    // seo_audit_seed: a canceled (or ended) audit gets no queue rows.
    if (!this.isRunning(audit.id)) return
    const table = this.table(this.frontier, audit.id)
    for (const seed of seeds) {
      // store.ts drops a URL over the column's limit instead of failing its batch.
      if (seed.url.length > MAX_URL_CHARS) continue
      // upsert(..., { ignoreDuplicates: true }): a row already there stays as it is.
      if (table.has(seed.url)) continue
      table.set(seed.url, {
        url: seed.url,
        depth: seed.depth,
        source: seed.source,
        inSitemap: seed.inSitemap,
        state: 'pending',
        chunkNo: null,
        seq: ++this.seq,
      })
    }
  }

  async claimChunk(
    auditId: string,
    chunkNo: number,
    limit: number,
    pagesLeftAfter: number,
  ): Promise<FrontierLease[]> {
    // The table's own iteration order, not seq order: the claim must sort.
    const rows = [...this.table(this.frontier, auditId).values()]
    const lease = (row: MemoryFrontierRow): FrontierLease => ({
      url: row.url,
      depth: row.depth,
      inSitemap: row.inSitemap,
    })

    // A chunk number that already ran: what it still holds, nothing new.
    if (rows.some((row) => row.chunkNo === chunkNo)) {
      return rows
        .filter((row) => row.chunkNo === chunkNo && row.state === 'leased')
        .sort(claimOrder)
        .map(lease)
    }

    // Waiting, or leased by an earlier chunk that lost it (chunks of one
    // audit run strictly in order). `chunk_no < p_chunk` is never true for null.
    const claimable = (row: MemoryFrontierRow) =>
      row.state === 'pending' ||
      (row.state === 'leased' && row.chunkNo !== null && row.chunkNo < chunkNo)
    const waitingSitemap = rows.filter(
      (row) => claimable(row) && row.inSitemap,
    ).length
    const picked = rows
      .filter(
        (row) =>
          claimable(row) &&
          (row.inSitemap ||
            row.depth === 0 ||
            waitingSitemap <= Math.max(pagesLeftAfter, 0)),
      )
      .sort(claimOrder)
      .slice(0, Math.max(limit, 0))
    for (const row of picked) {
      row.state = 'leased'
      row.chunkNo = chunkNo
    }
    return picked.map(lease)
  }

  /** Reverse the table's internal order (tests: the claim must not depend on it). */
  scrambleFrontier(auditId: string): void {
    const table = this.table(this.frontier, auditId)
    const rows = [...table.entries()].reverse()
    table.clear()
    for (const [url, row] of rows) table.set(url, row)
  }

  async discover(
    audit: AuditRecord,
    rows: Array<{ url: string; depth: number | null }>,
  ): Promise<number> {
    // seo_audit_discover: a canceled (or ended) audit gets no queue rows.
    if (!this.isRunning(audit.id)) return 0
    // distinct on (url) order by url, depth nulls last: the smallest depth a URL came with.
    const incoming = new Map<string, number | null>()
    for (const row of rows) {
      if (!row.url || row.url.length > MAX_URL_CHARS) continue
      if (!incoming.has(row.url)) {
        incoming.set(row.url, row.depth)
        continue
      }
      const seen = incoming.get(row.url) ?? null
      if (row.depth !== null && (seen === null || row.depth < seen)) {
        incoming.set(row.url, row.depth)
      }
    }

    const table = this.table(this.frontier, audit.id)
    let added = 0
    for (const [url, depth] of incoming) {
      const existing = table.get(url)
      if (existing) {
        if (
          existing.state !== 'crawled' &&
          existing.depth === null &&
          depth !== null
        ) {
          existing.source = 'link'
          existing.depth = depth
        }
        continue
      }
      table.set(url, {
        url,
        depth,
        source: 'link',
        inSitemap: false,
        state: 'pending',
        chunkNo: null,
        seq: ++this.seq,
      })
      added += 1
    }
    return added
  }

  async saveBatch(
    audit: AuditRecord,
    batch: {
      pages: CrawledPageResult[]
      issues: DetectedIssue[]
      links: PageLinksRow[]
    },
  ): Promise<void> {
    this.saveBatchCalls += 1
    const fault = this.takeFault()
    if (fault && !fault.afterRows) {
      throw new Error('simulated crash: the batch was never written')
    }

    const pages = this.table(this.pages, audit.id)
    for (const page of batch.pages) {
      checkUrlLength('seo_audit_page', page.url)
      if (
        !(PAGE_FETCH_CLASSES as readonly string[]).includes(page.fetchClass)
      ) {
        throw new Error(`seo_audit_page_fetch_class_known: ${page.fetchClass}`)
      }
      const sameUrl = [...pages.values()].find(
        (other) => other.url === page.url && other.id !== page.id,
      )
      if (sameUrl) throw new Error(`seo_audit_page_url_uq: ${page.url}`)
      pages.set(page.id, structuredClone(page))
    }

    const links = this.table(this.links, audit.id)
    for (const link of batch.links) {
      links.set(link.pageId, structuredClone(link))
    }

    this.upsertIssues(audit, batch.issues)

    if (fault) {
      throw new Error('simulated crash: the batch was written but not settled')
    }

    // seo_audit_settle_urls(crawled)
    const frontier = this.table(this.frontier, audit.id)
    for (const page of batch.pages) {
      const row = frontier.get(page.url)
      if (row) row.state = 'crawled'
    }
  }

  async releaseLeases(auditId: string, urls: string[]): Promise<void> {
    const frontier = this.table(this.frontier, auditId)
    for (const url of urls) {
      const row = frontier.get(url)
      if (row && row.state === 'leased') {
        row.state = 'pending'
        row.chunkNo = null
      }
    }
  }

  async counts(auditId: string): Promise<AuditCounts> {
    const rows = this.frontierRows(auditId)
    return {
      crawled: this.table(this.pages, auditId).size,
      // Not crawled yet: waiting, or leased by a chunk that has not saved it.
      pending: rows.filter((row) => row.state !== 'crawled').length,
      queued: rows.length,
    }
  }

  async slimPages(auditId: string): Promise<SlimPage[]> {
    return this.pageList(auditId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((page) => ({
        id: page.id,
        url: page.url,
        statusCode: page.statusCode,
        fetchClass: page.fetchClass,
        title: page.title,
        metaDescription: page.metaDescription,
        contentHash: page.contentHash,
        redirectUrl: page.redirectUrl,
        wordCount: page.wordCount,
        isIndexable: page.isIndexable,
        canonicalUrl: page.canonicalUrl,
        headerCanonicalUrl: page.headerCanonicalUrl,
      }))
  }

  async pageIdsWithIssue(
    auditId: string,
    issueType: AuditIssueType,
  ): Promise<Set<string>> {
    return new Set(
      this.issueList(auditId)
        .filter((issue) => issue.issueType === issueType && issue.pageId)
        .map((issue) => issue.pageId!),
    )
  }

  async brokenLinks(
    auditId: string,
    limit: number,
  ): Promise<
    Array<{
      sourcePageId: string
      sourceUrl: string
      targetUrl: string
      targetStatus: number
    }>
  > {
    const byUrl = new Map(
      this.pageList(auditId).map((page) => [page.url, page]),
    )
    const found: Array<{
      sourcePageId: string
      sourceUrl: string
      targetUrl: string
      targetStatus: number
    }> = []
    for (const link of this.linkRows(auditId)) {
      for (const target of link.targets) {
        const page = byUrl.get(target)
        if (!page || page.fetchClass !== 'ok' || page.statusCode < 400) continue
        found.push({
          sourcePageId: link.pageId,
          sourceUrl: link.url,
          targetUrl: target,
          targetStatus: page.statusCode,
        })
      }
    }
    // order by l.page_id, t.value
    found.sort(
      (a, b) =>
        compare(a.sourcePageId, b.sourcePageId) ||
        compare(a.targetUrl, b.targetUrl),
    )
    return found.slice(0, Math.max(limit, 0))
  }

  async orphanPages(
    auditId: string,
    startUrl: string,
  ): Promise<Array<{ pageId: string; url: string }>> {
    const inbound = new Set<string>()
    for (const link of this.linkRows(auditId)) {
      for (const target of link.targets) {
        if (target !== link.url) inbound.add(target)
      }
    }
    const pages = this.pageList(auditId)
    const redirectTargets = new Set(
      pages.map((page) => page.redirectUrl).filter(Boolean),
    )
    return pages
      .filter(
        (page) =>
          page.url !== startUrl &&
          page.fetchClass === 'ok' &&
          page.statusCode >= 200 &&
          page.statusCode < 300 &&
          !inbound.has(page.url) &&
          !redirectTargets.has(page.url),
      )
      .map((page) => ({ pageId: page.id, url: page.url }))
  }

  async saveIssues(audit: AuditRecord, issues: DetectedIssue[]): Promise<void> {
    this.upsertIssues(audit, issues)
  }

  async issueTally(
    auditId: string,
  ): Promise<{ critical: number; warning: number; info: number }> {
    const tally = { critical: 0, warning: 0, info: 0 }
    for (const issue of this.issueList(auditId)) tally[issue.severity] += 1
    return tally
  }

  async clearCrawlTables(auditId: string): Promise<void> {
    this.frontier.delete(auditId)
    this.links.delete(auditId)
  }

  // -------------------------------------------------------------------------

  private isRunning(auditId: string): boolean {
    return this.audits.get(auditId)?.status === 'running'
  }

  private table<T>(tables: Map<string, Map<string, T>>, auditId: string) {
    let table = tables.get(auditId)
    if (!table) {
      table = new Map()
      tables.set(auditId, table)
    }
    return table
  }

  private takeFault(): SaveFault | null {
    const next = this.faults[0]
    if (!next) return null
    if (next.skip > 0) {
      next.skip -= 1
      return null
    }
    this.faults.shift()
    return next
  }

  private upsertIssues(audit: AuditRecord, issues: DetectedIssue[]): void {
    const pages = this.table(this.pages, audit.id)
    const table = this.table(this.issues, audit.id)
    for (const issue of issues) {
      // seo_audit_issue.page_id references seo_audit_page(id).
      if (issue.pageId !== null && !pages.has(issue.pageId)) {
        throw new Error(
          `seo_audit_issue_page_id_fkey: no page ${issue.pageId} for ${issue.issueType}`,
        )
      }
      const id = issueRowId(
        audit.id,
        issue.issueType,
        issue.pageUrl,
        issue.dedupeKey ?? '',
      )
      table.set(id, {
        id,
        auditId: audit.id,
        pageId: issue.pageId,
        pageUrl: issue.pageUrl,
        issueType: issue.issueType,
        severity: AUDIT_ISSUE_TYPES[issue.issueType].severity,
        details: clipDetails(structuredClone(issue.details ?? {})),
      })
    }
  }
}

function checkUrlLength(table: string, url: string): void {
  if (url.length > MAX_URL_CHARS) {
    throw new Error(`${table}_url_length: ${url.length} characters`)
  }
}

/** order by case source when 'sitemap' then 1 else 0 end, seq */
function claimOrder(a: MemoryFrontierRow, b: MemoryFrontierRow): number {
  return (
    (a.source === 'sitemap' ? 1 : 0) - (b.source === 'sitemap' ? 1 : 0) ||
    a.seq - b.seq
  )
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
