import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  assignIssue,
  createIssue,
  dedupeProjectStatuses,
  deleteIssue,
  deleteWebhooks,
  describeErrorBody,
  getIssue,
  listWebhooks,
  refreshWebhooks,
  registerWebhooks,
  getTransitions,
  issueStatusCategoryKey,
  issueStatusName,
  isJiraNotFound,
  isNumericJiraId,
  jiraBaseUrl,
  jiraFetch,
  listAccessibleResources,
  listCreateMetaIssueTypes,
  listProjectStatuses,
  searchProjects,
  searchUsers,
  transitionIssue,
  JiraApiError,
  JiraInvalidIdentifierError,
  JiraUnauthorizedError,
} from '@/lib/integrations/jira-api'

/**
 * Tests for src/lib/integrations/jira-api.ts.
 *
 * Invariants locked in — each one a place where Jira differs from the Asana
 * client this file is a sibling of, and where copying Asana's behaviour would
 * have been wrong:
 *  - the URL is per-SITE: every call goes through
 *    api.atlassian.com/ex/jira/{cloudId}/rest/api/3, built from the cloudId
 *    argument. accessible-resources is the ONE account-scoped exception.
 *  - there is NO `data` envelope to unwrap — the resource comes back raw.
 *  - the error envelope is `{errorMessages, errors}` and the per-field `errors`
 *    map survives ONTO the thrown error, because the push branches on the field
 *    KEY ('duedate') rather than on a human sentence.
 *  - 429 backoff honors Retry-After up to a 60s ceiling, falls back to
 *    exponential, caps out. A longer Retry-After THROWS rather than sleeping.
 *  - the ids that get interpolated into a URL or into JQL are VALIDATED at this
 *    layer, since neither encoding nor escaping is available where they land.
 *  - 401 → distinct JiraUnauthorizedError; 404 → JiraApiError(404), which is how
 *    "the issue was deleted" is told apart from every other failure.
 *  - transitions are always requested with expand=transitions.fields (without it
 *    a resolution-requiring transition 400s invisibly).
 *  - deleteIssue NEVER throws — including on the 403 that a create-but-not-
 *    delete permission set produces, which is the common real-world case.
 */

type FakeResponse = {
  status?: number
  ok?: boolean
  json?: () => Promise<unknown>
  text?: () => Promise<string>
  headers?: Record<string, string>
}
let responses: FakeResponse[] = []
let requests: Array<{ url: string; init: RequestInit | undefined }> = []

function pushJson(body: unknown, status = 200) {
  responses.push({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}
/** A Jira error body: { errorMessages: [], errors: { field: msg } }. */
function pushError(
  status: number,
  body: { errorMessages?: string[]; errors?: Record<string, string> },
) {
  const full = { errorMessages: body.errorMessages ?? [], errors: body.errors ?? {} }
  responses.push({
    status,
    ok: false,
    json: async () => full,
    text: async () => JSON.stringify(full),
  })
}
function push429(retryAfter?: string, reason?: string) {
  const headers: Record<string, string> = {}
  if (retryAfter) headers['retry-after'] = retryAfter
  if (reason) headers['ratelimit-reason'] = reason
  responses.push({ status: 429, ok: false, json: async () => ({}), text: async () => '', headers })
}
function pushNoContent() {
  responses.push({ status: 204, ok: true, text: async () => '' })
}

const CLOUD = 'cafe0123'
const BASE = 'https://api.atlassian.com/ex/jira/cafe0123/rest/api/3'

beforeEach(() => {
  responses = []
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    const next = responses.shift()
    if (!next) throw new Error(`no fake response queued for ${url}`)
    return {
      status: next.status ?? 200,
      ok: next.ok ?? true,
      json: next.json ?? (async () => ({})),
      text: next.text ?? (async () => ''),
      headers: {
        get: (name: string) => next.headers?.[name.toLowerCase()] ?? null,
      },
    } as unknown as Response
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---- Transport -------------------------------------------------------------

describe('jiraBaseUrl', () => {
  it('addresses the GATEWAY per cloudId, never the tenant site directly', () => {
    // A 3LO app cannot call https://acme.atlassian.net/rest/... at all.
    expect(jiraBaseUrl(CLOUD)).toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`)
  })

  /**
   * REGRESSION (review finding: "cloudId from a query param is interpolated
   * unencoded into the gateway URL"). Every picker route takes `cloudId`
   * straight from `searchParams` behind nothing but workspace membership, and
   * it lands in the PATH of a request made with the workspace's Jira token. The
   * value is REJECTED rather than encoded: a real cloudId is a UUID, so
   * encoding is a no-op for every legitimate value and merely disguises a
   * hostile one.
   */
  it('REFUSES a cloudId carrying path or query characters', () => {
    const hostile = `${CLOUD}/rest/api/3/filter/search?x=`
    expect(() => jiraBaseUrl(hostile)).toThrow(JiraInvalidIdentifierError)
    // …and the ordinary shapes of nonsense too.
    for (const bad of ['', 'not a uuid', '../../admin', 'cloud-1', 'zzzzzzzz']) {
      expect(() => jiraBaseUrl(bad)).toThrow(JiraInvalidIdentifierError)
    }
  })

  it('accepts a real Atlassian cloudId (a UUID)', () => {
    const uuid = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
    expect(jiraBaseUrl(uuid)).toContain(`/ex/jira/${uuid}/`)
  })
})

describe('isNumericJiraId', () => {
  /**
   * REGRESSION (review finding: "project_id is stored unvalidated and
   * interpolated straight into the webhook's JQL filter"). `project = 10000 OR
   * assignee != null` is inside the restricted JQL subset webhooks accept, so a
   * widened filter registers cleanly and then delivers the whole tenant.
   */
  it('accepts digits only — the shape Atlassian mints', () => {
    expect(isNumericJiraId('10000')).toBe(true)
    for (const bad of ['10000 OR assignee != null', '10000;', '1e4', '', 'ENG', ' 10000']) {
      expect(isNumericJiraId(bad)).toBe(false)
    }
  })
})

describe('jiraFetch — auth, no envelope, errors', () => {
  it('sends a bearer token and returns the body RAW (no data unwrap)', async () => {
    pushJson({ id: '10001', key: 'ENG-1' })
    const result = await jiraFetch('tok-123', CLOUD, '/issue/10001')
    // Asana would have needed `.data` here; Jira returns the resource itself.
    expect(result).toEqual({ id: '10001', key: 'ENG-1' })

    const headers = requests[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(requests[0].url).toBe(`${BASE}/issue/10001`)
  })

  it('returns null on 204 No Content without parsing a body', async () => {
    pushNoContent()
    expect(await jiraFetch('tok', CLOUD, '/x', { method: 'POST' })).toBeNull()
  })

  it('returns null on a 200 with an empty body', async () => {
    responses.push({ status: 200, ok: true, text: async () => '' })
    expect(await jiraFetch('tok', CLOUD, '/x')).toBeNull()
  })

  it('returns null rather than throwing on a 200 with unparseable JSON', async () => {
    responses.push({ status: 200, ok: true, text: async () => '<html>oops</html>' })
    expect(await jiraFetch('tok', CLOUD, '/x')).toBeNull()
  })

  it('throws a distinct JiraUnauthorizedError on 401', async () => {
    responses.push({ status: 401, ok: false, text: async () => '' })
    await expect(jiraFetch('tok', CLOUD, '/x')).rejects.toBeInstanceOf(JiraUnauthorizedError)
  })

  it('throws JiraApiError(404) — the "issue was deleted" signal', async () => {
    pushError(404, { errorMessages: ['Issue does not exist or you do not have permission'] })
    const err = (await jiraFetch('tok', CLOUD, '/issue/1').catch((e) => e)) as JiraApiError
    expect(err).toBeInstanceOf(JiraApiError)
    expect(err.status).toBe(404)
    expect(isJiraNotFound(err)).toBe(true)
  })

  it('carries the per-field `errors` map onto the thrown error', async () => {
    // This is what the push branches on to retry without duedate — the field KEY
    // is stable, the sentence is not.
    pushError(400, {
      errors: {
        duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown.",
      },
    })
    const err = (await createIssue('tok', CLOUD, {
      fields: { project: { id: '1' }, issuetype: { id: '2' }, summary: 's' },
    }).catch((e) => e)) as JiraApiError

    expect(err).toBeInstanceOf(JiraApiError)
    expect(err.status).toBe(400)
    expect(Object.keys(err.fieldErrors)).toEqual(['duedate'])
    expect(err.message).toContain('duedate:')
  })

  it('flattens errorMessages into the message when there are no field errors', async () => {
    pushError(400, { errorMessages: ['Invalid request payload.'] })
    const err = (await jiraFetch('tok', CLOUD, '/x').catch((e) => e)) as JiraApiError
    expect(err.message).toContain('Invalid request payload.')
    expect(err.fieldErrors).toEqual({})
  })
})

describe('describeErrorBody', () => {
  it('merges general messages and field errors, keyed output for the field half', () => {
    const { message, fieldErrors } = describeErrorBody(
      JSON.stringify({ errorMessages: ['nope'], errors: { summary: 'is required' } }),
    )
    expect(message).toBe('nope; summary: is required')
    expect(fieldErrors).toEqual({ summary: 'is required' })
  })

  it('falls back to truncated raw text for a non-JSON body', () => {
    const { message, fieldErrors } = describeErrorBody('<html>500</html>')
    expect(message).toBe('<html>500</html>')
    expect(fieldErrors).toEqual({})
  })

  it('falls back to raw text when both halves are empty', () => {
    const raw = JSON.stringify({ errorMessages: [], errors: {} })
    expect(describeErrorBody(raw).message).toBe(raw)
  })

  it('ignores non-string field messages rather than stringifying junk', () => {
    const { fieldErrors } = describeErrorBody(
      JSON.stringify({ errors: { summary: 'bad', weird: { nested: true } } }),
    )
    expect(fieldErrors).toEqual({ summary: 'bad' })
  })

  it('is empty for an empty body', () => {
    expect(describeErrorBody('')).toEqual({ message: '', fieldErrors: {} })
  })
})

describe('jiraFetch — 429 handling', () => {
  it('HONORS Retry-After and retries once', async () => {
    vi.useFakeTimers()
    push429('1')
    pushJson({ id: '1' })

    const promise = jiraFetch('tok', CLOUD, '/issue/1')
    await vi.advanceTimersByTimeAsync(1300)
    await expect(promise).resolves.toEqual({ id: '1' })
    expect(requests).toHaveLength(2)
  })

  it('falls back to exponential backoff when Retry-After is absent', async () => {
    vi.useFakeTimers()
    push429()
    pushJson({ id: '1' })

    const promise = jiraFetch('tok', CLOUD, '/issue/1')
    await vi.advanceTimersByTimeAsync(1300)
    await expect(promise).resolves.toEqual({ id: '1' })
  })

  /**
   * REGRESSION (review finding: "429 Retry-After is honored with no upper
   * bound, pinning the function for up to an hour"). Jira's points quota resets
   * on the UTC hour and is shared across every tenant of this app, so a
   * Retry-After measured in tens of minutes is an ordinary answer — and
   * sleeping it holds a Vercel function until maxDuration kills it (the picker
   * route a user is typing into becomes a hung spinner, then a 504) or blows an
   * Inngest step timeout mid-page, losing the walk and its cursor.
   */
  it('THROWS instead of sleeping when Retry-After is past the 60s cap', async () => {
    vi.useFakeTimers()
    push429('2400', 'jira-quota-global-based')

    const err = (await jiraFetch('tok', CLOUD, '/issue/1').catch((e) => e)) as JiraApiError

    expect(err).toBeInstanceOf(JiraApiError)
    expect(err.status).toBe(429)
    expect(err.message).toContain('2400')
    // One request, no second attempt, and — crucially — nothing was slept on:
    // the fake timers were never advanced and the promise already settled.
    expect(requests).toHaveLength(1)
  })

  it('still honors a Retry-After AT the cap', async () => {
    vi.useFakeTimers()
    push429('60')
    pushJson({ id: '1' })

    const promise = jiraFetch('tok', CLOUD, '/issue/1')
    await vi.advanceTimersByTimeAsync(60_300)
    await expect(promise).resolves.toEqual({ id: '1' })
    expect(requests).toHaveLength(2)
  })

  it('gives up after the attempt cap and reports the RateLimit-Reason', async () => {
    vi.useFakeTimers()
    // The reason header is what makes a real incident diagnosable: a burst 429
    // and an hourly-quota 429 need completely different responses.
    push429('0', 'jira-quota-global-based')
    push429('0', 'jira-quota-global-based')
    push429('0', 'jira-quota-global-based')

    const promise = jiraFetch('tok', CLOUD, '/issue/1').catch((e) => e)
    await vi.advanceTimersByTimeAsync(5000)
    const err = (await promise) as JiraApiError
    expect(err).toBeInstanceOf(JiraApiError)
    expect(err.status).toBe(429)
    expect(err.message).toContain('jira-quota-global-based')
    expect(requests).toHaveLength(3)
  })
})

// ---- Account scope ---------------------------------------------------------

describe('listAccessibleResources', () => {
  it('hits the ACCOUNT-level endpoint with no cloudId in the path', async () => {
    pushJson([{ id: 'c1', name: 'Acme', url: 'https://acme.atlassian.net' }])
    const sites = await listAccessibleResources('tok')

    expect(requests[0].url).toBe('https://api.atlassian.com/oauth/token/accessible-resources')
    expect(sites).toEqual([{ id: 'c1', name: 'Acme', url: 'https://acme.atlassian.net' }])
  })

  it('returns [] when the body is not an array', async () => {
    pushJson({ nope: true })
    expect(await listAccessibleResources('tok')).toEqual([])
  })

  it('returns MULTIPLE sites unfiltered — the user picks, we never assume 1:1', async () => {
    pushJson([{ id: 'c1' }, { id: 'c2' }])
    expect(await listAccessibleResources('tok')).toHaveLength(2)
  })
})

// ---- Pickers ---------------------------------------------------------------

describe('searchProjects', () => {
  it('sends query + offset paging and reports the next startAt', async () => {
    pushJson({ values: [{ id: '1', key: 'ENG' }, { id: '2', key: 'OPS' }], isLast: false, startAt: 0 })
    const page = await searchProjects('tok', CLOUD, { query: 'eng' })

    const url = new URL(requests[0].url)
    expect(url.pathname).toBe('/ex/jira/cafe0123/rest/api/3/project/search')
    expect(url.searchParams.get('query')).toBe('eng')
    expect(url.searchParams.get('startAt')).toBe('0')
    expect(page.projects).toHaveLength(2)
    expect(page.isLast).toBe(false)
    expect(page.nextStartAt).toBe(2)
  })

  it('reports nextStartAt null on the last page', async () => {
    pushJson({ values: [{ id: '1', key: 'ENG' }], isLast: true, startAt: 0 })
    const page = await searchProjects('tok', CLOUD)
    expect(page.nextStartAt).toBeNull()
  })

  it('treats a bodyless response as an exhausted, empty page', async () => {
    pushJson(null)
    const page = await searchProjects('tok', CLOUD)
    expect(page).toEqual({ projects: [], isLast: true, nextStartAt: null })
  })

  it('omits query entirely when none was given', async () => {
    pushJson({ values: [], isLast: true })
    await searchProjects('tok', CLOUD)
    expect(new URL(requests[0].url).searchParams.has('query')).toBe(false)
  })
})

describe('listCreateMetaIssueTypes', () => {
  it('uses the GRANULAR createmeta path (not the deprecated all-in-one endpoint)', async () => {
    pushJson({ issueTypes: [{ id: '1', name: 'Task', subtask: false }] })
    const types = await listCreateMetaIssueTypes('tok', CLOUD, 'ENG')

    expect(requests[0].url).toContain('/issue/createmeta/ENG/issuetypes')
    expect(types).toEqual([{ id: '1', name: 'Task', subtask: false }])
  })

  it('returns the raw list INCLUDING subtasks — filtering is the caller\'s call', async () => {
    pushJson({ issueTypes: [{ id: '1', subtask: false }, { id: '2', subtask: true }] })
    expect(await listCreateMetaIssueTypes('tok', CLOUD, '10000')).toHaveLength(2)
  })

  it('url-encodes a project key with awkward characters', async () => {
    pushJson({ issueTypes: [] })
    await listCreateMetaIssueTypes('tok', CLOUD, 'A B')
    expect(requests[0].url).toContain('/issue/createmeta/A%20B/issuetypes')
  })

  it('returns [] when the body carries no issueTypes', async () => {
    pushJson({})
    expect(await listCreateMetaIssueTypes('tok', CLOUD, 'ENG')).toEqual([])
  })
})

describe('listProjectStatuses + dedupeProjectStatuses', () => {
  it('fetches the per-issue-type grouping verbatim', async () => {
    pushJson([{ id: '1', name: 'Bug', statuses: [{ id: '10', name: 'To Do' }] }])
    const groups = await listProjectStatuses('tok', CLOUD, '10000')
    expect(requests[0].url).toBe(`${BASE}/project/10000/statuses`)
    expect(groups).toHaveLength(1)
  })

  it('DE-DUPES across issue types by status id, keeping first-seen order', async () => {
    // Company-managed projects give each issue type its own workflow, so the
    // same status legitimately appears many times. The mapping UI wants one row.
    const flat = dedupeProjectStatuses([
      {
        id: '1',
        name: 'Bug',
        statuses: [
          { id: '10', name: 'To Do', statusCategory: { key: 'new' } },
          { id: '11', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        ],
      },
      {
        id: '2',
        name: 'Task',
        statuses: [
          { id: '11', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          { id: '12', name: 'Done', statusCategory: { key: 'done' } },
        ],
      },
    ])

    expect(flat).toEqual([
      { id: '10', name: 'To Do', category: 'new' },
      { id: '11', name: 'In Progress', category: 'indeterminate' },
      { id: '12', name: 'Done', category: 'done' },
    ])
  })

  it('falls back to the id as the name and null as the category', async () => {
    expect(dedupeProjectStatuses([{ id: '1', statuses: [{ id: '10' }] }])).toEqual([
      { id: '10', name: '10', category: null },
    ])
  })

  it('skips entries with no usable id and tolerates a missing statuses array', () => {
    expect(
      dedupeProjectStatuses([
        { id: '1' },
        { id: '2', statuses: [{ id: '' } as never, { id: '10', name: 'To Do' }] },
      ]),
    ).toEqual([{ id: '10', name: 'To Do', category: null }])
  })

  it('returns [] when the endpoint answers a non-array', async () => {
    pushJson({ nope: true })
    expect(await listProjectStatuses('tok', CLOUD, '1')).toEqual([])
  })
})

// ---- Issues ----------------------------------------------------------------

describe('createIssue', () => {
  it('POSTs the fields envelope verbatim', async () => {
    pushJson({ id: '10001', key: 'ENG-42', self: 'https://…' })
    const issue = await createIssue('tok', CLOUD, {
      fields: {
        project: { id: '10000' },
        issuetype: { id: '10' },
        summary: 'Ship it',
        duedate: '2026-07-30',
      },
    })

    expect(requests[0].url).toBe(`${BASE}/issue`)
    expect(requests[0].init?.method).toBe('POST')
    expect(JSON.parse(requests[0].init?.body as string)).toEqual({
      fields: {
        project: { id: '10000' },
        issuetype: { id: '10' },
        summary: 'Ship it',
        duedate: '2026-07-30',
      },
    })
    // The create response carries NO status — which is why the push reads back.
    expect(issue).toEqual({ id: '10001', key: 'ENG-42', self: 'https://…' })
  })
})

describe('getIssue', () => {
  it('requests fields=status by default — statusCategory is NESTED inside it', async () => {
    pushJson({
      id: '1',
      fields: { status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    })
    const issue = await getIssue('tok', CLOUD, '1')

    expect(new URL(requests[0].url).searchParams.get('fields')).toBe('status')
    expect(issueStatusName(issue)).toBe('In Progress')
    expect(issueStatusCategoryKey(issue)).toBe('indeterminate')
  })

  it('accepts an explicit field list', async () => {
    pushJson({ id: '1' })
    await getIssue('tok', CLOUD, '1', 'status,summary')
    expect(new URL(requests[0].url).searchParams.get('fields')).toBe('status,summary')
  })

  it('reads null for a missing status rather than throwing', () => {
    expect(issueStatusName({ id: '1' })).toBeNull()
    expect(issueStatusCategoryKey({ id: '1' })).toBeNull()
    expect(issueStatusName(null)).toBeNull()
    expect(issueStatusCategoryKey(undefined)).toBeNull()
  })
})

describe('getTransitions', () => {
  it('ALWAYS expands transitions.fields', async () => {
    // Without the expand there is no way to see that a transition requires a
    // resolution, and the POST 400s with no warning.
    pushJson({ transitions: [{ id: '31', name: 'Done', to: { id: '3' } }] })
    const transitions = await getTransitions('tok', CLOUD, '10001')

    expect(requests[0].url).toBe(
      `${BASE}/issue/10001/transitions?expand=transitions.fields`,
    )
    expect(transitions).toHaveLength(1)
  })

  it('returns [] when the body carries no transitions', async () => {
    pushJson({})
    expect(await getTransitions('tok', CLOUD, '1')).toEqual([])
  })
})

describe('transitionIssue', () => {
  it('POSTs the transition id and optional screen fields, tolerating 204', async () => {
    pushNoContent()
    await transitionIssue('tok', CLOUD, 'ENG-42', {
      transition: { id: '31' },
      fields: { resolution: { name: 'Done' } },
    })

    expect(requests[0].url).toBe(`${BASE}/issue/ENG-42/transitions`)
    expect(JSON.parse(requests[0].init?.body as string)).toEqual({
      transition: { id: '31' },
      fields: { resolution: { name: 'Done' } },
    })
  })

  it('lets a 409 Conflict propagate — retrying is the ECHO\'s decision', async () => {
    // Only the caller knows whether the transition it chose is still the right
    // one to replay, so the client stays dumb about concurrency.
    pushError(409, { errorMessages: ['concurrent transition'] })
    const err = (await transitionIssue('tok', CLOUD, '1', {
      transition: { id: '31' },
    }).catch((e) => e)) as JiraApiError
    expect(err.status).toBe(409)
  })
})

describe('searchUsers', () => {
  it('sends the query and returns matches', async () => {
    pushJson([{ accountId: 'acc-1', emailAddress: 'ada@example.com' }])
    const users = await searchUsers('tok', CLOUD, 'ada@example.com')
    expect(new URL(requests[0].url).searchParams.get('query')).toBe('ada@example.com')
    expect(users).toHaveLength(1)
  })

  it('returns [] for the documented empty-over-3LO case rather than throwing', async () => {
    // This endpoint is reported to answer empty under OAuth 3LO even for users
    // that exist — an EXPECTED outcome the push has to survive.
    pushJson([])
    expect(await searchUsers('tok', CLOUD, 'nobody@example.com')).toEqual([])
  })

  it('returns [] when the body is not an array', async () => {
    pushJson({ error: 'nope' })
    expect(await searchUsers('tok', CLOUD, 'x')).toEqual([])
  })
})

describe('assignIssue', () => {
  it('PUTs accountId ONLY (GDPR removed name/key identification)', async () => {
    pushNoContent()
    await assignIssue('tok', CLOUD, '10001', 'acc-1')
    expect(requests[0].url).toBe(`${BASE}/issue/10001/assignee`)
    expect(requests[0].init?.method).toBe('PUT')
    expect(JSON.parse(requests[0].init?.body as string)).toEqual({ accountId: 'acc-1' })
  })
})

describe('deleteIssue — best-effort, never throws', () => {
  it('deletes the issue', async () => {
    pushNoContent()
    await expect(deleteIssue('tok', CLOUD, '10001')).resolves.toBeUndefined()
    expect(requests[0].init?.method).toBe('DELETE')
  })

  it('swallows a 404 — the desired end-state already holds', async () => {
    pushError(404, { errorMessages: ['gone'] })
    await expect(deleteIssue('tok', CLOUD, '10001')).resolves.toBeUndefined()
  })

  it('swallows a 403 — "Delete Issues" is a SEPARATE permission from create', async () => {
    // The single most likely outcome in a real instance: the connected user can
    // create but not delete. The push it is cleaning up after already succeeded.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushError(403, { errorMessages: ['You do not have permission to delete issues'] })
    await expect(deleteIssue('tok', CLOUD, '10001')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('swallows a 401 too — a tidy-up must never fail a resolved push', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    responses.push({ status: 401, ok: false, text: async () => '' })
    await expect(deleteIssue('tok', CLOUD, '10001')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

// ---- Dynamic webhooks ------------------------------------------------------

describe('registerWebhooks', () => {
  it('POSTs the registration and returns the per-entry results', async () => {
    pushJson({ webhookRegistrationResult: [{ createdWebhookId: 6000 }] })

    const results = await registerWebhooks('tok', CLOUD, {
      url: 'https://nativeintelligence.dev/api/webhooks/jira',
      webhooks: [
        {
          events: ['jira:issue_updated', 'jira:issue_deleted'],
          jqlFilter: 'project = 10000',
          fieldIdsFilter: ['status'],
        },
      ],
    })

    expect(results).toEqual([{ createdWebhookId: 6000 }])
    expect(requests[0].url).toBe(`${BASE}/webhook`)
    expect(requests[0].init?.method).toBe('POST')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      url: 'https://nativeintelligence.dev/api/webhooks/jira',
      webhooks: [
        {
          events: ['jira:issue_updated', 'jira:issue_deleted'],
          jqlFilter: 'project = 10000',
          fieldIdsFilter: ['status'],
        },
      ],
    })
  })

  it('surfaces PARTIAL FAILURE — a 200 says nothing about the entries', async () => {
    // The documented shape: one result per requested webhook, each carrying
    // either an id or its own errors. Assuming all-or-nothing from the status
    // code would record a registration that does not exist.
    pushJson({
      webhookRegistrationResult: [
        { createdWebhookId: 6000 },
        { errors: ['The clause myClause is unsupported'] },
      ],
    })

    const results = await registerWebhooks('tok', CLOUD, { url: 'https://x/y', webhooks: [] })
    expect(results).toEqual([
      { createdWebhookId: 6000 },
      { errors: ['The clause myClause is unsupported'] },
    ])
  })

  it('returns an empty list rather than throwing on an unexpected body', async () => {
    pushJson({})
    expect(await registerWebhooks('tok', CLOUD, { url: 'https://x/y', webhooks: [] })).toEqual([])
  })

  it('propagates a 403 — "the caller isn\'t an app" has no runtime recovery', async () => {
    pushError(403, { errorMessages: ['The caller is not an app'] })
    await expect(
      registerWebhooks('tok', CLOUD, { url: 'https://x/y', webhooks: [] }),
    ).rejects.toBeInstanceOf(JiraApiError)
  })
})

describe('listWebhooks', () => {
  it('reads one offset page and reports the next cursor', async () => {
    pushJson({
      values: [{ id: 6000, url: 'https://nativeintelligence.dev/api/webhooks/jira' }],
      isLast: false,
      startAt: 0,
    })

    const page = await listWebhooks('tok', CLOUD, { startAt: 0 })

    expect(page.webhooks).toHaveLength(1)
    expect(page.isLast).toBe(false)
    expect(page.nextStartAt).toBe(1)
    expect(requests[0].url).toBe(`${BASE}/webhook?startAt=0&maxResults=50`)
  })

  it('reports no next cursor on the last page', async () => {
    pushJson({ values: [], isLast: true, startAt: 0 })
    expect((await listWebhooks('tok', CLOUD)).nextStartAt).toBeNull()
  })

  it('treats a body with no values as an empty last page', async () => {
    pushJson({})
    expect(await listWebhooks('tok', CLOUD)).toEqual({
      webhooks: [],
      isLast: true,
      nextStartAt: null,
    })
  })
})

describe('refreshWebhooks', () => {
  it('PUTs the ids and returns the single shared expiry', async () => {
    // One expirationDate covers every id in the call — not one per id.
    pushJson({ expirationDate: 1_800_000_000_000 })

    const result = await refreshWebhooks('tok', CLOUD, [6000, 6001])

    expect(result).toEqual({ expirationDate: 1_800_000_000_000 })
    expect(requests[0].url).toBe(`${BASE}/webhook/refresh`)
    expect(requests[0].init?.method).toBe('PUT')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ webhookIds: [6000, 6001] })
  })

  it('reports a null expiry when the body omits one', async () => {
    pushJson({})
    expect(await refreshWebhooks('tok', CLOUD, [6000])).toEqual({ expirationDate: null })
  })
})

describe('deleteWebhooks', () => {
  it('DELETEs with the id list in the body', async () => {
    pushNoContent()
    await deleteWebhooks('tok', CLOUD, [6000])

    expect(requests[0].url).toBe(`${BASE}/webhook`)
    expect(requests[0].init?.method).toBe('DELETE')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ webhookIds: [6000] })
  })

  it('does not call Jira at all for an empty list', async () => {
    await deleteWebhooks('tok', CLOUD, [])
    expect(requests).toHaveLength(0)
  })

  it('NEVER throws — every caller is mid-teardown or mid-re-register', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushError(500, { errorMessages: ['boom'] })
    await expect(deleteWebhooks('tok', CLOUD, [6000])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows a 404 silently — the desired end state already holds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushError(404, { errorMessages: ['gone'] })
    await expect(deleteWebhooks('tok', CLOUD, [6000])).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
