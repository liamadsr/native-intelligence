import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/account/actions/move/preflight.
 *
 * The route resolves a bulk action selection against the caller's current
 * workspace and reports the collateral of a move. These tests lock in the
 * response CONTRACT the move dialog consumes, the workspace pinning (ids
 * outside the current workspace are silently dropped, never 404'd), and the
 * crossing-relation arithmetic.
 *
 * The supabase mock dispatches per-table FIFO queues: each `.from(table)`
 * call consumes the next preprogrammed result for that table, which keeps the
 * mock honest about how many times each table is hit while staying agnostic
 * to filter-chain details. `action_relation` is queried twice — once from
 * each end of the link — so its queue holds two entries.
 */

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

const { POST } = await import(
  '@/app/api/account/actions/move/preflight/route'
)

// Proxy that returns itself for any chained filter method and resolves to
// `result` when awaited (or via .single()/.maybeSingle()).
function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(result).then(resolve, reject)
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve(result)
        }
        return () => proxy
      },
    },
  )
  return proxy
}

function makeSupabase(queues: Record<string, unknown[]>) {
  const calls: string[] = []
  return {
    calls,
    from: (table: string) => {
      calls.push(table)
      const queue = queues[table]
      const result =
        queue && queue.length > 0 ? queue.shift() : { data: [], error: null }
      return chain(result)
    },
  }
}

function buildReq(body: unknown) {
  return new Request('https://nativeintelligence.dev/api/account/actions/move/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function authWith(supabase: unknown) {
  hoisted.requireWorkspace.mockResolvedValue({
    supabase,
    user: { id: 'user-1' },
    workspaceId: 'w1',
  })
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
})

describe('POST /api/account/actions/move/preflight', () => {
  it('returns the auth response when requireWorkspace fails', async () => {
    const denied = new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
    })
    hoisted.requireWorkspace.mockResolvedValue(denied)
    const res = await POST(buildReq({ action_ids: ['a1'] }))
    expect(res.status).toBe(401)
  })

  it('returns 400 on invalid JSON body', async () => {
    const supabase = makeSupabase({})
    authWith(supabase)
    const res = await POST(buildReq('not-json'))
    expect(res.status).toBe(400)
    expect(supabase.calls).toHaveLength(0)
  })

  it('returns 400 when action_ids is not an array of non-empty strings', async () => {
    const supabase = makeSupabase({})
    authWith(supabase)
    for (const bad of [undefined, 'a1', [42], [''], [null], []]) {
      const res = await POST(buildReq({ action_ids: bad }))
      expect(res.status).toBe(400)
    }
    expect(supabase.calls).toHaveLength(0)
  })

  it('returns 400 when action_ids exceeds the size cap', async () => {
    const supabase = makeSupabase({})
    authWith(supabase)
    const res = await POST(
      buildReq({ action_ids: Array.from({ length: 501 }, (_, i) => `a-${i}`) }),
    )
    expect(res.status).toBe(400)
    expect(supabase.calls).toHaveLength(0)
  })

  it('returns 500 when a query errors instead of under-counting', async () => {
    authWith(
      makeSupabase({
        actions: [{ data: null, error: { message: 'boom' } }],
      }),
    )
    const res = await POST(buildReq({ action_ids: ['a1'] }))
    expect(res.status).toBe(500)
  })

  it('returns 500 when an artifact query errors', async () => {
    authWith(
      makeSupabase({
        actions: [{ data: [{ id: 'a1', identifier: 'ENG-1', title: 'One' }], error: null }],
        agent_run: [{ count: null, error: { message: 'boom' } }],
      }),
    )
    const res = await POST(buildReq({ action_ids: ['a1'] }))
    expect(res.status).toBe(500)
  })

  it('silently omits ids outside the current workspace and skips artifact reads', async () => {
    const supabase = makeSupabase({
      actions: [{ data: [], error: null }],
    })
    authWith(supabase)

    const res = await POST(buildReq({ action_ids: ['foreign-1', 'foreign-2'] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      actions: [],
      external_tasks: [],
      attachments: 0,
      agent_runs: 0,
      crossing_relations: 0,
    })
    // Nothing resolved in this workspace — the dependent queries must be
    // skipped, not sent with empty IN lists.
    expect(supabase.calls).toEqual(['actions'])
  })

  it('returns the full disclosure shape for a resolved selection', async () => {
    const supabase = makeSupabase({
      actions: [
        {
          data: [
            { id: 'a1', identifier: 'ENG-1', title: 'First' },
            { id: 'a2', identifier: 'ENG-2', title: 'Second' },
          ],
          error: null,
        },
      ],
      action_external_task: [
        {
          data: [
            {
              action_id: 'a1',
              provider: 'linear',
              external_title: 'ENG-11 First',
              external_url: 'https://linear.app/t/ENG-11',
            },
          ],
          error: null,
        },
      ],
      attachments: [{ count: 3, error: null }],
      agent_run: [{ count: 2, error: null }],
      action_relation: [
        // links stored FROM the selection
        {
          data: [
            { id: 'r1', action_id: 'a1', related_action_id: 'outside-1' },
            { id: 'r2', action_id: 'a1', related_action_id: 'a2' },
          ],
          error: null,
        },
        // links stored TOWARD the selection — r2 repeats and must not be
        // double-counted; r3 crosses in the other direction.
        {
          data: [
            { id: 'r2', action_id: 'a1', related_action_id: 'a2' },
            { id: 'r3', action_id: 'outside-2', related_action_id: 'a2' },
          ],
          error: null,
        },
      ],
    })
    authWith(supabase)

    const res = await POST(
      // The stale third id resolves to nothing and drops out silently.
      buildReq({ action_ids: ['a1', 'a2', 'gone'] }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.actions).toEqual([
      { id: 'a1', identifier: 'ENG-1', title: 'First' },
      { id: 'a2', identifier: 'ENG-2', title: 'Second' },
    ])
    expect(body.external_tasks).toEqual([
      {
        action_id: 'a1',
        provider: 'linear',
        external_title: 'ENG-11 First',
        external_url: 'https://linear.app/t/ENG-11',
      },
    ])
    expect(body.attachments).toBe(3)
    expect(body.agent_runs).toBe(2)
    // r1 and r3 cross the selection boundary; r2 is wholly inside it.
    expect(body.crossing_relations).toBe(2)
    expect(supabase.calls.filter((t) => t === 'action_relation')).toHaveLength(2)
  })

  it('chunks id lists at 100 per query and sums the counts', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `a-${i}`)
    const supabase = makeSupabase({
      actions: [
        { data: ids.slice(0, 100).map((id) => ({ id, identifier: null, title: id })), error: null },
        { data: ids.slice(100, 200).map((id) => ({ id, identifier: null, title: id })), error: null },
        { data: ids.slice(200).map((id) => ({ id, identifier: null, title: id })), error: null },
      ],
      attachments: [
        { count: 1, error: null },
        { count: 2, error: null },
        { count: 4, error: null },
      ],
      agent_run: [
        { count: 0, error: null },
        { count: 5, error: null },
        { count: 0, error: null },
      ],
    })
    authWith(supabase)

    const res = await POST(buildReq({ action_ids: ids }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.actions).toHaveLength(250)
    expect(body.attachments).toBe(7)
    expect(body.agent_runs).toBe(5)
    // 250 ids → 3 chunks per table, both for the initial resolve and for each
    // artifact read (action_relation is read from both ends).
    expect(supabase.calls.filter((t) => t === 'actions')).toHaveLength(3)
    expect(supabase.calls.filter((t) => t === 'attachments')).toHaveLength(3)
    expect(supabase.calls.filter((t) => t === 'action_relation')).toHaveLength(6)
  })
})
