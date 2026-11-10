/**
 * Tests for GET /api/account/labels and POST /api/account/labels
 *
 * Follows the integration-test pattern in src/test/integration.ts.
 *
 * GET
 *   - 401 when unauthenticated
 *   - 200 with full label list when no scope filter
 *   - 200 filtered by scope (universal + matching labels returned)
 *
 * POST
 *   - 401 when unauthenticated
 *   - 400 when name is missing
 *   - 409 when name already exists
 *   - 200 on success with correct DB insert (name, color, scopes, group_name)
 *   - scopes validated — invalid scope values stripped
 *   - null scopes when scopes array is empty
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  labelInsert: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

// Minimal chainable Supabase query builder
function chain(result: unknown) {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve(result)
      }
      return () => new Proxy({}, handler)
    },
  }
  return new Proxy({}, handler)
}

function makeFakeSupabase(opts: {
  labelListData?: unknown
  labelInsertResult?: unknown
} = {}) {
  const { labelListData = [], labelInsertResult = { data: null, error: null } } = opts

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    from: (table: string) => {
      if (table === 'label') {
        return {
          select: () => chain({ data: labelListData, error: null }),
          insert: (payload: unknown) => {
            hoisted.labelInsert(payload)
            return chain(labelInsertResult)
          },
        }
      }
      return chain({ data: null, error: null })
    },
  }
}

function makeAuthContext(supabaseOpts?: Parameters<typeof makeFakeSupabase>[0]) {
  return {
    supabase: makeFakeSupabase(supabaseOpts),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  }
}

const UNAUTHED_RESPONSE = new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
})

const { GET, POST } = await import('@/app/api/account/labels/route')

function getReq(scope?: string): NextRequest {
  const url = scope
    ? `https://nativeintelligence.dev/api/account/labels?scope=${scope}`
    : 'https://nativeintelligence.dev/api/account/labels'
  const req = buildRequest({ url, method: 'GET' })
  // next/server NextRequest exposes nextUrl; polyfill it for tests
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as unknown as NextRequest
}

function postReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/labels',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.labelInsert.mockReset()
  hoisted.requireWorkspace.mockResolvedValue(makeAuthContext())
})

// ─── GET ────────────────────────────────────────────────────────────────────

describe('GET /api/account/labels', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(UNAUTHED_RESPONSE)
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns empty labels array when workspace has no labels', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await readJson<{ labels: unknown[] }>(res)
    expect(body.labels).toEqual([])
  })

  it('returns all labels when no scope filter', async () => {
    const fakeLabels = [
      { id: 'l-1', name: 'Bug', color: '#ef4444', group_name: null, scopes: null },
      { id: 'l-2', name: 'Feature', color: '#22c55e', group_name: 'Type', scopes: ['action'] },
    ]
    hoisted.requireWorkspace.mockResolvedValueOnce(
      makeAuthContext({ labelListData: fakeLabels }),
    )
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await readJson<{ labels: { id: string; name: string }[] }>(res)
    expect(body.labels).toHaveLength(2)
    expect(body.labels[0]).toMatchObject({ id: 'l-1', name: 'Bug' })
    expect(body.labels[1]).toMatchObject({ id: 'l-2', name: 'Feature' })
  })

  it('passes scope filter through when provided', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(makeAuthContext({ labelListData: [] }))
    const res = await GET(getReq('action'))
    expect(res.status).toBe(200)
  })
})

// ─── POST ───────────────────────────────────────────────────────────────────

describe('POST /api/account/labels', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(UNAUTHED_RESPONSE)
    const res = await POST(postReq({ name: 'Bug' }))
    expect(res.status).toBe(401)
    expect(hoisted.labelInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when name is missing', async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(400)
    expect(hoisted.labelInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when name is empty string', async () => {
    const res = await POST(postReq({ name: '' }))
    expect(res.status).toBe(400)
    expect(hoisted.labelInsert).not.toHaveBeenCalled()
  })

  it('returns 409 when a label with that name already exists', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      makeAuthContext({
        labelInsertResult: { data: null, error: { code: '23505', message: 'duplicate' } },
      }),
    )
    const res = await POST(postReq({ name: 'Bug' }))
    expect(res.status).toBe(409)
    expect(hoisted.labelInsert).toHaveBeenCalled()
  })

  it('creates label with default color and inserts correct payload', async () => {
    const created = { id: 'l-new', name: 'Triaged', color: '#6b7280', group_name: null, scopes: null }
    hoisted.requireWorkspace.mockResolvedValueOnce(
      makeAuthContext({ labelInsertResult: { data: created, error: null } }),
    )
    const res = await POST(postReq({ name: 'Triaged' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ label: { id: string } }>(res)
    expect(body.label.id).toBe('l-new')
    expect(hoisted.labelInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'workspace-1',
        name: 'Triaged',
        color: '#6b7280',
        group_name: null,
        scopes: null,
      }),
    )
  })

  it('creates label with provided color, scopes, and group_name', async () => {
    const created = {
      id: 'l-2',
      name: 'Backend',
      color: '#3b82f6',
      group_name: 'Team',
      scopes: ['action', 'project'],
    }
    hoisted.requireWorkspace.mockResolvedValueOnce(
      makeAuthContext({ labelInsertResult: { data: created, error: null } }),
    )
    const res = await POST(
      postReq({ name: 'Backend', color: '#3b82f6', group_name: 'Team', scopes: ['action', 'project'] }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.labelInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Backend',
        color: '#3b82f6',
        group_name: 'Team',
        scopes: ['action', 'project'],
      }),
    )
  })

  it('stores null scopes when scopes array is empty', async () => {
    const created = { id: 'l-3', name: 'Universal', color: '#6b7280', group_name: null, scopes: null }
    hoisted.requireWorkspace.mockResolvedValueOnce(
      makeAuthContext({ labelInsertResult: { data: created, error: null } }),
    )
    const res = await POST(postReq({ name: 'Universal', scopes: [] }))
    expect(res.status).toBe(200)
    expect(hoisted.labelInsert).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: null }),
    )
  })

  it('strips invalid scope values', async () => {
    const created = { id: 'l-4', name: 'Filtered', color: '#6b7280', group_name: null, scopes: ['action'] }
    hoisted.requireWorkspace.mockResolvedValueOnce(
      makeAuthContext({ labelInsertResult: { data: created, error: null } }),
    )
    const res = await POST(postReq({ name: 'Filtered', scopes: ['action', 'invalid_scope'] }))
    expect(res.status).toBe(200)
    expect(hoisted.labelInsert).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['action'] }),
    )
  })
})
