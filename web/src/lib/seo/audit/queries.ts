/**
 * What the product reads about site audits (the SEO page and the tools):
 * the list, one audit with its findings by type, the findings themselves,
 * the crawled pages. Every read is scoped by workspace_id in the query: the
 * caller's client is the service role's, so the filter is the fence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type { IssueSeverity } from './issues'
import type { PageFetchClass } from './types'
import {
  issueGroups,
  type SiteAuditDetail,
  type SiteAuditIssueRow,
  type SiteAuditPageRow,
  type SiteAuditPhase,
  type SiteAuditStatus,
  type SiteAuditView,
} from './view'

export const AUDIT_FIELDS =
  'id, start_url, origin, status, phase, max_pages, pages_crawled, pages_queued, critical_count, warning_count, info_count, error_code, error_detail, started_by, created_at, started_at, completed_at'

export interface AuditRow {
  id: string
  start_url: string
  origin: string
  status: SiteAuditStatus
  phase: SiteAuditPhase
  max_pages: number
  pages_crawled: number
  pages_queued: number
  critical_count: number
  warning_count: number
  info_count: number
  error_code: string | null
  error_detail: string | null
  started_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function auditView(row: AuditRow): SiteAuditView {
  return {
    id: row.id,
    start_url: row.start_url,
    host: hostOf(row.start_url),
    status: row.status,
    phase: row.phase,
    max_pages: row.max_pages,
    pages_crawled: row.pages_crawled,
    pages_queued: Math.max(row.pages_queued, row.pages_crawled),
    counts: {
      critical: row.critical_count,
      warning: row.warning_count,
      info: row.info_count,
    },
    error:
      row.status === 'failed'
        ? (row.error_detail ?? 'The audit stopped unexpectedly. Run it again.')
        : null,
    started_by: row.started_by,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  }
}

export const AUDIT_LIST_LIMIT = 50

/** The workspace's audits, newest first. */
export async function listSiteAudits(
  svc: SupabaseClient,
  workspaceId: string,
  limit = AUDIT_LIST_LIMIT,
): Promise<SiteAuditView[]> {
  const { data, error } = await svc
    .from('seo_audit')
    .select(AUDIT_FIELDS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), AUDIT_LIST_LIMIT))
  if (error) throw new Error(`seo audit list failed: ${error.message}`)
  return ((data ?? []) as AuditRow[]).map(auditView)
}

/** One audit of this workspace, or null. */
export async function getSiteAudit(
  svc: SupabaseClient,
  workspaceId: string,
  auditId: string,
): Promise<SiteAuditView | null> {
  const { data, error } = await svc
    .from('seo_audit')
    .select(AUDIT_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', auditId)
    .maybeSingle()
  if (error) throw new Error(`seo audit read failed: ${error.message}`)
  return data ? auditView(data as AuditRow) : null
}

/** The workspace's audit that is queued or running, if any. */
export async function getLiveSiteAudit(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<SiteAuditView | null> {
  const { data, error } = await svc
    .from('seo_audit')
    .select(AUDIT_FIELDS)
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`seo audit read failed: ${error.message}`)
  const row = ((data ?? []) as AuditRow[])[0]
  return row ? auditView(row) : null
}

/** One audit with its findings counted by type (what each means and how to fix it included), or null. */
export async function getSiteAuditDetail(
  svc: SupabaseClient,
  workspaceId: string,
  auditId: string,
): Promise<SiteAuditDetail | null> {
  const audit = await getSiteAudit(svc, workspaceId, auditId)
  if (!audit) return null
  const { data, error } = await svc.rpc('seo_audit_issue_summary', {
    p_audit: auditId,
  })
  if (error) throw new Error(`seo audit summary failed: ${error.message}`)
  const rows = (
    (data ?? []) as Array<{
      issue_type: string
      issue_count: number | string
      page_count: number | string
    }>
  ).map((row) => ({
    issue_type: row.issue_type,
    issue_count: Number(row.issue_count),
    page_count: Number(row.page_count),
  }))
  return { audit, issues: issueGroups(rows) }
}

export const AUDIT_PAGE_SIZE = 100

export interface Paged<T> {
  rows: T[]
  /** Pass as `offset` for the next page; null when this was the last. */
  next_offset: number | null
}

function pageBounds(
  offset: unknown,
  limit: unknown,
): { from: number; size: number } {
  const from =
    typeof offset === 'number' && Number.isFinite(offset) && offset > 0
      ? Math.floor(offset)
      : 0
  const size =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), AUDIT_PAGE_SIZE)
      : AUDIT_PAGE_SIZE
  return { from, size }
}

/** An audit's findings, optionally of one type or one severity, a page at a time. The audit must be this workspace's. */
export async function listSiteAuditIssues(
  svc: SupabaseClient,
  workspaceId: string,
  auditId: string,
  filter: {
    type?: string
    severity?: IssueSeverity
    offset?: number
    limit?: number
  } = {},
): Promise<Paged<SiteAuditIssueRow>> {
  const { from, size } = pageBounds(filter.offset, filter.limit)
  let query = svc
    .from('seo_audit_issue')
    .select('id, issue_type, severity, page_id, page_url, details')
    .eq('workspace_id', workspaceId)
    .eq('audit_id', auditId)
  if (filter.type) query = query.eq('issue_type', filter.type)
  if (filter.severity) query = query.eq('severity', filter.severity)
  // One more than asked: its presence says there is a next page.
  const { data, error } = await query
    .order('issue_type')
    .order('page_url')
    .order('id')
    .range(from, from + size)
  if (error) throw new Error(`seo audit issues failed: ${error.message}`)
  const all = (data ?? []) as Array<{
    id: string
    issue_type: string
    severity: IssueSeverity
    page_id: string | null
    page_url: string
    details: Record<string, unknown> | null
  }>
  const rows = all.slice(0, size).map((row) => ({
    id: row.id,
    type: row.issue_type,
    severity: row.severity,
    page_id: row.page_id,
    page_url: row.page_url,
    details: row.details ?? {},
  }))
  return { rows, next_offset: all.length > size ? from + size : null }
}

const PAGE_FIELDS =
  'id, url, status_code, fetch_class, redirect_url, title, meta_description, canonical_url, h1_count, word_count, images_total, images_missing_alt, internal_link_count, external_link_count, has_structured_data, is_indexable, crawl_depth, in_sitemap, response_time_ms'

export type AuditPageFilter =
  | 'all'
  | 'errors'
  | 'redirects'
  | 'noindex'
  | 'not_in_sitemap'
export const AUDIT_PAGE_FILTERS: readonly AuditPageFilter[] = [
  'all',
  'errors',
  'redirects',
  'noindex',
  'not_in_sitemap',
]

/** An audit's crawled pages, a page at a time. The audit must be this workspace's. */
export async function listSiteAuditPages(
  svc: SupabaseClient,
  workspaceId: string,
  auditId: string,
  filter: { show?: AuditPageFilter; offset?: number; limit?: number } = {},
): Promise<Paged<SiteAuditPageRow>> {
  const { from, size } = pageBounds(filter.offset, filter.limit)
  let query = svc
    .from('seo_audit_page')
    .select(PAGE_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('audit_id', auditId)
  if (filter.show === 'errors')
    query = query.or('status_code.gte.400,fetch_class.neq.ok')
  if (filter.show === 'redirects')
    query = query.gte('status_code', 300).lt('status_code', 400)
  if (filter.show === 'noindex')
    query = query
      .eq('is_indexable', false)
      .gte('status_code', 200)
      .lt('status_code', 300)
  if (filter.show === 'not_in_sitemap')
    query = query
      .eq('in_sitemap', false)
      .gte('status_code', 200)
      .lt('status_code', 300)
  const { data, error } = await query
    .order('url')
    .order('id')
    .range(from, from + size)
  if (error) throw new Error(`seo audit pages failed: ${error.message}`)
  const all = (data ?? []) as Array<
    SiteAuditPageRow & { fetch_class: PageFetchClass }
  >
  return {
    rows: all.slice(0, size),
    next_offset: all.length > size ? from + size : null,
  }
}
