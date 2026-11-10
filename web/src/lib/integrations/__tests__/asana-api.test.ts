import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  asanaFetch,
  addTaskToSection,
  createTask,
  createWebhook,
  deleteTask,
  deleteWebhook,
  getMe,
  getTask,
  getWebhook,
  webhookResourceGid,
  listProjects,
  listSections,
  listWorkspaces,
  listWorkspaceUsers,
  typeaheadProjects,
  typeaheadUsers,
  updateTaskCompleted,
  AsanaApiError,
  AsanaInvalidGidError,
  AsanaUnauthorizedError,
} from '@/lib/integrations/asana-api'

/**
 * Tests for src/lib/integrations/asana-api.ts.
 *
 * Invariants locked in:
 *  - the `data` envelope is unwrapped on every response and wrapped on every
 *    write body (Asana's universal convention).
 *  - 429 backoff HONORS the Retry-After header (Asana always sends one), falls
 *    back to exponential only when it's absent, and throws after the cap.
 *  - 401 → distinct AsanaUnauthorizedError; other non-2xx → AsanaApiError whose
 *    message carries the parsed `errors[].message`.
 *  - listProjects reads the offset cursor from OUTSIDE the data envelope.
 *  - createTask never sends both due_on and due_at (the caller's job, but the
 *    body must pass through verbatim) and always asks for permalink_url.
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
/** An Asana error body: { errors: [{ message }] }. */
function pushError(status: number, message: string) {
  const body = { errors: [{ message }] }
  responses.push({
    status,
    ok: false,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}
function push429(retryAfter?: string) {
  responses.push({
    status: 429,
    ok: false,
    json: async () => ({}),
    text: async () => '',
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
  })
}

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

describe('asanaFetch — auth, envelope, errors', () => {
  it('sends a bearer token and UNWRAPS the top-level data envelope', async () => {
    pushJson({ data: { gid: '1', name: 'Acme' } })
    const result = await asanaFetch('tok-123', '/workspaces')
    expect(result).toEqual({ gid: '1', name: 'Acme' })

    const headers = requests[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(requests[0].url).toBe('https://app.asana.com/api/1.0/workspaces')
  })

  it('returns null when the body carries no data key', async () => {
    pushJson({})
    expect(await asanaFetch('tok', '/x')).toBeNull()
  })

  it('returns null on 204 No Content without parsing a body', async () => {
    responses.push({ status: 204, ok: true })
    expect(await asanaFetch('tok', '/x', { method: 'POST' })).toBeNull()
  })

  it('throws a distinct AsanaUnauthorizedError on 401', async () => {
    pushError(401, 'Not Authorized')
    await expect(asanaFetch('tok', '/x')).rejects.toBeInstanceOf(AsanaUnauthorizedError)
  })

  it('throws AsanaApiError carrying the status and the parsed errors[].message', async () => {
    pushError(400, 'due_on: Invalid date')
    const err = await asanaFetch('tok', '/tasks', { method: 'POST' }).catch((e) => e)
    expect(err).toBeInstanceOf(AsanaApiError)
    expect((err as AsanaApiError).status).toBe(400)
    expect((err as AsanaApiError).message).toContain('due_on: Invalid date')
  })

  it('falls back to raw text when the error body is not the documented shape', async () => {
    responses.push({
      status: 500,
      ok: false,
      json: async () => ({}),
      text: async () => '<html>gateway</html>',
    })
    const err = await asanaFetch('tok', '/x').catch((e) => e)
    expect((err as AsanaApiError).status).toBe(500)
    expect((err as AsanaApiError).message).toContain('<html>gateway</html>')
  })
})

describe('asanaFetch — 429 backoff honors Retry-After', () => {
  it('waits exactly the Retry-After seconds, then succeeds', async () => {
    vi.useFakeTimers()
    push429('5') // Asana asks for 5s
    pushJson({ data: { ok: true } })

    const promise = asanaFetch('tok', '/x')
    // Not yet: the client must still be sleeping out the 5s (plus <250ms jitter).
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(await promise).toEqual({ ok: true })
    expect(requests).toHaveLength(2)
  })

  it('falls back to exponential backoff when Retry-After is absent', async () => {
    vi.useFakeTimers()
    push429() // no header
    pushJson({ data: { ok: true } })

    const promise = asanaFetch('tok', '/x')
    await vi.advanceTimersByTimeAsync(2000) // 1s base + jitter
    expect(await promise).toEqual({ ok: true })
    expect(requests).toHaveLength(2)
  })

  /**
   * REGRESSION (round-1 audit, api-edges issue 3): this expression was the
   * byte-equivalent twin of the unbounded Jira one, and the harm is identical —
   * `retryAfter * 1000` with no ceiling sleeps a Vercel function until
   * maxDuration kills it (a user-facing route becomes a hung spinner, then a
   * 504) or blows an Inngest step timeout mid-page, losing the walk. Past the
   * cap we throw the retryable 429 and let the caller's own backoff — Inngest's,
   * for every background path — own the wait.
   */
  it('THROWS instead of sleeping when Retry-After is past the 60s cap', async () => {
    vi.useFakeTimers()
    push429('2400')

    const err = (await asanaFetch('tok', '/x').catch((e) => e)) as AsanaApiError

    expect(err).toBeInstanceOf(AsanaApiError)
    expect(err.status).toBe(429)
    expect(err.message).toContain('2400')
    // One request, no second attempt, and nothing was slept on: the fake timers
    // were never advanced and the promise has already settled.
    expect(requests).toHaveLength(1)
  })

  it('still honors a Retry-After AT the cap', async () => {
    vi.useFakeTimers()
    push429('60')
    pushJson({ data: { ok: true } })

    const promise = asanaFetch('tok', '/x')
    await vi.advanceTimersByTimeAsync(60_300)
    expect(await promise).toEqual({ ok: true })
    expect(requests).toHaveLength(2)
  })

  it('throws AsanaApiError(429) after the attempt cap', async () => {
    vi.useFakeTimers()
    push429('1')
    push429('1')
    push429('1')

    const settled = asanaFetch('tok', '/x').catch((e) => e)
    await vi.advanceTimersByTimeAsync(20000)
    const err = await settled
    expect(err).toBeInstanceOf(AsanaApiError)
    expect((err as AsanaApiError).status).toBe(429)
    // Exactly MAX_ATTEMPTS (3) requests were made.
    expect(requests).toHaveLength(3)
  })
})

describe('getMe', () => {
  it('reads /users/me and unwraps the identity', async () => {
    pushJson({ data: { gid: 'u1', name: 'Ada', email: 'ada@example.com' } })
    const me = await getMe('tok')
    expect(me.email).toBe('ada@example.com')
    expect(requests[0].url).toContain('/users/me')
  })
})

describe('pickers', () => {
  it('listWorkspaces requests gid+name and returns [] on an empty payload', async () => {
    pushJson({ data: null })
    expect(await listWorkspaces('tok')).toEqual([])
    expect(requests[0].url).toContain('opt_fields=gid,name')
  })

  it('listProjects caps limit, excludes archived, and reads next_page.offset', async () => {
    pushJson({
      data: [{ gid: 'p1', name: 'Eng' }],
      // The cursor lives OUTSIDE the data envelope — the one place the client
      // must not unwrap.
      next_page: { offset: 'eyJ0eXAi' },
    })
    const res = await listProjects('tok', 'w1', { limit: 500, offset: 'prev' })

    const url = new URL(requests[0].url)
    expect(url.pathname).toBe('/api/1.0/workspaces/w1/projects')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('archived')).toBe('false')
    expect(url.searchParams.get('offset')).toBe('prev')
    expect(res.projects).toEqual([{ gid: 'p1', name: 'Eng' }])
    expect(res.nextOffset).toBe('eyJ0eXAi')
  })

  it('listProjects reports exhaustion as a null cursor', async () => {
    pushJson({ data: [{ gid: 'p1', name: 'Eng' }] })
    const res = await listProjects('tok', 'w1')
    expect(res.nextOffset).toBeNull()
  })

  it('typeaheadProjects passes resource_type=project and the query', async () => {
    pushJson({ data: [{ gid: 'p9', name: 'Growth' }] })
    const res = await typeaheadProjects('tok', 'w1', 'gro')

    const url = new URL(requests[0].url)
    expect(url.pathname).toBe('/api/1.0/workspaces/w1/typeahead')
    expect(url.searchParams.get('resource_type')).toBe('project')
    expect(url.searchParams.get('query')).toBe('gro')
    expect(res).toEqual([{ gid: 'p9', name: 'Growth' }])
  })

  it('listSections reads the project sections', async () => {
    pushJson({ data: [{ gid: 's1', name: 'To do' }] })
    const res = await listSections('tok', 'p1')
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/projects/p1/sections')
    expect(res).toEqual([{ gid: 's1', name: 'To do' }])
  })
})

/**
 * REGRESSION (review finding: "Asana workspace gid raw-interpolated into API
 * path (no validation/encoding)").
 *
 * Every helper above builds its path by interpolating a caller-supplied gid,
 * and the routes upstream only check it is a non-empty string. A gid carrying
 * `/` or `?` therefore re-points the request at a DIFFERENT Asana endpoint
 * under the workspace's own token — bounded by what that token can reach, so
 * defense-in-depth rather than privilege escalation, but exactly the class
 * Jira's sibling client closes with CLOUD_ID_PATTERN.
 *
 * Validated at the CLIENT, not per-route, deliberately: the choke point covers
 * the new users route and the pre-existing projects/sections routes at once,
 * plus anything added later.
 */
describe('gid validation — the path-injection choke point', () => {
  const HOSTILE = [
    '123/projects?opt_fields=',
    '../../users/me',
    '123?opt_pretty=true',
    '123#frag',
    '',
    '   ',
  ]

  it('listProjects refuses a hostile workspace gid before any fetch', async () => {
    for (const gid of HOSTILE) {
      await expect(listProjects('tok', gid)).rejects.toBeInstanceOf(AsanaInvalidGidError)
    }
    expect(requests).toHaveLength(0)
  })

  it('typeaheadProjects refuses a hostile workspace gid before any fetch', async () => {
    for (const gid of HOSTILE) {
      await expect(typeaheadProjects('tok', gid, 'q')).rejects.toBeInstanceOf(
        AsanaInvalidGidError,
      )
    }
    expect(requests).toHaveLength(0)
  })

  it('listWorkspaceUsers refuses a hostile workspace gid before any fetch', async () => {
    for (const gid of HOSTILE) {
      await expect(listWorkspaceUsers('tok', gid)).rejects.toBeInstanceOf(AsanaInvalidGidError)
    }
    expect(requests).toHaveLength(0)
  })

  it('typeaheadUsers refuses a hostile workspace gid before any fetch', async () => {
    for (const gid of HOSTILE) {
      await expect(typeaheadUsers('tok', gid, 'q')).rejects.toBeInstanceOf(AsanaInvalidGidError)
    }
    expect(requests).toHaveLength(0)
  })

  it('listSections refuses a hostile project gid before any fetch', async () => {
    for (const gid of HOSTILE) {
      await expect(listSections('tok', gid)).rejects.toBeInstanceOf(AsanaInvalidGidError)
    }
    expect(requests).toHaveLength(0)
  })

  it('addTaskToSection refuses a hostile section gid before any fetch', async () => {
    await expect(addTaskToSection('tok', '123/tasks', 't1')).rejects.toBeInstanceOf(
      AsanaInvalidGidError,
    )
    expect(requests).toHaveLength(0)
  })

  it('names the offending field so the caller can report which id was bad', async () => {
    await expect(listSections('tok', '../x')).rejects.toThrow(/projectGid/)
    await expect(listWorkspaceUsers('tok', '../x')).rejects.toThrow(/workspaceGid/)
  })

  it('accepts an ordinary Asana gid', async () => {
    pushJson({ data: [{ gid: 's1', name: 'To do' }] })
    await expect(listSections('tok', '1201234567890123')).resolves.toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/projects/1201234567890123/sections')
  })
})

describe('task writes', () => {
  it('createTask WRAPS the payload in data and requests permalink_url back', async () => {
    pushJson({ data: { gid: 't1', permalink_url: 'https://app.asana.com/0/1/t1', completed: false } })
    const task = await createTask('tok', {
      name: 'Ship it',
      projects: ['p1'],
      html_notes: '<body>hi</body>',
      due_on: '2026-07-30',
    })

    expect(requests[0].init?.method).toBe('POST')
    const body = JSON.parse((requests[0].init?.body as string) ?? '{}')
    expect(body).toEqual({
      data: {
        name: 'Ship it',
        projects: ['p1'],
        html_notes: '<body>hi</body>',
        due_on: '2026-07-30',
      },
    })
    expect(requests[0].url).toContain('opt_fields=gid,permalink_url,completed,name')
    expect(task.permalink_url).toBe('https://app.asana.com/0/1/t1')
  })

  it('updateTaskCompleted PUTs { data: { completed } }', async () => {
    pushJson({ data: { gid: 't1', completed: true } })
    await updateTaskCompleted('tok', 't1', true)

    expect(requests[0].init?.method).toBe('PUT')
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/tasks/t1')
    expect(JSON.parse((requests[0].init?.body as string) ?? '{}')).toEqual({
      data: { completed: true },
    })
  })

  it('addTaskToSection POSTs { data: { task } } to the section', async () => {
    pushJson({ data: {} })
    await addTaskToSection('tok', 's2', 't1')

    expect(requests[0].init?.method).toBe('POST')
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/sections/s2/addTask')
    expect(JSON.parse((requests[0].init?.body as string) ?? '{}')).toEqual({
      data: { task: 't1' },
    })
  })

  it('getTask reads the current provider state', async () => {
    pushJson({ data: { gid: 't1', completed: true, name: 'Ship it' } })
    const task = await getTask('tok', 't1')
    expect(task.completed).toBe(true)
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/tasks/t1')
  })

  it('surfaces a 401 on a write as AsanaUnauthorizedError', async () => {
    pushError(401, 'Not Authorized')
    await expect(updateTaskCompleted('tok', 't1', true)).rejects.toBeInstanceOf(
      AsanaUnauthorizedError,
    )
  })

  it('surfaces a deleted task as AsanaApiError(404)', async () => {
    pushError(404, 'task: Not a recognized ID')
    const err = await getTask('tok', 'gone').catch((e) => e)
    expect(err).toBeInstanceOf(AsanaApiError)
    expect((err as AsanaApiError).status).toBe(404)
  })

  it('deleteTask DELETEs /tasks/{gid}', async () => {
    responses.push({ status: 204, ok: true, json: async () => null, text: async () => '' })
    await deleteTask('tok', 't1')

    expect(requests[0].init?.method).toBe('DELETE')
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/tasks/t1')
  })

  it('deleteTask NEVER throws — it is best-effort cleanup on a success path', async () => {
    // A 500 (or a 404, or a 401) while tidying up an orphan must not turn a
    // resolved push into a failure.
    pushError(500, 'Server Error')
    await expect(deleteTask('tok', 't1')).resolves.toBeUndefined()

    pushError(404, 'task: Not a recognized ID')
    await expect(deleteTask('tok', 'gone')).resolves.toBeUndefined()

    pushError(401, 'Not Authorized')
    await expect(deleteTask('tok', 't1')).resolves.toBeUndefined()
  })
})

// ---- Webhooks (Phase B) ----------------------------------------------------

/**
 * The webhook helpers' contracts, all of which the registration lifecycle
 * depends on:
 *  - create POSTs the {resource, target, filters} triple under the data
 *    envelope (the handshake is Asana's side of it and can't be unit-tested).
 *  - getWebhook maps 404 → null rather than throwing: a garbage-collected
 *    registration is the EXPECTED outcome there, and the caller re-creates.
 *  - deleteWebhook never throws (best-effort teardown, mirrors deleteTask).
 *  - webhookResourceGid reads both shapes Asana uses for `resource`.
 */
describe('asana-api — webhooks', () => {
  it('createWebhook POSTs resource + target + filters inside the data envelope', async () => {
    pushJson({ data: { gid: 'wh-1', active: true } })
    const created = await createWebhook('tok', {
      resource: 'proj-1',
      target: 'https://nativeintelligence.dev/api/webhooks/asana/tss-1',
      filters: [{ resource_type: 'task', action: 'changed', fields: ['completed'] }],
    })

    expect(created).toEqual({ gid: 'wh-1', active: true })
    expect(requests[0].init?.method).toBe('POST')
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/webhooks')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      data: {
        resource: 'proj-1',
        target: 'https://nativeintelligence.dev/api/webhooks/asana/tss-1',
        filters: [{ resource_type: 'task', action: 'changed', fields: ['completed'] }],
      },
    })
  })

  it('createWebhook surfaces a 401 as AsanaUnauthorizedError', async () => {
    pushError(401, 'Not Authorized')
    await expect(
      createWebhook('tok', { resource: 'p', target: 'https://x/y' }),
    ).rejects.toBeInstanceOf(AsanaUnauthorizedError)
  })

  it('getWebhook returns the registration on 200', async () => {
    pushJson({
      data: { gid: 'wh-1', active: true, resource: { gid: 'proj-1', resource_type: 'project' } },
    })
    const found = await getWebhook('tok', 'wh-1')
    expect(found?.gid).toBe('wh-1')
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/webhooks/wh-1')
  })

  it('getWebhook returns NULL on 404 instead of throwing', async () => {
    // Asana garbage-collects webhooks (24h of failures, or a deleted project);
    // the caller re-creates rather than failing the run.
    pushError(404, 'webhook: Not a recognized ID')
    await expect(getWebhook('tok', 'gone')).resolves.toBeNull()
  })

  it('getWebhook still THROWS on a non-404 failure', async () => {
    pushError(500, 'Server Error')
    await expect(getWebhook('tok', 'wh-1')).rejects.toBeInstanceOf(AsanaApiError)
  })

  it('deleteWebhook DELETEs /webhooks/{gid} and never throws', async () => {
    responses.push({ status: 204, ok: true, json: async () => null, text: async () => '' })
    await deleteWebhook('tok', 'wh-1')
    expect(requests[0].init?.method).toBe('DELETE')
    expect(new URL(requests[0].url).pathname).toBe('/api/1.0/webhooks/wh-1')

    pushError(500, 'Server Error')
    await expect(deleteWebhook('tok', 'wh-1')).resolves.toBeUndefined()

    pushError(404, 'webhook: Not a recognized ID')
    await expect(deleteWebhook('tok', 'gone')).resolves.toBeUndefined()

    pushError(401, 'Not Authorized')
    await expect(deleteWebhook('tok', 'wh-1')).resolves.toBeUndefined()
  })

  it('webhookResourceGid reads both the compact object and the bare-string shape', () => {
    expect(webhookResourceGid({ gid: 'wh', resource: { gid: 'proj-1' } })).toBe('proj-1')
    expect(webhookResourceGid({ gid: 'wh', resource: 'proj-2' })).toBe('proj-2')
    expect(webhookResourceGid({ gid: 'wh' })).toBeNull()
    expect(webhookResourceGid(null)).toBeNull()
  })
})
