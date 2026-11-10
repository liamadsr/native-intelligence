/**
 * GET /api/account/captures — list, with capture visibility ("Only me").
 *
 * The list has two branches with very different exposure:
 *   - no project_id: already `.eq('user_id', me)`, so scope is implied.
 *   - project_id: deliberately drops the user filter to show the whole
 *     project's captures — which is exactly where a private capture would
 *     leak. That branch must carry the visibility predicate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  orSpy: vi.fn(),
  eqSpy: vi.fn(),
  selectSpy: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

vi.mock('@/lib/crm/contacts', () => ({ seedSelfParticipant: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

const WORKSPACE_ID = 'ws-test-1'
const USER_ID = 'user-1'
const PROJECT_ID = 'proj-1'

/**
 * Records the select columns plus every .or()/.eq() the captures query applies,
 * and resolves to a single capture row. `projects` resolves to a found project
 * so the project branch proceeds; the count-rollup tables resolve empty.
 */
function makeFakeSupabase({ projectFound = true } = {}) {
  const captureRow = {
    id: 'cap-1',
    title: 'Standup',
    summary: null,
    recorded_at: '2026-06-06T09:00:00Z',
    created_at: '2026-06-06T09:00:00Z',
    status: 'active',
    is_pinned: false,
    participants: [],
    duration_seconds: 60,
    started_at: '2026-06-06T09:00:00Z',
    ended_at: null,
    ai_processed: false,
    visibility: 'workspace',
  }

  const captureChain: Record<string, unknown> = {
    select: (cols: string) => {
      hoisted.selectSpy(cols)
      return captureChain
    },
    eq: (field: string, value: unknown) => {
      hoisted.eqSpy(field, value)
      return captureChain
    },
    neq: () => captureChain,
    or: (expr: string) => {
      hoisted.orSpy(expr)
      return captureChain
    },
    order: () => captureChain,
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [captureRow], error: null }),
  }

  const projectChain: Record<string, unknown> = {
    select: () => projectChain,
    eq: () => projectChain,
    maybeSingle: async () => ({ data: projectFound ? { id: PROJECT_ID } : null, error: null }),
  }

  const emptyChain: Record<string, unknown> = {
    select: () => emptyChain,
    eq: () => emptyChain,
    in: () => emptyChain,
    order: () => emptyChain,
    range: () => emptyChain,
    then: (resolve: (v: { data: never[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  }

  return {
    from: (table: string) => {
      if (table === 'captures') return captureChain
      if (table === 'projects') return projectChain
      return emptyChain
    },
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
  }
}

function happyAuth(opts: { projectFound?: boolean } = {}) {
  return {
    supabase: makeFakeSupabase(opts),
    user: { id: USER_ID },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  }
}

function listReq(query = ''): NextRequest {
  return {
    nextUrl: new URL(`https://nativeintelligence.dev/api/account/captures${query}`),
  } as unknown as NextRequest
}

/**
 * Create-path fake: `insert().select().single()` resolves to the inserted row
 * as the DB would return it under CAPTURE_LIST_FIELDS.
 */
function makeCreateSupabase(row: Record<string, unknown>) {
  const chain: Record<string, unknown> = {
    insert: () => chain,
    select: (cols: string) => {
      hoisted.selectSpy(cols)
      return chain
    },
    eq: () => chain,
    single: async () => ({ data: row, error: null }),
  }
  return { from: () => chain, auth: { getUser: vi.fn() }, rpc: vi.fn() }
}

function createReq(body: Record<string, unknown>): NextRequest {
  return {
    nextUrl: new URL('https://nativeintelligence.dev/api/account/captures'),
    json: async () => body,
  } as unknown as NextRequest
}

const { GET, POST } = await import('@/app/api/account/captures/route')

describe('GET /api/account/captures — visibility', () => {
  beforeEach(() => {
    hoisted.orSpy.mockClear()
    hoisted.eqSpy.mockClear()
    hoisted.selectSpy.mockClear()
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const res = await GET(listReq())
    expect(res.status).toBe(401)
  })

  it('selects the visibility column so the client can render scope', async () => {
    await GET(listReq())
    expect(hoisted.selectSpy.mock.calls[0][0]).toContain('visibility')
  })

  // user_id must travel WITH visibility: the scope control renders only for the
  // capture's creator, so a payload carrying visibility but not user_id leaves
  // the control hidden (canOfferVisibilityControl falls back to hiding it).
  it('selects user_id alongside visibility so the scope control can resolve the creator', async () => {
    await GET(listReq())
    expect(hoisted.selectSpy.mock.calls[0][0]).toContain('user_id')
  })

  it('the project branch applies the visibility predicate (it drops the user filter)', async () => {
    const res = await GET(listReq(`?project_id=${PROJECT_ID}`))
    expect(res.status).toBe(200)
    expect(hoisted.orSpy).toHaveBeenCalledWith(`visibility.eq.workspace,user_id.eq.${USER_ID}`)
    // And it must NOT fall back to the blanket user filter — the whole point of
    // the branch is showing teammates' workspace captures in the project.
    expect(hoisted.eqSpy).not.toHaveBeenCalledWith('user_id', USER_ID)
  })

  it('the no-project branch stays creator-scoped (visibility implied)', async () => {
    const res = await GET(listReq())
    expect(res.status).toBe(200)
    expect(hoisted.eqSpy).toHaveBeenCalledWith('user_id', USER_ID)
  })

  it('404s when the project is not in this workspace (before any capture read)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuth({ projectFound: false }))
    const res = await GET(listReq(`?project_id=${PROJECT_ID}`))
    expect(res.status).toBe(404)
  })

  it('returns the shaped capture list', async () => {
    const res = await GET(listReq())
    const json = await readJson<{ captures: Array<{ id: string }> }>(res)
    expect(json.captures).toHaveLength(1)
    expect(json.captures[0].id).toBe('cap-1')
  })
})

/**
 * POST /api/account/captures — the create response seeds the client-side
 * capture cache (seedCaptureCache), which is what the detail panel renders
 * from before its own GET lands. The scope control is creator-only, so the
 * response must carry BOTH user_id and visibility or the control stays hidden
 * on a brand-new capture — exactly when someone decides "this one is personal".
 */
describe('POST /api/account/captures — create response shape', () => {
  const createdRow = {
    id: 'cap-new',
    user_id: USER_ID,
    title: 'New capture',
    summary: null,
    recorded_at: '2026-06-06T09:00:00Z',
    created_at: '2026-06-06T09:00:00Z',
    status: 'active',
    is_pinned: false,
    visibility: 'workspace',
  }

  beforeEach(() => {
    hoisted.selectSpy.mockClear()
    hoisted.requireWorkspace.mockResolvedValue({
      supabase: makeCreateSupabase(createdRow),
      user: { id: USER_ID },
      workspaceId: WORKSPACE_ID,
      member: { id: 'member-1', role: 'owner' },
    })
  })

  it('returns user_id and visibility so the seeded cache can render the scope control', async () => {
    const res = await POST(createReq({ title: 'New capture' }))
    const json = await readJson<{ capture: { user_id: string; visibility: string } }>(res)
    expect(json.capture.user_id).toBe(USER_ID)
    expect(json.capture.visibility).toBe('workspace')
  })

  it('selects user_id on the insert so the row can carry it back', async () => {
    await POST(createReq({ title: 'New capture' }))
    expect(hoisted.selectSpy.mock.calls[0][0]).toContain('user_id')
  })
})
