import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for GET /api/account/documents/[id]/move/preflight.
 *
 * These lock in the disclosure CONTRACT the move dialog consumes — active
 * share links, other members' drafts, comments, and the sole-vs-shared claim
 * split (delegated to partitionClaimsForSources, unit-tested separately) —
 * plus the workspace pin that stops a multi-workspace user probing documents
 * outside the one they're viewing.
 *
 * The supabase mock dispatches per-table FIFO queues: each `.from(table)`
 * call consumes the next preprogrammed result for that table.
 */

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  // The drafts-by-others count runs on the service client (author-only RLS
  // hides other members' drafts from the user client); route it into the same
  // per-table queue mock as the user client.
  serviceRef: { client: null as unknown },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => hoisted.serviceRef.client,
}))

const { GET } = await import(
  '@/app/api/account/documents/[id]/move/preflight/route'
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
  const client = {
    calls,
    from: (table: string) => {
      calls.push(table)
      const queue = queues[table]
      const result =
        queue && queue.length > 0 ? queue.shift() : { data: [], error: null }
      return chain(result)
    },
  }
  hoisted.serviceRef.client = client
  return client
}

const params = Promise.resolve({ id: 'doc-1' })
const req = new Request('https://dial8.ai/api/account/documents/doc-1/move/preflight')

const documentRow = { data: { id: 'doc-1', workspace_id: 'w1' }, error: null }

function authWith(supabase: unknown) {
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase,
    user: { id: 'user-1' },
    workspaceId: 'w1',
    member: { id: 'member-1' },
  })
}

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
})

describe('GET /api/account/documents/[id]/move/preflight', () => {
  it('returns the auth response when requireWorkspaceMember fails', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const res = await GET(req, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the document is not in the current workspace', async () => {
    const supabase = makeSupabase({ document: [{ data: null, error: null }] })
    authWith(supabase)
    const res = await GET(req, { params })
    expect(res.status).toBe(404)
    // The pin failed, so nothing else may be queried.
    expect(supabase.calls).toEqual(['document'])
  })

  it('returns 500 when a count query errors instead of under-counting', async () => {
    authWith(
      makeSupabase({
        document: [documentRow],
        share: [{ count: null, error: { message: 'boom' } }],
      }),
    )
    const res = await GET(req, { params })
    expect(res.status).toBe(500)
  })

  it('returns empty artifact sets for a bare document', async () => {
    const supabase = makeSupabase({
      document: [documentRow],
      share: [{ count: 0, error: null }],
      document_draft: [{ count: 0, error: null }],
      comment: [{ count: 0, error: null }],
      claim_source: [{ data: [], error: null }],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      document_id: 'doc-1',
      shares_active: 0,
      drafts_by_others: 0,
      comments: 0,
      claims: { sole_sourced: 0, shared: 0 },
    })
    // No linked claims → the scoping and evidence queries must be skipped.
    expect(supabase.calls.filter((t) => t === 'claim')).toHaveLength(0)
    expect(supabase.calls.filter((t) => t === 'claim_source')).toHaveLength(1)
  })

  it('reports shares, other members drafts, comments and the claim split', async () => {
    const supabase = makeSupabase({
      document: [documentRow],
      share: [{ count: 2, error: null }],
      document_draft: [{ count: 3, error: null }],
      comment: [{ count: 5, error: null }],
      claim_source: [
        // evidence rows pointing at this document
        { data: [{ claim_id: 'claim-sole' }, { claim_id: 'claim-shared' }], error: null },
        // full evidence for the workspace-scoped linked claims
        {
          data: [
            { claim_id: 'claim-sole', source_type: 'document', source_id: 'doc-1' },
            { claim_id: 'claim-shared', source_type: 'document', source_id: 'doc-1' },
            { claim_id: 'claim-shared', source_type: 'capture', source_id: 'cap-9' },
          ],
          error: null,
        },
      ],
      claim: [{ data: [{ id: 'claim-sole' }, { id: 'claim-shared' }], error: null }],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      document_id: 'doc-1',
      shares_active: 2,
      drafts_by_others: 3,
      comments: 5,
      claims: { sole_sourced: 1, shared: 1 },
    })
  })

  it('drops claims outside the current workspace from the partition', async () => {
    const supabase = makeSupabase({
      document: [documentRow],
      share: [{ count: 0, error: null }],
      document_draft: [{ count: 0, error: null }],
      comment: [{ count: 0, error: null }],
      claim_source: [{ data: [{ claim_id: 'foreign-claim' }], error: null }],
      claim: [{ data: [], error: null }],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.claims).toEqual({ sole_sourced: 0, shared: 0 })
    // claim_source is queried once for this document's evidence; the
    // follow-up evidence query is skipped because no scoped claim survived.
    expect(supabase.calls.filter((t) => t === 'claim_source')).toHaveLength(1)
  })

  it('returns 500 when the claim evidence query errors', async () => {
    authWith(
      makeSupabase({
        document: [documentRow],
        share: [{ count: 0, error: null }],
        document_draft: [{ count: 0, error: null }],
        comment: [{ count: 0, error: null }],
        claim_source: [
          { data: [{ claim_id: 'c1' }], error: null },
          { data: null, error: { message: 'boom' } },
        ],
        claim: [{ data: [{ id: 'c1' }], error: null }],
      }),
    )
    const res = await GET(req, { params })
    expect(res.status).toBe(500)
  })
})
