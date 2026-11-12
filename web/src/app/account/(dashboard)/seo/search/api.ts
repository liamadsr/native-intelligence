/**
 * Client-side fetch layer for SEO's Search performance page: one place that
 * knows the Google routes (src/app/api/account/seo/google/*) and their error
 * envelope ({ error, code, details } with details `{ product, reconnect_by?,
 * retry_after_seconds? }` on a Google failure).
 *
 * Every call throws ../api's SeoRequestError on a refusal, so the page reads
 * codes with `errorCode` like its siblings. ../api keeps its parser private,
 * so the same reading is written here.
 *
 * Every read asks Google at the time and costs nothing.
 */
import type {
  AnalyticsReport,
  AnalyticsReportInput,
  AnalyticsSourceView,
  GoogleSeoErrorDetails,
  GoogleSeoStatus,
  SearchConsolePerformance,
  SearchConsolePerformanceInput,
  SearchConsoleSourceView,
  SearchOpportunities,
  UrlInspectionResult,
} from '@/lib/seo/google/view'
import { SeoRequestError, errorCode } from '../api'

const BASE = '/api/account/seo/google'

async function answer<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  throw new SeoRequestError({
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    code: typeof body.code === 'string' ? body.code : 'UNKNOWN',
    details: body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : null,
    status: res.status,
  })
}

const send = (method: 'POST' | 'PUT', body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** A Google failure's details (who has to sign in again, how long to wait), or null. */
export function googleDetails(err: unknown): GoogleSeoErrorDetails | null {
  if (!(err instanceof SeoRequestError)) return null
  const d = err.apiError.details
  return d && (d.product === 'search_console' || d.product === 'analytics') ? (d as unknown as GoogleSeoErrorDetails) : null
}

/** The workspace's choice is gone or never made: the status must be read again. */
export function isSetupGone(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'NOT_CONNECTED' || code === 'NO_SOURCE'
}

// ── Status and the workspace's choices ───────────────────────────────────

/** Per product: the state, the caller's connections, the choice and what could be chosen. Asks Google: up to 20 s. */
export async function fetchGoogleStatus(): Promise<GoogleSeoStatus> {
  return answer<GoogleSeoStatus>(await fetch(`${BASE}/status`))
}

export async function chooseSite(site_url: string, account_id?: string): Promise<SearchConsoleSourceView> {
  const data = await answer<{ source: SearchConsoleSourceView }>(
    await fetch(`${BASE}/search-console/site`, send('PUT', account_id ? { site_url, account_id } : { site_url })),
  )
  return data.source
}

export async function clearSite(): Promise<void> {
  await answer<unknown>(await fetch(`${BASE}/search-console/site`, { method: 'DELETE' }))
}

export async function chooseProperty(property_id: string, account_id?: string): Promise<AnalyticsSourceView> {
  const data = await answer<{ source: AnalyticsSourceView }>(
    await fetch(`${BASE}/analytics/property`, send('PUT', account_id ? { property_id, account_id } : { property_id })),
  )
  return data.source
}

export async function clearProperty(): Promise<void> {
  await answer<unknown>(await fetch(`${BASE}/analytics/property`, { method: 'DELETE' }))
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function fetchPerformance(input: SearchConsolePerformanceInput): Promise<SearchConsolePerformance> {
  return answer<SearchConsolePerformance>(await fetch(`${BASE}/search-console/performance`, send('POST', input)))
}

export async function fetchOpportunities(input: { start_date?: string; end_date?: string; limit?: number }): Promise<SearchOpportunities> {
  return answer<SearchOpportunities>(await fetch(`${BASE}/search-console/opportunities`, send('POST', input)))
}

export async function inspectUrls(urls: string[]): Promise<UrlInspectionResult> {
  return answer<UrlInspectionResult>(await fetch(`${BASE}/search-console/inspect`, send('POST', { urls })))
}

export async function fetchAnalyticsReport(input: AnalyticsReportInput): Promise<AnalyticsReport> {
  return answer<AnalyticsReport>(await fetch(`${BASE}/analytics/report`, send('POST', input)))
}
