/**
 * Tests for the Linear push/unlink route pair:
 *   GET    /api/account/actions/[id]/linear
 *   POST   /api/account/actions/[id]/linear
 *   DELETE /api/account/actions/[id]/linear/[linkId]
 *
 * The routes are thin — pushActionToLinear owns every decision — so what is
 * asserted here is the TRANSLATION layer, which is where a provider-generic UI
 * either keeps working or quietly stops:
 *  - each coded push failure maps to the status and code PushToTrackerMenu
 *    branches on, identically to the asana and jira routes.
 *  - `unauthorized` is re-coded as `reconnect_required` on the wire (the UI's
 *    vocabulary), and `action_not_found` becomes a 404 rather than a 400.
 *  - an already-linked action is a 409 that CARRIES the existing link, so the
 *    panel can render the chip it was missing instead of just erroring.
 *  - every query is workspace-scoped AND provider-scoped: an action may hold an
 *    asana, a jira and a linear link at once, so an unscoped read or delete
 *    would return or destroy the wrong one.
 *  - the unlink is Dial8-side ONLY — it never touches the Linear issue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoistedPush = vi.hoisted(() => ({ pushActionToLinear: vi.fn() }))
vi.mock('@/lib/tasks/linear-push', () => ({
  pushActionToLinear: hoistedPush.pushActionToLinear,
}))

const hoistedWorkspace = vi.hoisted(() => ({ getCurrentWorkspaceId: vi.fn() }))
vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoistedWorkspace.getCurrentWorkspaceId,
}))

// GET/POST resolve auth via requireWorkspace (perf phase 2 migration); the
// [linkId] DELETE below is still on the legacy getUser/getCurrentWorkspaceId
// path, so BOTH mock layers are driven by the same hoisted knobs. The mock
// mirrors the real helper's contract: 401 Response for no user, 400 for no
// workspace, otherwise the same fake client createClient hands out.
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => {
    if (!hoistedSupabase.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const workspaceId = await hoistedWorkspace.getCurrentWorkspaceId()
    if (!workspaceId) {
      return new Response(JSON.stringify({ error: 'No workspace', code: 'NO_WORKSPACE' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const { createClient } = await import('@/lib/supabase/server')
    return { supabase: await createClient(), user: hoistedSupabase.user, workspaceId }
  },
}))

const hoistedSupabase = vi.hoisted(() => ({
  user: null as unknown,
  /** Filters applied to the last built query, in order. */
  filters: [] as Array<{ col: string; val: unknown }>,
  selectResult: { data: [] as unknown, error: null as unknown },
  deleteError: null as unknown,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: hoistedSupabase.user } }) },
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api,
        delete: () => {
          isDelete = true
          return api
        },
        eq: (col: string, val: unknown) => {
          hoistedSupabase.filters.push({ col, val })
          return api
        },
        order: async () => (isDelete ? {} : hoistedSupabase.selectResult),
        then: undefined,
      }
      let isDelete = false
      // A delete chain is awaited directly after its .eq()s, so the builder has
      // to be thenable; a select chain terminates at .order().
      ;(api as { then?: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve(isDelete ? { error: hoistedSupabase.deleteError } : hoistedSupabase.selectResult)
      return api
    },
  }),
}))

const { GET, POST } = await import('../route')
const { DELETE } = await import('../[linkId]/route')

const LINK = {
  id: 'link-1',
  action_id: 'act-1',
  provider: 'linear',
  external_id: 'issue-uuid-1',
  external_url: 'https://linear.app/acme/issue/ENG-7',
  external_title: 'Ship the thing',
  external_state_label: 'Todo',
  completed: false,
}

function params() {
  return { params: Promise.resolve({ id: 'act-1' }) }
}

/** The DELETE route's params — the link id is required there. */
function linkParams(linkId = 'link-1') {
  return { params: Promise.resolve({ id: 'act-1', linkId }) }
}

/** Which columns the last query filtered on. */
function filterCols(): string[] {
  return hoistedSupabase.filters.map((f) => f.col)
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedSupabase.user = { id: 'u-1' }
  hoistedSupabase.filters = []
  hoistedSupabase.selectResult = { data: [LINK], error: null }
  hoistedSupabase.deleteError = null
  hoistedWorkspace.getCurrentWorkspaceId.mockResolvedValue('ws-1')
  hoistedPush.pushActionToLinear.mockResolvedValue({ ok: true, link: LINK, created: true })
})

// ---- GET -------------------------------------------------------------------

describe('GET /api/account/actions/[id]/linear', () => {
  it('lists the action’s linear links', async () => {
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tasks: [LINK] })
  })

  it('scopes by action, PROVIDER and workspace', async () => {
    // An action may hold an asana AND a jira AND a linear link, so dropping the
    // provider filter would return another provider's row to the Linear chip.
    await GET(new Request('http://x'), params())
    expect(filterCols()).toEqual(['action_id', 'provider', 'workspace_id'])
    expect(hoistedSupabase.filters[1].val).toBe('linear')
  })

  it('401s an unauthenticated caller', async () => {
    hoistedSupabase.user = null
    expect((await GET(new Request('http://x'), params())).status).toBe(401)
  })

  it('400s when there is no current workspace', async () => {
    hoistedWorkspace.getCurrentWorkspaceId.mockResolvedValue(null)
    expect((await GET(new Request('http://x'), params())).status).toBe(400)
  })

  it('500s on a read failure', async () => {
    hoistedSupabase.selectResult = { data: null, error: { message: 'db down' } }
    expect((await GET(new Request('http://x'), params())).status).toBe(500)
  })
})

// ---- POST ------------------------------------------------------------------

describe('POST /api/account/actions/[id]/linear', () => {
  it('201s with the new link on a successful push', async () => {
    const res = await POST(new Request('http://x', { method: 'POST' }), params())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ task: LINK })
    expect(hoistedPush.pushActionToLinear).toHaveBeenCalledWith({
      actionId: 'act-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      supabase: expect.anything(),
    })
  })

  /**
   * The 409 carries the link deliberately: an already-linked action is not a
   * mistake the user made twice, and returning the row lets the panel render the
   * chip it was missing rather than showing an error for a correct state.
   */
  it('409s with the EXISTING link when the action is already linked', async () => {
    hoistedPush.pushActionToLinear.mockResolvedValue({ ok: true, link: LINK, created: false })
    const res = await POST(new Request('http://x', { method: 'POST' }), params())

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('already_linked')
    expect(body.task).toEqual(LINK)
  })

  it('404s an action that does not exist in the workspace', async () => {
    hoistedPush.pushActionToLinear.mockResolvedValue({
      ok: false,
      code: 'action_not_found',
      error: 'Action not found',
    })
    expect((await POST(new Request('http://x', { method: 'POST' }), params())).status).toBe(404)
  })

  /**
   * The one code the route RENAMES on the wire. The push says `unauthorized`;
   * the UI's banner logic speaks `reconnect_required`, the same word the picker
   * routes use — so the two never need separate handling.
   */
  it('re-codes `unauthorized` as 400 reconnect_required', async () => {
    hoistedPush.pushActionToLinear.mockResolvedValue({
      ok: false,
      code: 'unauthorized',
      error: 'Reconnect Linear to continue',
    })
    const res = await POST(new Request('http://x', { method: 'POST' }), params())

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it.each(['not_connected', 'not_configured', 'push_failed'])(
    'passes %s through as a 400 with its code intact',
    async (code) => {
      hoistedPush.pushActionToLinear.mockResolvedValue({ ok: false, code, error: 'nope' })
      const res = await POST(new Request('http://x', { method: 'POST' }), params())
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe(code)
    },
  )

  it('401s an unauthenticated caller BEFORE pushing', async () => {
    hoistedSupabase.user = null
    expect((await POST(new Request('http://x', { method: 'POST' }), params())).status).toBe(401)
    expect(hoistedPush.pushActionToLinear).not.toHaveBeenCalled()
  })

  it('400s when there is no current workspace, without pushing', async () => {
    hoistedWorkspace.getCurrentWorkspaceId.mockResolvedValue(null)
    expect((await POST(new Request('http://x', { method: 'POST' }), params())).status).toBe(400)
    expect(hoistedPush.pushActionToLinear).not.toHaveBeenCalled()
  })

  it('500s (never throws) when the push throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoistedPush.pushActionToLinear.mockRejectedValue(new Error('boom'))
    const res = await POST(new Request('http://x', { method: 'POST' }), params())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })
})

// ---- DELETE ----------------------------------------------------------------

describe('DELETE /api/account/actions/[id]/linear/[linkId]', () => {
  it('unlinks and reports success', async () => {
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), linkParams())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('scopes the delete by link, action, PROVIDER and workspace', async () => {
    // Every one of the four matters: without the provider filter a Dial8 user
    // tidying up a Linear chip could delete the action's Jira link instead.
    await DELETE(new Request('http://x', { method: 'DELETE' }), linkParams())
    expect(filterCols()).toEqual(['id', 'action_id', 'provider', 'workspace_id'])
    expect(hoistedSupabase.filters[2].val).toBe('linear')
  })

  it('401s an unauthenticated caller', async () => {
    hoistedSupabase.user = null
    const res = await DELETE(
      new Request('http://x', { method: 'DELETE' }),
      linkParams(),
    )
    expect(res.status).toBe(401)
  })

  it('500s on a delete failure', async () => {
    hoistedSupabase.deleteError = { message: 'db down' }
    const res = await DELETE(
      new Request('http://x', { method: 'DELETE' }),
      linkParams(),
    )
    expect(res.status).toBe(500)
  })
})
