import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createIssue,
  deleteIssue,
  findUserByEmail,
  getIssue,
  getViewerAndOrg,
  issueStateName,
  issueStateType,
  isLinearInputError,
  isLinearRateLimited,
  linearGraphQL,
  listTeamProjects,
  listTeamStates,
  listTeams,
  revokeToken,
  updateIssueState,
  LinearApiError,
  LinearUnauthorizedError,
  type LinearGraphQLError,
} from '@/lib/integrations/linear-api'

/**
 * Tests for src/lib/integrations/linear-api.ts.
 *
 * Invariants locked in — each one a place where Linear differs from the Jira
 * client this file is a sibling of, and where copying Jira's behaviour would
 * have been wrong:
 *  - ONE endpoint for everything, addressed by nobody: no cloudId argument, no
 *    per-site base URL, and NOTHING interpolated into a URL — every id travels
 *    as a GraphQL variable, which is why this file has no identifier-validation
 *    machinery at all.
 *  - HTTP 200 is NOT success: a `errors[]` array with a 200 status is the normal
 *    GraphQL failure mode and must throw.
 *  - rate limiting is DUAL-MODE — the documented 429 AND an HTTP 400 carrying
 *    `extensions.code === 'RATELIMITED'`. Detecting only the first would turn a
 *    throttle into a permanent input error.
 *  - 429 backoff honors Retry-After up to a 60s ceiling, falls back to
 *    exponential, caps out. A longer Retry-After THROWS rather than sleeping.
 *  - 401 AND 403 both → LinearUnauthorizedError: one fix (reconnect), and Linear
 *    does not distinguish them reliably.
 *  - `issue(id:)` returning null is a clean, error-free response — the caller's
 *    whole "deleted vs invisible vs never existed" ambiguity starts here.
 *  - deleteIssue and revokeToken NEVER throw (best-effort cleanup paths).
 */

type FakeResponse = {
  status?: number
  ok?: boolean
  text?: () => Promise<string>
  headers?: Record<string, string>
}
let responses: FakeResponse[] = []
let requests: Array<{ url: string; init: RequestInit | undefined }> = []

/** A successful GraphQL response: `{ data: … }` with HTTP 200. */
function pushData(data: unknown) {
  responses.push({ status: 200, ok: true, text: async () => JSON.stringify({ data }) })
}
/** A GraphQL-level failure: HTTP 200 carrying an `errors[]` array. */
function pushGraphQLErrors(
  errors: Array<{ message?: string; extensions?: Record<string, unknown> }>,
  status = 200,
) {
  responses.push({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify({ data: null, errors }),
  })
}
function pushStatus(status: number, body = '', headers?: Record<string, string>) {
  responses.push({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    headers,
  })
}
function push429(retryAfter?: string) {
  const headers: Record<string, string> = {}
  if (retryAfter) headers['retry-after'] = retryAfter
  responses.push({ status: 429, ok: false, text: async () => '', headers })
}
/** Linear's OTHER rate-limit shape: HTTP 400 + RATELIMITED in the errors array. */
function push400RateLimited(retryAfter?: string) {
  const headers: Record<string, string> = {}
  if (retryAfter) headers['retry-after'] = retryAfter
  responses.push({
    status: 400,
    ok: false,
    text: async () =>
      JSON.stringify({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }),
    headers,
  })
}

const URL_ = 'https://api.linear.app/graphql'

/** The parsed `{ query, variables }` body of the Nth fetch. */
function bodyOf(index: number): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(requests[index].init?.body))
}

/**
 * Await a rejection and hand back the error, typed loosely enough to read
 * `status` / `graphQLErrors` off it. A bare `.catch(e => e)` types as `unknown`,
 * which every assertion below would then have to cast at the call site.
 */
async function rejection<T>(promise: Promise<T>): Promise<
  Error & { status?: number; graphQLErrors?: LinearGraphQLError[] }
> {
  try {
    await promise
    throw new Error('expected the call to reject, but it resolved')
  } catch (err) {
    return err as Error & { status?: number; graphQLErrors?: LinearGraphQLError[] }
  }
}

beforeEach(() => {
  responses = []
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      const next = responses.shift()
      if (!next) throw new Error(`no fake response queued for ${url}`)
      return {
        status: next.status ?? 200,
        ok: next.ok ?? true,
        text: next.text ?? (async () => ''),
        headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
      } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---- Transport -------------------------------------------------------------

describe('linearGraphQL — transport', () => {
  it('POSTs query + variables as JSON to the ONE endpoint, with bearer auth', async () => {
    pushData({ ok: true })
    await linearGraphQL('tok', 'query Q($id: String!) { thing(id: $id) { id } }', { id: 'x' })

    expect(requests[0].url).toBe(URL_)
    expect(requests[0].init?.method).toBe('POST')
    const headers = requests[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['Content-Type']).toBe('application/json')
    expect(bodyOf(0)).toEqual({
      query: 'query Q($id: String!) { thing(id: $id) { id } }',
      variables: { id: 'x' },
    })
  })

  /**
   * The property that removes jira-api's whole JiraInvalidIdentifierError
   * apparatus: a hostile id cannot escape a JSON string value, so it is inert
   * rather than dangerous, and refusing it would be theatre.
   */
  it('carries ids as VARIABLES — nothing is ever interpolated into a URL', async () => {
    pushData({ issue: null })
    await getIssue('tok', '../../admin?x=1')

    expect(requests[0].url).toBe(URL_)
    expect(bodyOf(0).variables).toEqual({ id: '../../admin?x=1' })
    expect(bodyOf(0).query).not.toContain('../../admin')
  })

  it('unwraps `data` and returns it', async () => {
    pushData({ viewer: { id: 'u-1' } })
    expect(await linearGraphQL('tok', '{ viewer { id } }')).toEqual({ viewer: { id: 'u-1' } })
  })

  it('returns null when the response carries no data', async () => {
    pushStatus(200, JSON.stringify({}))
    expect(await linearGraphQL('tok', '{ viewer { id } }')).toBeNull()
  })

  it('sends an empty variables object when none are given', async () => {
    pushData({})
    await linearGraphQL('tok', '{ viewer { id } }')
    expect(bodyOf(0).variables).toEqual({})
  })
})

describe('linearGraphQL — errors', () => {
  it('throws LinearUnauthorizedError on 401', async () => {
    pushStatus(401)
    await expect(linearGraphQL('tok', '{ viewer { id } }')).rejects.toBeInstanceOf(
      LinearUnauthorizedError,
    )
  })

  /**
   * 403 folds into the SAME error as 401, unlike the Jira client where a 403 is
   * an ordinary JiraApiError. Linear answers a scope-less mutation with either,
   * and both have exactly one fix from the user's side: reconnect.
   */
  it('throws LinearUnauthorizedError on 403 too — one error, one fix', async () => {
    pushStatus(403)
    const err = await rejection(linearGraphQL('tok', '{ viewer { id } }'))
    expect(err).toBeInstanceOf(LinearUnauthorizedError)
    expect(err.status).toBe(403)
  })

  /**
   * The GraphQL failure mode, and the reason `res.ok` alone can never be the
   * success test in this file.
   */
  it('throws on HTTP 200 carrying an errors[] array', async () => {
    pushGraphQLErrors([{ message: 'Field is required', extensions: { code: 'INVALID_INPUT' } }])

    const err = await rejection(linearGraphQL('tok', 'mutation { x }'))
    expect(err).toBeInstanceOf(LinearApiError)
    expect(err.status).toBe(200)
    expect(err.message).toContain('Field is required')
    expect(err.graphQLErrors).toHaveLength(1)
  })

  it('keeps the errors array structurally, not just flattened into a message', async () => {
    // The push branches on `extensions.code`; the messages are human prose and
    // are not a stable contract.
    pushGraphQLErrors([{ message: 'nope', extensions: { code: 'INVALID_INPUT' } }])
    const err = await rejection(linearGraphQL('tok', 'mutation { x }'))
    expect(err.graphQLErrors?.[0]?.extensions?.code).toBe('INVALID_INPUT')
  })

  it('throws LinearApiError with the status on a non-2xx that is not a rate limit', async () => {
    pushGraphQLErrors([{ message: 'Bad request' }], 400)
    const err = await rejection(linearGraphQL('tok', '{ viewer { id } }'))
    expect(err).toBeInstanceOf(LinearApiError)
    expect(err.status).toBe(400)
    expect(err.message).toContain('Bad request')
  })

  it('survives a non-JSON error body rather than throwing on the parse', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // An HTML error page from an edge proxy — the status is the only meaning.
    pushStatus(502, '<html>bad gateway</html>')
    pushStatus(502, '<html>bad gateway</html>')
    pushStatus(502, '<html>bad gateway</html>')

    const promise = rejection(linearGraphQL('tok', '{ viewer { id } }'))
    await vi.advanceTimersByTimeAsync(10_000)
    const err = await promise
    // 502 is transient, so it exhausts the retries and reports as unavailable.
    expect(err).toBeInstanceOf(LinearApiError)
    expect(err.status).toBe(502)
  })

  it('reports the raw body on a non-retryable non-JSON response', async () => {
    pushStatus(418, 'not a teapot, but not JSON either')
    const err = await rejection(linearGraphQL('tok', '{ viewer { id } }'))
    expect(err).toBeInstanceOf(LinearApiError)
    expect(err.message).toContain('not a teapot')
  })
})

describe('linearGraphQL — rate limiting (both modes)', () => {
  it('honors Retry-After on a 429 and retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    push429('1')
    pushData({ viewer: { id: 'u-1' } })

    const promise = linearGraphQL('tok', '{ viewer { id } }')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await promise).toEqual({ viewer: { id: 'u-1' } })
    expect(requests).toHaveLength(2)
  })

  /**
   * The mode Linear actually uses most, and the one a Jira-shaped client would
   * miss entirely: a throttled request comes back as HTTP 400 with the code in
   * the GraphQL errors array. Treating it as a plain 400 would surface a
   * transient throttle as a permanent input rejection — and, in the push, would
   * trigger the strip-optionals retry against fields that were never at fault.
   */
  it('treats an HTTP 400 + RATELIMITED as a rate limit, not an input error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    push400RateLimited('1')
    pushData({ viewer: { id: 'u-1' } })

    const promise = linearGraphQL('tok', '{ viewer { id } }')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await promise).toEqual({ viewer: { id: 'u-1' } })
    expect(requests).toHaveLength(2)
  })

  it('caps out after MAX_ATTEMPTS and throws a retryable error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    push429('1')
    push429('1')
    push429('1')

    const promise = rejection(linearGraphQL('tok', '{ viewer { id } }'))
    await vi.advanceTimersByTimeAsync(10_000)
    const err = await promise
    expect(err).toBeInstanceOf(LinearApiError)
    expect(err.status).toBe(429)
    expect(err.message).toContain('rate limited')
    expect(requests).toHaveLength(3)
  })

  /**
   * Sleeping a long reset inside a Vercel function turns a picker route into a
   * hung spinner and then a 504, and blows an Inngest step timeout mid-page.
   * Past the ceiling the honest move is to throw and let the caller's own
   * backoff own the wait.
   */
  it('THROWS rather than sleeping when Retry-After exceeds the 60s cap', async () => {
    push429('2400')
    const err = await rejection(linearGraphQL('tok', '{ viewer { id } }'))
    expect(err).toBeInstanceOf(LinearApiError)
    expect(err.message).toContain('over the 60s cap')
    // One attempt only — it never slept.
    expect(requests).toHaveLength(1)
  })

  it('falls back to exponential backoff when Retry-After is missing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    push429()
    pushData({ ok: true })

    const promise = linearGraphQL('tok', '{ viewer { id } }')
    await vi.advanceTimersByTimeAsync(3000)
    await promise
    expect(requests).toHaveLength(2)
  })

  it('retries a 5xx as transient', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    pushStatus(503)
    pushData({ ok: true })

    const promise = linearGraphQL('tok', '{ viewer { id } }')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await promise).toEqual({ ok: true })
    expect(requests).toHaveLength(2)
  })
})

describe('isLinearInputError / isLinearRateLimited', () => {
  it('recognizes each documented input-error code', () => {
    for (const code of ['INVALID_INPUT', 'BAD_USER_INPUT', 'ARGUMENT_VALIDATION_ERROR']) {
      expect(isLinearInputError(new LinearApiError(200, 'x', [{ extensions: { code } }]))).toBe(
        true,
      )
    }
  })

  it('recognizes the ENTITY-NOT-FOUND shape a stale project or state id produces', () => {
    // The payload Linear actually returns when the create names an id that has
    // since been deleted — exactly what the strip-optionals retry exists for.
    // Its code is 'INPUT_ERROR', NOT the 'INVALID_INPUT' the fixtures used to
    // fabricate, so classifying on `code` alone missed the whole class. Linear's
    // codes are unstable across error families; `type` and `userError` are not.
    const notFound = new LinearApiError(200, 'Entity not found', [
      {
        message: 'Entity not found: Project - Could not find referenced Project.',
        extensions: { type: 'invalid input', code: 'INPUT_ERROR', userError: true },
      },
    ])
    expect(isLinearInputError(notFound)).toBe(true)
  })

  it('classifies on `type` / `userError` when the code is unrecognized', () => {
    expect(
      isLinearInputError(
        new LinearApiError(200, 'x', [{ extensions: { type: 'user error', code: 'WHATEVER' } }]),
      ),
    ).toBe(true)
    expect(
      isLinearInputError(new LinearApiError(200, 'x', [{ extensions: { userError: true } }])),
    ).toBe(true)
    expect(
      isLinearInputError(
        new LinearApiError(200, 'x', [{ extensions: { type: 'feature not accessible' } }]),
      ),
    ).toBe(true)
  })

  it('does NOT treat a body-level TRANSIENT error as an input error', () => {
    // Linear dresses internal failures as 200-with-errors too. Stripping the due
    // date cannot fix a lock timeout, and treating it as input would burn the
    // one retry and then report a permanent failure for a blip.
    for (const type of ['internal error', 'lock timeout', 'network error']) {
      expect(isLinearInputError(new LinearApiError(200, 'x', [{ extensions: { type } }]))).toBe(
        false,
      )
    }
  })

  it('does NOT treat a rate limit or an unknown code as an input error', () => {
    // The distinction the push depends on: stripping optional fields cannot fix
    // a throttle, and retrying without them would just burn the second attempt.
    expect(
      isLinearInputError(new LinearApiError(400, 'x', [{ extensions: { code: 'RATELIMITED' } }])),
    ).toBe(false)
    expect(isLinearInputError(new LinearApiError(200, 'x', [{ extensions: {} }]))).toBe(false)
    expect(isLinearInputError(new LinearApiError(500, 'x'))).toBe(false)
    expect(isLinearInputError(new Error('plain'))).toBe(false)
    expect(isLinearInputError(null)).toBe(false)
  })

  it('recognizes the RATELIMITED body variant', () => {
    expect(
      isLinearRateLimited(new LinearApiError(400, 'x', [{ extensions: { code: 'RATELIMITED' } }])),
    ).toBe(true)
    expect(isLinearRateLimited(new LinearApiError(400, 'x', [{ extensions: {} }]))).toBe(false)
    expect(isLinearRateLimited(new Error('plain'))).toBe(false)
  })
})

// ---- Identity --------------------------------------------------------------

describe('getViewerAndOrg', () => {
  it('reads the connected user and the organization in one shallow query', async () => {
    pushData({
      viewer: { id: 'u-1', name: 'Ada', email: 'ada@example.com' },
      organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    })

    expect(await getViewerAndOrg('tok')).toEqual({
      viewer: { id: 'u-1', name: 'Ada', email: 'ada@example.com' },
      organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    })
    // Both are ROOT fields — no nesting, so no complexity multiplication.
    expect(bodyOf(0).query).toContain('viewer')
    expect(bodyOf(0).query).toContain('organization')
  })

  it('reports nulls rather than throwing when either half is absent', async () => {
    pushData({})
    expect(await getViewerAndOrg('tok')).toEqual({ viewer: null, organization: null })
  })
})

// ---- Pickers ---------------------------------------------------------------

describe('listTeams', () => {
  it('requests one capped page of teams with id/key/name', async () => {
    pushData({ teams: { nodes: [{ id: 't-1', key: 'ENG', name: 'Engineering' }] } })

    expect(await listTeams('tok')).toEqual([{ id: 't-1', key: 'ENG', name: 'Engineering' }])
    expect(bodyOf(0).variables).toEqual({ first: 50, after: null })
  })

  it('FOLLOWS the cursor so an org past the first page is still reachable', async () => {
    // A team the workspace wants to push into can sort past position 50 in a
    // 60-team org. Truncating there made that team unconfigurable — and silently
    // so, since the picker offers no search box to reach it another way.
    pushData({
      teams: {
        nodes: [{ id: 't-1', key: 'ENG', name: 'Engineering' }],
        pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
      },
    })
    pushData({
      teams: {
        nodes: [{ id: 't-2', key: 'OPS', name: 'Operations' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    })

    expect(await listTeams('tok')).toEqual([
      { id: 't-1', key: 'ENG', name: 'Engineering' },
      { id: 't-2', key: 'OPS', name: 'Operations' },
    ])
    expect(bodyOf(0).variables.after).toBeNull()
    expect(bodyOf(1).variables.after).toBe('cur-1')
  })

  it('stops at the page cap rather than walking an unbounded org', async () => {
    // Sequential SHALLOW pages respect the complexity budget, but the walk still
    // needs a ceiling so a pathological org can't hold a picker request open.
    for (let i = 0; i < 10; i++) {
      pushData({
        teams: {
          nodes: [{ id: `t-${i}`, key: 'ENG', name: 'Engineering' }],
          pageInfo: { hasNextPage: true, endCursor: `cur-${i}` },
        },
      })
    }

    const teams = await listTeams('tok')

    expect(requests).toHaveLength(5)
    expect(teams).toHaveLength(5)
  })

  it('clamps an oversized page request to the list cap', async () => {
    pushData({ teams: { nodes: [] } })
    await listTeams('tok', { first: 500 })
    expect(bodyOf(0).variables.first).toBe(50)
  })

  /**
   * The complexity-budget rule, asserted structurally: nesting a 100-state
   * connection inside a 50-team one is how a single query blows the 10k cap, and
   * the picker fetches states for ONE team at a time anyway.
   */
  it('does NOT nest states or projects inside the team query', async () => {
    pushData({ teams: { nodes: [] } })
    await listTeams('tok')
    expect(bodyOf(0).query).not.toContain('states')
    expect(bodyOf(0).query).not.toContain('projects')
  })

  it('returns an empty array rather than throwing on a shapeless response', async () => {
    pushData({})
    expect(await listTeams('tok')).toEqual([])
  })
})

describe('listTeamStates', () => {
  it('requests the team’s states WITH type and position — the derivation inputs', async () => {
    pushData({
      team: { states: { nodes: [{ id: 's-1', name: 'Todo', type: 'unstarted', position: 0 }] } },
    })

    expect(await listTeamStates('tok', 't-1')).toEqual([
      { id: 's-1', name: 'Todo', type: 'unstarted', position: 0 },
    ])
    expect(bodyOf(0).variables).toEqual({ teamId: 't-1', first: 100 })
    // Without `type` there is no fold and without `position` no tie-break.
    expect(bodyOf(0).query).toContain('type')
    expect(bodyOf(0).query).toContain('position')
  })

  it('returns an empty array for an unknown team rather than throwing', async () => {
    pushData({ team: null })
    expect(await listTeamStates('tok', 't-nope')).toEqual([])
  })
})

describe('listTeamProjects', () => {
  it('scopes projects THROUGH the team', async () => {
    pushData({ team: { projects: { nodes: [{ id: 'p-1', name: 'Q3 Launch' }] } } })

    expect(await listTeamProjects('tok', 't-1')).toEqual([{ id: 'p-1', name: 'Q3 Launch' }])
    expect(bodyOf(0).variables).toEqual({ teamId: 't-1', first: 50, after: null })
    expect(bodyOf(0).query).toContain('team(id: $teamId)')
  })

  it('FOLLOWS the cursor — a mature team accumulates past 50 projects', async () => {
    pushData({
      team: {
        projects: {
          nodes: [{ id: 'p-1', name: 'Q3 Launch' }],
          pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
        },
      },
    })
    pushData({
      team: {
        projects: {
          nodes: [{ id: 'p-2', name: 'Q4 Launch' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })

    expect(await listTeamProjects('tok', 't-1')).toEqual([
      { id: 'p-1', name: 'Q3 Launch' },
      { id: 'p-2', name: 'Q4 Launch' },
    ])
    expect(bodyOf(1).variables.after).toBe('cur-1')
  })

  it('returns an empty array for a team with no projects', async () => {
    pushData({ team: { projects: { nodes: [] } } })
    expect(await listTeamProjects('tok', 't-1')).toEqual([])
  })
})

// ---- Users -----------------------------------------------------------------

describe('findUserByEmail', () => {
  it('filters server-side on an EXACT email and returns the single match', async () => {
    pushData({ users: { nodes: [{ id: 'u-9', name: 'Ada', email: 'ada@example.com' }] } })

    expect(await findUserByEmail('tok', 'ada@example.com')).toEqual({
      id: 'u-9',
      name: 'Ada',
      email: 'ada@example.com',
    })
    expect(bodyOf(0).variables).toEqual({ email: 'ada@example.com' })
    // Server-side filter, not a client-side scan of everyone's addresses.
    expect(bodyOf(0).query).toContain('filter: { email: { eq: $email } }')
  })

  /**
   * No match is the EXPECTED outcome, not an error: the member's Native Intelligence email is
   * whatever they signed up with and need not be their address in the customer's
   * Linear org.
   */
  it('returns null on no match', async () => {
    pushData({ users: { nodes: [] } })
    expect(await findUserByEmail('tok', 'nobody@example.com')).toBeNull()
  })

  it('returns null rather than GUESSING when more than one user comes back', async () => {
    pushData({ users: { nodes: [{ id: 'u-1' }, { id: 'u-2' }] } })
    expect(await findUserByEmail('tok', 'shared@example.com')).toBeNull()
  })
})

// ---- Issues ----------------------------------------------------------------

describe('createIssue', () => {
  const ISSUE = {
    id: 'issue-uuid-1',
    identifier: 'ENG-7',
    title: 'Ship it',
    url: 'https://linear.app/acme/issue/ENG-7',
    state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
  }

  it('sends the input and returns the created issue', async () => {
    pushData({ issueCreate: { success: true, issue: ISSUE } })

    expect(await createIssue('tok', { teamId: 't-1', title: 'Ship it' })).toEqual(ISSUE)
    expect(bodyOf(0).variables).toEqual({ input: { teamId: 't-1', title: 'Ship it' } })
  })

  /**
   * The create response carries the landing STATE inline — which is why the
   * Linear push needs no follow-up read, where the Jira one must GET the issue
   * to learn its status.
   */
  it('asks for the landing state so the push needs no read-back', async () => {
    pushData({ issueCreate: { success: true, issue: ISSUE } })
    await createIssue('tok', { teamId: 't-1', title: 'Ship it' })
    expect(bodyOf(0).query).toContain('state { id name type }')
  })

  it('sends the description as a MARKDOWN STRING, not a tree', async () => {
    pushData({ issueCreate: { success: true, issue: ISSUE } })
    await createIssue('tok', { teamId: 't-1', title: 'Ship it', description: '**bold**' })
    expect(bodyOf(0).variables.input).toMatchObject({ description: '**bold**' })
  })

  it('throws when Linear reports success:false', async () => {
    // The field exists in the schema; trusting a null issue would store a link
    // to nothing.
    pushData({ issueCreate: { success: false, issue: null } })
    await expect(createIssue('tok', { teamId: 't-1', title: 'x' })).rejects.toBeInstanceOf(
      LinearApiError,
    )
  })

  it('throws when the issue comes back without an id', async () => {
    pushData({ issueCreate: { success: true, issue: { identifier: 'ENG-7' } } })
    await expect(createIssue('tok', { teamId: 't-1', title: 'x' })).rejects.toThrow(
      /unsuccessful/,
    )
  })
})

describe('updateIssueState', () => {
  it('sets the state DIRECTLY — no transition lookup, no resolution field', async () => {
    // The single biggest simplification over Jira: any state is settable from
    // any other, so there is nothing to discover against the live issue first.
    pushData({
      issueUpdate: {
        success: true,
        issue: { id: 'i-1', identifier: 'ENG-7', state: { id: 's-done', name: 'Done', type: 'completed' } },
      },
    })

    const issue = await updateIssueState('tok', 'i-1', 's-done')
    expect(issue.state).toEqual({ id: 's-done', name: 'Done', type: 'completed' })
    expect(bodyOf(0).variables).toEqual({ id: 'i-1', stateId: 's-done' })
    expect(bodyOf(0).query).toContain('issueUpdate')
    expect(bodyOf(0).query).not.toContain('transition')
  })

  it('returns the resulting state so the caller needs no second read', async () => {
    pushData({
      issueUpdate: { success: true, issue: { id: 'i-1', state: { id: 's-done', name: 'Done' } } },
    })
    expect(issueStateName(await updateIssueState('tok', 'i-1', 's-done'))).toBe('Done')
  })

  it('throws when Linear reports success:false', async () => {
    pushData({ issueUpdate: { success: false, issue: null } })
    await expect(updateIssueState('tok', 'i-1', 's-done')).rejects.toBeInstanceOf(LinearApiError)
  })
})

describe('getIssue', () => {
  /**
   * The ambiguity the whole retryable-marker stance is built on: deleted, not
   * visible to this user, and never existed all produce this identical clean
   * response, with NO errors entry to tell them apart.
   */
  it('returns null with NO error for a missing / invisible / nonexistent issue', async () => {
    pushData({ issue: null })
    expect(await getIssue('tok', 'gone')).toBeNull()
  })

  it('requests trashed AND archivedAt — they mean OPPOSITE things', async () => {
    // `trashed` is the 30-day delete grace window (treat as gone); `archivedAt`
    // is Linear auto-archiving an old completed issue (a real issue whose state
    // must still apply).
    pushData({ issue: { id: 'i-1' } })
    await getIssue('tok', 'i-1')
    expect(bodyOf(0).query).toContain('trashed')
    expect(bodyOf(0).query).toContain('archivedAt')
  })

  it('returns the issue with its state', async () => {
    pushData({
      issue: {
        id: 'i-1',
        identifier: 'ENG-7',
        url: 'https://linear.app/acme/issue/ENG-7',
        trashed: false,
        archivedAt: null,
        state: { id: 's-doing', name: 'In Progress', type: 'started' },
      },
    })

    const issue = await getIssue('tok', 'i-1')
    expect(issue?.id).toBe('i-1')
    expect(issueStateType(issue)).toBe('started')
  })

  it('propagates a 401 rather than reporting the issue as missing', async () => {
    // A null means "gone"; an auth failure means "we could not look". Collapsing
    // them would mark every link task_missing the moment a token aged out.
    pushStatus(401)
    await expect(getIssue('tok', 'i-1')).rejects.toBeInstanceOf(LinearUnauthorizedError)
  })
})

describe('deleteIssue', () => {
  it('deletes the issue', async () => {
    pushData({ issueDelete: { success: true } })
    await deleteIssue('tok', 'i-1')
    expect(bodyOf(0).variables).toEqual({ id: 'i-1' })
  })

  /**
   * Best-effort by contract: every caller is cleaning up an orphan it just
   * created, and turning a failed tidy-up into a failed push would be strictly
   * worse for a user who ends up correctly linked either way.
   */
  it('NEVER throws — not on a GraphQL error, not on a 403, not on a 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushGraphQLErrors([{ message: 'not permitted' }])
    await expect(deleteIssue('tok', 'i-1')).resolves.toBeUndefined()

    pushStatus(403)
    await expect(deleteIssue('tok', 'i-2')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

describe('revokeToken', () => {
  it('POSTs the token form-encoded to the revoke endpoint', async () => {
    pushStatus(200)
    await revokeToken('tok')

    expect(requests[0].url).toBe('https://api.linear.app/oauth/revoke')
    expect(requests[0].init?.method).toBe('POST')
    expect(String(requests[0].init?.body)).toContain('token=tok')
  })

  it('NEVER throws — a disconnect must complete whatever Linear says', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushStatus(400)
    await expect(revokeToken('tok')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('survives a network failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(revokeToken('tok')).resolves.toBeUndefined()
  })
})

// ---- Payload readers -------------------------------------------------------

describe('issueStateName / issueStateType', () => {
  it('reads both off an issue payload', () => {
    const issue = { id: 'i-1', state: { id: 's-1', name: 'In Progress', type: 'started' } }
    expect(issueStateName(issue)).toBe('In Progress')
    expect(issueStateType(issue)).toBe('started')
  })

  it('returns null for a missing state, a blank value, or a null issue', () => {
    expect(issueStateName(null)).toBeNull()
    expect(issueStateType(undefined)).toBeNull()
    expect(issueStateName({ id: 'i-1' })).toBeNull()
    expect(issueStateName({ id: 'i-1', state: { id: 's', name: '' } })).toBeNull()
    expect(issueStateType({ id: 'i-1', state: { id: 's', type: '' } })).toBeNull()
  })
})
