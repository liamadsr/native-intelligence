/**
 * Client-side fetch layer for SEO's Site audit: one place that knows the
 * route shapes (src/app/api/account/seo/audits/*) and the error envelope
 * ({ error, code, details } via src/lib/api-errors).
 *
 * Modelled on prospecting/api.ts, including the thrown-error class carrying
 * the parsed code, because the page branches on three of them: a start's
 * `NO_SITE` / `INVALID_URL` / `NOT_PUBLIC` (said beside the address field), a
 * start's `AUDIT_ALREADY_RUNNING` (opens the live audit instead), and a
 * delete's `STILL_RUNNING`.
 *
 * Every call goes through the globally patched `window.fetch` (plain `fetch`).
 */
import type {
  SiteAuditDetail,
  SiteAuditIssueRow,
  SiteAuditPageRow,
  SiteAuditView,
} from '@/lib/seo/audit/view'

// ── Shapes returned by the routes ────────────────────────────────────────

export interface AuditLimits {
  min_pages: number
  default_pages: number
  max_pages: number
}

/** GET /api/account/seo/audits. */
export interface AuditListPayload {
  audits: SiteAuditView[]
  /** The workspace's own site: the start form's default. */
  default_url: string | null
  limits: AuditLimits
}

/** What the Pages tab narrows the crawled pages to (the route's `show`). */
export type AuditPageFilter = 'all' | 'errors' | 'redirects' | 'noindex' | 'not_in_sitemap'

export interface Paged<T> {
  rows: T[]
  /** Pass as `offset` for the next page; null when this was the last. */
  next_offset: number | null
}

// ── Errors ───────────────────────────────────────────────────────────────

export interface SeoApiError {
  message: string
  /** The envelope code ('INVALID_URL', 'AUDIT_ALREADY_RUNNING', 'BAD_REQUEST', …). */
  code: string
  details: Record<string, unknown> | null
  status: number
}

export class SeoRequestError extends Error {
  apiError: SeoApiError
  constructor(apiError: SeoApiError) {
    super(apiError.message)
    this.name = 'SeoRequestError'
    this.apiError = apiError
  }
}

async function parseError(res: Response): Promise<SeoApiError> {
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const details =
    body.details && typeof body.details === 'object'
      ? (body.details as Record<string, unknown>)
      : null
  return {
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    // A start's 400 tucks its reason in `details.code` ('NO_SITE', …) under the
    // envelope's generic BAD_REQUEST; every other route puts it in `code`.
    code:
      (typeof body.code === 'string' && body.code !== 'BAD_REQUEST' ? body.code : null) ??
      (details && typeof details.code === 'string' ? details.code : null) ??
      (typeof body.code === 'string' ? body.code : 'UNKNOWN'),
    details,
    status: res.status,
  }
}

export async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new SeoRequestError(await parseError(res))
  return (await res.json()) as T
}

/** The parsed code for a thrown request error, or null for anything else. */
export function errorCode(err: unknown): string | null {
  return err instanceof SeoRequestError ? err.apiError.code : null
}

/** A message safe to show the person for any thrown value. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof SeoRequestError) return err.apiError.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/** A start refused for a reason the person can correct in the address field. */
export const START_FIELD_CODES: ReadonlySet<string> = new Set(['NO_SITE', 'INVALID_URL', 'NOT_PUBLIC'])

/** The live audit a 409 AUDIT_ALREADY_RUNNING carries, or null. */
export function runningAuditOf(err: unknown): SiteAuditView | null {
  if (errorCode(err) !== 'AUDIT_ALREADY_RUNNING') return null
  const audit = (err as SeoRequestError).apiError.details?.audit
  return audit && typeof audit === 'object' && typeof (audit as { id?: unknown }).id === 'string' ? (audit as SiteAuditView) : null
}

// ── Audits ───────────────────────────────────────────────────────────────

const BASE = '/api/account/seo/audits'

/** The workspace's audits, newest first, the default site and the page bounds. */
export async function fetchAudits(): Promise<AuditListPayload> {
  return jsonOrThrow<AuditListPayload>(await fetch(BASE))
}

/**
 * Start an audit. A second start while one runs throws with code
 * `AUDIT_ALREADY_RUNNING` (409) carrying the live audit (runningAuditOf).
 */
export async function startAudit(body: { url?: string | null; maxPages?: number }): Promise<SiteAuditView> {
  const payload: Record<string, unknown> = {}
  if (body.url) payload.url = body.url
  if (body.maxPages !== undefined) payload.max_pages = body.maxPages
  const data = await jsonOrThrow<{ audit: SiteAuditView }>(
    await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  return data.audit
}

/** One audit and its findings by type, most serious first. The poll target. */
export async function fetchAuditDetail(id: string): Promise<SiteAuditDetail> {
  return jsonOrThrow<SiteAuditDetail>(await fetch(`${BASE}/${id}`))
}

/** Stop a queued or running audit; what it found stays. */
export async function cancelAudit(id: string): Promise<SiteAuditView> {
  const data = await jsonOrThrow<{ audit: SiteAuditView }>(await fetch(`${BASE}/${id}/cancel`, { method: 'POST' }))
  return data.audit
}

/** Delete an audit that has ended. A live one throws with code `STILL_RUNNING`. */
export async function deleteAudit(id: string): Promise<void> {
  await jsonOrThrow<{ deleted: boolean }>(await fetch(`${BASE}/${id}`, { method: 'DELETE' }))
}

/** One issue type's findings in an audit, a page at a time. */
export async function fetchAuditIssues(
  id: string,
  opts: { type?: string; severity?: string; offset?: number; limit?: number } = {},
): Promise<Paged<SiteAuditIssueRow>> {
  const qs = new URLSearchParams()
  if (opts.type) qs.set('type', opts.type)
  if (opts.severity) qs.set('severity', opts.severity)
  if (opts.offset) qs.set('offset', String(opts.offset))
  if (opts.limit) qs.set('limit', String(opts.limit))
  const q = qs.toString()
  const data = await jsonOrThrow<{ issues: SiteAuditIssueRow[]; next_offset: number | null }>(
    await fetch(`${BASE}/${id}/issues${q ? `?${q}` : ''}`),
  )
  return { rows: data.issues, next_offset: data.next_offset }
}

/** An audit's crawled pages, narrowed by `show`, a page at a time. */
export async function fetchAuditPages(
  id: string,
  opts: { show?: AuditPageFilter; offset?: number; limit?: number } = {},
): Promise<Paged<SiteAuditPageRow>> {
  const qs = new URLSearchParams()
  if (opts.show && opts.show !== 'all') qs.set('show', opts.show)
  if (opts.offset) qs.set('offset', String(opts.offset))
  if (opts.limit) qs.set('limit', String(opts.limit))
  const q = qs.toString()
  const data = await jsonOrThrow<{ pages: SiteAuditPageRow[]; next_offset: number | null }>(
    await fetch(`${BASE}/${id}/pages${q ? `?${q}` : ''}`),
  )
  return { rows: data.pages, next_offset: data.next_offset }
}
