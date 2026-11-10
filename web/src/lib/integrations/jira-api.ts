/**
 * Jira Cloud REST API v3 HTTP client (OAuth 2.0 3LO).
 *
 * Thin wrapper over the Atlassian gateway used by the action push
 * (src/lib/tasks/jira-push.ts), the Native Intelligence→Jira status echo
 * (src/lib/inngest/jira-echo-status.ts) and the destination picker routes
 * (/api/account/jira/*).
 *
 * Three Jira conventions shape everything below, and each one is a deliberate
 * divergence from the Asana client this file is otherwise a sibling of:
 *
 *  - **There is no single base URL.** A 3LO app never talks to
 *    `https://{site}.atlassian.net` directly; it goes through the gateway at
 *    `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`, where cloudId
 *    identifies the customer's site and comes from the destination config. So
 *    every function here takes `(accessToken, cloudId, …)` rather than Asana's
 *    `(accessToken, …)`. The ONE exception is listAccessibleResources, which is
 *    account-scoped and is how you learn a cloudId in the first place.
 *  - **No response envelope.** Asana wraps every payload in `data`; Jira returns
 *    the raw resource. There is no unwrap step, so `jiraFetch` IS the transport.
 *  - **A different error shape**: `{ errorMessages: string[], errors: {field: msg} }`.
 *    `errors` is the load-bearing half — it names the field that was rejected,
 *    which is how the push tells "duedate isn't on this project's create screen"
 *    apart from every other 400. JiraApiError therefore carries it structurally
 *    (`fieldErrors`) instead of only flattening it into a message.
 *
 * Auth is a bearer access token (60-min TTL) minted by the OAuth stack; the
 * caller is responsible for refreshing via the token-manager between calls.
 */

/** Atlassian's API gateway. Both the account-level and per-site paths live here. */
const ATLASSIAN_API = 'https://api.atlassian.com'

/**
 * Thrown when an Atlassian identifier that is about to be INTERPOLATED into a
 * URL or a JQL string doesn't have the shape Atlassian mints.
 *
 * Not a defensive nicety: a cloudId reaches this module from a query param
 * (`/api/account/jira/*?cloudId=…`) and from stored config, and it lands in the
 * PATH of an authenticated request. `encodeURIComponent` is wrong there (a real
 * cloudId is a UUID and encoding is a no-op for it, while encoding a hostile one
 * would silently keep addressing an unintended path); refusing the value is the
 * only honest answer. The same applies to the numeric ids that go into the
 * webhook's JQL filter, where there is no encoding available at all.
 */
export class JiraInvalidIdentifierError extends Error {
  readonly code = 'JIRA_INVALID_IDENTIFIER'
  readonly field: string
  constructor(field: string, value: unknown) {
    super(
      `Invalid Jira ${field}: expected an Atlassian-minted identifier, got ` +
        `${typeof value === 'string' ? JSON.stringify(value.slice(0, 60)) : typeof value}`,
    )
    this.name = 'JiraInvalidIdentifierError'
    this.field = field
  }
}

/**
 * A cloudId as `accessible-resources` mints them: a UUID. Matched loosely
 * (hex + dashes, 8–64 chars) rather than as a strict UUID so a future Atlassian
 * format tweak doesn't lock every tenant out — but strictly enough that nothing
 * matching can carry a `/`, `?`, `#`, `..` or a credential.
 */
const CLOUD_ID_PATTERN = /^[0-9a-f-]{8,64}$/i

/** Project / issue-type / status ids. Atlassian mints these as integers. */
const NUMERIC_ID_PATTERN = /^\d+$/

export function isValidJiraCloudId(value: unknown): value is string {
  return typeof value === 'string' && CLOUD_ID_PATTERN.test(value)
}

export function isNumericJiraId(value: unknown): value is string {
  return typeof value === 'string' && NUMERIC_ID_PATTERN.test(value)
}

/**
 * Throw unless `value` is a numeric Atlassian id, and hand it back so it can be
 * used inline at the point of interpolation — which is the only place a caller
 * should be reaching for it (jiraWebhookJql is the one today: a project id going
 * into a JQL string, where no escaping exists to fall back on).
 */
export function assertNumericJiraId(field: string, value: unknown): string {
  if (!isNumericJiraId(value)) throw new JiraInvalidIdentifierError(field, value)
  return value
}

/**
 * Per-site REST v3 root for a cloudId.
 *
 * VALIDATES rather than encodes — see JiraInvalidIdentifierError. This is the
 * single choke point every per-site call goes through, so the check here covers
 * the picker routes, the push, the echo, the read-back and the webhook
 * lifecycle at once, whatever validation their own callers did or didn't do.
 */
export function jiraBaseUrl(cloudId: string): string {
  if (!isValidJiraCloudId(cloudId)) {
    throw new JiraInvalidIdentifierError('cloudId', cloudId)
  }
  return `${ATLASSIAN_API}/ex/jira/${cloudId}/rest/api/3`
}

/**
 * Thrown when Jira returns 401. Distinct from a generic error so the caller can
 * mark the link/account as needing a reconnect rather than retrying (the
 * token-manager owns refresh; this client never refreshes mid-request).
 */
export class JiraUnauthorizedError extends Error {
  readonly code = 'JIRA_UNAUTHORIZED'
  constructor(message = 'Jira returned 401 Unauthorized') {
    super(message)
    this.name = 'JiraUnauthorizedError'
  }
}

/**
 * Generic non-2xx (non-401) failure, carrying the HTTP status AND Jira's
 * per-field `errors` map.
 *
 * `fieldErrors` is what makes the create path's "retry without duedate" recovery
 * possible without string-matching a human-readable sentence: Jira answers a
 * field that isn't on the issue type's create screen with
 * `errors: { duedate: "Field 'duedate' cannot be set. It is not on the
 * appropriate screen, or unknown." }`, and the field KEY is the stable part.
 */
export class JiraApiError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string>
  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message)
    this.name = 'JiraApiError'
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

/** True when `err` is a Jira 404 — the issue/resource is gone. */
export function isJiraNotFound(err: unknown): boolean {
  return err instanceof JiraApiError && err.status === 404
}

// ---------------------------------------------------------------------------
// Minimal response shapes (only what we consume)
// ---------------------------------------------------------------------------

/** One entry of `GET /oauth/token/accessible-resources` — an authorized site. */
export interface JiraSite {
  /** THE cloudId. Every per-site API path is built from this, never from `url`. */
  id: string
  name?: string
  /** `https://acme.atlassian.net` — display + permalink construction only. */
  url?: string
  avatarUrl?: string
  scopes?: string[]
}

export interface JiraProject {
  id: string
  key: string
  name?: string
  avatarUrls?: Record<string, string>
}

export interface JiraIssueType {
  id: string
  name?: string
  /** Subtasks need a `parent` and can't be created top-level — callers filter. */
  subtask?: boolean
}

export interface JiraStatusCategory {
  id?: number
  /** 'new' | 'indeterminate' | 'done' — the STABLE enum. `name` is localizable. */
  key?: string
  name?: string
  colorName?: string
}

export interface JiraStatus {
  id: string
  name?: string
  statusCategory?: JiraStatusCategory
}

/** `GET /project/{id}/statuses` returns one entry PER ISSUE TYPE. */
export interface JiraIssueTypeStatuses {
  id: string
  name?: string
  subtask?: boolean
  statuses?: JiraStatus[]
}

export interface JiraIssue {
  id: string
  key?: string
  self?: string
  fields?: {
    summary?: string
    status?: JiraStatus
    [key: string]: unknown
  }
}

/** One allowed value on a transition-screen field (e.g. a resolution). */
export interface JiraAllowedValue {
  id?: string
  name?: string
  value?: string
}

/** Field metadata from `expand=transitions.fields`, same shape as createmeta. */
export interface JiraTransitionField {
  required?: boolean
  name?: string
  allowedValues?: JiraAllowedValue[]
}

export interface JiraTransition {
  id: string
  name?: string
  /** The status this transition LANDS ON — the only thing we select against. */
  to?: JiraStatus
  hasScreen?: boolean
  isAvailable?: boolean
  /** Present only with `expand=transitions.fields`; keyed by field id. */
  fields?: Record<string, JiraTransitionField>
}

export interface JiraUser {
  accountId?: string
  displayName?: string
  emailAddress?: string | null
  accountType?: string
  active?: boolean
}

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 1000

/**
 * The longest `Retry-After` this client will actually sleep for.
 *
 * Jira's three limiters have wildly different reset horizons, and one of them —
 * the points quota — resets on the UTC hour and is shared across every tenant of
 * this app, so a `Retry-After: 2400` is entirely possible. Sleeping it would
 * hold a Vercel function until maxDuration kills it (a user-facing picker route
 * becomes a hung spinner, then a 504) or blow an Inngest step timeout mid-page.
 * Past this ceiling we throw the retryable JiraApiError(429) instead and let the
 * caller's own backoff — Inngest's, for every background path — own the wait.
 */
const MAX_RETRY_AFTER_MS = 60_000

/** Test-seam: overridable so fake timers don't have to advance real sleeps. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse Jira's `{ errorMessages: [], errors: { field: msg } }` envelope.
 *
 * BOTH halves matter and neither is guaranteed present: `errorMessages` carries
 * general failures ("Invalid request payload"), `errors` carries per-field
 * validation. Returns the flattened human message plus the raw field map (which
 * the create path branches on). Falls back to the truncated raw text when the
 * body isn't the documented shape.
 */
export function describeErrorBody(raw: string): {
  message: string
  fieldErrors: Record<string, string>
} {
  if (!raw) return { message: '', fieldErrors: {} }
  try {
    const parsed = JSON.parse(raw) as {
      errorMessages?: unknown
      errors?: unknown
    }
    const general = Array.isArray(parsed?.errorMessages)
      ? parsed.errorMessages.filter((m): m is string => typeof m === 'string')
      : []

    const fieldErrors: Record<string, string> = {}
    const rawErrors = parsed?.errors
    if (rawErrors && typeof rawErrors === 'object' && !Array.isArray(rawErrors)) {
      for (const [field, message] of Object.entries(rawErrors as Record<string, unknown>)) {
        if (typeof message === 'string') fieldErrors[field] = message
      }
    }

    const parts = [
      ...general,
      ...Object.entries(fieldErrors).map(([field, message]) => `${field}: ${message}`),
    ]
    if (parts.length > 0) return { message: parts.join('; '), fieldErrors }
    return { message: raw.slice(0, 300), fieldErrors }
  } catch {
    // Not JSON — fall through to the raw text.
    return { message: raw.slice(0, 300), fieldErrors: {} }
  }
}

/**
 * Core transport, against an ABSOLUTE url.
 *
 * - Bearer auth from `accessToken`.
 * - 429: Jira sends `Retry-After` (seconds) — honor it rather than guessing.
 *   Falls back to an exponential schedule (1s, 2s) plus jitter when the header
 *   is missing/unparseable. Capped at MAX_ATTEMPTS total requests, then throws
 *   JiraApiError(429). `RateLimit-Reason` (`jira-quota-global-based` /
 *   `jira-burst-based` / `jira-per-issue-on-write`) is LOGGED but not branched
 *   on in v1 — knowing which of the three systems tripped is what makes a real
 *   incident diagnosable, and guessing a per-system strategy without traffic
 *   data would be fiction.
 * - 401: throw JiraUnauthorizedError (caller reconnects / marks the link).
 * - other non-2xx: throw JiraApiError with the status, the flattened message and
 *   the per-field error map.
 */
async function jiraRequest(
  accessToken: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let attempt = 0
  while (true) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (res.status === 429) {
      attempt++
      const reason = res.headers?.get?.('ratelimit-reason')
      if (attempt >= MAX_ATTEMPTS) {
        throw new JiraApiError(
          429,
          `Jira rate limited after ${attempt} attempts ${url}` +
            (reason ? ` (${reason})` : ''),
        )
      }
      const retryAfter = Number(res.headers?.get?.('retry-after'))
      const honoured = Number.isFinite(retryAfter) && retryAfter > 0
      const waitMs = honoured ? retryAfter * 1000 : BASE_BACKOFF_MS * 2 ** (attempt - 1)

      // A quota reset an hour out is not something to sleep on inside a request
      // or an Inngest step — see MAX_RETRY_AFTER_MS.
      if (waitMs > MAX_RETRY_AFTER_MS) {
        throw new JiraApiError(
          429,
          `Jira rate limited with Retry-After ${retryAfter}s (over the ` +
            `${MAX_RETRY_AFTER_MS / 1000}s cap) ${url}` + (reason ? ` (${reason})` : ''),
        )
      }

      console.warn(
        `[jira-api] 429 on ${url}${reason ? ` reason=${reason}` : ''}; retrying (attempt ${attempt}).`,
      )
      const jitter = Math.floor(Math.random() * 250)
      await sleep(waitMs + jitter)
      continue
    }

    if (res.status === 401) {
      throw new JiraUnauthorizedError()
    }

    if (!res.ok) {
      let message = ''
      let fieldErrors: Record<string, string> = {}
      try {
        const described = describeErrorBody(await res.text())
        message = described.message
        fieldErrors = described.fieldErrors
      } catch {
        // ignore — the status is the useful part
      }
      throw new JiraApiError(
        res.status,
        `Jira request failed (${res.status}) ${url}${message ? `: ${message}` : ''}`,
        fieldErrors,
      )
    }

    // 204 No Content (transitions, assignee) — return null rather than blow up.
    if (res.status === 204) return null
    const text = await res.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
}

/**
 * The call every per-site helper below uses: jiraRequest against
 * `{gateway}/ex/jira/{cloudId}/rest/api/3{path}`. There is no envelope to
 * unwrap — Jira returns the resource itself.
 */
export async function jiraFetch(
  accessToken: string,
  cloudId: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  return jiraRequest(accessToken, `${jiraBaseUrl(cloudId)}${path}`, init)
}

// ---------------------------------------------------------------------------
// Account scope (no cloudId — this is how you LEARN one)
// ---------------------------------------------------------------------------

/**
 * `GET /oauth/token/accessible-resources` — every Jira site this token can
 * reach.
 *
 * Multi-site Atlassian accounts return MORE THAN ONE entry, so the user picks
 * (we never assume 1:1) and the chosen `id` is persisted as `cloud_id` in the
 * destination config. `url` is display/permalink only — Atlassian's guidance is
 * that `id` is the API identity.
 */
export async function listAccessibleResources(accessToken: string): Promise<JiraSite[]> {
  const data = (await jiraRequest(
    accessToken,
    `${ATLASSIAN_API}/oauth/token/accessible-resources`,
  )) as JiraSite[] | null
  return Array.isArray(data) ? data : []
}

// ---------------------------------------------------------------------------
// Pickers (destination config)
// ---------------------------------------------------------------------------

/** Max page size the picker routes request. */
export const LIST_MAX_LIMIT = 50

/**
 * The most createmeta pages either createmeta walk below will follow.
 *
 * A ceiling, not an expectation: at LIST_MAX_LIMIT per page this reaches 250
 * fields or issue types, well past any real project, while keeping the request
 * bounded if a pathological project (or a `startAt` that fails to advance) would
 * otherwise loop forever.
 */
const MAX_CREATEMETA_PAGES = 5

/**
 * `GET /project/search` — one page of projects, optionally name/key-filtered.
 *
 * Jira pages with startAt/maxResults (offset paging) and reports `isLast`,
 * unlike Asana's opaque cursor. `query` matches project name OR key, which is
 * exactly what search-as-you-type wants.
 */
export async function searchProjects(
  accessToken: string,
  cloudId: string,
  options: { query?: string; startAt?: number; maxResults?: number } = {},
): Promise<{ projects: JiraProject[]; isLast: boolean; nextStartAt: number | null }> {
  const maxResults = Math.min(options.maxResults ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const params = new URLSearchParams()
  params.set('maxResults', String(maxResults))
  params.set('startAt', String(options.startAt ?? 0))
  if (options.query) params.set('query', options.query)

  const body = (await jiraFetch(
    accessToken,
    cloudId,
    `/project/search?${params.toString()}`,
  )) as { values?: JiraProject[]; isLast?: boolean; startAt?: number } | null

  const projects = body?.values ?? []
  const isLast = body?.isLast ?? true
  const startAt = body?.startAt ?? options.startAt ?? 0
  return {
    projects,
    isLast,
    nextStartAt: isLast ? null : startAt + projects.length,
  }
}

/**
 * `GET /issue/createmeta/{projectIdOrKey}/issuetypes` — the issue types a new
 * issue can be created as in this project.
 *
 * This is the granular REPLACEMENT for the deprecated all-in-one
 * `GET /issue/createmeta`. Returns the raw list including subtasks; the picker
 * route filters `subtask: true` out (a subtask create requires a `parent` and
 * can never be a top-level push target).
 *
 * Issue type ids are per-SITE and, in team-managed projects, per-PROJECT copies
 * — never cache one across projects, always resolve here.
 *
 * PAGED to exhaustion (bounded by MAX_CREATEMETA_PAGES). One page covers every
 * ordinary project, but the compose panel turns this list into a REQUIRED pick —
 * a type past the first page was previously unreachable with nothing on screen
 * saying the list was cut short, which is the same failure the Linear team
 * picker was paged to fix. `startAt` still exists for a caller that wants one
 * explicit page.
 */
export async function listCreateMetaIssueTypes(
  accessToken: string,
  cloudId: string,
  projectIdOrKey: string,
  options: { startAt?: number; maxResults?: number } = {},
): Promise<JiraIssueType[]> {
  const maxResults = Math.min(options.maxResults ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const issueTypes: JiraIssueType[] = []
  let startAt = options.startAt ?? 0

  for (let page = 0; page < MAX_CREATEMETA_PAGES; page++) {
    const params = new URLSearchParams()
    params.set('maxResults', String(maxResults))
    params.set('startAt', String(startAt))

    const body = (await jiraFetch(
      accessToken,
      cloudId,
      `/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes?${params.toString()}`,
    )) as { issueTypes?: JiraIssueType[]; total?: number } | null

    const batch = body?.issueTypes ?? []
    issueTypes.push(...batch)

    if (batch.length < maxResults) break
    if (typeof body?.total === 'number' && issueTypes.length >= body.total) break
    startAt += batch.length
  }

  return issueTypes
}

/**
 * A field on an issue type's CREATE screen, from
 * `GET /issue/createmeta/{project}/issuetypes/{typeId}`.
 *
 * This is the compose panel's whole oracle, and each half answers a different
 * question the panel would otherwise have to guess at:
 *  - PRESENCE answers "is this field even on the create screen": createmeta only
 *    returns fields that are, so an ABSENT `duedate` means a date input would
 *    400 with "Field 'duedate' cannot be set. It is not on the appropriate
 *    screen, or unknown". Detection, never create-and-retry.
 *  - `required` answers "must this push carry a value".
 *  - `allowedValues` answers "can Native Intelligence render it at all": a select-shaped field
 *    becomes a dropdown, a free-text one cannot be answered generically and is
 *    what the panel's required-field wall refuses on.
 *  - `hasDefaultValue` is the escape hatch that makes a required field harmless:
 *    Jira fills it itself, so the create succeeds without us naming it.
 */
export interface JiraCreateMetaField {
  fieldId: string
  name?: string
  required?: boolean
  hasDefaultValue?: boolean
  schema?: { type?: string; custom?: string; customId?: number; items?: string }
  allowedValues?: JiraAllowedValue[]
  operations?: string[]
}

/**
 * `GET /issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}` — every
 * field on THAT project+type's create screen, walked to exhaustion.
 *
 * Paged for real, unlike the issue-type list next door: a custom-field-heavy
 * enterprise project passes 50 fields easily, and a required custom field
 * sitting on page 2 is precisely the one that would 400 the create — so
 * stopping at page 1 would defeat the entire point of asking.
 *
 * Jira's envelope here is `{ fields, startAt, maxResults, total }`; the walk
 * stops on a short page OR on reaching `total`, and never on `isLast` (which
 * this endpoint does not return, unlike /project/search).
 */
export async function listCreateMetaFields(
  accessToken: string,
  cloudId: string,
  projectIdOrKey: string,
  issueTypeId: string,
): Promise<JiraCreateMetaField[]> {
  const fields: JiraCreateMetaField[] = []
  let startAt = 0

  for (let page = 0; page < MAX_CREATEMETA_PAGES; page++) {
    const params = new URLSearchParams()
    params.set('maxResults', String(LIST_MAX_LIMIT))
    params.set('startAt', String(startAt))

    const body = (await jiraFetch(
      accessToken,
      cloudId,
      `/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes/` +
        `${encodeURIComponent(issueTypeId)}?${params.toString()}`,
    )) as { fields?: JiraCreateMetaField[]; total?: number } | null

    const batch = body?.fields ?? []
    fields.push(...batch)

    // A short page is exhaustion. The `total` check is the belt to that
    // suspenders: an endpoint that returned a full page AND reported fewer
    // remaining would otherwise cost a wasted round trip.
    if (batch.length < LIST_MAX_LIMIT) break
    if (typeof body?.total === 'number' && fields.length >= body.total) break
    startAt += batch.length
  }

  return fields
}

/**
 * `GET /user/assignable/search?project={key}&query={text}` — the users who can
 * actually be assigned an issue in this project.
 *
 * The one to reach for over `searchUsers` (which is `/user/search`, the flaky
 * 3LO one used by the best-effort email bridge): this endpoint is
 * PERMISSION-FILTERED to the project, which is what makes it a legitimate picker
 * source rather than a guess.
 *
 * TWO documented traps, both handled here:
 *  - IT UNDER-RETURNS. Atlassian's own docs say it "usually returns fewer users
 *    than specified in maxResults" because the permission filter runs AFTER the
 *    match — so a short page is NOT end-of-results and the walk must not
 *    short-circuit on one. It pages a fixed number of times and stops only on a
 *    genuinely EMPTY page.
 *  - `emailAddress` IS NULLABLE per each user's Atlassian privacy setting while
 *    `accountId` is always populated. Callers render displayName and submit
 *    accountId; email is decorative and absent-tolerant. Users with no accountId
 *    are dropped here — they cannot be assigned to anything.
 */
export async function searchAssignableUsers(
  accessToken: string,
  cloudId: string,
  projectKey: string,
  options: { query?: string; maxResults?: number; maxPages?: number } = {},
): Promise<JiraUser[]> {
  const maxResults = Math.min(options.maxResults ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const maxPages = options.maxPages ?? 3
  const users: JiraUser[] = []
  const seen = new Set<string>()
  let startAt = 0

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams()
    params.set('project', projectKey)
    params.set('maxResults', String(maxResults))
    params.set('startAt', String(startAt))
    // Jira treats an absent `query` as "everyone assignable", which is exactly
    // what the picker wants before the user types. An empty string is NOT the
    // same thing to Jira, so it is omitted rather than sent blank.
    if (options.query) params.set('query', options.query)

    const batch = (await jiraFetch(
      accessToken,
      cloudId,
      `/user/assignable/search?${params.toString()}`,
    )) as JiraUser[] | null

    const rows = Array.isArray(batch) ? batch : []
    for (const user of rows) {
      const accountId = user?.accountId
      if (typeof accountId !== 'string' || accountId.length === 0) continue
      if (seen.has(accountId)) continue
      seen.add(accountId)
      users.push(user)
    }

    // ONLY an empty page ends the walk. A short-but-nonempty one is the
    // documented normal case here and must not be read as exhaustion.
    if (rows.length === 0) break
    startAt += rows.length
  }

  return users
}

/**
 * `GET /project/{projectIdOrKey}/statuses` — every status reachable in a
 * project, grouped BY ISSUE TYPE.
 *
 * The per-issue-type shape is not incidental: in company-managed projects each
 * issue type can carry its own workflow and therefore its own status set. The
 * bucket→status picker wants ONE flat de-duplicated list, so callers fold across
 * the returned issue types by status id (dedupeProjectStatuses below).
 */
export async function listProjectStatuses(
  accessToken: string,
  cloudId: string,
  projectIdOrKey: string,
): Promise<JiraIssueTypeStatuses[]> {
  const data = (await jiraFetch(
    accessToken,
    cloudId,
    `/project/${encodeURIComponent(projectIdOrKey)}/statuses`,
  )) as JiraIssueTypeStatuses[] | null
  return Array.isArray(data) ? data : []
}

/**
 * Flatten `listProjectStatuses` into the distinct statuses of a project,
 * de-duplicated by status id and keeping first-seen order (which is the
 * workflow order of the project's first issue type — a far more useful ordering
 * for a mapping UI than alphabetical).
 */
export function dedupeProjectStatuses(
  groups: JiraIssueTypeStatuses[],
): Array<{ id: string; name: string; category: string | null }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; name: string; category: string | null }> = []
  for (const group of groups) {
    for (const status of group?.statuses ?? []) {
      const id = status?.id
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: typeof status.name === 'string' ? status.name : id,
        category:
          typeof status.statusCategory?.key === 'string' ? status.statusCategory.key : null,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** An Atlassian Document Format node (description bodies). */
export interface AdfNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  content?: AdfNode[]
}

/** The ADF root. `version` is an INTEGER and appears on the doc node only. */
export interface AdfDoc {
  version: 1
  type: 'doc'
  content: AdfNode[]
}

export interface CreateIssueInput {
  fields: {
    /** `{ id }` — resolved from the destination config, never a guessed key. */
    project: { id: string }
    /** `{ id }` — per-project in team-managed projects, so always config-driven. */
    issuetype: { id: string }
    summary: string
    /** ADF, NOT a string — v3 rejects a plain-text description. */
    description?: AdfDoc
    /** Date-only `YYYY-MM-DD`. Screen-gated: may 400 (see jira-push's retry). */
    duedate?: string
    [key: string]: unknown
  }
}

/** `POST /issue` — create one issue. Response is `{ id, key, self }` only. */
export async function createIssue(
  accessToken: string,
  cloudId: string,
  input: CreateIssueInput,
): Promise<JiraIssue> {
  const data = (await jiraFetch(accessToken, cloudId, '/issue', {
    method: 'POST',
    body: JSON.stringify(input),
  })) as JiraIssue
  return data
}

/**
 * `GET /issue/{idOrKey}?fields=…` — current provider-side state.
 *
 * Defaults to `status` because that is the whole read half of the sync: the
 * statusCategory is nested INSIDE `fields.status` (you cannot request
 * `fields=statusCategory`), so `fields=status` is what both the post-create
 * stamp and the read-back fold ask for.
 */
export async function getIssue(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  fields = 'status',
): Promise<JiraIssue> {
  const params = new URLSearchParams({ fields })
  const data = (await jiraFetch(
    accessToken,
    cloudId,
    `/issue/${encodeURIComponent(issueIdOrKey)}?${params.toString()}`,
  )) as JiraIssue
  return data
}

/**
 * `GET /issue/{idOrKey}/transitions?expand=transitions.fields` — the transitions
 * this issue can take RIGHT NOW.
 *
 * Two things the caller must internalize:
 *  - The list is already filtered by the connected user's permissions AND the
 *    workflow's conditions — it "uses the exact same user permissions as the
 *    GUI". A missing transition therefore does NOT prove the workflow lacks an
 *    edge; it may be a permissions gap for THIS connected account.
 *  - `expand=transitions.fields` is what surfaces `fields.resolution` with its
 *    `required` flag and `allowedValues`. Without it a done-transition that
 *    requires a resolution 400s and there is no way to see it coming.
 */
export async function getTransitions(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
): Promise<JiraTransition[]> {
  const body = (await jiraFetch(
    accessToken,
    cloudId,
    `/issue/${encodeURIComponent(issueIdOrKey)}/transitions?expand=transitions.fields`,
  )) as { transitions?: JiraTransition[] } | null
  return body?.transitions ?? []
}

export interface TransitionIssueInput {
  transition: { id: string }
  /** Only fields present on THAT transition's screen may be set here. */
  fields?: Record<string, unknown>
}

/**
 * `POST /issue/{idOrKey}/transitions` — fire one transition. 204 No Content.
 *
 * Concurrent transitions on the SAME issue now answer 409 Conflict (Atlassian's
 * change notice, which explicitly tells integrators to retry). This client does
 * NOT retry the 409 itself — the echo owns that, because only it knows whether
 * the transition it picked is still the right one to replay.
 */
export async function transitionIssue(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  input: TransitionIssueInput,
): Promise<void> {
  await jiraFetch(
    accessToken,
    cloudId,
    `/issue/${encodeURIComponent(issueIdOrKey)}/transitions`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

/**
 * `GET /user/search?query=…` — resolve a person to an accountId.
 *
 * FLAKY BY DESIGN OF THE PLATFORM, and the caller must treat it that way: over
 * OAuth 3LO this endpoint is reported to return an empty array even for users
 * that exist (works with API-token auth, not with 3LO), and `emailAddress` is
 * additionally nullable per each user's Atlassian privacy setting. So an empty
 * result is the EXPECTED outcome, not an error — the push assigns only on an
 * unambiguous single match and otherwise leaves the issue unassigned.
 */
export async function searchUsers(
  accessToken: string,
  cloudId: string,
  query: string,
  options: { maxResults?: number } = {},
): Promise<JiraUser[]> {
  const params = new URLSearchParams({ query })
  params.set('maxResults', String(options.maxResults ?? 10))
  const data = (await jiraFetch(
    accessToken,
    cloudId,
    `/user/search?${params.toString()}`,
  )) as JiraUser[] | null
  return Array.isArray(data) ? data : []
}

/**
 * `PUT /issue/{idOrKey}/assignee` — set the assignee by accountId.
 *
 * accountId ONLY: the GDPR migration removed `name`/`key` from every user-
 * identifying payload in Cloud. Done as a separate call rather than a create
 * field so an assignee failure can never cost us the issue itself.
 */
export async function assignIssue(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  accountId: string,
): Promise<void> {
  await jiraFetch(accessToken, cloudId, `/issue/${encodeURIComponent(issueIdOrKey)}/assignee`, {
    method: 'PUT',
    body: JSON.stringify({ accountId }),
  })
}

/**
 * `DELETE /issue/{idOrKey}` — best-effort cleanup of an issue we should not have
 * created (the push lost the link-row race and orphaned it).
 *
 * NEVER throws, and 403 is a FIRST-CLASS expected outcome here, not an edge
 * case: "Delete Issues" is a separate project permission from create and is
 * commonly locked down, so an account that can push may well not be able to
 * tidy up. Turning that into a push failure would be strictly worse for the
 * user, who ends up correctly linked either way — just with one stray issue.
 */
export async function deleteIssue(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
): Promise<void> {
  try {
    await jiraFetch(accessToken, cloudId, `/issue/${encodeURIComponent(issueIdOrKey)}`, {
      method: 'DELETE',
    })
  } catch (err) {
    // 404 → already deleted / never existed: the desired end-state holds.
    if (isJiraNotFound(err)) return
    console.warn(
      `[jira-api] deleteIssue failed for ${issueIdOrKey} (best-effort cleanup) —`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ---------------------------------------------------------------------------
// Dynamic webhooks (Jira → Native Intelligence read-back)
// ---------------------------------------------------------------------------

/**
 * One subscription inside a registration request.
 *
 * `jqlFilter` is REQUIRED by the schema even where it has no effect, and only a
 * restricted JQL subset is accepted (`project`, `issueKey`, `issuetype`,
 * `status`, `priority`, `assignee`, `reporter`, `issue.property`, with
 * `= != IN NOT IN` only). `project = {id}` is inside that subset.
 *
 * `fieldIdsFilter: ['status']` is what turns `jira:issue_updated` from "every
 * edit of every issue in the project" into "the changelog touched status" — the
 * only change this integration reads back. It has no effect on
 * `jira:issue_deleted`, which carries no changelog.
 */
export interface JiraWebhookSubscription {
  events: string[]
  jqlFilter: string
  fieldIdsFilter?: string[]
  issuePropertyKeysFilter?: string[]
}

export interface RegisterWebhooksInput {
  /** Absolute https URL. ONE url per app — Atlassian's own schema says so. */
  url: string
  webhooks: JiraWebhookSubscription[]
}

/**
 * One entry of the registration response, positionally matched to the request.
 * Exactly one of the two is present — PARTIAL SUCCESS IS NORMAL (an unsupported
 * JQL clause fails its own entry and leaves the others registered), so callers
 * must read each element rather than assume all-or-nothing.
 */
export interface JiraWebhookRegistrationResult {
  createdWebhookId?: number
  errors?: string[]
}

/** A registered webhook as `GET /webhook` reports it. */
export interface JiraRegisteredWebhook {
  id?: number
  url?: string
  events?: string[]
  jqlFilter?: string
  fieldIdsFilter?: string[]
  /** Epoch MILLISECONDS. 30 days out from create/refresh. */
  expirationDate?: number
}

/**
 * `POST /webhook` — register dynamic webhooks for THIS app + connected user.
 *
 * 403 when the caller "isn't an app" (i.e. the token isn't an OAuth 2.0 app
 * token) — surfaced as a plain JiraApiError, since there is no recovery from it
 * at runtime.
 */
export async function registerWebhooks(
  accessToken: string,
  cloudId: string,
  input: RegisterWebhooksInput,
): Promise<JiraWebhookRegistrationResult[]> {
  const body = (await jiraFetch(accessToken, cloudId, '/webhook', {
    method: 'POST',
    body: JSON.stringify(input),
  })) as { webhookRegistrationResult?: JiraWebhookRegistrationResult[] } | null
  return body?.webhookRegistrationResult ?? []
}

/**
 * `GET /webhook` — one page of the webhooks this app registered FOR THIS USER
 * on this site.
 *
 * Scoped to (app, user, tenant), which is also how the 5-webhook cap is
 * counted, so the list is short by construction. Offset-paginated like every
 * other Jira list.
 */
export async function listWebhooks(
  accessToken: string,
  cloudId: string,
  options: { startAt?: number; maxResults?: number } = {},
): Promise<{ webhooks: JiraRegisteredWebhook[]; isLast: boolean; nextStartAt: number | null }> {
  const params = new URLSearchParams()
  params.set('startAt', String(options.startAt ?? 0))
  params.set('maxResults', String(Math.min(options.maxResults ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)))

  const body = (await jiraFetch(accessToken, cloudId, `/webhook?${params.toString()}`)) as {
    values?: JiraRegisteredWebhook[]
    isLast?: boolean
    startAt?: number
  } | null

  const webhooks = body?.values ?? []
  const isLast = body?.isLast ?? true
  const startAt = body?.startAt ?? options.startAt ?? 0
  return { webhooks, isLast, nextStartAt: isLast ? null : startAt + webhooks.length }
}

/**
 * `PUT /webhook/refresh` — push the expiry of registered webhooks out 30 days.
 *
 * A dynamic webhook EXPIRES 30 days after creation or its last refresh and then
 * goes inactive (recoverable for a further 3 months). Refreshing is strictly
 * cheaper than re-registering: it keeps the id, so nothing has to be persisted,
 * and it doesn't churn the 5-per-app-per-user-per-tenant cap.
 *
 * "Unrecognized webhook IDs (those that are not found or belong to other apps)
 * are ignored" — so a stale id is a silent no-op, not an error. The response
 * carries ONE `expirationDate` covering every id in the call.
 */
export async function refreshWebhooks(
  accessToken: string,
  cloudId: string,
  webhookIds: number[],
): Promise<{ expirationDate: number | null }> {
  const body = (await jiraFetch(accessToken, cloudId, '/webhook/refresh', {
    method: 'PUT',
    body: JSON.stringify({ webhookIds }),
  })) as { expirationDate?: number } | null
  const expirationDate = body?.expirationDate
  return { expirationDate: typeof expirationDate === 'number' ? expirationDate : null }
}

/**
 * `DELETE /webhook` — best-effort teardown. NEVER throws, mirroring
 * deleteIssue: every caller is either re-registering or disconnecting, and a
 * failed tidy-up must not stop that.
 *
 * "Only webhooks registered by the calling app are removed. If webhooks created
 * by other apps are specified, they are ignored" — so a superset/stale id list
 * is safe. 202 Accepted: the removal is ASYNC and may still show up in a
 * subsequent GET, which is why convergence keys off our own stored id rather
 * than off the absence of a deleted one.
 */
export async function deleteWebhooks(
  accessToken: string,
  cloudId: string,
  webhookIds: number[],
): Promise<void> {
  if (webhookIds.length === 0) return
  try {
    await jiraFetch(accessToken, cloudId, '/webhook', {
      method: 'DELETE',
      body: JSON.stringify({ webhookIds }),
    })
  } catch (err) {
    if (isJiraNotFound(err)) return
    console.warn(
      `[jira-api] deleteWebhooks failed for [${webhookIds.join(',')}] (best-effort teardown) —`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Read the status name off an issue payload, or null. */
export function issueStatusName(issue: JiraIssue | null | undefined): string | null {
  const name = issue?.fields?.status?.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

/** Read the STABLE statusCategory key off an issue payload, or null. */
export function issueStatusCategoryKey(issue: JiraIssue | null | undefined): string | null {
  const key = issue?.fields?.status?.statusCategory?.key
  return typeof key === 'string' && key.length > 0 ? key : null
}
