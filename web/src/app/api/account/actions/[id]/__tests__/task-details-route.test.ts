/**
 * Tests for GET /api/account/actions/[id]/task-details?provider=…
 *
 * The property lens's read route. Invariants locked in:
 *  - AUTH + SCOPE: requireWorkspace short-circuits; the ACTION is verified in the
 *    workspace before the link, so an id from another workspace answers "action not
 *    found" rather than the "not linked" a missing link would produce.
 *  - The link lookup is scoped by action AND provider AND workspace_id — matching
 *    the existing DELETE handlers' `.eq` chain exactly, because without the
 *    workspace predicate a member of workspace A could read workspace B's link.
 *  - `provider` is validated against the three known values before any work.
 *  - THE STATUS MAP is the contract the UI branches on, and two entries carry the
 *    design: reconnect_required is 400 (never a bare 401, which the client would
 *    "fix" by refreshing a token that was never the problem), and task_missing vs
 *    task_deleted are BOTH 404 distinguished only by code — because the difference
 *    is retryability, not status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => auth.result,
}))

const hoistedLens = vi.hoisted(() => ({
  readJiraTaskDetails: vi.fn(),
  readAsanaTaskDetails: vi.fn(),
  readLinearTaskDetails: vi.fn(),
}))
vi.mock('@/lib/tasks/jira-lens', () => ({
  readJiraTaskDetails: hoistedLens.readJiraTaskDetails,
  updateJiraTaskFields: vi.fn(),
}))
vi.mock('@/lib/tasks/asana-lens', () => ({
  readAsanaTaskDetails: hoistedLens.readAsanaTaskDetails,
  updateAsanaTaskFields: vi.fn(),
}))
vi.mock('@/lib/tasks/linear-lens', () => ({
  readLinearTaskDetails: hoistedLens.readLinearTaskDetails,
  updateLinearTaskFields: vi.fn(),
}))

const { GET } = await import('../task-details/route')

const LINK_ROW = {
  id: 'link-1',
  external_id: '10042',
  external_scope: 'cloud-abc',
  external_url: 'https://acme.atlassian.net/browse/ENG-42',
  external_title: 'Fix the thing',
}

/** A lens body, the shape every provider's collector answers with. */
function details(provider: string) {
  return {
    ok: true,
    provider,
    link_id: 'link-1',
    url: 'https://x/1',
    title: 'Fix the thing',
    status_name: 'In Progress',
    fields: {
      project: null,
      issue_type: null,
      team: null,
      section: null,
      assignee: null,
      priority: null,
      due_date: null,
      labels: [],
    },
    editable: { assignee: true, priority: true, due_date: true, labels: true },
    option_scope: {},
  }
}

/**
 * A Supabase fake that records every `.eq()` so the tests can assert the link
 * lookup is workspace-scoped, and answers per-table.
 */
const db = vi.hoisted(() => ({
  action: null as unknown,
  link: null as unknown,
  eqs: [] as Array<{ table: string; column: string; value: unknown }>,
}))

function fakeSupabase() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          db.eqs.push({ table, column, value })
          return chain
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data: table === 'actions' ? db.action : db.link,
          error: null,
        }),
      }
      return chain
    },
  }
}

function req(query = 'provider=jira'): Request {
  return new Request(`http://x/api/account/actions/act-1/task-details?${query}`)
}

function params() {
  return { params: Promise.resolve({ id: 'act-1' }) }
}

/** Every `.eq` recorded against the link table. */
function linkEqs() {
  return db.eqs.filter((e) => e.table === 'action_external_task')
}

beforeEach(() => {
  vi.clearAllMocks()
  db.eqs = []
  db.action = { id: 'act-1' }
  db.link = LINK_ROW
  auth.result = { supabase: fakeSupabase(), user: { id: 'u-1' }, workspaceId: 'ws-1' }
  hoistedLens.readJiraTaskDetails.mockResolvedValue(details('jira'))
  hoistedLens.readAsanaTaskDetails.mockResolvedValue(details('asana'))
  hoistedLens.readLinearTaskDetails.mockResolvedValue(details('linear'))
})

// ---- Auth + validation ---------------------------------------------------

describe('GET task-details — gates', () => {
  it('short-circuits when requireWorkspace returns a Response', async () => {
    auth.result = new Response('nope', { status: 403 })
    const res = await GET(req(), params())
    expect(res.status).toBe(403)
    expect(hoistedLens.readJiraTaskDetails).not.toHaveBeenCalled()
  })

  it('requires the provider query param', async () => {
    const res = await GET(req(''), params())
    expect(res.status).toBe(400)
    expect(hoistedLens.readJiraTaskDetails).not.toHaveBeenCalled()
  })

  it.each([['hubspot'], ['JIRA'], ['  '], ['jira,asana']])(
    'rejects the unknown provider %s',
    async (provider) => {
      const res = await GET(req(`provider=${encodeURIComponent(provider)}`), params())
      expect(res.status).toBe(400)
    },
  )

  /**
   * The action is checked FIRST so an id from another workspace answers 404 "action
   * not found" rather than "not linked" — the same distinction every other action
   * route draws, and the one a probing caller learns nothing from.
   */
  it('404s when the action is not in this workspace', async () => {
    db.action = null
    const res = await GET(req(), params())
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/Action not found/)
    expect(hoistedLens.readJiraTaskDetails).not.toHaveBeenCalled()
  })

  it('404s link_not_found when the action has no link for that provider', async () => {
    db.link = null
    const res = await GET(req(), params())
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('link_not_found')
    expect(hoistedLens.readJiraTaskDetails).not.toHaveBeenCalled()
  })
})

// ---- Link scoping --------------------------------------------------------

describe('GET task-details — link lookup scoping', () => {
  /** Without workspace_id, a member of workspace A could read workspace B's link. */
  it('scopes the link by action AND provider AND workspace_id', async () => {
    await GET(req(), params())
    expect(linkEqs()).toEqual([
      { table: 'action_external_task', column: 'action_id', value: 'act-1' },
      { table: 'action_external_task', column: 'provider', value: 'jira' },
      { table: 'action_external_task', column: 'workspace_id', value: 'ws-1' },
    ])
  })

  it.each([['jira'], ['asana'], ['linear']])(
    'looks the link up for the requested provider %s',
    async (provider) => {
      await GET(req(`provider=${provider}`), params())
      expect(linkEqs()).toContainEqual({
        table: 'action_external_task',
        column: 'provider',
        value: provider,
      })
    },
  )
})

// ---- Provider dispatch ---------------------------------------------------

describe('GET task-details — dispatch', () => {
  it.each([
    ['jira', () => hoistedLens.readJiraTaskDetails],
    ['asana', () => hoistedLens.readAsanaTaskDetails],
    ['linear', () => hoistedLens.readLinearTaskDetails],
  ])('routes %s to its own collector with the link row', async (provider, getMock) => {
    const res = await GET(req(`provider=${provider}`), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, provider })
    expect(getMock()).toHaveBeenCalledWith({ workspaceId: 'ws-1', link: LINK_ROW })
    // Exactly one collector runs — never a fan-out.
    const others = [
      hoistedLens.readJiraTaskDetails,
      hoistedLens.readAsanaTaskDetails,
      hoistedLens.readLinearTaskDetails,
    ].filter((m) => m !== getMock())
    for (const other of others) expect(other).not.toHaveBeenCalled()
  })

  it('returns the collector body verbatim', async () => {
    const body = details('jira')
    hoistedLens.readJiraTaskDetails.mockResolvedValue(body)
    const res = await GET(req(), params())
    expect(await res.json()).toEqual(body)
  })
})

// ---- The failure-code → status map --------------------------------------

describe('GET task-details — error taxonomy', () => {
  /**
   * reconnect_required IS 400, NOT 401. A bare 401 is indistinguishable from the
   * caller's own Supabase session expiring, which the client "fixes" by refreshing a
   * token that was never the problem. Every picker route makes this same choice.
   */
  it('maps reconnect_required to 400, never a bare 401', async () => {
    hoistedLens.readJiraTaskDetails.mockResolvedValue({
      ok: false,
      code: 'reconnect_required',
      error: 'Reconnect Jira to continue',
    })
    const res = await GET(req(), params())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it.each([['not_connected'], ['not_configured'], ['field_not_editable']])(
    'maps %s to 400',
    async (code) => {
      hoistedLens.readJiraTaskDetails.mockResolvedValue({ ok: false, code, error: 'x' })
      const res = await GET(req(), params())
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe(code)
    },
  )

  /**
   * BOTH 404, distinguished ONLY by the code — because the difference is
   * retryability rather than status. task_missing is Jira's/Linear's ambiguous
   * gone-or-invisible (Retry offered); task_deleted is Asana's unambiguous gone
   * (terminal, no Retry).
   */
  it.each([['task_missing'], ['task_deleted']])(
    'maps %s to 404 with the code preserved',
    async (code) => {
      hoistedLens.readJiraTaskDetails.mockResolvedValue({ ok: false, code, error: 'x' })
      const res = await GET(req(), params())
      expect(res.status).toBe(404)
      expect((await res.json()).code).toBe(code)
    },
  )

  /** 502, not 500: the failure is UPSTREAM, and a 500 reads as a Native Intelligence bug. */
  it('maps provider_error to 502', async () => {
    hoistedLens.readJiraTaskDetails.mockResolvedValue({
      ok: false,
      code: 'provider_error',
      error: 'Jira is rate limiting this workspace right now.',
    })
    const res = await GET(req(), params())
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.code).toBe('provider_error')
    expect(body.error).toMatch(/rate limiting/)
  })
})
