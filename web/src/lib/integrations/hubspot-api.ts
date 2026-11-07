/**
 * HubSpot CRM v3 HTTP client.
 *
 * Thin wrapper over the HubSpot public API used by the backfill + incremental
 * sync (src/lib/inngest/hubspot-functions.ts). Uses the CRM v3 object paths
 * (`/crm/v3/objects/{type}`), which are still fully supported and the best
 * documented for search — date-versioned paths exist but buy us nothing here.
 *
 * Auth is a bearer access token (30-min TTL) minted by the OAuth stack; the
 * caller is responsible for refreshing via the token-manager between runs.
 */

const HUBSPOT_BASE = 'https://api.hubapi.com'

/** Objects this integration syncs. */
export type HubspotObjectType = 'contacts' | 'companies'

/**
 * Thrown when HubSpot returns 401. Distinct from a generic error so the caller
 * can decide to refresh the token on the next run (the token-manager owns the
 * refresh; this client never refreshes mid-request).
 */
export class HubspotUnauthorizedError extends Error {
  readonly code = 'HUBSPOT_UNAUTHORIZED'
  constructor(message = 'HubSpot returned 401 Unauthorized') {
    super(message)
    this.name = 'HubspotUnauthorizedError'
  }
}

/** Generic non-2xx (non-401) failure, carrying the HTTP status. */
export class HubspotApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HubspotApiError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Minimal response shapes (only what we consume)
// ---------------------------------------------------------------------------

export interface HubspotObject {
  id: string
  properties: Record<string, string | null>
  /** Present only when `associations` were requested on the list call. */
  associations?: {
    companies?: {
      results?: Array<{ id: string; type?: string }>
    }
  }
  archived?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface HubspotPaging {
  next?: { after?: string; link?: string }
}

export interface HubspotListResponse {
  results: HubspotObject[]
  paging?: HubspotPaging
}

const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1000

/** Test-seam: overridable so fake timers don't have to advance real sleeps. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Core fetch wrapper.
 *
 * - Bearer auth from `accessToken`.
 * - 429: HubSpot documents a JSON body with a `policyName` (`SECONDLY` | `DAILY`)
 *   but does NOT reliably send a Retry-After header, so we back off on a fixed
 *   schedule (1s, 2s, 4s) plus jitter, up to MAX_RETRIES attempts, then throw.
 * - 401: throw HubspotUnauthorizedError (caller refreshes on the next run).
 * - other non-2xx: throw HubspotApiError with the status.
 */
export async function hubspotFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${HUBSPOT_BASE}${path}`

  let attempt = 0
  // Loop indices: attempt 0 is the first try; on 429 we retry until we've made
  // MAX_RETRIES+1 total requests (initial + 3 backed-off retries would be too
  // many — the brief says max 3 attempts, so cap at MAX_RETRIES total).
  while (true) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (res.status === 429) {
      attempt++
      if (attempt >= MAX_RETRIES) {
        // Read the policy for a useful error message; body may be absent.
        let policyName = 'unknown'
        try {
          const body = (await res.json()) as { policyName?: string }
          if (body?.policyName) policyName = body.policyName
        } catch {
          // ignore — rate-limit body isn't guaranteed
        }
        throw new HubspotApiError(
          429,
          `HubSpot rate limited (policy=${policyName}) after ${attempt} attempts`,
        )
      }
      // Exponential backoff with jitter. No Retry-After to honor.
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1)
      const jitter = Math.floor(Math.random() * 250)
      await sleep(backoff + jitter)
      continue
    }

    if (res.status === 401) {
      throw new HubspotUnauthorizedError()
    }

    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        // ignore
      }
      throw new HubspotApiError(
        res.status,
        `HubSpot request failed (${res.status}) ${path}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      )
    }

    // 204 No Content or empty body — return null rather than blow up on json().
    if (res.status === 204) return null
    return res.json()
  }
}

// ---------------------------------------------------------------------------
// List (backfill path)
// ---------------------------------------------------------------------------

/** Max page size the list endpoint accepts. */
export const LIST_MAX_LIMIT = 100

export interface ListObjectsOptions {
  /** Paging cursor (`paging.next.after` from a prior page). */
  after?: string
  /** Properties to request — ALWAYS pass explicitly; defaults are unreliable. */
  properties: string[]
  /** Association object types to expand (e.g. ['companies']). */
  associations?: string[]
  /** Page size, capped at LIST_MAX_LIMIT (100). */
  limit?: number
}

/**
 * GET the list endpoint for an object type. Uncapped — this is the backfill
 * path. `paging.next.after` on the response is the next cursor; its absence
 * means the listing is exhausted.
 */
export async function listObjects(
  accessToken: string,
  objectType: HubspotObjectType,
  options: ListObjectsOptions,
): Promise<HubspotListResponse> {
  const limit = Math.min(options.limit ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('properties', options.properties.join(','))
  if (options.associations?.length) {
    params.set('associations', options.associations.join(','))
  }
  if (options.after) params.set('after', options.after)

  const data = (await hubspotFetch(
    accessToken,
    `/crm/v3/objects/${objectType}?${params.toString()}`,
  )) as HubspotListResponse
  return { results: data?.results ?? [], paging: data?.paging }
}

// ---------------------------------------------------------------------------
// Search (incremental path)
// ---------------------------------------------------------------------------

/** Max page size the search endpoint accepts. */
export const SEARCH_MAX_LIMIT = 200

/**
 * Hard cap HubSpot enforces: a single search query returns at most 10,000
 * results across all its pages. The incremental loop must advance `since` past
 * this window (re-querying) rather than paging beyond it — see
 * advanceSearchWatermark for the pattern callers should follow.
 */
export const SEARCH_RESULT_CAP = 10000

export interface SearchObjectsOptions {
  /** hs_lastmodifieddate lower bound, epoch ms — filter is strictly GT. */
  since: number
  /** Paging cursor within the current query window. */
  after?: string
  /** Properties to request. */
  properties: string[]
  /** Page size, capped at SEARCH_MAX_LIMIT (200). */
  limit?: number
}

/**
 * POST the search endpoint. Filters on `hs_lastmodifieddate GT since`, sorts
 * ascending by the same property (a SINGLE sort — HubSpot rejects multiple),
 * and returns one page. The caller pages via `paging.next.after` and, on
 * exhausting the 10k window, re-queries with `since` bumped to the last page's
 * max hs_lastmodifieddate (see advanceSearchWatermark).
 */
export async function searchObjects(
  accessToken: string,
  objectType: HubspotObjectType,
  options: SearchObjectsOptions,
): Promise<HubspotListResponse> {
  const limit = Math.min(options.limit ?? SEARCH_MAX_LIMIT, SEARCH_MAX_LIMIT)
  const body: Record<string, unknown> = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'hs_lastmodifieddate',
            operator: 'GT',
            value: String(options.since),
          },
        ],
      },
    ],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    properties: options.properties,
    limit,
  }
  if (options.after) body.after = options.after

  const data = (await hubspotFetch(
    accessToken,
    `/crm/v3/objects/${objectType}/search`,
    { method: 'POST', body: JSON.stringify(body) },
  )) as HubspotListResponse
  return { results: data?.results ?? [], paging: data?.paging }
}

/**
 * Pull the epoch-ms hs_lastmodifieddate off a search result. Returns NaN when
 * the property is absent/unparseable so callers can skip it in max() folds.
 * HubSpot returns hs_lastmodifieddate either as an epoch-ms string or an ISO
 * timestamp depending on endpoint/version — handle both.
 */
export function lastModifiedMs(obj: HubspotObject): number {
  const raw = obj.properties?.hs_lastmodifieddate ?? obj.updatedAt ?? null
  if (!raw) return NaN
  // All-digits → already epoch ms.
  if (/^\d+$/.test(raw)) return Number(raw)
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? NaN : parsed
}

/**
 * Drive one full incremental pass for an object type, honoring BOTH HubSpot
 * search limits: 200 results/page (via searchObjects) and 10,000 results/query.
 *
 * The 10k cap can't be paged past, so when a query window fills up we restart
 * the query with `since` re-anchored to `(maxSeen - 1)` — one millisecond BEFORE
 * the max hs_lastmodifieddate seen. Anchoring at `maxSeen` itself would drop, via
 * the strictly-GT filter, any records that share that exact boundary millisecond
 * but fell beyond the 10k window (they would be permanently skipped). Anchoring
 * one ms earlier re-fetches the whole boundary-ms cohort; because the sort is
 * ascending and upserts are idempotent, re-processing the tail of the previous
 * window is harmless.
 *
 * Livelock guard: if a re-anchor does not move `since` strictly past the
 * previous window's anchor (pathological: >10k records share a single
 * millisecond, so `maxSeen - 1` lands at-or-before where we already were), we
 * log a warning naming the stuck timestamp and force-advance to `maxSeen + 1`,
 * accepting the documented skip of that millisecond's overflow rather than
 * looping forever.
 *
 * `onPage` is invoked for every page of results (in order) so the caller can
 * upsert incrementally and persist progress. Returns the final watermark: the
 * max hs_lastmodifieddate observed, or the starting `since` when nothing
 * changed (so callers never regress the stored watermark).
 */
export async function advanceSearchWatermark(
  accessToken: string,
  objectType: HubspotObjectType,
  params: {
    since: number
    properties: string[]
    limit?: number
    onPage: (results: HubspotObject[]) => Promise<void>
    /** Safety bound on total pages fetched per invocation (default 500). */
    maxPages?: number
    /**
     * Per-query result cap (default SEARCH_RESULT_CAP = 10,000). Test-seam only:
     * shrink it to exercise the window re-anchor + livelock guard without having
     * to fake thousands of pages. Production callers must leave it unset.
     */
    resultCap?: number
  },
): Promise<{ watermark: number; totalSeen: number; pagesFetched: number }> {
  const pageLimit = Math.min(params.limit ?? SEARCH_MAX_LIMIT, SEARCH_MAX_LIMIT)
  const maxPages = params.maxPages ?? 500
  const resultCap = params.resultCap ?? SEARCH_RESULT_CAP
  const pagesPerWindow = Math.max(1, Math.ceil(resultCap / pageLimit))

  let since = params.since
  let watermark = params.since
  let totalSeen = 0
  let pagesFetched = 0

  // Outer loop: one iteration per 10k query WINDOW (re-anchored `since`).
  while (pagesFetched < maxPages) {
    let after: string | undefined
    let pagesThisWindow = 0
    let advanced = false
    // The anchor this window started from — the re-anchor must move strictly
    // past it, else we're stuck on a single boundary millisecond.
    const windowStart = since

    // Inner loop: page through the current window until exhausted or capped.
    while (pagesFetched < maxPages) {
      const page = await searchObjects(accessToken, objectType, {
        since,
        after,
        properties: params.properties,
        limit: pageLimit,
      })
      pagesFetched++
      pagesThisWindow++

      if (page.results.length > 0) {
        await params.onPage(page.results)
        totalSeen += page.results.length
        for (const obj of page.results) {
          const ms = lastModifiedMs(obj)
          if (!Number.isNaN(ms) && ms > watermark) watermark = ms
        }
      }

      const nextAfter = page.paging?.next?.after
      if (!nextAfter) {
        // Window fully drained — the whole pass is done.
        return { watermark, totalSeen, pagesFetched }
      }

      // Hit the 10k window cap. Re-anchor `since` one ms BEFORE the max seen so
      // boundary-millisecond records beyond the cap are re-fetched next window.
      if (pagesThisWindow >= pagesPerWindow) {
        const reanchor = watermark - 1
        if (reanchor > windowStart) {
          since = reanchor
          advanced = true
        } else {
          // Livelock: >10k records in a single millisecond. `maxSeen - 1` can't
          // advance us. Force past the boundary (accepting the documented skip
          // of that ms's overflow) rather than re-querying forever.
          console.warn(
            `[hubspot-api] advanceSearchWatermark livelock on ${objectType}: ` +
              `>${SEARCH_RESULT_CAP} records share hs_lastmodifieddate=${watermark}; ` +
              `force-advancing past it (overflow at this timestamp is skipped).`,
          )
          since = watermark + 1
          advanced = true
        }
        break // restart the outer loop with the re-anchored `since`
      }

      after = nextAfter
    }

    // Defensive: if we exited the inner loop without re-anchoring (only possible
    // by hitting maxPages mid-window), stop — the outer loop can't make progress.
    if (!advanced) break
  }

  return { watermark, totalSeen, pagesFetched }
}

// ---------------------------------------------------------------------------
// Meetings (engagement writeback)
// ---------------------------------------------------------------------------

/**
 * meeting→contact association type. HubSpot's HUBSPOT_DEFINED association
 * catalog assigns typeId 200 to the meeting-to-contact link; every associated
 * contact on a created meeting uses the same entry.
 */
export const MEETING_TO_CONTACT_ASSOCIATION_TYPE_ID = 200

export interface CreateMeetingInput {
  /** Engagement timestamp — epoch ms string (HubSpot's hs_timestamp). */
  hs_timestamp: string
  hs_meeting_title: string
  /** Plain-text body. HubSpot caps meeting notes at 65,536 chars; keep < 60k. */
  hs_meeting_body: string
  /** Optional start/end, epoch ms strings. */
  hs_meeting_start_time?: string
  hs_meeting_end_time?: string
  /** HubSpot contact object ids to associate the meeting to. */
  contactIds: string[]
}

export interface CreatedMeeting {
  id: string
}

/**
 * Create ONE meeting engagement (`POST /crm/v3/objects/meetings`) associated to
 * every supplied contact id in a single call. Returns the created object id
 * (persisted on the capture for idempotency).
 *
 * Throws HubspotUnauthorizedError on 401 (e.g. a token minted before the
 * contacts.write scope existed) — the caller treats that as a clean no-op, NOT
 * a retry, since re-firing can never grow a scope the token never had.
 */
export async function createMeeting(
  accessToken: string,
  input: CreateMeetingInput,
): Promise<CreatedMeeting> {
  const properties: Record<string, string> = {
    hs_timestamp: input.hs_timestamp,
    hs_meeting_title: input.hs_meeting_title,
    hs_meeting_body: input.hs_meeting_body,
  }
  if (input.hs_meeting_start_time) properties.hs_meeting_start_time = input.hs_meeting_start_time
  if (input.hs_meeting_end_time) properties.hs_meeting_end_time = input.hs_meeting_end_time

  const associations = input.contactIds.map((id) => ({
    to: { id },
    types: [
      {
        associationCategory: 'HUBSPOT_DEFINED',
        associationTypeId: MEETING_TO_CONTACT_ASSOCIATION_TYPE_ID,
      },
    ],
  }))

  const data = (await hubspotFetch(accessToken, '/crm/v3/objects/meetings', {
    method: 'POST',
    body: JSON.stringify({ properties, associations }),
  })) as CreatedMeeting

  return { id: data.id }
}

// ---------------------------------------------------------------------------
// Contacts (writeback: dedupe-search + create)
// ---------------------------------------------------------------------------

/**
 * Search a single contact by exact email (`POST /crm/v3/objects/contacts/search`
 * with an `email EQ` filter, limit 1). Used by the contact-push writeback to
 * dedupe BEFORE creating — if HubSpot already has a contact for this email we
 * claim the existing object id rather than minting a duplicate.
 *
 * Returns the first matching object or null when HubSpot has none. Throws
 * HubspotUnauthorizedError on 401 (token predates the contacts.write scope) so
 * the caller can treat it as a clean no-op.
 */
export async function searchContactByEmail(
  accessToken: string,
  email: string,
): Promise<HubspotObject | null> {
  const body: Record<string, unknown> = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'email',
            operator: 'EQ',
            value: email,
          },
        ],
      },
    ],
    properties: ['email'],
    limit: 1,
  }

  const data = (await hubspotFetch(
    accessToken,
    '/crm/v3/objects/contacts/search',
    { method: 'POST', body: JSON.stringify(body) },
  )) as HubspotListResponse

  return data?.results?.[0] ?? null
}

export interface CreateContactInput {
  /** All optional — HubSpot accepts a contact with any subset of these. */
  email?: string | null
  firstname?: string | null
  lastname?: string | null
  phone?: string | null
  jobtitle?: string | null
}

export interface CreatedContact {
  id: string
}

/**
 * Create ONE contact (`POST /crm/v3/objects/contacts`). Only non-empty
 * properties are sent (HubSpot rejects empty-string values on some managed
 * properties, and sending nulls is pointless). Returns the created object id
 * (persisted locally for idempotency + future association).
 *
 * Throws HubspotUnauthorizedError on 401 (token missing the contacts.write
 * scope) — the caller treats that as a clean no-op, NOT a retry. Throws
 * HubspotApiError(409) when the email already exists (a create-race against a
 * concurrent writer); the caller re-searches once and claims.
 */
export async function createContact(
  accessToken: string,
  input: CreateContactInput,
): Promise<CreatedContact> {
  const properties: Record<string, string> = {}
  if (input.email) properties.email = input.email
  if (input.firstname) properties.firstname = input.firstname
  if (input.lastname) properties.lastname = input.lastname
  if (input.phone) properties.phone = input.phone
  if (input.jobtitle) properties.jobtitle = input.jobtitle

  const data = (await hubspotFetch(accessToken, '/crm/v3/objects/contacts', {
    method: 'POST',
    body: JSON.stringify({ properties }),
  })) as CreatedContact

  return { id: data.id }
}

/**
 * Archive (soft-delete) ONE contact (`DELETE /crm/v3/objects/contacts/{id}`).
 * HubSpot's DELETE archives the object (recoverable for 90 days) rather than
 * hard-deleting it.
 *
 * Used ONLY to undo an orphan: the contact-push writeback creates a HubSpot
 * contact and then loses the compare-and-swap race to persist the link locally
 * (a concurrent read-sync claimed the row first). The just-created HubSpot
 * object is now unreferenced, so we archive it to avoid leaving a duplicate.
 *
 * Best-effort by contract: a 404 (already gone / never existed) is treated as
 * success, and any other failure is swallowed with a warning — the caller is
 * already on a lost-race no-op path and must not throw/retry over cleanup.
 * A 401 is likewise logged and swallowed (the token lost its scope; the orphan
 * is a lesser evil than a retry storm).
 */
export async function archiveContact(accessToken: string, contactId: string): Promise<void> {
  try {
    await hubspotFetch(accessToken, `/crm/v3/objects/contacts/${contactId}`, {
      method: 'DELETE',
    })
  } catch (err) {
    // 404 → already archived / never existed: the desired end-state holds.
    if (err instanceof HubspotApiError && err.status === 404) return
    console.warn(
      `[hubspot-api] archiveContact failed for ${contactId} (best-effort cleanup) —`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ---------------------------------------------------------------------------
// Property sets (single source of truth for both list + search)
// ---------------------------------------------------------------------------

export const CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'phone',
  'mobilephone',
  'jobtitle',
  'hs_lastmodifieddate',
  // The first full import (roadmap track G3, src/lib/crm/import/sources/hubspot.ts):
  // where they live, whether they're a customer, and the last time anyone was in touch.
  'hs_additional_emails',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'company',
  'lifecyclestage',
  'notes_last_contacted',
  'hs_last_sales_activity_timestamp',
]

export const COMPANY_PROPERTIES = [
  'name',
  'domain',
  'website',
  'industry',
  'description',
  'numberofemployees',
  'annualrevenue',
  'city',
  'state',
  'country',
  'hs_lastmodifieddate',
  'phone',
  'address',
  'address2',
  'zip',
]
