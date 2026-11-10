/**
 * Linear GraphQL API client (OAuth 2.0).
 *
 * Thin wrapper over Linear's single endpoint, used by the action push
 * (src/lib/tasks/linear-push.ts), the Native Intelligence→Linear status echo and the
 * destination picker routes (/api/account/linear/*).
 *
 * Sibling of jira-api.ts and asana-api.ts, and structurally the SIMPLEST of the
 * three. Four differences shape everything below:
 *
 *  - **ONE URL for everybody.** There is no per-tenant hostname and no gateway
 *    path to build, so every function takes `(accessToken, …)` — no cloudId
 *    argument, and none of jira-api's identifier-validation machinery, because
 *    nothing is ever interpolated into a URL. Ids travel as GraphQL VARIABLES,
 *    which are transported as JSON and cannot break out of anything.
 *  - **HTTP 200 is not success.** GraphQL reports application errors in an
 *    `errors[]` array with a 200 status, so the transport has to inspect the
 *    body on the happy path too. `linearGraphQL` is the single place that
 *    happens.
 *  - **Rate limiting is DUAL-MODE.** The documented 429 exists, but Linear also
 *    answers a rate-limited request with HTTP 400 and
 *    `errors[].extensions.code === 'RATELIMITED'`. Detecting only the first
 *    would turn a throttle into a hard failure — see isRateLimitedBody.
 *  - **Queries are budgeted by COMPLEXITY, not just count** (2M points/hour,
 *    10k per query). Every query here is deliberately SHALLOW — one level of
 *    nesting, explicit `first:` on every connection. Never nest
 *    teams → projects → issues in one call to save a round trip; that trade goes
 *    the wrong way here.
 *
 * Auth is a bearer access token (~24h TTL) minted by the OAuth stack; the caller
 * refreshes via the token-manager between calls. Because 24h is long, a 401 here
 * is a genuinely rare event rather than the routine mid-flight expiry Jira's
 * 1-hour tokens produce.
 */

/** Linear's one and only API endpoint. */
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'

/** OAuth token revocation — used by the disconnect path, best-effort. */
const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke'

/**
 * Thrown when Linear rejects the credentials: HTTP 401, or the 403 that a token
 * missing a scope produces.
 *
 * Both fold into ONE error because they have one fix from the user's side —
 * reconnect — and because Linear does not distinguish them reliably (a
 * scope-less mutation can answer either). The caller marks the link/account
 * rather than retrying; this client never refreshes mid-request.
 */
export class LinearUnauthorizedError extends Error {
  readonly code = 'LINEAR_UNAUTHORIZED'
  readonly status: number
  constructor(status = 401, message = 'Linear rejected the access token') {
    super(message)
    this.name = 'LinearUnauthorizedError'
    this.status = status
  }
}

/** One entry of a GraphQL `errors[]` array (only the fields we consume). */
export interface LinearGraphQLError {
  message?: string
  path?: Array<string | number>
  extensions?: {
    /** Linear's stable machine code — 'RATELIMITED', 'INVALID_INPUT', … */
    code?: string
    type?: string
    [key: string]: unknown
  }
}

/**
 * Generic failure, carrying the HTTP status AND the raw GraphQL errors array.
 *
 * `graphQLErrors` is the load-bearing half, exactly as `fieldErrors` is on
 * JiraApiError: the push branches on whether Linear rejected the INPUT (in which
 * case retrying with optional fields stripped can succeed) versus anything else,
 * and `extensions.code` is the stable part of that judgement — the messages are
 * human prose.
 *
 * `status` is 200 for a GraphQL-level error, which is not a bug: it records what
 * HTTP actually said, and callers that care about transport health check
 * `graphQLErrors.length` instead.
 */
export class LinearApiError extends Error {
  readonly status: number
  readonly graphQLErrors: LinearGraphQLError[]
  constructor(status: number, message: string, graphQLErrors: LinearGraphQLError[] = []) {
    super(message)
    this.name = 'LinearApiError'
    this.status = status
    this.graphQLErrors = graphQLErrors
  }
}

/**
 * Did Linear reject this request's INPUT (as opposed to failing transiently)?
 *
 * The signal the push's strip-optionals retry keys off. Anything else (a
 * timeout, a 5xx dressed as a GraphQL error) must NOT be "recovered" by dropping
 * fields, because the fields were never the problem.
 *
 * CLASSIFY ON `type` AND `userError`, NOT ON `code` ALONE. Linear's machine
 * codes are not stable across error families — the entity-not-found rejection a
 * stale project or state id produces (precisely what the retry exists for)
 * carries code 'INPUT_ERROR', while an argument-validation failure carries
 * 'INVALID_INPUT'; both carry `type: 'invalid input'` and `userError: true`.
 * Keying on the code set alone silently missed the not-found class entirely, so
 * a deleted project turned every push into a hard 500 instead of a retry. The
 * codes are kept as an additional accept, never as the only one.
 */
const INPUT_ERROR_CODES = new Set([
  'INVALID_INPUT',
  'INPUT_ERROR',
  'BAD_USER_INPUT',
  'ARGUMENT_VALIDATION_ERROR',
  'FEATURE_NOT_ACCESSIBLE',
])

/** Linear's `extensions.type` values that mean "you sent something bad". */
const INPUT_ERROR_TYPES = new Set(['invalid input', 'user error', 'feature not accessible'])

export function isLinearInputError(err: unknown): boolean {
  // The status gate keeps rate-limit and transport failures out: those surface
  // as 400/429/5xx, never as a GraphQL-level 200-with-errors.
  if (!(err instanceof LinearApiError) || err.status !== 200) return false
  return err.graphQLErrors.some((e) => {
    const ext = e?.extensions
    if (!ext) return false
    if (typeof ext.code === 'string' && INPUT_ERROR_CODES.has(ext.code)) return true
    if (typeof ext.type === 'string' && INPUT_ERROR_TYPES.has(ext.type.toLowerCase())) return true
    // `userError: true` is Linear's own "the caller is at fault" flag — the one
    // the official SDK derives InvalidInputLinearError from.
    return ext.userError === true
  })
}

/** True when `err` is Linear's non-429 rate-limit shape (HTTP 400 + RATELIMITED). */
export function isLinearRateLimited(err: unknown): boolean {
  if (!(err instanceof LinearApiError)) return false
  return err.graphQLErrors.some((e) => e?.extensions?.code === 'RATELIMITED')
}

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 1000

/**
 * The longest `Retry-After` this client will actually sleep for.
 *
 * Same ceiling and same reasoning as jira-api's: Linear's request quota resets
 * on a rolling hour, so a large Retry-After is possible, and sleeping it would
 * hold a Vercel function until maxDuration kills it (a picker route becomes a
 * hung spinner then a 504) or blow an Inngest step timeout. Past the cap we
 * throw the retryable error and let the caller's own backoff — Inngest's, for
 * every background path — own the wait.
 */
const MAX_RETRY_AFTER_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Pull the `errors` array out of a parsed GraphQL body, defensively. */
function graphQLErrorsOf(body: unknown): LinearGraphQLError[] {
  const errors = (body as { errors?: unknown } | null)?.errors
  return Array.isArray(errors) ? (errors as LinearGraphQLError[]) : []
}

/** Flatten a GraphQL errors array into one human message. */
function describeGraphQLErrors(errors: LinearGraphQLError[]): string {
  const parts = errors
    .map((e) => (typeof e?.message === 'string' ? e.message : ''))
    .filter((m) => m.length > 0)
  return parts.join('; ')
}

/**
 * Core transport: POST one GraphQL operation, return `data`.
 *
 * The retry/error rules, in the order they are applied — HTTP STATUS FIRST,
 * because a 401 dressed as a GraphQL error and a 401 from the edge are the same
 * fact and only the status is always present:
 *  - 401/403 → LinearUnauthorizedError (caller reconnects / marks the link).
 *  - 429 → honor `Retry-After` (seconds) up to the cap, else exponential
 *    backoff with jitter; MAX_ATTEMPTS then throws a retryable LinearApiError.
 *  - 400 carrying `extensions.code === 'RATELIMITED'` → the SAME retry path.
 *    This is the mode Linear actually uses most, and treating it as a plain 400
 *    would surface a throttle as a permanent input error.
 *  - other 5xx → transient, retried on the same schedule.
 *  - other non-2xx → LinearApiError with the status and any errors array.
 *  - 200 WITH `errors[]` → LinearApiError(200, …). Not retried here: whether it
 *    is recoverable depends on the operation (a create can retry without
 *    optional fields, an update cannot), so the caller decides.
 */
export async function linearGraphQL<T = unknown>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let attempt = 0
  while (true) {
    const res = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })

    // Credentials first: nothing below can be interpreted without them.
    if (res.status === 401 || res.status === 403) {
      throw new LinearUnauthorizedError(
        res.status,
        `Linear returned ${res.status} — the access token was rejected`,
      )
    }

    // The body is needed for BOTH the 400-RATELIMITED check and the 200-with-
    // errors check, so read it once here rather than in two branches.
    let body: unknown = null
    let rawText = ''
    try {
      rawText = await res.text()
      body = rawText ? JSON.parse(rawText) : null
    } catch {
      // Not JSON — `body` stays null and the status carries the meaning.
    }
    const errors = graphQLErrorsOf(body)

    const rateLimited =
      res.status === 429 ||
      (res.status === 400 && errors.some((e) => e?.extensions?.code === 'RATELIMITED'))
    const transient = res.status >= 500

    if (rateLimited || transient) {
      attempt++
      if (attempt >= MAX_ATTEMPTS) {
        throw new LinearApiError(
          res.status,
          `Linear ${rateLimited ? 'rate limited' : 'unavailable'} after ${attempt} attempts`,
          errors,
        )
      }
      const retryAfter = Number(res.headers?.get?.('retry-after'))
      const honoured = Number.isFinite(retryAfter) && retryAfter > 0
      const waitMs = honoured ? retryAfter * 1000 : BASE_BACKOFF_MS * 2 ** (attempt - 1)

      // A reset a long way out is not something to sleep on inside a request or
      // an Inngest step — see MAX_RETRY_AFTER_MS.
      if (waitMs > MAX_RETRY_AFTER_MS) {
        throw new LinearApiError(
          res.status,
          `Linear rate limited with Retry-After ${retryAfter}s (over the ` +
            `${MAX_RETRY_AFTER_MS / 1000}s cap)`,
          errors,
        )
      }

      console.warn(
        `[linear-api] ${res.status}${rateLimited ? ' (rate limited)' : ''}; ` +
          `retrying (attempt ${attempt}).`,
      )
      const jitter = Math.floor(Math.random() * 250)
      await sleep(waitMs + jitter)
      continue
    }

    if (!res.ok) {
      const message = describeGraphQLErrors(errors) || rawText.slice(0, 300)
      throw new LinearApiError(
        res.status,
        `Linear request failed (${res.status})${message ? `: ${message}` : ''}`,
        errors,
      )
    }

    // 200 + errors[] — the GraphQL failure mode. `data` may be partially
    // populated alongside it, but a partial result is not something any caller
    // here wants silently, so it is an error either way.
    if (errors.length > 0) {
      throw new LinearApiError(
        200,
        `Linear rejected the operation: ${describeGraphQLErrors(errors) || 'unknown error'}`,
        errors,
      )
    }

    return ((body as { data?: T } | null)?.data ?? null) as T
  }
}

// ---------------------------------------------------------------------------
// Minimal response shapes (only what we consume)
// ---------------------------------------------------------------------------

/**
 * A Linear workflow state.
 *
 * `type` is the whole reason Linear needs no bucket→status mapping UI: it is a
 * plain String with SEVEN documented values — `triage`, `backlog`, `unstarted`,
 * `started`, `completed`, `canceled`, `duplicate` — and it is stable across
 * teams however the states are NAMED. src/lib/tasks/lifecycle.ts owns the fold.
 *
 * `position` orders states within a team; the state_map derivation uses it as
 * the tie-break when a team has several states of the same type.
 */
export interface LinearWorkflowState {
  id: string
  name?: string
  /** One of the 7 documented values. Treated as an open string defensively. */
  type?: string
  position?: number
}

/** A GraphQL Relay connection, narrowed to the two parts the picker walks. */
interface LinearConnection<T> {
  nodes?: T[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
}

export interface LinearTeam {
  id: string
  /** The short prefix ("ENG") that issue identifiers are built from. */
  key?: string
  name?: string
}

export interface LinearProject {
  id: string
  name?: string
}

export interface LinearOrganization {
  id: string
  name?: string
  /** The org's URL slug. Display only. */
  urlKey?: string
}

export interface LinearUser {
  id: string
  name?: string
  email?: string
  /** The nickname Linear shows in its own UI. Distinct from `name`. */
  displayName?: string
  avatarUrl?: string
  /**
   * A bot/integration actor rather than a person. Filtered CLIENT-SIDE by the
   * assignee picker: `UserFilter` has no comparator for it, so there is no way
   * to exclude one in the query.
   */
  app?: boolean
  /**
   * Limited to a subset of teams. Also client-side-only (no `UserFilter.guest`),
   * and also filtered out of the assignee picker — a guest CAN be assigned on a
   * team they can reach, but offering one from a team-scoped list is more often
   * noise than intent.
   */
  guest?: boolean
}

/**
 * A Linear issue as the read paths see it.
 *
 * `identifier` ("ENG-123") is DISPLAY-ONLY and deliberately not an identity:
 * Linear rewrites it when an issue moves to a different team. `id` (a UUID) is
 * permanent and globally unique, which is what every link row stores.
 *
 * `trashed` marks an issue in Linear's 30-day delete grace window — a real
 * state, distinct from archived, and treated as "gone" by the read-back.
 * `archivedAt` is NOT: Linear auto-archives old completed issues, so an archived
 * issue is a perfectly real one whose state must still apply.
 */
export interface LinearIssue {
  id: string
  identifier?: string
  title?: string
  url?: string
  updatedAt?: string
  trashed?: boolean
  archivedAt?: string | null
  state?: LinearWorkflowState
  team?: { id: string; key?: string }
}

/** Max page size the picker queries request. */
export const LIST_MAX_LIMIT = 50

/** Team state lists are small and wanted whole — one page covers every real team. */
const STATES_PAGE_SIZE = 100

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The connected user AND the organization the token belongs to.
 *
 * The org id is what the destination config stores as `organization_id`, and
 * what the webhook read-back sanity-checks a delivery against. There is no
 * "list organizations" call to make: an OAuth token belongs to exactly one
 * Linear organization, so this is both the identity lookup and the org lookup.
 */
export async function getViewerAndOrg(
  accessToken: string,
): Promise<{ viewer: LinearUser | null; organization: LinearOrganization | null }> {
  const data = await linearGraphQL<{
    viewer?: LinearUser
    organization?: LinearOrganization
  }>(
    accessToken,
    `query ViewerAndOrg {
       viewer { id name email }
       organization { id name urlKey }
     }`,
  )
  return {
    viewer: data?.viewer ?? null,
    organization: data?.organization ?? null,
  }
}

// ---------------------------------------------------------------------------
// Pickers (destination config)
// ---------------------------------------------------------------------------

/**
 * The most pages either picker walk will follow.
 *
 * A ceiling, not an expectation: at LIST_MAX_LIMIT per page this reaches 250
 * teams or projects, past any real organization, while keeping a picker request
 * bounded if an org is pathological or a cursor ever fails to advance.
 */
const MAX_LIST_PAGES = 5

/**
 * Every team in the connected organization.
 *
 * Deliberately flat: no nested `states` or `projects`, even though GraphQL would
 * happily return them in this one round trip. Nesting a 100-state connection
 * inside a 50-team connection is how a single query blows the 10k complexity cap
 * — and the picker fetches states for ONE team at a time anyway.
 *
 * PAGED, because one page is not "every team". Enterprise orgs run more than 50
 * teams (Linear's model is roughly one per squad), and unlike the Jira and Asana
 * pickers this one has no search box to reach an item another way — so a team
 * past the first page was flatly unconfigurable, with nothing on screen saying
 * the list was cut short. Sequential SHALLOW pages keep the complexity budget
 * intact; it is nesting, not paging, that the budget punishes.
 */
export async function listTeams(
  accessToken: string,
  options: { first?: number } = {},
): Promise<LinearTeam[]> {
  const first = Math.min(options.first ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const teams: LinearTeam[] = []
  let after: string | null = null

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const data: { teams?: LinearConnection<LinearTeam> } = await linearGraphQL<{
      teams?: LinearConnection<LinearTeam>
    }>(
      accessToken,
      `query Teams($first: Int!, $after: String) {
       teams(first: $first, after: $after) {
         nodes { id key name }
         pageInfo { hasNextPage endCursor }
       }
     }`,
      { first, after },
    )
    teams.push(...(data?.teams?.nodes ?? []))

    const pageInfo = data?.teams?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    after = pageInfo.endCursor
  }

  return teams
}

/**
 * One team's workflow states, with the `type` and `position` the state_map
 * derivation folds on.
 *
 * Read at destination-save time (to derive the map) and again by the echo when a
 * saved state id has gone stale — a state the user deleted in Linear since.
 */
export async function listTeamStates(
  accessToken: string,
  teamId: string,
): Promise<LinearWorkflowState[]> {
  const data = await linearGraphQL<{
    team?: { states?: { nodes?: LinearWorkflowState[] } }
  }>(
    accessToken,
    `query TeamStates($teamId: String!, $first: Int!) {
       team(id: $teamId) {
         states(first: $first) { nodes { id name type position } }
       }
     }`,
    { teamId, first: STATES_PAGE_SIZE },
  )
  return data?.team?.states?.nodes ?? []
}

/**
 * One team's projects.
 *
 * Scoped THROUGH the team rather than filtering a global `projects` connection:
 * a project belongs to teams, and the picker only ever offers projects of the
 * team already chosen.
 *
 * Paged for the same reason as listTeams, and more pressingly: projects
 * accumulate one per initiative and completed-but-unarchived ones stay in the
 * connection, so a mature team passes 50 long before it has 50 LIVE projects.
 */
export async function listTeamProjects(
  accessToken: string,
  teamId: string,
  options: { first?: number } = {},
): Promise<LinearProject[]> {
  const first = Math.min(options.first ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const projects: LinearProject[] = []
  let after: string | null = null

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const data: { team?: { projects?: LinearConnection<LinearProject> } } = await linearGraphQL<{
      team?: { projects?: LinearConnection<LinearProject> }
    }>(
      accessToken,
      `query TeamProjects($teamId: String!, $first: Int!, $after: String) {
       team(id: $teamId) {
         projects(first: $first, after: $after) {
           nodes { id name }
           pageInfo { hasNextPage endCursor }
         }
       }
     }`,
      { teamId, first, after },
    )
    projects.push(...(data?.team?.projects?.nodes ?? []))

    const pageInfo = data?.team?.projects?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    after = pageInfo.endCursor
  }

  return projects
}

/**
 * A Linear issue label.
 *
 * `isGroup` is the field that matters and the one easiest to miss: a GROUP label
 * is a container ("Type", "Area") whose CHILDREN are the applicable labels — the
 * group itself cannot be put on an issue. Offering one in a picker produces a
 * `labelIds` entry Linear rejects, so callers filter them out.
 *
 * `team` is nullable, and that nullability IS the scoping model: a label with no
 * team is a workspace-level label available to every team. There are not two
 * label queries to make, only one whose results carry their own scope.
 */
export interface LinearIssueLabel {
  id: string
  name?: string
  color?: string
  isGroup?: boolean
  team?: { id: string } | null
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Resolve a person to a Linear user id by exact email.
 *
 * NO MATCH IS THE COMMON CASE and the caller must treat it that way: the Native Intelligence
 * member's email is whatever they signed up with, and there is no reason it is
 * the same address they use in the customer's Linear org. The push assigns on a
 * single exact match and otherwise creates the issue unassigned — the same
 * best-effort stance as the Jira sibling, applied at CREATE time because Linear
 * accepts `assigneeId` in the create input.
 *
 * Filtered server-side (`filter: { email: { eq: … } }`) rather than by listing
 * users and matching locally: a large org's user list is both a complexity
 * problem and a needless read of everybody's addresses.
 */
export async function findUserByEmail(
  accessToken: string,
  email: string,
): Promise<LinearUser | null> {
  const data = await linearGraphQL<{ users?: { nodes?: LinearUser[] } }>(
    accessToken,
    `query UserByEmail($email: String!) {
       users(filter: { email: { eq: $email } }, first: 1) { nodes { id name email } }
     }`,
    { email },
  )
  const nodes = data?.users?.nodes ?? []
  return nodes.length === 1 ? nodes[0] : null
}

/**
 * The page size every compose-panel query below passes EXPLICITLY.
 *
 * Small on purpose. Linear's complexity cost multiplies a connection's per-item
 * cost by `first`, and the default when you omit it is 50 — so relying on the
 * default costs roughly 5x per keystroke for options nobody scrolls to. Ten is
 * a picker's worth.
 */
export const TYPEAHEAD_PAGE_SIZE = 10

/**
 * The people who can be assigned an issue, scoped to a team when one is known.
 *
 * TWO query shapes, and which one runs is the whole design:
 *  - NO query text → `Team.members`, the correct pre-typing list. There is no
 *    `assignableUsers` field in Linear's schema (checked — it does not exist);
 *    team membership is the closest real notion of "who belongs here".
 *  - QUERY text → the top-level `users` connection filtered on displayName OR
 *    name. Both, because they are separate fields: `displayName` is the nickname
 *    Linear shows and `name` is the full name, and a user typing either expects
 *    a hit. Deliberately WORKSPACE-scoped rather than team-scoped: a filter over
 *    Team.members would need a nested connection, which is exactly the shape
 *    that blows the complexity budget.
 *
 * `guest` and `app` are filtered CLIENT-SIDE because `UserFilter` carries no
 * comparator for either — this is a schema fact, not an oversight here. Disabled
 * users need no filtering at all: the `users` query excludes them by default.
 */
export async function listAssignableUsers(
  accessToken: string,
  options: { teamId?: string; query?: string; first?: number } = {},
): Promise<LinearUser[]> {
  const first = Math.min(options.first ?? TYPEAHEAD_PAGE_SIZE, LIST_MAX_LIMIT)
  const query = options.query?.trim()

  let nodes: LinearUser[] = []
  if (query) {
    const data = await linearGraphQL<{ users?: { nodes?: LinearUser[] } }>(
      accessToken,
      `query SearchUsers($q: String!, $first: Int!) {
         users(
           filter: { or: [
             { displayName: { containsIgnoreCase: $q } },
             { name: { containsIgnoreCase: $q } }
           ] },
           first: $first
         ) { nodes { id name displayName email avatarUrl guest app } }
       }`,
      { q: query, first },
    )
    nodes = data?.users?.nodes ?? []
  } else if (options.teamId) {
    const data = await linearGraphQL<{
      team?: { members?: { nodes?: LinearUser[] } }
    }>(
      accessToken,
      `query TeamMembers($teamId: String!, $first: Int!) {
         team(id: $teamId) {
           members(first: $first) { nodes { id name displayName email avatarUrl guest app } }
         }
       }`,
      { teamId: options.teamId, first },
    )
    nodes = data?.team?.members?.nodes ?? []
  } else {
    const data = await linearGraphQL<{ users?: { nodes?: LinearUser[] } }>(
      accessToken,
      `query Users($first: Int!) {
         users(first: $first) { nodes { id name displayName email avatarUrl guest app } }
       }`,
      { first },
    )
    nodes = data?.users?.nodes ?? []
  }

  return nodes.filter((u) => !!u?.id && u.app !== true && u.guest !== true)
}

/**
 * The labels applicable to a team: the team's own PLUS the workspace-level ones.
 *
 * Both come from ONE query, because Linear models the distinction as a nullable
 * `IssueLabel.team` rather than as two collections — a label with no team is
 * available everywhere. The filter is therefore an `or` of "this team" and "no
 * team", not a union of two round trips.
 *
 * GROUP LABELS ARE EXCLUDED HERE rather than in the route, so every caller gets
 * an applicable-only list: a group is a container whose children are the real
 * labels, and putting a group's own id in `labelIds` is rejected.
 */
export async function listTeamLabels(
  accessToken: string,
  teamId: string,
  options: { first?: number } = {},
): Promise<LinearIssueLabel[]> {
  const first = Math.min(options.first ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
  const labels: LinearIssueLabel[] = []
  let after: string | null = null

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const data: { issueLabels?: LinearConnection<LinearIssueLabel> } = await linearGraphQL<{
      issueLabels?: LinearConnection<LinearIssueLabel>
    }>(
      accessToken,
      `query TeamLabels($teamId: ID!, $first: Int!, $after: String) {
         issueLabels(
           filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] },
           first: $first,
           after: $after
         ) {
           nodes { id name color isGroup team { id } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { teamId, first, after },
    )
    labels.push(...(data?.issueLabels?.nodes ?? []))

    const pageInfo = data?.issueLabels?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    after = pageInfo.endCursor
  }

  return labels.filter((label) => !!label?.id && label.isGroup !== true)
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * The create input.
 *
 * `teamId` is the only required field — a Linear issue belongs to a TEAM, and a
 * project is optional (which is the structural reason the destination gate here
 * is one id rather than Jira's site+project+issue-type triple).
 *
 * `description` is MARKDOWN — a plain string, not ADF and not HTML. Nothing to
 * escape and nothing to build.
 *
 * `stateId` is optional; omitting it lands the issue in the team's default
 * (backlog or triage). We pass the mapped `not_started` state when the
 * destination has one, so a pushed issue starts where the workspace said
 * not-started lives rather than wherever the team defaults to.
 *
 * `dueDate` is a TimelessDate: `YYYY-MM-DD`.
 */
export interface CreateIssueInput {
  teamId: string
  title: string
  description?: string
  stateId?: string
  assigneeId?: string
  projectId?: string
  /** `YYYY-MM-DD`. */
  dueDate?: string
  /**
   * 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low — a fixed workspace-wide
   * scale with no per-team customization to look up. Compose-panel only.
   */
  priority?: number
  /** Label UUIDs. Group labels are not applicable — see listTeamLabels. */
  labelIds?: string[]
  [key: string]: unknown
}

/**
 * `issueCreate` — create one issue and return its identity.
 *
 * The mutation asks for exactly what the link row stores: the permanent `id`,
 * the display `identifier`, the browsable `url`, and the state it actually
 * landed in (so the push needs no follow-up read the way the Jira one does —
 * Linear returns the state inline, Jira's create response carries no status).
 *
 * `success: false` without an `errors[]` entry is treated as a failure too:
 * the field exists in the schema, and trusting a null issue would store a link
 * to nothing.
 */
export async function createIssue(
  accessToken: string,
  input: CreateIssueInput,
): Promise<LinearIssue> {
  const data = await linearGraphQL<{
    issueCreate?: { success?: boolean; issue?: LinearIssue }
  }>(
    accessToken,
    `mutation CreateIssue($input: IssueCreateInput!) {
       issueCreate(input: $input) {
         success
         issue {
           id
           identifier
           title
           url
           state { id name type }
           team { id key }
         }
       }
     }`,
    { input },
  )

  const issue = data?.issueCreate?.issue
  if (!data?.issueCreate?.success || !issue?.id) {
    throw new LinearApiError(200, 'Linear reported the issue create as unsuccessful')
  }
  return issue
}

/**
 * `issueUpdate` — move an issue to a workflow state.
 *
 * A DIRECT WRITE, and the single biggest simplification Linear brings over Jira:
 * there is no transition graph to discover, no per-issue availability to check,
 * no resolution field to satisfy. Any state on the issue's team is settable from
 * any other, and Linear maintains `completedAt` / `canceledAt` itself.
 *
 * Returns the issue's state as Linear reports it AFTER the write, so the caller
 * can store the resulting label without a second read.
 */
export async function updateIssueState(
  accessToken: string,
  issueId: string,
  stateId: string,
): Promise<LinearIssue> {
  const data = await linearGraphQL<{
    issueUpdate?: { success?: boolean; issue?: LinearIssue }
  }>(
    accessToken,
    `mutation UpdateIssueState($id: String!, $stateId: String!) {
       issueUpdate(id: $id, input: { stateId: $stateId }) {
         success
         issue { id identifier url state { id name type } }
       }
     }`,
    { id: issueId, stateId },
  )

  const issue = data?.issueUpdate?.issue
  if (!data?.issueUpdate?.success || !issue?.id) {
    throw new LinearApiError(200, 'Linear reported the issue update as unsuccessful')
  }
  return issue
}

/**
 * `issue(id:)` — the read-back.
 *
 * RETURNS NULL FOR THREE DIFFERENT THINGS, and Linear does not distinguish them:
 * the issue was deleted, the connected user cannot see it, or the id never
 * existed. All three come back as a clean `{ data: { issue: null } }` with NO
 * `errors` entry, which is why the caller's marker for a null is RETRYABLE
 * (`task_missing`) and never terminal — the same stance jira-link-marker takes
 * for Jira's ambiguous 404, and for the same reason: a permission scheme edited
 * for an hour is indistinguishable from a deletion, and a terminal marker would
 * silently kill the sync for every link in the workspace.
 *
 * `trashed` and `archivedAt` are requested because they mean OPPOSITE things
 * here — see LinearIssue.
 */
export async function getIssue(
  accessToken: string,
  issueId: string,
): Promise<LinearIssue | null> {
  const data = await linearGraphQL<{ issue?: LinearIssue | null }>(
    accessToken,
    `query Issue($id: String!) {
       issue(id: $id) {
         id
         identifier
         title
         url
         updatedAt
         trashed
         archivedAt
         state { id name type }
         team { id key }
       }
     }`,
    { id: issueId },
  )
  return data?.issue ?? null
}

/**
 * `issueDelete` — best-effort cleanup of an issue we should not have created
 * (the push lost the link-row race and orphaned it).
 *
 * NEVER throws, mirroring jira-api's deleteIssue: the user ends up correctly
 * linked either way, just possibly with one stray issue, and turning a failed
 * tidy-up into a failed push would be strictly worse. Note that Linear's delete
 * is a TRASH (30-day grace), so even the successful path is recoverable by the
 * user — which is exactly the property that makes doing it automatically safe.
 */
export async function deleteIssue(accessToken: string, issueId: string): Promise<void> {
  try {
    await linearGraphQL(
      accessToken,
      `mutation DeleteIssue($id: String!) {
         issueDelete(id: $id) { success }
       }`,
      { id: issueId },
    )
  } catch (err) {
    console.warn(
      `[linear-api] deleteIssue failed for ${issueId} (best-effort cleanup) —`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * `POST /oauth/revoke` — best-effort token revocation on disconnect.
 *
 * For Linear this is the ENTIRE disconnect-side teardown, because its webhooks
 * are app-level and end with the authorization rather than with a registration
 * we own (see the disconnect route). NEVER throws: a disconnect must complete
 * whatever Linear says, and an un-revoked token expires within 24h regardless.
 */
export async function revokeToken(accessToken: string): Promise<void> {
  try {
    const res = await fetch(LINEAR_REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: accessToken }),
    })
    if (!res.ok) {
      console.warn(`[linear-api] token revoke returned ${res.status} (best-effort).`)
    }
  } catch (err) {
    console.warn(
      '[linear-api] token revoke failed (best-effort) —',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

/** Read the workflow-state NAME off an issue payload, or null. */
export function issueStateName(issue: LinearIssue | null | undefined): string | null {
  const name = issue?.state?.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

/** Read the stable workflow-state TYPE off an issue payload, or null. */
export function issueStateType(issue: LinearIssue | null | undefined): string | null {
  const type = issue?.state?.type
  return typeof type === 'string' && type.length > 0 ? type : null
}
