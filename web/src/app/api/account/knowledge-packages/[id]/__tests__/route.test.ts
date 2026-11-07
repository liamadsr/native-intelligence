/**
 * Tests for PATCH /api/account/knowledge-packages/[id] — the team-visibility
 * invariant added in slice 0 of context packages (mirrors the POST-side
 * check on the RESULTING row), plus the export route's invisible-package
 * status (404, not the 400 it used to return).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  // Queue of results returned by successive terminal calls (single/
  // maybeSingle/awaited chain) against the knowledge_package table — PATCH
  // hits it twice: the existing-row fetch, then the update.
  packageResults: [] as unknown[],
}))

// ── Chain builder ──────────────────────────────────────────────────────────
function makeQueueChain() {
  const next = () =>
    Promise.resolve(
      hoisted.packageResults.length > 0
        ? hoisted.packageResults.shift()
        : { data: null, error: null },
    )
  const chain: Record<string, unknown> = {}
  const proxy = new Proxy(chain, {
    get(_t, prop: string) {
      if (prop === 'then') return (cb: (v: unknown) => unknown) => next().then(cb)
      if (prop === 'single' || prop === 'maybeSingle') return () => next()
      return () => proxy
    },
  })
  return proxy as unknown
}

function makeEmptyChain() {
  const chain: Record<string, unknown> = {}
  const proxy = new Proxy(chain, {
    get(_t, prop: string) {
      if (prop === 'then')
        return (cb: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(cb)
      if (prop === 'single' || prop === 'maybeSingle')
        return () => Promise.resolve({ data: null, error: null })
      return () => proxy
    },
  })
  return proxy as unknown
}

function makeFakeSupabase() {
  return {
    auth: { getUser: hoisted.getUser },
    // Only knowledge_package pops the result queue — any other table gets an
    // inert empty chain, so a future extra query can't silently mis-assign
    // queue entries.
    from: (table: string) =>
      table === 'knowledge_package' ? makeQueueChain() : makeEmptyChain(),
    rpc: vi.fn(),
  }
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => {
    const { data } = await hoisted.getUser()
    if (!data?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const workspaceId = await hoisted.getCurrentWorkspaceId()
    return { supabase: makeFakeSupabase(), user: data.user, workspaceId }
  },
}))

const { PATCH } = await import('@/app/api/account/knowledge-packages/[id]/route')
const { GET: EXPORT_GET } = await import(
  '@/app/api/account/knowledge-packages/[id]/export/route'
)

// ── Helpers ────────────────────────────────────────────────────────────────
const PKG_ID = 'pkg-abc'

function makeParams(id = PKG_ID) {
  return { params: Promise.resolve({ id }) }
}

function patchReq(body: unknown): NextRequest {
  return buildRequest({
    url: `https://dial8.ai/api/account/knowledge-packages/${PKG_ID}`,
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

function happyAuth() {
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.packageResults = []
})

describe('PATCH /knowledge-packages/[id] — team visibility invariant', () => {
  it('rejects visibility=team when neither patch nor row carries a team_id', async () => {
    happyAuth()
    hoisted.packageResults = [
      { data: { visibility: 'workspace', team_id: null }, error: null }, // existing-row fetch
    ]
    const res = await PATCH(patchReq({ visibility: 'team' }), makeParams())
    expect(res.status).toBe(400)
    const body = (await readJson(res)) as { error: string }
    expect(body.error).toMatch(/team visibility requires team_id/)
  })

  it('rejects nulling team_id on a team-visible package', async () => {
    happyAuth()
    hoisted.packageResults = [
      { data: { visibility: 'team', team_id: 'team-1' }, error: null },
    ]
    const res = await PATCH(patchReq({ team_id: null }), makeParams())
    expect(res.status).toBe(400)
  })

  it("accepts visibility=team when the row's existing team_id satisfies it", async () => {
    happyAuth()
    hoisted.packageResults = [
      { data: { visibility: 'workspace', team_id: 'team-1' }, error: null }, // fetch
      {
        data: {
          id: PKG_ID,
          name: 'P',
          slug: 'p',
          description: null,
          visibility: 'team',
          team_id: 'team-1',
          rules: {},
          updated_at: 'now',
        },
        error: null,
      }, // update
    ]
    const res = await PATCH(patchReq({ visibility: 'team' }), makeParams())
    expect(res.status).toBe(200)
    const body = (await readJson(res)) as { package: { visibility: string } }
    expect(body.package.visibility).toBe('team')
  })

  it('404s when the package is invisible or not editable', async () => {
    happyAuth()
    hoisted.packageResults = [{ data: null, error: null }]
    const res = await PATCH(patchReq({ visibility: 'team', team_id: 't' }), makeParams())
    expect(res.status).toBe(404)
  })

  it('skips the invariant fetch for unrelated updates', async () => {
    happyAuth()
    hoisted.packageResults = [
      {
        data: {
          id: PKG_ID,
          name: 'Renamed',
          slug: 'p',
          description: null,
          visibility: 'workspace',
          team_id: null,
          rules: {},
          updated_at: 'now',
        },
        error: null,
      }, // update is the FIRST and only knowledge_package query
    ]
    const res = await PATCH(patchReq({ name: 'Renamed' }), makeParams())
    expect(res.status).toBe(200)
  })
})

describe('GET /knowledge-packages/[id]/export — invisible package', () => {
  it('returns 404 (not 400) when RLS hides the package', async () => {
    happyAuth()
    hoisted.packageResults = [{ data: null, error: null }]
    const req = buildRequest({
      url: `https://dial8.ai/api/account/knowledge-packages/${PKG_ID}/export?format=markdown`,
      method: 'GET',
    }) as unknown as NextRequest
    const res = await EXPORT_GET(req, makeParams())
    expect(res.status).toBe(404)
  })
})
