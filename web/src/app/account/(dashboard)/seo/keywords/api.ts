/**
 * Client-side fetch layer for SEO's Keywords page: one place that knows the
 * route shapes (src/app/api/account/seo/keywords/*, serp, lookups) and the
 * error envelope ({ error, code, details } via src/lib/api-errors).
 *
 * Errors are thrown as the Site audit's SeoRequestError (../api.ts), so the
 * page reads them with the same `errorCode` / `errorMessage`. The page
 * branches on: a 400 (VALIDATION_ERROR or the envelope's BAD_REQUEST: said
 * beside the field), 402 SPEND_LIMIT_REACHED (a neutral line, the page stays
 * usable), 503 SEO_NOT_CONFIGURED / 403 FREE_PLAN (the "not set up" notice),
 * 409 SAVED_KEYWORDS_FULL, and 404 on a SERP re-check (every read failed
 * and the check was dropped; one that found nothing is kept and answers).
 *
 * Every call goes through the globally patched `window.fetch` (plain `fetch`).
 */
import type { SeoLookupDetail, SeoLookupSummary } from '@/lib/seo/lookup-view'
import { SEO_DATA_OFF_CODES } from '@/lib/seo/spend-view'
import type {
  KeywordMetricsResult,
  KeywordResearchMode,
  KeywordResearchResult,
  KeywordResultLimit,
  KeywordRow,
  SavedKeyword,
  SavedKeywordPage,
  SavedKeywordSort,
  SavedKeywordTagCount,
  SerpResult,
} from '@/lib/seo/keywords/view'
import { SeoRequestError } from '../api'

// ── Errors ───────────────────────────────────────────────────────────────

/** ../api.ts keeps its own reader private; this one reads the same envelope the same way. */
async function readOrThrow<T>(res: Response): Promise<T> {
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

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** Codes that mean search data can't be bought here at all (the page shows the notice). */
export const DATA_OFF_CODES: ReadonlySet<string> = SEO_DATA_OFF_CODES

/** A request the person can correct where they typed it (a 400 of any code). */
export function isFieldError(err: unknown): boolean {
  return err instanceof SeoRequestError && err.apiError.status === 400
}

// ── Research ─────────────────────────────────────────────────────────────

/** What a research asks (the Refresh button asks the same again). */
export interface ResearchAsk {
  seed: string
  location_code: number
  language_code: string
  mode: KeywordResearchMode
  result_limit: KeywordResultLimit
  group_keywords: boolean
}

/** Keyword ideas around a seed. Spends unless a stored answer (24 h) is there or `refresh` is false. */
export async function researchKeywords(ask: ResearchAsk, opts: { refresh?: boolean } = {}): Promise<KeywordResearchResult> {
  const body: Record<string, unknown> = {
    seed: ask.seed,
    location_code: ask.location_code,
    language_code: ask.language_code,
  }
  if (ask.mode !== 'auto') body.mode = ask.mode
  if (ask.result_limit !== 150) body.result_limit = ask.result_limit
  if (ask.group_keywords) body.group_keywords = true
  if (opts.refresh) body.refresh = true
  return readOrThrow<KeywordResearchResult>(await fetch('/api/account/seo/keywords/research', json('POST', body)))
}

/** Fresh numbers for keywords in one market. Saved keywords there take them too. Spends. */
export async function fetchKeywordMetrics(body: {
  keywords: string[]
  location_code: number
  language_code: string
  refresh?: boolean
}): Promise<KeywordMetricsResult> {
  return readOrThrow<KeywordMetricsResult>(await fetch('/api/account/seo/keywords/metrics', json('POST', body)))
}

// ── Past lookups (free) ──────────────────────────────────────────────────

export const RESEARCH_KIND = 'keyword_research'

export async function fetchRecentResearch(limit = 8): Promise<SeoLookupSummary[]> {
  const data = await readOrThrow<{ lookups: SeoLookupSummary[] }>(
    await fetch(`/api/account/seo/lookups?kind=${RESEARCH_KIND}&limit=${limit}`),
  )
  return data.lookups
}

/** What a stored research holds (research.ts's StoredResearch and its request key). */
export interface StoredResearchRequest {
  seed?: string
  location_code?: number
  language_code?: string
  mode?: KeywordResearchMode
  result_limit?: number
  group_keywords?: boolean
}
export type StoredResearchResult = Omit<KeywordResearchResult, 'lookup_id' | 'fetched_at' | 'from_cache'>

export async function fetchStoredResearch(id: string): Promise<SeoLookupDetail<StoredResearchRequest, StoredResearchResult>> {
  return readOrThrow(await fetch(`/api/account/seo/lookups/${id}`))
}

// ── Saved keywords (free) ────────────────────────────────────────────────

export interface SavedQuery {
  offset?: number
  limit?: number
  search?: string
  tags?: readonly string[]
  sort?: SavedKeywordSort
  dir?: 'asc' | 'desc'
}

export type SavedPayload = SavedKeywordPage & { tags: SavedKeywordTagCount[]; max: number }

export function savedQueryString(q: SavedQuery): string {
  const qs = new URLSearchParams()
  if (q.offset) qs.set('offset', String(q.offset))
  if (q.limit) qs.set('limit', String(q.limit))
  if (q.search?.trim()) qs.set('search', q.search.trim())
  for (const tag of q.tags ?? []) qs.append('tag', tag)
  if (q.sort) qs.set('sort', q.sort)
  if (q.dir) qs.set('dir', q.dir)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export async function fetchSaved(q: SavedQuery = {}): Promise<SavedPayload> {
  return readOrThrow<SavedPayload>(await fetch(`/api/account/seo/keywords/saved${savedQueryString(q)}`))
}

/** The numbers a saved keyword keeps from a research row. */
function metricOf(row: KeywordRow) {
  return {
    keyword: row.keyword,
    search_volume: row.search_volume,
    cpc: row.cpc,
    competition: row.competition,
    keyword_difficulty: row.keyword_difficulty,
    intent: row.intent,
    trend: row.trend.slice(-24),
  }
}

export async function saveKeywords(body: {
  rows: KeywordRow[]
  location_code: number
  language_code: string
  tags?: string[]
}): Promise<{ added: number; already_saved: number; rows: SavedKeyword[] }> {
  const payload: Record<string, unknown> = {
    keywords: body.rows.map((r) => r.keyword),
    location_code: body.location_code,
    language_code: body.language_code,
    metrics: body.rows.map(metricOf),
  }
  if (body.tags && body.tags.length > 0) payload.tags = body.tags
  return readOrThrow(await fetch('/api/account/seo/keywords/saved', json('POST', payload)))
}

export async function retagSaved(body: { ids: string[]; add_tags?: string[]; remove_tags?: string[] }): Promise<{ updated: number }> {
  return readOrThrow(await fetch('/api/account/seo/keywords/saved', json('PATCH', body)))
}

export async function removeSaved(ids: string[]): Promise<{ removed: number }> {
  return readOrThrow(await fetch('/api/account/seo/keywords/saved', json('DELETE', { ids })))
}

// ── Live results (SERP) ──────────────────────────────────────────────────

/** Live Google results for one keyword. Spends unless a stored check (12 h) answers. */
export async function checkSerp(body: { keyword: string; location_code: number; language_code: string; refresh?: boolean }): Promise<SerpResult> {
  const payload: Record<string, unknown> = { keyword: body.keyword, location_code: body.location_code, language_code: body.language_code }
  if (body.refresh) payload.refresh = true
  return readOrThrow<SerpResult>(await fetch('/api/account/seo/serp', json('POST', payload)))
}

/** A bought check read again, collecting reads still out. Free. 404: it was dropped (every read failed). */
export async function recheckSerp(id: string): Promise<SerpResult> {
  return readOrThrow<SerpResult>(await fetch(`/api/account/seo/serp/${id}`))
}
