import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for GET /api/account/projects/[id]/move/preflight.
 *
 * These lock in the response CONTRACT the move dialog consumes (the counts
 * plus the external tracker links that will be severed), the workspace pin
 * that stops a multi-workspace user probing projects outside the one they're
 * viewing, and the `IN` chunking for projects with many actions.
 *
 * The supabase mock dispatches per-table FIFO queues: each `.from(table)`
 * call consumes the next preprogrammed result for that table, which keeps the
 * mock honest about how many times each table is hit while staying agnostic
 * to filter-chain details.
 */

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

const { GET } = await import(
  '@/app/api/account/projects/[id]/move/preflight/route'
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

const params = Promise.resolve({ id: 'p1' })
const req = new Request('https://dial8.ai/api/account/projects/p1/move/preflight')

const projectRow = { data: { id: 'p1', workspace_id: 'w1' }, error: null }

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

describe('GET /api/account/projects/[id]/move/preflight', () => {
  it('returns the auth response when requireWorkspace fails', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const res = await GET(req, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the project is not in the current workspace', async () => {
    const supabase = makeSupabase({ projects: [{ data: null, error: null }] })
    authWith(supabase)
    const res = await GET(req, { params })
    expect(res.status).toBe(404)
    // The pin failed, so no closure query may run.
    expect(supabase.calls).toEqual(['projects'])
  })

  it('returns 500 when a count query errors instead of under-counting', async () => {
    authWith(
      makeSupabase({
        projects: [projectRow],
        document: [{ count: null, error: { message: 'boom' } }],
      }),
    )
    const res = await GET(req, { params })
    expect(res.status).toBe(500)
  })

  it('returns zeroes for an empty project and skips the external task query', async () => {
    const supabase = makeSupabase({
      projects: [projectRow],
      actions: [{ data: [], error: null }],
      document: [{ count: 0, error: null }],
      milestone: [{ count: 0, error: null }],
      captures: [{ count: 0, error: null }],
      view: [{ count: 0, error: null }],
      project_label: [{ count: 0, error: null }],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      project_id: 'p1',
      actions: 0,
      documents: 0,
      milestones: 0,
      captures_to_unlink: 0,
      views_to_delete: 0,
      labels: 0,
      external_tasks: [],
    })
    // With no actions there is nothing to look up — never an empty IN list.
    expect(supabase.calls.filter((t) => t === 'action_external_task')).toHaveLength(0)
  })

  it('reports the closure counts and the external tracker links', async () => {
    const supabase = makeSupabase({
      projects: [projectRow],
      actions: [{ data: [{ id: 'a1' }, { id: 'a2' }], error: null }],
      document: [{ count: 4, error: null }],
      milestone: [{ count: 2, error: null }],
      captures: [{ count: 7, error: null }],
      view: [{ count: 1, error: null }],
      project_label: [{ count: 3, error: null }],
      action_external_task: [
        {
          data: [
            {
              action_id: 'a1',
              provider: 'jira',
              external_title: 'ENG-1 Ship it',
              external_url: 'https://example.atlassian.net/browse/ENG-1',
            },
            {
              action_id: 'a2',
              provider: 'linear',
              external_title: 'LIN-9 Fix it',
              external_url: 'https://linear.app/x/issue/LIN-9',
            },
          ],
          error: null,
        },
      ],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      project_id: 'p1',
      actions: 2,
      documents: 4,
      milestones: 2,
      captures_to_unlink: 7,
      views_to_delete: 1,
      labels: 3,
      external_tasks: [
        {
          action_id: 'a1',
          provider: 'jira',
          external_title: 'ENG-1 Ship it',
          external_url: 'https://example.atlassian.net/browse/ENG-1',
        },
        {
          action_id: 'a2',
          provider: 'linear',
          external_title: 'LIN-9 Fix it',
          external_url: 'https://linear.app/x/issue/LIN-9',
        },
      ],
    })
  })

  it('chunks the external task lookup and concatenates every batch', async () => {
    // 250 actions → three `IN` batches of at most 100 ids each.
    const actionRows = Array.from({ length: 250 }, (_, i) => ({ id: `a${i}` }))
    const supabase = makeSupabase({
      projects: [projectRow],
      actions: [{ data: actionRows, error: null }],
      document: [{ count: 0, error: null }],
      milestone: [{ count: 0, error: null }],
      captures: [{ count: 0, error: null }],
      view: [{ count: 0, error: null }],
      project_label: [{ count: 0, error: null }],
      action_external_task: [
        { data: [{ action_id: 'a1', provider: 'jira', external_title: null, external_url: null }], error: null },
        { data: [], error: null },
        { data: [{ action_id: 'a201', provider: 'asana', external_title: 'T', external_url: null }], error: null },
      ],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(supabase.calls.filter((t) => t === 'action_external_task')).toHaveLength(3)
    expect(body.actions).toBe(250)
    expect(body.external_tasks.map((t: { action_id: string }) => t.action_id)).toEqual([
      'a1',
      'a201',
    ])
  })

  it('returns 500 when an external task batch errors', async () => {
    authWith(
      makeSupabase({
        projects: [projectRow],
        actions: [{ data: [{ id: 'a1' }], error: null }],
        document: [{ count: 0, error: null }],
        milestone: [{ count: 0, error: null }],
        captures: [{ count: 0, error: null }],
        view: [{ count: 0, error: null }],
        project_label: [{ count: 0, error: null }],
        action_external_task: [{ data: null, error: { message: 'boom' } }],
      }),
    )
    const res = await GET(req, { params })
    expect(res.status).toBe(500)
  })
})
