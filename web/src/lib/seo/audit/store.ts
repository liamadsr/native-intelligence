/**
 * The site audit's database layer for the crawl (migration 590): the
 * AuditStore the engine talks to, over the service-role client. The
 * background lane is the only writer of these tables.
 *
 * Every write here is safe to repeat: pages and issues are upserts on ids
 * derived from what they are about, link rows on (audit, page), queue seeds
 * ignore rows that already exist, and the functions (claim, discover,
 * settle) are written to be re-run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type {
  AuditCounts,
  AuditPatch,
  AuditPhase,
  AuditRecord,
  AuditStatus,
  AuditStore,
  CrawlState,
  FrontierLease,
  FrontierSeed,
  PageLinksRow,
} from './engine'
import { clipDetails, clipText } from './clip'
import { issueRowId } from './ids'
import { AUDIT_ISSUE_TYPES, type AuditIssueType } from './issues'
import { MAX_URL_CHARS } from './limits'
import type { SlimPage } from './multipage-checks'
import type { DetectedIssue } from './page-reporters'
import type { CrawledPageResult, PageFetchClass } from './types'

/** Rows per insert: small enough for one request body, large enough to seed a sitemap quickly. */
const WRITE_CHUNK = 500
/** PostgREST hands back at most this many rows per request. */
const READ_PAGE = 1000

const AUDIT_COLUMNS =
  'id, workspace_id, start_url, origin, status, phase, max_pages, robots_txt, crawl_state'

interface AuditDbRow {
  id: string
  workspace_id: string
  start_url: string
  origin: string
  status: AuditStatus
  phase: AuditPhase
  max_pages: number
  robots_txt: string | null
  crawl_state: CrawlState | null
}

function toRecord(row: AuditDbRow): AuditRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    startUrl: row.start_url,
    origin: row.origin,
    status: row.status,
    phase: row.phase,
    maxPages: row.max_pages,
    robotsTxt: row.robots_txt,
    crawlState: row.crawl_state ?? {},
  }
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`seo audit ${what} failed: ${error.message}`)
}

function chunked<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/** A stored string, cut to what a column should hold (by characters, never through a surrogate pair). Text here is the audited site's own. */
function clip(value: string | null, max: number): string | null {
  if (value === null) return null
  return clipText(value, max)
}

function pageRow(audit: AuditRecord, page: CrawledPageResult) {
  const internal = page.links.filter((link) => link.isInternal).length
  return {
    id: page.id,
    audit_id: audit.id,
    workspace_id: audit.workspaceId,
    url: page.url,
    status_code: page.statusCode,
    fetch_class: page.fetchClass,
    redirect_url: clip(page.redirectUrl, 2048),
    title: clip(page.title, 1000),
    meta_description: clip(page.metaDescription, 2000),
    canonical_url: clip(page.canonicalUrl, 2048),
    header_canonical_url: clip(page.headerCanonicalUrl, 2048),
    robots_meta: clip(page.robotsMeta, 500),
    x_robots_tag: clip(page.xRobotsTag, 500),
    og_title: clip(page.ogTitle, 1000),
    og_description: clip(page.ogDescription, 2000),
    og_image: clip(page.ogImage, 2048),
    h1_count: page.h1Count,
    h2_count: page.h2Count,
    h3_count: page.h3Count,
    h4_count: page.h4Count,
    h5_count: page.h5Count,
    h6_count: page.h6Count,
    word_count: page.wordCount,
    images_total: page.imagesTotal,
    images_missing_alt: page.imagesMissingAlt,
    internal_link_count: internal,
    external_link_count: page.links.length - internal,
    has_structured_data: page.hasStructuredData,
    is_indexable: page.isIndexable,
    crawl_depth: page.crawlDepth,
    in_sitemap: page.inSitemap,
    content_hash: page.contentHash,
    response_time_ms: Math.round(page.responseTimeMs),
  }
}

function issueRow(audit: AuditRecord, issue: DetectedIssue) {
  return {
    id: issueRowId(
      audit.id,
      issue.issueType,
      issue.pageUrl,
      issue.dedupeKey ?? '',
    ),
    audit_id: audit.id,
    workspace_id: audit.workspaceId,
    page_id: issue.pageId,
    page_url: issue.pageUrl,
    issue_type: issue.issueType,
    severity: AUDIT_ISSUE_TYPES[issue.issueType].severity,
    // Details can quote the site: every string and list is held to a bound.
    details: clipDetails(issue.details ?? {}),
  }
}

const PATCH_COLUMNS: Record<keyof AuditPatch, string> = {
  startUrl: 'start_url',
  origin: 'origin',
  status: 'status',
  phase: 'phase',
  pagesCrawled: 'pages_crawled',
  pagesQueued: 'pages_queued',
  robotsTxt: 'robots_txt',
  crawlState: 'crawl_state',
  criticalCount: 'critical_count',
  warningCount: 'warning_count',
  infoCount: 'info_count',
  errorCode: 'error_code',
  errorDetail: 'error_detail',
  completedAt: 'completed_at',
}

export function createAuditStore(supabase: SupabaseClient): AuditStore {
  const count = async (
    table: string,
    filter: (
      q: ReturnType<ReturnType<SupabaseClient['from']>['select']>,
    ) => unknown,
  ): Promise<number> => {
    const query = supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
    const { count: n, error } = (await filter(query)) as {
      count: number | null
      error: { message: string } | null
    }
    fail(`count ${table}`, error)
    return n ?? 0
  }

  return {
    async getAudit(auditId) {
      const { data, error } = await supabase
        .from('seo_audit')
        .select(AUDIT_COLUMNS)
        .eq('id', auditId)
        .maybeSingle()
      fail('read', error)
      return data ? toRecord(data as AuditDbRow) : null
    },

    async updateAudit(auditId, patch) {
      const row: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      }
      for (const [key, value] of Object.entries(patch) as Array<
        [keyof AuditPatch, unknown]
      >) {
        if (value !== undefined) row[PATCH_COLUMNS[key]] = value
      }
      const { error } = await supabase
        .from('seo_audit')
        .update(row)
        .eq('id', auditId)
      fail('update', error)
    },

    async seedFrontier(audit, seeds: FrontierSeed[]) {
      // The column's own limit: one overlong URL must not fail its whole batch.
      const rows = seeds
        .filter((seed) => seed.url.length <= MAX_URL_CHARS)
        .map((seed) => ({
          url: seed.url,
          depth: seed.depth,
          source: seed.source,
          in_sitemap: seed.inSitemap,
        }))
      // The function writes only while the audit is running (a cancel in
      // between leaves no queue behind), and ignores URLs already queued.
      for (const part of chunked(rows, WRITE_CHUNK)) {
        const { error } = await supabase.rpc('seo_audit_seed', {
          p_audit: audit.id,
          p_workspace: audit.workspaceId,
          p_rows: part,
        })
        fail('seed', error)
      }
    },

    async claimChunk(auditId, chunkNo, limit, pagesLeftAfter) {
      const { data, error } = await supabase.rpc('seo_audit_claim_chunk', {
        p_audit: auditId,
        p_chunk: chunkNo,
        p_limit: limit,
        p_pages_left_after: pagesLeftAfter,
      })
      fail('claim', error)
      return (
        (data ?? []) as Array<{
          url: string
          depth: number | null
          in_sitemap: boolean
        }>
      ).map(
        (row): FrontierLease => ({
          url: row.url,
          depth: row.depth,
          inSitemap: row.in_sitemap,
        }),
      )
    },

    async discover(audit, rows) {
      let added = 0
      for (const part of chunked(rows, WRITE_CHUNK)) {
        const { data, error } = await supabase.rpc('seo_audit_discover', {
          p_audit: audit.id,
          p_workspace: audit.workspaceId,
          p_rows: part,
        })
        fail('discover', error)
        added += typeof data === 'number' ? data : 0
      }
      return added
    },

    async saveBatch(audit, batch) {
      if (batch.pages.length > 0) {
        const { error } = await supabase.from('seo_audit_page').upsert(
          batch.pages.map((page) => pageRow(audit, page)),
          { onConflict: 'id' },
        )
        fail('save pages', error)
      }
      if (batch.links.length > 0) {
        const rows = batch.links.map((link: PageLinksRow) => ({
          audit_id: audit.id,
          workspace_id: audit.workspaceId,
          page_id: link.pageId,
          url: link.url,
          targets: link.targets,
        }))
        const { error } = await supabase
          .from('seo_audit_link')
          .upsert(rows, { onConflict: 'audit_id,page_id' })
        fail('save links', error)
      }
      if (batch.issues.length > 0) {
        const { error } = await supabase.from('seo_audit_issue').upsert(
          batch.issues.map((issue) => issueRow(audit, issue)),
          { onConflict: 'id' },
        )
        fail('save issues', error)
      }
      // Last: a batch that died above leaves its URLs leased, so the retry fetches them again.
      const { error } = await supabase.rpc('seo_audit_settle_urls', {
        p_audit: audit.id,
        p_crawled: batch.pages.map((page) => page.url),
        p_released: [],
      })
      fail('settle', error)
    },

    async releaseLeases(auditId, urls) {
      for (const part of chunked(urls, WRITE_CHUNK)) {
        const { error } = await supabase.rpc('seo_audit_settle_urls', {
          p_audit: auditId,
          p_crawled: [],
          p_released: part,
        })
        fail('release', error)
      }
    },

    async counts(auditId): Promise<AuditCounts> {
      const [crawled, pending, queued] = await Promise.all([
        count('seo_audit_page', (q) => q.eq('audit_id', auditId)),
        // Not crawled yet: waiting, or leased by a chunk that has not saved
        // it. A leased URL is still owed: a retried chunk gets it back.
        count('seo_audit_frontier', (q) =>
          q.eq('audit_id', auditId).neq('state', 'crawled'),
        ),
        count('seo_audit_frontier', (q) => q.eq('audit_id', auditId)),
      ])
      return { crawled, pending, queued }
    },

    async slimPages(auditId) {
      const pages: SlimPage[] = []
      for (let from = 0; ; from += READ_PAGE) {
        const { data, error } = await supabase
          .from('seo_audit_page')
          .select(
            'id, url, status_code, fetch_class, title, meta_description, content_hash, redirect_url, word_count, is_indexable, canonical_url, header_canonical_url',
          )
          .eq('audit_id', auditId)
          .order('id')
          .range(from, from + READ_PAGE - 1)
        fail('read pages', error)
        const rows = (data ?? []) as Array<{
          id: string
          url: string
          status_code: number | null
          fetch_class: PageFetchClass
          title: string | null
          meta_description: string | null
          content_hash: string | null
          redirect_url: string | null
          word_count: number
          is_indexable: boolean
          canonical_url: string | null
          header_canonical_url: string | null
        }>
        for (const row of rows) {
          pages.push({
            id: row.id,
            url: row.url,
            statusCode: row.status_code,
            fetchClass: row.fetch_class,
            title: row.title,
            metaDescription: row.meta_description,
            contentHash: row.content_hash,
            redirectUrl: row.redirect_url,
            wordCount: row.word_count,
            isIndexable: row.is_indexable,
            canonicalUrl: row.canonical_url,
            headerCanonicalUrl: row.header_canonical_url,
          })
        }
        if (rows.length < READ_PAGE) return pages
      }
    },

    async pageIdsWithIssue(auditId, issueType: AuditIssueType) {
      const ids = new Set<string>()
      for (let from = 0; ; from += READ_PAGE) {
        const { data, error } = await supabase
          .from('seo_audit_issue')
          .select('id, page_id')
          .eq('audit_id', auditId)
          .eq('issue_type', issueType)
          .order('id')
          .range(from, from + READ_PAGE - 1)
        fail('read issues', error)
        const rows = (data ?? []) as Array<{ page_id: string | null }>
        for (const row of rows) if (row.page_id) ids.add(row.page_id)
        if (rows.length < READ_PAGE) return ids
      }
    },

    async brokenLinks(auditId, limit) {
      const { data, error } = await supabase.rpc('seo_audit_broken_links', {
        p_audit: auditId,
        p_limit: limit,
      })
      fail('broken links', error)
      return (
        (data ?? []) as Array<{
          source_page_id: string
          source_url: string
          target_url: string
          target_status: number
        }>
      ).map((row) => ({
        sourcePageId: row.source_page_id,
        sourceUrl: row.source_url,
        targetUrl: row.target_url,
        targetStatus: row.target_status,
      }))
    },

    async orphanPages(auditId, startUrl) {
      const { data, error } = await supabase.rpc('seo_audit_orphan_pages', {
        p_audit: auditId,
        p_start_url: startUrl,
      })
      fail('orphan pages', error)
      return ((data ?? []) as Array<{ page_id: string; url: string }>).map(
        (row) => ({ pageId: row.page_id, url: row.url }),
      )
    },

    async saveIssues(audit, issues) {
      for (const part of chunked(issues, WRITE_CHUNK)) {
        const { error } = await supabase.from('seo_audit_issue').upsert(
          part.map((issue) => issueRow(audit, issue)),
          { onConflict: 'id' },
        )
        fail('save issues', error)
      }
    },

    async issueTally(auditId) {
      const [critical, warning, info] = await Promise.all(
        (['critical', 'warning', 'info'] as const).map((severity) =>
          count('seo_audit_issue', (q) =>
            q.eq('audit_id', auditId).eq('severity', severity),
          ),
        ),
      )
      return { critical, warning, info }
    },

    async clearCrawlTables(auditId) {
      const frontier = await supabase
        .from('seo_audit_frontier')
        .delete()
        .eq('audit_id', auditId)
      fail('clear queue', frontier.error)
      const links = await supabase
        .from('seo_audit_link')
        .delete()
        .eq('audit_id', auditId)
      fail('clear links', links.error)
    },
  }
}
