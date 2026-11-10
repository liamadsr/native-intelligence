/**
 * Tests for GET/POST /api/account/views — perf phase 2 migration to
 * requireWorkspace.
 *
 * Locked in: 401 passthrough from the auth helper, the GET payload shape
 * (views + is_favorited + total), favorites_only filtering, and POST
 * validation error semantics ({ error, code } bodies).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  viewRows: [] as Record<string, unknown>[],
  favoriteRows: [] as { view_id: string }[],
  viewInsert: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

function chain(result: unknown) {
  const target: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => new Proxy(target, handler)
    },
  }
  return new Proxy(target, handler)
}

function makeFakeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'view') {
        return {
          select: () => chain({ data: hoisted.viewRows, count: hoisted.viewRows.length, error: null }),
          insert: (payload: unknown) => {
            hoisted.viewInsert(payload)
            return chain({ data: { id: 'view-new', ...(payload as Record<string, unknown>) }, error: null })
          },
        }
      }
      if (table === 'view_favorite') {
        return chain({ data: hoisted.favoriteRows, error: null })
      }
      return chain({ data: null, error: null })
    },
  }
}

const { GET, POST } = await import('@/app/api/account/views/route')

function getReq(query = ''): NextRequest {
  // The route reads request.nextUrl.searchParams — a plain fetch Request has
  // no nextUrl, so stub it with a URL (same searchParams surface).
  const req = buildRequest({
    url: `https://nativeintelligence.dev/api/account/views${query}`,
    method: 'GET',
  }) as Request & { nextUrl: URL }
  req.nextUrl = new URL(`https://nativeintelligence.dev/api/account/views${query}`)
  return req as unknown as NextRequest
}

function postReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/views',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.viewInsert.mockReset()
  hoisted.viewRows = [
    { id: 'view-1', name: 'My view', entity_type: 'action' },
    { id: 'view-2', name: 'Other view', entity_type: 'action' },
  ]
  hoisted.favoriteRows = [{ view_id: 'view-1' }]

  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  })
})

function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('GET /api/account/views', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(unauthorizedResponse())
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns views with is_favorited flags and total', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await readJson<{ views: { id: string; is_favorited: boolean }[]; total: number }>(res)
    expect(body.views).toHaveLength(2)
    expect(body.views[0]).toMatchObject({ id: 'view-1', is_favorited: true })
    expect(body.views[1]).toMatchObject({ id: 'view-2', is_favorited: false })
    expect(body.total).toBe(2)
  })

  it('favorites_only filters to favorited views and totals the filtered set', async () => {
    const res = await GET(getReq('?favorites_only=true'))
    const body = await readJson<{ views: { id: string }[]; total: number }>(res)
    expect(body.views).toHaveLength(1)
    expect(body.views[0].id).toBe('view-1')
    expect(body.total).toBe(1)
  })
})

describe('POST /api/account/views', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(unauthorizedResponse())
    const res = await POST(postReq({ name: 'X', entity_type: 'action' }))
    expect(res.status).toBe(401)
    expect(hoisted.viewInsert).not.toHaveBeenCalled()
  })

  it('400s a missing name with the standard error shape', async () => {
    const res = await POST(postReq({ entity_type: 'action' }))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body.error).toBe('Name is required')
    expect(body.code).toBe('BAD_REQUEST')
  })

  it('400s a team view without team_id', async () => {
    const res = await POST(postReq({ name: 'X', entity_type: 'action', visibility: 'team' }))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('Team views require a team_id')
  })

  it('creates a view stamped with workspace and creator', async () => {
    const res = await POST(postReq({ name: 'New view', entity_type: 'action' }))
    expect(res.status).toBe(201)
    const body = await readJson<{ view: { id: string } }>(res)
    expect(body.view.id).toBe('view-new')
    expect(hoisted.viewInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'workspace-1',
        created_by: 'user-1',
        name: 'New view',
        entity_type: 'action',
      }),
    )
  })
})
