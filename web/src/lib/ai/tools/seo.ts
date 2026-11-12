import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_AUDIT_PAGES, MAX_AUDIT_PAGES, MAX_URL_CHARS, MIN_AUDIT_PAGES } from '@/lib/seo/audit/limits'
import {
  AUDIT_PAGE_FILTERS,
  getSiteAudit,
  getSiteAuditDetail,
  listSiteAuditIssues,
  listSiteAuditPages,
  listSiteAudits,
} from '@/lib/seo/audit/queries'
import { cancelSiteAudit, startSiteAudit } from '@/lib/seo/audit/start'
import { normalizeUrl } from '@/lib/seo/audit/url-utils'
import { isAuditIssueType, isLiveAudit, ISSUE_SEVERITIES, type SiteAuditView } from '@/lib/seo/audit/view'
import { webText } from './web-derived'

/**
 * SEO: the site audit (src/lib/seo/audit).
 *
 *   start_site_audit        crawl a website politely and check it for SEO
 *                           problems. Runs in the background for a few minutes.
 *   list_site_audits        the workspace's audits, newest first.
 *   get_site_audit          one audit: progress while it runs, then its
 *                           findings by type, each with what it means and how
 *                           to fix it. Can wait for a running audit.
 *   get_site_audit_issues   the findings themselves: which pages, what was
 *                           measured.
 *   get_site_audit_pages    the crawled pages and what each one carries.
 *   cancel_site_audit       stop a running audit; what it found stays.
 *
 * An audit costs nothing but our own requests to a public site, so there is
 * no confirmation step and a loop may start one. No site named means the
 * workspace's own website.
 *
 * Titles, descriptions and URLs paths come from the audited site: whoever
 * wrote its pages can put instructions in them, so page text goes to the
 * model inside the WEB fence (web-derived.ts). URLs stay plain: the model
 * needs them verbatim. The rule is structural: a string from the site stays
 * plain only when it is a normalised http(s) URL; anything else (a canonical
 * that is not a web address, a host name, quoted text) is fenced.
 *
 * A failure underneath (the database) is logged and comes back to the model
 * as a plain sentence, never the error's own text.
 */

const WAIT_POLL_MS = 5_000
const WAIT_MAX_MS = 90_000

function auditForModel(audit: SiteAuditView) {
  return {
    audit_id: audit.id,
    site: audit.host,
    start_url: audit.start_url,
    status: audit.status,
    phase: audit.phase,
    pages_crawled: audit.pages_crawled,
    pages_found: audit.pages_queued,
    page_limit: audit.max_pages,
    issues: audit.counts,
    error: audit.error,
    started_at: audit.started_at ?? audit.created_at,
    completed_at: audit.completed_at,
  }
}

/** A normalised http(s) URL, as the crawl stores the addresses it read: the one kind of site string the model gets plain. */
function isPlainUrl(value: string): boolean {
  return (
    value.length <= MAX_URL_CHARS &&
    /^https?:\/\//i.test(value) &&
    normalizeUrl(value, undefined, { keepTrackingParams: true }) === value
  )
}

/** A site string as the model reads it: a normalised URL plain, anything else fenced. */
function siteString(value: string | null): string | null {
  return value === null || isPlainUrl(value) ? value : webText(value)
}

/** A finding's measured details, every string that is not a normalised URL fenced, at any depth. Numbers and booleans stay plain. */
function detailsForModel(value: unknown): unknown {
  if (typeof value === 'string') return siteString(value)
  if (Array.isArray(value)) return value.map(detailsForModel)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = detailsForModel(item)
    return out
  }
  return value
}

const COULD_NOT = {
  read: 'The audit could not be read just now. Try again.',
  start: 'The audit could not be started just now. Try again.',
  stop: 'The audit could not be stopped just now. Try again.',
} as const

/** A tool's work, with a failure underneath logged and answered in plain words, never the database's. */
async function guarded<T>(what: keyof typeof COULD_NOT, tool: string, run: () => Promise<T>): Promise<T | { success: false; error: string }> {
  try {
    return await run()
  } catch (err) {
    console.error(`[seo-audit] ${tool} failed`, err)
    return { success: false, error: COULD_NOT[what] }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createSeoTools(userId: string, supabase: SupabaseClient, workspaceId: string) {
  const who = { userId, workspaceId }
  return {
    start_site_audit: tool({
      description:
        'Audit a website for SEO problems: crawls it politely (its robots.txt respected, about one page a second) and checks every page for broken links and pages, missing or duplicate titles and descriptions, heading and canonical problems, thin content, redirect chains, pages search engines are told not to index, and pages nothing links to. ' +
        'With no url it audits the workspace’s own website. Runs in the background and takes a few minutes: tell the person it started, then read the result with get_site_audit (wait: true) and report the few findings that matter most, in plain words. One audit at a time per workspace.',
      inputSchema: z.object({
        url: z.string().trim().min(1).max(2000).optional().describe('The website to audit, e.g. "example.com". Default: the workspace’s own website'),
        max_pages: z
          .number()
          .int()
          .min(MIN_AUDIT_PAGES)
          .max(MAX_AUDIT_PAGES)
          .optional()
          .describe(`How many pages to crawl at most (default ${DEFAULT_AUDIT_PAGES}, up to ${MAX_AUDIT_PAGES}). More pages take longer: about a second each`),
      }),
      execute: ({ url, max_pages }) => guarded('start', 'start_site_audit', async () => {
        const out = await startSiteAudit(supabase, who, { url: url ?? null, maxPages: max_pages })
        if (!out.ok) {
          return {
            success: false,
            code: out.code,
            error: out.message,
            ...(out.code === 'AUDIT_ALREADY_RUNNING' ? { running: auditForModel(out.audit) } : {}),
          }
        }
        return {
          success: true,
          audit: auditForModel(out.audit),
          message: `The audit of ${out.audit.host} started. It takes a few minutes. Read it with get_site_audit (audit_id, wait: true).`,
        }
      }),
    }),

    list_site_audits: tool({
      description: 'The workspace’s SEO site audits, newest first: which site, when, how many pages, and how many critical, warning and info findings each has.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('How many (default 10)'),
      }),
      execute: ({ limit }) => guarded('read', 'list_site_audits', async () => {
        const audits = await listSiteAudits(supabase, workspaceId, limit ?? 10)
        return { success: true, audits: audits.map(auditForModel) }
      }),
    }),

    get_site_audit: tool({
      description:
        'Read one SEO site audit: its progress while it runs, and once it is done its findings grouped by type, most serious first, each with what it means and how to fix it. ' +
        'With no audit_id it reads the newest audit. wait: true waits up to 90 seconds for a running audit to finish (call again if it is still running). ' +
        'For which pages a finding is on, use get_site_audit_issues. When the audited site is the workspace’s own connected website, offer to fix a finding with change_website, and call it only after the owner says yes, one change at a time.',
      inputSchema: z.object({
        audit_id: z.string().uuid().optional().describe('The audit to read; default the newest'),
        wait: z.boolean().optional().describe('Wait (up to 90 seconds) for a running audit to finish before answering'),
      }),
      execute: ({ audit_id, wait }) => guarded('read', 'get_site_audit', async () => {
        const id = audit_id ?? (await listSiteAudits(supabase, workspaceId, 1))[0]?.id
        if (!id) return { success: false, code: 'NO_AUDIT', error: 'There is no audit yet. Start one with start_site_audit.' }

        let audit = await getSiteAudit(supabase, workspaceId, id)
        if (!audit) return { success: false, code: 'NOT_FOUND', error: 'That audit doesn’t exist.' }
        if (wait) {
          const deadline = Date.now() + WAIT_MAX_MS
          while (isLiveAudit(audit.status) && Date.now() < deadline) {
            await sleep(WAIT_POLL_MS)
            audit = (await getSiteAudit(supabase, workspaceId, id)) ?? audit
          }
        }
        if (isLiveAudit(audit.status)) {
          return { success: true, audit: auditForModel(audit), findings: [], message: 'Still running. Call get_site_audit again (wait: true) in a moment.' }
        }
        const detail = await getSiteAuditDetail(supabase, workspaceId, id)
        return {
          success: true,
          audit: auditForModel(detail?.audit ?? audit),
          findings: (detail?.issues ?? []).map((group) => ({
            type: group.type,
            severity: group.severity,
            title: group.title,
            findings: group.count,
            pages: group.pages,
            what_it_means: group.explanation,
            how_to_fix: group.how_to_fix,
          })),
        }
      }),
    }),

    get_site_audit_issues: tool({
      description:
        'The findings of an SEO site audit, one row per finding: the page it is on and what the check measured (a title’s length, a broken link’s target, the other pages in a duplicate group). Filter by type (from get_site_audit) or by severity. Returns up to 50 at a time; pass next_offset for more.',
      inputSchema: z.object({
        audit_id: z.string().uuid().describe('The audit'),
        type: z.string().trim().max(60).optional().describe('One issue type from get_site_audit, e.g. "broken-internal-link"'),
        severity: z.enum(['critical', 'warning', 'info']).optional().describe('Only findings of this severity'),
        offset: z.number().int().min(0).optional().describe('next_offset from the previous call'),
      }),
      execute: ({ audit_id, type, severity, offset }) => guarded('read', 'get_site_audit_issues', async () => {
        if (type !== undefined && !isAuditIssueType(type)) {
          return { success: false, code: 'UNKNOWN_TYPE', error: 'That isn’t an issue type. Take one from get_site_audit’s findings.' }
        }
        if (severity !== undefined && !ISSUE_SEVERITIES.includes(severity)) return { success: false, error: 'severity is critical, warning or info.' }
        if (!(await getSiteAudit(supabase, workspaceId, audit_id))) return { success: false, code: 'NOT_FOUND', error: 'That audit doesn’t exist.' }
        const page = await listSiteAuditIssues(supabase, workspaceId, audit_id, { type, severity, offset, limit: 50 })
        return {
          success: true,
          issues: page.rows.map((row) => ({
            type: row.type,
            severity: row.severity,
            page_url: row.page_url,
            details: detailsForModel(row.details),
          })),
          next_offset: page.next_offset,
        }
      }),
    }),

    get_site_audit_pages: tool({
      description:
        'The pages an SEO site audit crawled, one row per URL: status code, title, meta description, H1 count, word count, images without alt text, link counts, click depth, whether it is indexable and in the sitemap. `show` narrows them: errors, redirects, noindex, not_in_sitemap. Returns up to 50 at a time; pass next_offset for more.',
      inputSchema: z.object({
        audit_id: z.string().uuid().describe('The audit'),
        show: z.enum(['all', 'errors', 'redirects', 'noindex', 'not_in_sitemap']).optional().describe('Which pages (default all)'),
        offset: z.number().int().min(0).optional().describe('next_offset from the previous call'),
      }),
      execute: ({ audit_id, show, offset }) => guarded('read', 'get_site_audit_pages', async () => {
        if (show !== undefined && !AUDIT_PAGE_FILTERS.includes(show)) return { success: false, error: 'Unknown filter.' }
        if (!(await getSiteAudit(supabase, workspaceId, audit_id))) return { success: false, code: 'NOT_FOUND', error: 'That audit doesn’t exist.' }
        const page = await listSiteAuditPages(supabase, workspaceId, audit_id, { show: show ?? 'all', offset, limit: 50 })
        return {
          success: true,
          pages: page.rows.map((row) => ({
            url: row.url,
            status_code: row.status_code,
            fetch: row.fetch_class,
            redirects_to: siteString(row.redirect_url),
            title: webText(row.title),
            meta_description: webText(row.meta_description),
            canonical_url: siteString(row.canonical_url),
            h1_count: row.h1_count,
            word_count: row.word_count,
            images: row.images_total,
            images_missing_alt: row.images_missing_alt,
            internal_links: row.internal_link_count,
            external_links: row.external_link_count,
            structured_data: row.has_structured_data,
            indexable: row.is_indexable,
            click_depth: row.crawl_depth,
            in_sitemap: row.in_sitemap,
            response_ms: row.response_time_ms,
          })),
          next_offset: page.next_offset,
        }
      }),
    }),

    cancel_site_audit: tool({
      description: 'Stop an SEO site audit that is queued or running. The pages it already read stay readable.',
      inputSchema: z.object({
        audit_id: z.string().uuid().describe('The audit to stop'),
      }),
      execute: ({ audit_id }) => guarded('stop', 'cancel_site_audit', async () => {
        const out = await cancelSiteAudit(supabase, { workspaceId }, audit_id)
        if (!out.ok) return { success: false, code: out.code, error: out.message }
        return { success: true, audit: auditForModel(out.audit) }
      }),
    }),
  }
}
