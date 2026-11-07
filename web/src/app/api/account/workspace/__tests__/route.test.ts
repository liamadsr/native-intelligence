/**
 * Tests for GET /api/account/workspace — the member-email mapping.
 *
 * The route used to call listAllAuthUsers(), a sequential paged scan of the
 * ENTIRE product user base through the GoTrue admin API, per request, just to
 * map emails for the workspace's own members — a cost that grows with total
 * signups, not workspace size. It now does one getUserById per member, in
 * parallel CHUNKS of 10 (an unbounded Promise.all would burst one simultaneous
 * admin HTTP request per member for large workspaces from a single lambda).
 * These tests lock in:
 *  - one admin lookup per member, never a full listing scan,
 *  - bounded concurrency: never more than 10 lookups in flight, while lookups
 *    within a chunk still run in parallel,
 *  - per-member soft failure: a failed lookup yields '' for that member while
 *    the rest keep their emails and the request still succeeds — including
 *    failures spread across different chunks,
 *  - result order follows the member list, not lookup completion order,
 *  - the response shape is unchanged (workspace / members+email / aiMembers /
 *    invites / currentRole / currentMemberId).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readJson } from '@/test/integration'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceIdOrResponse: vi.fn(),
  getUserById: vi.fn(),
  listUsers: vi.fn(),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceIdOrResponse: hoisted.getCurrentWorkspaceIdOrResponse,
  WORKSPACE_COOKIE: 'dial8_workspace',
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    auth: {
      admin: {
        getUserById: hoisted.getUserById,
        listUsers: hoisted.listUsers,
      },
    },
  }),
}))

// Pulled in by the POST/DELETE handlers in the same module — inert here, but
// mocked so importing the route doesn't drag their dependency trees in.
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: vi.fn() }))
vi.mock('@/lib/crm/contacts', () => ({ ensureMemberContact: vi.fn() }))
vi.mock('@/lib/flows/seed-default-loops', () => ({ seedDefaultLoops: vi.fn() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Fake Supabase — the GET's five parallel queries, keyed by table. The two
// member queries share a table but end differently (list awaits the chain,
// current member calls .single()), so the chain resolves both terminals.
// ---------------------------------------------------------------------------

const db = {
  workspace: { id: 'ws-1', name: 'Acme', slug: 'acme' },
  members: [
    { id: 'mem-1', user_id: 'user-1', display_name: 'Alice', avatar_url: null, role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'mem-2', user_id: 'user-2', display_name: 'Bob', avatar_url: null, role: 'member', created_at: '2026-01-02T00:00:00.000Z' },
  ],
  invites: [] as unknown[],
  currentMember: { id: 'mem-1', role: 'owner' },
  aiMembers: [
    { id: 'ai-1', name: 'Eve', avatar_url: null, team_id: 'team-1', created_at: '2026-01-03T00:00:00.000Z' },
  ],
}

function chain(tableData: { list?: unknown; single?: unknown }) {
  const proxy: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) =>
      Promise.resolve({ data: tableData.list ?? null, error: null }).then(cb),
    single: async () => ({ data: tableData.single ?? null, error: null }),
  }
  return new Proxy(proxy, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return () => new Proxy(proxy, this)
    },
  }) as unknown
}

const aiMemberEqs: Array<[string, unknown]> = []

const fakeSupabase = {
  auth: { getUser: hoisted.getUser },
  from: (table: string) => {
    if (table === 'workspace') return chain({ single: db.workspace })
    if (table === 'member') return chain({ list: db.members, single: db.currentMember })
    if (table === 'invite') return chain({ list: db.invites })
    if (table === 'ai_team_member') {
      // Record the filters: the assignee list must leave system teammates and
      // work bots out (bots-v3 Phase 3).
      const inner = chain({ list: db.aiMembers }) as Record<string, unknown>
      const rec: Record<string, unknown> = new Proxy(inner, {
        get(target, prop: string) {
          if (prop === 'eq') return (col: string, val: unknown) => (aiMemberEqs.push([col, val]), rec)
          if (prop === 'then') return target.then
          const v = (target as Record<string, unknown>)[prop]
          return typeof v === 'function' ? (...args: unknown[]) => ((v as (...a: unknown[]) => unknown)(...args), rec) : v
        },
      })
      return rec
    }
    return chain({})
  },
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeSupabase,
}))

const { GET } = await import('@/app/api/account/workspace/route')

interface WorkspaceResponse {
  workspace: { id: string }
  members: { id: string; user_id: string; email: string }[]
  aiMembers: { id: string; name: string }[]
  invites: unknown[]
  currentRole: string | null
  currentMemberId: string | null
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.getCurrentWorkspaceIdOrResponse.mockReset()
  hoisted.getUserById.mockReset()
  hoisted.listUsers.mockReset()

  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  hoisted.getCurrentWorkspaceIdOrResponse.mockResolvedValue('ws-1')
  hoisted.getUserById.mockImplementation(async (id: string) => ({
    data: { user: { id, email: `${id}@example.com` } },
    error: null,
  }))
})

// ---------------------------------------------------------------------------

describe('GET /api/account/workspace — member emails', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    const res = await GET()
    expect(res.status).toBe(401)
    expect(hoisted.getUserById).not.toHaveBeenCalled()
  })

  it('maps emails via one getUserById per member — never a full user listing', async () => {
    const res = await GET()
    expect(res.status).toBe(200)

    const body = await readJson<WorkspaceResponse>(res)
    expect(body.members.map((m) => m.email)).toEqual([
      'user-1@example.com',
      'user-2@example.com',
    ])

    // One lookup per member, bounded by workspace size…
    expect(hoisted.getUserById).toHaveBeenCalledTimes(2)
    expect(hoisted.getUserById).toHaveBeenCalledWith('user-1')
    expect(hoisted.getUserById).toHaveBeenCalledWith('user-2')
    // …and NEVER the all-users scan that grows with total signups.
    expect(hoisted.listUsers).not.toHaveBeenCalled()

    // Response shape is unchanged.
    expect(body.workspace).toEqual(db.workspace)
    expect(body.aiMembers).toEqual([
      { id: 'ai-1', name: 'Eve', avatar_url: null, team_id: 'team-1' },
    ])
    expect(body.invites).toEqual([])
    expect(body.currentRole).toBe('owner')
    expect(body.currentMemberId).toBe('mem-1')
  })

  it('a rejected lookup yields "" for that member only — the request still succeeds', async () => {
    hoisted.getUserById.mockImplementation(async (id: string) => {
      if (id === 'user-2') throw new Error('service role key mismatch')
      return { data: { user: { id, email: `${id}@example.com` } }, error: null }
    })

    const res = await GET()
    expect(res.status).toBe(200)

    const body = await readJson<WorkspaceResponse>(res)
    expect(body.members.map((m) => m.email)).toEqual(['user-1@example.com', ''])
  })

  it('an errored (non-throwing) lookup also falls back to ""', async () => {
    hoisted.getUserById.mockImplementation(async (id: string) => {
      if (id === 'user-1') {
        return { data: { user: null }, error: { message: 'User not found' } }
      }
      return { data: { user: { id, email: `${id}@example.com` } }, error: null }
    })

    const res = await GET()
    expect(res.status).toBe(200)

    const body = await readJson<WorkspaceResponse>(res)
    expect(body.members.map((m) => m.email)).toEqual(['', 'user-2@example.com'])
  })

  it('chunks the lookups for a large workspace — parallel within a chunk, never more than 10 in flight', async () => {
    // 25 members: three chunks (10 / 10 / 5). The unbounded Promise.all this
    // guards against would put all 25 in flight at once.
    const originalMembers = db.members
    db.members = Array.from({ length: 25 }, (_, i) => ({
      id: `mem-${i + 1}`,
      user_id: `user-${i + 1}`,
      display_name: `User ${i + 1}`,
      avatar_url: null,
      role: i === 0 ? 'owner' : 'member',
      created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))

    // Track in-flight concurrency. The setTimeout(0) hold is what makes the
    // lookups of one chunk genuinely overlap — each increments BEFORE any of
    // them resolves, so `peak` observes the real fan-out width.
    let active = 0
    let peak = 0
    hoisted.getUserById.mockImplementation(async (id: string) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active -= 1
      // One failure in the FIRST chunk (throw) and one in the LAST (soft
      // error): a failed chunk member must not fail its chunk, and later
      // chunks must still run after an earlier chunk had a failure.
      if (id === 'user-3') throw new Error('gotrue timeout')
      if (id === 'user-22') return { data: { user: null }, error: { message: 'not found' } }
      return { data: { user: { id, email: `${id}@example.com` } }, error: null }
    })

    try {
      const res = await GET()
      expect(res.status).toBe(200)

      // One lookup per member, chunk-bounded — parallel (not serialized to 1),
      // never the whole workspace at once.
      expect(hoisted.getUserById).toHaveBeenCalledTimes(25)
      expect(peak).toBeLessThanOrEqual(10)
      expect(peak).toBeGreaterThan(1)
      expect(hoisted.listUsers).not.toHaveBeenCalled()

      // Every member keeps its slot in member order; the two failures fall
      // back to '' without dragging their chunkmates (or the request) down.
      const body = await readJson<WorkspaceResponse>(res)
      expect(body.members).toHaveLength(25)
      expect(body.members.map((m) => m.email)).toEqual(
        db.members.map((m) =>
          m.user_id === 'user-3' || m.user_id === 'user-22' ? '' : `${m.user_id}@example.com`,
        ),
      )
    } finally {
      db.members = originalMembers
    }
  })
})

describe('GET /api/account/workspace — the assignee list (bots-v3 Phase 3)', () => {
  it('leaves system teammates and work bots (fronts_only) out', async () => {
    aiMemberEqs.length = 0
    const res = await GET()
    expect(res.status).toBe(200)
    expect(aiMemberEqs).toEqual(expect.arrayContaining([['is_system', false], ['fronts_only', false]]))
  })
})
