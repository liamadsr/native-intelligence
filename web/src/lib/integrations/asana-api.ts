/**
 * Asana API v1.0 HTTP client.
 *
 * Thin wrapper over the Asana public API used by the action push
 * (src/lib/tasks/asana-push.ts), the Native Intelligence→Asana status echo
 * (src/lib/inngest/asana-echo-status.ts), and the destination picker routes
 * (/api/account/asana/*).
 *
 * Two Asana conventions shape everything below:
 *  - EVERY request and response wraps its payload in a top-level `data` key.
 *    asanaFetch unwraps it, so callers see the payload directly and POST/PUT
 *    helpers wrap their bodies on the way out.
 *  - Errors come back as `{ errors: [{ message, help? }] }`, NOT a bare string.
 *
 * Auth is a bearer access token (60-min TTL) minted by the OAuth stack; the
 * caller is responsible for refreshing via the token-manager between calls.
 */

const ASANA_BASE = 'https://app.asana.com/api/1.0'

/**
 * Thrown when Asana returns 401. Distinct from a generic error so the caller
 * can mark the link/account as needing a reconnect rather than retrying (the
 * token-manager owns refresh; this client never refreshes mid-request).
 */
export class AsanaUnauthorizedError extends Error {
  readonly code = 'ASANA_UNAUTHORIZED'
  constructor(message = 'Asana returned 401 Unauthorized') {
    super(message)
    this.name = 'AsanaUnauthorizedError'
  }
}

/**
 * Thrown when a gid is not a shape that can safely be interpolated into a path.
 *
 * Mirrors Jira's JiraInvalidIdentifierError, and exists for the same reason:
 * every helper below builds its URL as `/workspaces/${gid}/...`, so a gid
 * carrying `/`, `?`, `#` or `..` does not fail — it silently re-points the
 * request at a DIFFERENT Asana endpoint under the workspace's own token. The
 * routes upstream only know the value is a non-empty string, which is why the
 * check lives here at the client rather than being repeated per route.
 */
export class AsanaInvalidGidError extends Error {
  readonly code = 'ASANA_INVALID_GID'
  readonly field: string
  constructor(field: string, value: unknown) {
    super(`Invalid Asana ${field}: ${typeof value === 'string' ? value : typeof value}`)
    this.name = 'AsanaInvalidGidError'
    this.field = field
  }
}

/**
 * A gid as Asana mints them: a decimal integer string.
 *
 * Matched loosely (word characters and dashes) rather than digits-only so a
 * future Asana format change doesn't lock every workspace out — but strictly
 * enough that nothing matching can carry a path separator, a query, a fragment
 * or a traversal segment, which is the whole security property.
 */
const GID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidAsanaGid(value: unknown): value is string {
  return typeof value === 'string' && GID_PATTERN.test(value)
}

/**
 * Throw unless `value` is a safely-interpolatable gid, and hand it back so it
 * can be used inline at the point of interpolation — the only place a caller
 * should be reaching for it.
 */
export function assertAsanaGid(field: string, value: unknown): string {
  if (!isValidAsanaGid(value)) throw new AsanaInvalidGidError(field, value)
  return value
}

/** Generic non-2xx (non-401) failure, carrying the HTTP status. */
export class AsanaApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AsanaApiError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Minimal response shapes (only what we consume)
// ---------------------------------------------------------------------------

/** Every Asana resource carries at least a gid; most carry a name. */
export interface AsanaNamedResource {
  gid: string
  name: string
}

export interface AsanaTask {
  gid: string
  name?: string
  completed?: boolean
  permalink_url?: string
}

/** Offset paging envelope on list endpoints. */
interface AsanaNextPage {
  offset?: string
  path?: string
  uri?: string
}

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 1000

/**
 * The longest `Retry-After` this client will actually sleep for.
 *
 * Same ceiling, and the same reasoning, as the Jira client's MAX_RETRY_AFTER_MS:
 * a long Retry-After is a REAL answer from a rate limiter, and sleeping it holds
 * a Vercel function until maxDuration kills it (a user-facing route becomes a
 * hung spinner, then a 504) or blows an Inngest step timeout mid-page, losing
 * the walk and its cursor. Past this we throw the retryable AsanaApiError(429)
 * and let the caller's own backoff — Inngest's, for every background path — own
 * the wait.
 */
const MAX_RETRY_AFTER_MS = 60_000

/** Test-seam: overridable so fake timers don't have to advance real sleeps. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse Asana's `{ errors: [{ message }] }` body into a single message. Falls
 * back to the raw text (truncated) when the body isn't the documented shape.
 */
function describeErrorBody(raw: string): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { errors?: Array<{ message?: string }> }
    const messages = (parsed?.errors ?? [])
      .map((e) => e?.message)
      .filter((m): m is string => !!m)
    if (messages.length > 0) return messages.join('; ')
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return raw.slice(0, 300)
}

/**
 * Core transport. Returns the FULL response body (envelope intact) so the
 * offset-paged list endpoints can read `next_page.offset`; asanaFetch below is
 * the unwrapping wrapper everything else uses.
 *
 * - Bearer auth from `accessToken`.
 * - 429: Asana ALWAYS sends a `Retry-After` header (seconds) — honor it rather
 *   than guessing (this is the one place Asana is friendlier than HubSpot,
 *   whose 429s carry only a policyName). Falls back to an exponential schedule
 *   (1s, 2s) plus jitter when the header is missing/unparseable, and refuses to
 *   sleep past MAX_RETRY_AFTER_MS. Capped at MAX_ATTEMPTS total requests, then
 *   throws AsanaApiError(429).
 * - 401: throw AsanaUnauthorizedError (caller reconnects / marks the link).
 * - other non-2xx: throw AsanaApiError with the status + parsed error message.
 */
async function asanaRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${ASANA_BASE}${path}`

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
      if (attempt >= MAX_ATTEMPTS) {
        throw new AsanaApiError(
          429,
          `Asana rate limited after ${attempt} attempts ${path}`,
        )
      }
      // Honor Retry-After (seconds). Only fall back to exponential backoff when
      // the header is absent or not a positive number.
      const retryAfter = Number(res.headers?.get?.('retry-after'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * 2 ** (attempt - 1)

      // A reset far enough out is not something to sleep on inside a request or
      // an Inngest step — see MAX_RETRY_AFTER_MS.
      if (waitMs > MAX_RETRY_AFTER_MS) {
        throw new AsanaApiError(
          429,
          `Asana rate limited with Retry-After ${retryAfter}s (over the ` +
            `${MAX_RETRY_AFTER_MS / 1000}s cap) ${path}`,
        )
      }

      const jitter = Math.floor(Math.random() * 250)
      await sleep(waitMs + jitter)
      continue
    }

    if (res.status === 401) {
      throw new AsanaUnauthorizedError()
    }

    if (!res.ok) {
      let detail = ''
      try {
        detail = describeErrorBody(await res.text())
      } catch {
        // ignore — the status is the useful part
      }
      throw new AsanaApiError(
        res.status,
        `Asana request failed (${res.status}) ${path}${detail ? `: ${detail}` : ''}`,
      )
    }

    // 204 No Content — return null rather than blow up on json().
    if (res.status === 204) return null
    return res.json()
  }
}

/**
 * The call every helper below uses: asanaRequest plus the top-level `data`
 * unwrap that Asana wraps every payload in. Returns null on an empty/204 body.
 */
export async function asanaFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const body = (await asanaRequest(accessToken, path, init)) as { data?: unknown } | null
  return body?.data ?? null
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface AsanaUser {
  gid: string
  name?: string
  email?: string
}

/** `GET /users/me` — the connecting user (used by the OAuth callback). */
export async function getMe(accessToken: string): Promise<AsanaUser> {
  return (await asanaFetch(accessToken, '/users/me')) as AsanaUser
}

// ---------------------------------------------------------------------------
// Pickers (destination config)
// ---------------------------------------------------------------------------

/** `GET /workspaces` — every workspace/organization the token can see. */
export async function listWorkspaces(accessToken: string): Promise<AsanaNamedResource[]> {
  const data = (await asanaFetch(
    accessToken,
    '/workspaces?opt_fields=gid,name',
  )) as AsanaNamedResource[] | null
  return data ?? []
}

/** Max page size Asana's list endpoints accept. */
export const LIST_MAX_LIMIT = 100

/**
 * `GET /workspaces/{gid}/projects` — one page of non-archived projects.
 *
 * Asana pages with an OPAQUE offset cursor (`next_page.offset`), not a page
 * number: pass the previous response's offset back to advance. Absent
 * next_page → the listing is exhausted. The cursor lives OUTSIDE the `data`
 * envelope, so this is the one helper that reads the raw body (asanaRequest)
 * rather than the unwrapped asanaFetch.
 */
export async function listProjects(
  accessToken: string,
  workspaceGid: string,
  options: { offset?: string; limit?: number } = {},
): Promise<{ projects: AsanaNamedResource[]; nextOffset: string | null }> {
  const limit = Math.min(options.limit ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('archived', 'false')
  params.set('opt_fields', 'gid,name')
  if (options.offset) params.set('offset', options.offset)

  const body = (await asanaRequest(
    accessToken,
    `/workspaces/${assertAsanaGid('workspaceGid', workspaceGid)}/projects?${params.toString()}`,
  )) as { data?: AsanaNamedResource[]; next_page?: AsanaNextPage | null }

  return {
    projects: body?.data ?? [],
    nextOffset: body?.next_page?.offset ?? null,
  }
}

/**
 * `GET /workspaces/{gid}/typeahead` — recency-ordered project search.
 *
 * SINGLE page by design (Asana's typeahead has no cursor) and ordered by the
 * user's own recency, which is exactly what search-as-you-type wants: the
 * project they touched last hour beats the alphabetically-first one.
 */
export async function typeaheadProjects(
  accessToken: string,
  workspaceGid: string,
  query: string,
  options: { limit?: number } = {},
): Promise<AsanaNamedResource[]> {
  const params = new URLSearchParams()
  params.set('resource_type', 'project')
  params.set('query', query)
  params.set('opt_fields', 'gid,name')
  if (options.limit) params.set('count', String(options.limit))

  const data = (await asanaFetch(
    accessToken,
    `/workspaces/${assertAsanaGid('workspaceGid', workspaceGid)}/typeahead?${params.toString()}`,
  )) as AsanaNamedResource[] | null
  return data ?? []
}

/**
 * `GET /workspaces/{gid}/users` — one page of the workspace's members.
 *
 * The AUTHORITATIVE listing, and deliberately the one used when the picker has
 * no query: Asana's typeahead next door is explicitly documented as optimized
 * for speed over completeness, so "who is in this workspace" is answered here
 * and "what did they just type" is answered there.
 *
 * `email` must be requested EXPLICITLY via opt_fields (Asana returns the compact
 * `gid`+`resource_type` form otherwise) and can still come back null for guests
 * or restricted-visibility members — so it is decorative in the picker and
 * identity is always the `gid`.
 */
export async function listWorkspaceUsers(
  accessToken: string,
  workspaceGid: string,
  options: { offset?: string; limit?: number } = {},
): Promise<{ users: AsanaUser[]; nextOffset: string | null }> {
  const limit = Math.min(options.limit ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('opt_fields', 'gid,name,email')
  if (options.offset) params.set('offset', options.offset)

  const body = (await asanaRequest(
    accessToken,
    `/workspaces/${assertAsanaGid('workspaceGid', workspaceGid)}/users?${params.toString()}`,
  )) as { data?: AsanaUser[]; next_page?: AsanaNextPage | null }

  return {
    users: body?.data ?? [],
    nextOffset: body?.next_page?.offset ?? null,
  }
}

/**
 * `GET /workspaces/{gid}/typeahead?resource_type=user` — fuzzy user search.
 *
 * SINGLE page by design (Asana's typeahead has no cursor) and ranked by the
 * connected user's own assignment/collaboration recency, which is what
 * search-as-you-type wants.
 *
 * NOT AUTHORITATIVE, by Asana's own documentation: it warns the endpoint trades
 * accuracy for speed. So it drives the interactive filter only — validation and
 * the pre-typing list come from listWorkspaceUsers above.
 */
export async function typeaheadUsers(
  accessToken: string,
  workspaceGid: string,
  query: string,
  options: { limit?: number } = {},
): Promise<AsanaUser[]> {
  const params = new URLSearchParams()
  params.set('resource_type', 'user')
  params.set('query', query)
  params.set('opt_fields', 'gid,name,email')
  if (options.limit) params.set('count', String(options.limit))

  const data = (await asanaFetch(
    accessToken,
    `/workspaces/${assertAsanaGid('workspaceGid', workspaceGid)}/typeahead?${params.toString()}`,
  )) as AsanaUser[] | null
  return data ?? []
}

/** `GET /projects/{gid}/sections` — the project's board columns / list sections. */
export async function listSections(
  accessToken: string,
  projectGid: string,
): Promise<AsanaNamedResource[]> {
  const data = (await asanaFetch(
    accessToken,
    `/projects/${assertAsanaGid('projectGid', projectGid)}/sections?opt_fields=gid,name`,
  )) as AsanaNamedResource[] | null
  return data ?? []
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Fields we always ask Asana to echo back on a task read/create. */
export const TASK_OPT_FIELDS = 'gid,permalink_url,completed,name'

export interface CreateTaskInput {
  /** Task title. */
  name: string
  /**
   * Project placement. Asana requires a create to resolve to EXACTLY ONE
   * workspace, which `projects` (or `memberships`) supplies implicitly.
   * Pass `memberships` when a section is mapped for the action's bucket,
   * otherwise `projects` — never both.
   */
  projects?: string[]
  memberships?: Array<{ project: string; section: string }>
  /**
   * HTML body. Asana accepts a small HTML subset and REQUIRES a `<body>`
   * wrapper. Mutually exclusive with `notes` — send one, never both.
   */
  html_notes?: string
  notes?: string
  /** Date-only due date (YYYY-MM-DD). Mutually exclusive with due_at. */
  due_on?: string
  /** Datetime due date (ISO 8601). Mutually exclusive with due_on. */
  due_at?: string
  /** A user gid OR a plain email address — Asana resolves both. */
  assignee?: string
}

/**
 * `POST /tasks` — create one task, asking for the fields we persist on the link
 * row (`permalink_url` above all: it's the only user-facing deep link).
 *
 * Throws AsanaUnauthorizedError on 401 and AsanaApiError otherwise. A 4xx caused
 * by an unresolvable `assignee` is the caller's to handle (asana-push retries
 * once without the assignee) — this client stays dumb about it.
 */
export async function createTask(
  accessToken: string,
  input: CreateTaskInput,
): Promise<AsanaTask> {
  const data = (await asanaFetch(
    accessToken,
    `/tasks?opt_fields=${TASK_OPT_FIELDS}`,
    { method: 'POST', body: JSON.stringify({ data: input }) },
  )) as AsanaTask
  return data
}

/**
 * `PUT /tasks/{gid}` — set the completion flag.
 *
 * This is the whole Native Intelligence→Asana lifecycle write: Asana has no status field, so
 * both 'done' and 'canceled' land as completed:true (see
 * src/lib/tasks/lifecycle.ts for why canceled is unrepresentable).
 */
export async function updateTaskCompleted(
  accessToken: string,
  taskGid: string,
  completed: boolean,
): Promise<AsanaTask> {
  const data = (await asanaFetch(
    accessToken,
    `/tasks/${taskGid}?opt_fields=${TASK_OPT_FIELDS}`,
    { method: 'PUT', body: JSON.stringify({ data: { completed } }) },
  )) as AsanaTask
  return data
}

/**
 * `POST /sections/{gid}/addTask` — move an existing task into a section.
 *
 * Section placement at CREATE time goes through `memberships` on createTask;
 * this is the move path used by the status echo when the action changes bucket.
 */
export async function addTaskToSection(
  accessToken: string,
  sectionGid: string,
  taskGid: string,
): Promise<void> {
  await asanaFetch(accessToken, `/sections/${assertAsanaGid('sectionGid', sectionGid)}/addTask`, {
    method: 'POST',
    body: JSON.stringify({ data: { task: taskGid } }),
  })
}

/**
 * `DELETE /tasks/{gid}` — best-effort cleanup of a task we should not have
 * created (the push lost the link-row race and orphaned it).
 *
 * NEVER throws: this only ever runs on a path that is already resolving to a
 * successful "you're linked" answer, and turning a tidy-up failure into a push
 * failure would be strictly worse for the caller. Mirrors hubspot-api's
 * archiveContact — 404 is the desired end-state, everything else is logged.
 */
export async function deleteTask(accessToken: string, taskGid: string): Promise<void> {
  try {
    await asanaFetch(accessToken, `/tasks/${taskGid}`, { method: 'DELETE' })
  } catch (err) {
    // 404 → already deleted / never existed: the desired end-state holds.
    if (err instanceof AsanaApiError && err.status === 404) return
    console.warn(
      `[asana-api] deleteTask failed for ${taskGid} (best-effort cleanup) —`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** `GET /tasks/{gid}` — current provider-side state of one task. */
export async function getTask(accessToken: string, taskGid: string): Promise<AsanaTask> {
  const data = (await asanaFetch(
    accessToken,
    `/tasks/${taskGid}?opt_fields=${TASK_OPT_FIELDS}`,
  )) as AsanaTask
  return data
}

// ---------------------------------------------------------------------------
// Webhooks (Phase B — Asana → Native Intelligence read-back)
// ---------------------------------------------------------------------------

/** One event filter on a webhook registration. */
export interface AsanaWebhookFilter {
  resource_type: string
  action: string
  /** Only deliver when one of these fields changed (action 'changed' only). */
  fields?: string[]
}

/** A registered webhook as Asana reports it. */
export interface AsanaWebhook {
  gid: string
  /** The watched resource — compact (`{gid, resource_type}`) on a GET. */
  resource?: { gid?: string; resource_type?: string } | string
  /** The URL Asana delivers to — our receiver, including the syncStateId. */
  target?: string
  active?: boolean
}

export interface CreateWebhookInput {
  /** Resource gid to watch. We always watch a PROJECT. */
  resource: string
  /** Absolute https URL Asana POSTs deliveries to. */
  target: string
  filters?: AsanaWebhookFilter[]
}

/** Fields we ask Asana to echo back on a webhook read/create. */
const WEBHOOK_OPT_FIELDS = 'gid,active,resource,resource.gid,target'

/**
 * `POST /webhooks` — register a webhook.
 *
 * CONCURRENT HANDSHAKE: this call BLOCKS until Asana has POSTed an
 * `X-Hook-Secret` challenge to `target` and our receiver has echoed that header
 * back with a 200. Only then does this return 201 + the webhook gid. So the
 * receiver route must already be live and reachable when this runs, and the
 * secret is persisted by the RECEIVER (see the handshake CAS in
 * src/app/api/webhooks/asana/[syncStateId]/route.ts), not from the response
 * here — Asana never repeats the secret in this body.
 */
export async function createWebhook(
  accessToken: string,
  input: CreateWebhookInput,
): Promise<AsanaWebhook> {
  const data = (await asanaFetch(
    accessToken,
    `/webhooks?opt_fields=${WEBHOOK_OPT_FIELDS}`,
    { method: 'POST', body: JSON.stringify({ data: input }) },
  )) as AsanaWebhook
  return data
}

/**
 * `GET /webhooks/{gid}` — liveness probe for a registration we already own.
 *
 * Returns null on 404 rather than throwing: a webhook Asana has garbage-
 * collected (the watched project was deleted, or the app was disconnected) is
 * the single most expected outcome here, and the caller's response is to
 * re-create rather than to fail the run.
 */
export async function getWebhook(
  accessToken: string,
  webhookGid: string,
): Promise<AsanaWebhook | null> {
  try {
    const data = (await asanaFetch(
      accessToken,
      `/webhooks/${webhookGid}?opt_fields=${WEBHOOK_OPT_FIELDS}`,
    )) as AsanaWebhook | null
    return data ?? null
  } catch (err) {
    if (err instanceof AsanaApiError && err.status === 404) return null
    throw err
  }
}

/**
 * `DELETE /webhooks/{gid}` — best-effort teardown. NEVER throws, mirroring
 * deleteTask: every caller is already on its way to re-registering, and a
 * failed tidy-up must not stop that (a stale webhook delivers to a receiver
 * whose sync state has no matching gid, which is itself a clean no-op).
 */
export async function deleteWebhook(accessToken: string, webhookGid: string): Promise<void> {
  try {
    await asanaFetch(accessToken, `/webhooks/${webhookGid}`, { method: 'DELETE' })
  } catch (err) {
    // 404 → already gone: the desired end-state holds.
    if (err instanceof AsanaApiError && err.status === 404) return
    console.warn(
      `[asana-api] deleteWebhook failed for ${webhookGid} (best-effort teardown) —`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Read the watched resource gid off a webhook, whatever shape it came in. */
export function webhookResourceGid(webhook: AsanaWebhook | null | undefined): string | null {
  const resource = webhook?.resource
  if (typeof resource === 'string') return resource || null
  const gid = resource?.gid
  return typeof gid === 'string' && gid.length > 0 ? gid : null
}
