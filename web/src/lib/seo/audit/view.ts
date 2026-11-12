/**
 * What the SEO page and the tools read about a site audit: the shapes the
 * API returns. Safe to import from client components (types and plain
 * functions only, nothing of the server's).
 */
import {
  AUDIT_ISSUE_TYPES,
  getIssueDescriptor,
  ISSUE_SEVERITY_ORDER,
  type IssueSeverity,
} from './issues'
import type { PageFetchClass } from './types'

export type SiteAuditStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
export type SiteAuditPhase = 'discovery' | 'crawl' | 'analysis' | 'done'

export interface SiteAuditView {
  id: string
  /** The address the audit starts from (after the site's own redirects, once discovery ran). */
  start_url: string
  /** The site's host, for a title ("example.com"). */
  host: string
  status: SiteAuditStatus
  phase: SiteAuditPhase
  max_pages: number
  pages_crawled: number
  /** URLs known so far, held to the page budget: the progress bar's whole. */
  pages_queued: number
  counts: { critical: number; warning: number; info: number }
  /** Why it failed, in words for the person; null unless status is failed. */
  error: string | null
  started_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

/** One issue type's findings in an audit, with what it means and how to fix it. */
export interface SiteAuditIssueGroup {
  type: string
  severity: IssueSeverity
  title: string
  explanation: string
  how_to_fix: string
  /** Findings of this type. */
  count: number
  /** Different pages they are on. */
  pages: number
}

export interface SiteAuditIssueRow {
  id: string
  type: string
  severity: IssueSeverity
  page_id: string | null
  page_url: string
  /** What the check measured. Text in here can be the audited site's own. */
  details: Record<string, unknown>
}

export interface SiteAuditPageRow {
  id: string
  url: string
  status_code: number | null
  fetch_class: PageFetchClass
  redirect_url: string | null
  title: string | null
  meta_description: string | null
  canonical_url: string | null
  h1_count: number
  word_count: number
  images_total: number
  images_missing_alt: number
  internal_link_count: number
  external_link_count: number
  has_structured_data: boolean
  is_indexable: boolean
  crawl_depth: number | null
  in_sitemap: boolean
  response_time_ms: number | null
}

export interface SiteAuditDetail {
  audit: SiteAuditView
  issues: SiteAuditIssueGroup[]
}

/** True while the audit is still being worked on (poll it). */
export function isLiveAudit(status: SiteAuditStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** An issue type's row counts as a group the page and the tools show: most serious first, then most findings. */
export function issueGroups(
  rows: Array<{ issue_type: string; issue_count: number; page_count: number }>,
): SiteAuditIssueGroup[] {
  const groups: SiteAuditIssueGroup[] = []
  for (const row of rows) {
    const descriptor = getIssueDescriptor(row.issue_type)
    // A type this build no longer knows (an old audit): nothing to say about it.
    if (!descriptor) continue
    groups.push({
      type: row.issue_type,
      severity: descriptor.severity,
      title: descriptor.title,
      explanation: descriptor.explanation,
      how_to_fix: descriptor.howToFix,
      count: row.issue_count,
      pages: row.page_count,
    })
  }
  return groups.sort(
    (a, b) =>
      ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
      b.count - a.count ||
      a.title.localeCompare(b.title),
  )
}

export function isAuditIssueType(
  value: unknown,
): value is keyof typeof AUDIT_ISSUE_TYPES {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AUDIT_ISSUE_TYPES, value)
  )
}

export const ISSUE_SEVERITIES: readonly IssueSeverity[] = [
  'critical',
  'warning',
  'info',
]

export function isIssueSeverity(value: unknown): value is IssueSeverity {
  return (
    typeof value === 'string' &&
    (ISSUE_SEVERITIES as readonly string[]).includes(value)
  )
}
