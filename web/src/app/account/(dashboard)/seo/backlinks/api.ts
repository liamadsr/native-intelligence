/**
 * Client-side fetch layer for SEO's Backlinks page: one place that knows the
 * backlinks routes' shapes (src/app/api/account/seo/backlinks/*) and the
 * stored lookups (…/seo/lookups).
 *
 * Errors come back as the Site audit page's SeoRequestError (../api.ts), so
 * the page branches on the same parsed codes: 402 SPEND_LIMIT_REACHED (a
 * neutral banner, the page stays usable), 503 SEO_NOT_CONFIGURED / 403
 * FREE_PLAN (lookups are off: the page's notice), 400 VALIDATION_ERROR or
 * NO_SITE (the message is for the person: beside the field), anything else
 * a "Could not …".
 *
 * What spends: the overview and each profile page, unless the route answers
 * from its stored copy (`from_cache`, 12 hours). The stored lookups, one
 * stored lookup and the own site are free reads.
 */
import type {
  BacklinksOverview,
  BacklinksProfilePage,
  BacklinksRowsFilters,
  BacklinksRowsMode,
  BacklinksSortOrder,
  BacklinksTab,
} from '@/lib/seo/backlinks/view'
import type { SeoLookupDetail, SeoLookupSummary } from '@/lib/seo/lookup-view'
import { SEO_DATA_OFF_CODES } from '@/lib/seo/spend-view'
import type { ResearchScope } from '@/lib/seo/shared/researchScope'
import { SeoRequestError, errorCode } from '../api'

// ../api.ts keeps its JSON reader to itself, so this one mirrors it: the same
// envelope ({ error, code, details }) parsed into the same error class.
async function readJson<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const details = body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : null
  throw new SeoRequestError({
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    code: typeof body.code === 'string' ? body.code : 'UNKNOWN',
    details,
    status: res.status,
  })
}

const post = (path: string, body: Record<string, unknown>) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

// ── What an error means for the page ─────────────────────────────────────

/**
 * How the page treats a failed paid call:
 *   limit   402: the month's limit, said in a neutral banner
 *   off     503 SEO_NOT_CONFIGURED / 403 FREE_PLAN: lookups are off
 *   field   400: the person's to correct, beside the field
 *   failed  anything else: "Could not …" with a retry
 */
export type PaidFailure = 'limit' | 'off' | 'field' | 'failed'

export function paidFailure(err: unknown): PaidFailure {
  const code = errorCode(err)
  const status = err instanceof SeoRequestError ? err.apiError.status : 0
  if (code === 'SPEND_LIMIT_REACHED' || status === 402) return 'limit'
  if (code && SEO_DATA_OFF_CODES.has(code)) return 'off'
  if (status === 400) return 'field'
  return 'failed'
}

// ── Backlinks data (these spend unless stored) ───────────────────────────

/** What names the site or page looked up: as typed, or as an overview answered it. */
export interface BacklinksTarget {
  target: string
  scope?: ResearchScope
}

/** A site's or page's overview. */
export async function fetchOverview(input: BacklinksTarget & { refresh?: boolean }): Promise<BacklinksOverview> {
  const body: Record<string, unknown> = { target: input.target }
  if (input.scope) body.scope = input.scope
  if (input.refresh) body.refresh = true
  const data = await readJson<{ overview: BacklinksOverview }>(await post('/api/account/seo/backlinks/overview', body))
  return data.overview
}

/** One page of one list, with its controls as the route takes them. */
export interface ProfileQuery extends BacklinksTarget {
  tab: BacklinksTab
  page: number
  page_size: number
  sort_field: string
  sort_order: BacklinksSortOrder
  /** The Links tab's filters; the other tabs send `include` only. */
  filters: BacklinksRowsFilters
  mode?: BacklinksRowsMode
  hide_spam?: boolean
  refresh?: boolean
}

export async function fetchProfile(query: ProfileQuery): Promise<BacklinksProfilePage> {
  const body: Record<string, unknown> = {
    tab: query.tab,
    target: query.target,
    page: query.page,
    page_size: query.page_size,
    sort_field: query.sort_field,
    sort_order: query.sort_order,
    filters: query.filters,
  }
  if (query.scope) body.scope = query.scope
  if (query.tab === 'backlinks' && query.mode) body.mode = query.mode
  if (query.tab !== 'pages' && query.hide_spam !== undefined) body.hide_spam = query.hide_spam
  if (query.refresh) body.refresh = true
  const data = await readJson<{ profile: BacklinksProfilePage }>(await post('/api/account/seo/backlinks/profile', body))
  return data.profile
}

// ── Free reads ───────────────────────────────────────────────────────────

/** The stored-lookup kind of an overview (src/lib/seo/backlinks/service.ts). */
export const OVERVIEW_KIND = 'backlinks_overview'

/** The workspace's stored overviews, newest first. */
export async function fetchRecentOverviews(limit = 20): Promise<SeoLookupSummary[]> {
  const data = await readJson<{ lookups: SeoLookupSummary[] }>(await fetch(`/api/account/seo/lookups?kind=${OVERVIEW_KIND}&limit=${limit}`))
  return data.lookups ?? []
}

/** How an overview is stored: the route's answer without what is worked out per read. */
export type StoredOverview = Omit<BacklinksOverview, 'lookup_id' | 'fetched_at' | 'from_cache'>

/** One stored overview, whole. */
export async function fetchStoredOverview(id: string): Promise<SeoLookupDetail<unknown, StoredOverview>> {
  return readJson<SeoLookupDetail<unknown, StoredOverview>>(await fetch(`/api/account/seo/lookups/${id}`))
}

/**
 * The workspace's own site. No SEO route answers just this, so it is read
 * from the Site audit list's `default_url` (free, the same resolver the
 * backlinks routes use when no target is named).
 */
export async function fetchOwnSite(): Promise<string | null> {
  const data = await readJson<{ default_url?: string | null }>(await fetch('/api/account/seo/audits'))
  return typeof data.default_url === 'string' && data.default_url ? data.default_url : null
}
