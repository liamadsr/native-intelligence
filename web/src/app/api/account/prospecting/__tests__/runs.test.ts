/**
 * Integration tests for the prospecting RUN routes.
 *
 * Same tier as `./routes.test.ts`: the handler runs end to end from
 * `new Request()` → `Response`, with `api-auth` and `@/lib/prospecting/runs`
 * mocked. What is under test is the ROUTE's own job — parsing, and the mapping
 * from a lib result code to an HTTP status — not the lib logic, which has its
 * own tests.
 *
 * The mappings that matter and would otherwise be silent:
 *   - RUN_ALREADY_LIVE → 409 with that code in the ENVELOPE (not `details`),
 *     because two presses of Find is normal and the client branches on it
 *   - NOT_CANCELABLE → 409 (not 500): a finished run is not an error
 *   - NOT_FOUND → 404 for every cross-workspace id (not 403)
 *   - an EMPTY body on kickoff is valid — running with the list's own budget
 *     is the common case
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  createRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  requestCancel: vi.fn(),
  listRunCandidates: vi.fn(),
  listActiveRuns: vi.fn(),
}))

const WS = 'ws-1'
const USER = { id: 'user-1', email: 'ada@acme.test' }
const supabase = {} as never

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/prospecting/runs', () => ({
  createRun: hoisted.createRun,
  listRuns: hoisted.listRuns,
  getRun: hoisted.getRun,
  requestCancel: hoisted.requestCancel,
  listRunCandidates: hoisted.listRunCandidates,
  listActiveRuns: hoisted.listActiveRuns,
}))

const listRunsRoute = await import('@/app/api/account/prospecting/lists/[id]/runs/route')
const runRoute = await import('@/app/api/account/prospecting/runs/[id]/route')
const cancelRoute = await import('@/app/api/account/prospecting/runs/[id]/cancel/route')
const candidatesRoute = await import('@/app/api/account/prospecting/runs/[id]/candidates/route')
const activeRoute = await import('@/app/api/account/prospecting/runs/active/route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

/** Next's route handlers read `request.nextUrl`; a plain Request has none. */
function nextRequest(url: string, init: Parameters<typeof buildRequest>[0] = {}) {
  const req = buildRequest({ ...init, url })
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as never
}

const RUN = { id: 'run-1', status: 'queued', is_live: true }

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: USER, workspaceId: WS })
})

// ---------------------------------------------------------------------------
// POST /lists/[id]/runs — kickoff
// ---------------------------------------------------------------------------

describe('POST /api/account/prospecting/lists/[id]/runs', () => {
  const url = 'https://dial8.ai/api/account/prospecting/lists/list-1/runs'

  it('starts a run with no body at all', async () => {
    hoisted.createRun.mockResolvedValue({ ok: true, run: RUN })
    const res = await listRunsRoute.POST(nextRequest(url, { method: 'POST' }), params('list-1'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ run: RUN })
    expect(hoisted.createRun).toHaveBeenCalledWith(supabase, {
      workspaceId: WS,
      userId: USER.id,
      listId: 'list-1',
      budgetDollars: undefined,
    })
  })

  it('passes a budget override through', async () => {
    hoisted.createRun.mockResolvedValue({ ok: true, run: RUN })
    await listRunsRoute.POST(
      nextRequest(url, { method: 'POST', body: { budget_dollars: 5 } }),
      params('list-1'),
    )
    expect(hoisted.createRun).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ budgetDollars: 5 }),
    )
  })

  it('answers 200 — not 201 — when the companies joined the people search already running', async () => {
    hoisted.createRun.mockResolvedValue({ ok: true, run: RUN, joined: { appended: ['e2'] } })
    const res = await listRunsRoute.POST(
      nextRequest(url, { method: 'POST', body: { kind: 'people', entry_ids: ['e2'] } }),
      params('list-1'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: RUN, joined: { appended: ['e2'] } })
  })

  it('409s a second press with RUN_ALREADY_LIVE in the envelope', async () => {
    hoisted.createRun.mockResolvedValue({
      ok: false,
      code: 'RUN_ALREADY_LIVE',
      error: 'This list already has a run in progress',
    })
    const res = await listRunsRoute.POST(nextRequest(url, { method: 'POST' }), params('list-1'))
    expect(res.status).toBe(409)
    const body = await res.json()
    // The envelope's own `code` is what the client branches on — burying it in
    // `details.code` would leave `code` as the generic 'BAD_REQUEST'.
    expect(body.code).toBe('RUN_ALREADY_LIVE')
    expect(body.error).toBe('This list already has a run in progress')
  })

  it('400s an archived list with its own code', async () => {
    hoisted.createRun.mockResolvedValue({ ok: false, code: 'LIST_ARCHIVED', error: 'archived' })
    const res = await listRunsRoute.POST(nextRequest(url, { method: 'POST' }), params('list-1'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('LIST_ARCHIVED')
  })

  it('404s a cross-workspace list id', async () => {
    hoisted.createRun.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'List not found' })
    const res = await listRunsRoute.POST(nextRequest(url, { method: 'POST' }), params('list-1'))
    expect(res.status).toBe(404)
  })

  it('500s a DB_ERROR', async () => {
    hoisted.createRun.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'boom' })
    const res = await listRunsRoute.POST(nextRequest(url, { method: 'POST' }), params('list-1'))
    expect(res.status).toBe(500)
  })

  it('400s malformed JSON without touching the lib', async () => {
    const res = await listRunsRoute.POST(
      nextRequest(url, { method: 'POST', body: '{oops', raw: true }),
      params('list-1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only body as no body, not a parse error', async () => {
    hoisted.createRun.mockResolvedValue({ ok: true, run: RUN })
    const res = await listRunsRoute.POST(
      nextRequest(url, { method: 'POST', body: '  ', raw: true }),
      params('list-1'),
    )
    expect(res.status).toBe(201)
  })

  it('propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await listRunsRoute.POST(nextRequest(url, { method: 'POST' }), params('list-1'))
    expect(res.status).toBe(401)
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /lists/[id]/runs — history
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/lists/[id]/runs', () => {
  const url = 'https://dial8.ai/api/account/prospecting/lists/list-1/runs'

  it('returns the history', async () => {
    hoisted.listRuns.mockResolvedValue({ ok: true, runs: [RUN] })
    const res = await listRunsRoute.GET(nextRequest(url), params('list-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runs: [RUN] })
    expect(hoisted.listRuns).toHaveBeenCalledWith(supabase, {
      workspaceId: WS,
      listId: 'list-1',
      limit: undefined,
    })
  })

  it('passes a numeric limit through and ignores garbage', async () => {
    hoisted.listRuns.mockResolvedValue({ ok: true, runs: [] })
    await listRunsRoute.GET(nextRequest(`${url}?limit=5`), params('list-1'))
    expect(hoisted.listRuns).toHaveBeenCalledWith(supabase, expect.objectContaining({ limit: 5 }))
    await listRunsRoute.GET(nextRequest(`${url}?limit=abc`), params('list-1'))
    expect(hoisted.listRuns).toHaveBeenLastCalledWith(
      supabase,
      expect.objectContaining({ limit: undefined }),
    )
  })

  it('404s a cross-workspace list id', async () => {
    hoisted.listRuns.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'List not found' })
    const res = await listRunsRoute.GET(nextRequest(url), params('list-1'))
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /runs/[id] — the poll target
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/runs/[id]', () => {
  const url = 'https://dial8.ai/api/account/prospecting/runs/run-1'

  it('returns the run with is_live derived server-side', async () => {
    hoisted.getRun.mockResolvedValue({ ok: true, run: RUN })
    const res = await runRoute.GET(nextRequest(url), params('run-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: RUN, is_live: true })
  })

  it('reports a budget-exhausted run as not live so the poll stops', async () => {
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN, status: 'budget_exhausted', is_live: false },
    })
    const res = await runRoute.GET(nextRequest(url), params('run-1'))
    expect((await res.json()).is_live).toBe(false)
  })

  it('404s a cross-workspace run id', async () => {
    hoisted.getRun.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'Run not found' })
    const res = await runRoute.GET(nextRequest(url), params('run-1'))
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /runs/[id]/cancel
// ---------------------------------------------------------------------------

describe('POST /api/account/prospecting/runs/[id]/cancel', () => {
  const url = 'https://dial8.ai/api/account/prospecting/runs/run-1/cancel'

  it('returns the canceling run — NOT canceled, which the engine writes', async () => {
    hoisted.requestCancel.mockResolvedValue({
      ok: true,
      run: { ...RUN, status: 'canceling', is_live: true },
    })
    const res = await cancelRoute.POST(nextRequest(url, { method: 'POST' }), params('run-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'canceling' })
    expect(hoisted.requestCancel).toHaveBeenCalledWith(supabase, {
      workspaceId: WS,
      runId: 'run-1',
    })
  })

  it('409s a run that already finished', async () => {
    hoisted.requestCancel.mockResolvedValue({
      ok: false,
      code: 'NOT_CANCELABLE',
      error: 'This run has already finished',
    })
    const res = await cancelRoute.POST(nextRequest(url, { method: 'POST' }), params('run-1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NOT_CANCELABLE')
  })

  it('404s a cross-workspace run id', async () => {
    hoisted.requestCancel.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'Run not found' })
    const res = await cancelRoute.POST(nextRequest(url, { method: 'POST' }), params('run-1'))
    expect(res.status).toBe(404)
  })

  it('propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await cancelRoute.POST(nextRequest(url, { method: 'POST' }), params('run-1'))
    expect(res.status).toBe(401)
    expect(hoisted.requestCancel).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /runs/[id]/candidates — the ledger
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/runs/[id]/candidates', () => {
  const url = 'https://dial8.ai/api/account/prospecting/runs/run-1/candidates'

  it('returns the grouped ledger', async () => {
    const groups = [
      { outcome: 'new', reason: null, count: 1, candidates: [{ id: 'c1', link: { kind: 'entry', id: 'e1' } }] },
      { outcome: 'suppressed', reason: 'this_list', count: 2, candidates: [] },
    ]
    hoisted.listRunCandidates.mockResolvedValue({ ok: true, run: RUN, groups, total: 3 })
    const res = await candidatesRoute.GET(nextRequest(url), params('run-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: RUN, groups, total: 3 })
  })

  it('404s a cross-workspace run id', async () => {
    hoisted.listRunCandidates.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'Run not found' })
    const res = await candidatesRoute.GET(nextRequest(url), params('run-1'))
    expect(res.status).toBe(404)
  })

  it('500s a DB_ERROR', async () => {
    hoisted.listRunCandidates.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'boom' })
    const res = await candidatesRoute.GET(nextRequest(url), params('run-1'))
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// /runs/active
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/runs/active', () => {
  it('returns the workspace-wide live runs with their list names', async () => {
    // The one read that answers "is anything happening right now?" — every
    // other run endpoint is scoped to a list the caller already knows about,
    // which is exactly why a run started from the chat was invisible.
    hoisted.listActiveRuns.mockResolvedValue({
      ok: true,
      runs: [{ ...RUN, list_id: 'list-1', list_name: 'Series A fintechs' }],
    })
    const res = await activeRoute.GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      runs: [{ ...RUN, list_id: 'list-1', list_name: 'Series A fintechs' }],
    })
  })

  it('scopes to the CALLER\'s workspace — the route takes no workspace input', async () => {
    hoisted.listActiveRuns.mockResolvedValue({ ok: true, runs: [] })
    await activeRoute.GET()
    expect(hoisted.listActiveRuns.mock.calls[0][1]).toEqual({ workspaceId: WS })
  })

  it('an empty workspace is 200 with an empty array, not a 404', async () => {
    hoisted.listActiveRuns.mockResolvedValue({ ok: true, runs: [] })
    const res = await activeRoute.GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ runs: [] })
  })

  it('a failed read is a 500, never an empty "nothing is running"', async () => {
    // An empty array is a claim the poll would render as "all quiet"; a read
    // that failed has no right to make it.
    hoisted.listActiveRuns.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'boom' })
    const res = await activeRoute.GET()
    expect(res.status).toBe(500)
  })

  it('requires a workspace like every other prospecting route', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('no', { status: 401 }))
    const res = await activeRoute.GET()
    expect(res.status).toBe(401)
    expect(hoisted.listActiveRuns).not.toHaveBeenCalled()
  })
})
