/**
 * Tests for GET/POST /api/account/captures/[id]/labels
 *
 * Follows the integration-test pattern established in
 * src/app/api/account/actions/__tests__/route.test.ts.
 *
 * What we assert:
 *   GET
 *     - 401 when unauthenticated
 *     - 404 when capture does not belong to this workspace
 *     - 200 with empty array when capture has no labels
 *     - 200 with labels when labels are attached
 *   POST
 *     - 401 when unauthenticated
 *     - 400 when label_id is missing
 *     - 404 when capture not found in workspace
 *     - 409 when label is already attached
 *     - 200 on success, verifying the DB insert was called with right args
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  captureLabelInsert: vi.fn(),
}))

// Minimal chainable Supabase builder
function makeChain(result: unknown): unknown {
  const chain: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  return new Proxy(chain, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve(result)
      }
      return () => proxy
    },
  })
  var proxy = new Proxy(chain, { // NOSONAR – var hoisting needed so proxy can refer to itself
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve(result)
      }
      return () => proxy
    },
  })
}

// Proxy that returns itself for any chained method, resolving to `result`
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
  captureData: unknown
  captureLabelData?: unknown
}) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    from: (table: string) => {
      if (table === 'captures') {
        return chain({ data: opts.captureData, error: null })
      }
      if (table === 'capture_label') {
        if (opts.captureLabelData !== undefined) {
          return {
            select: () => chain({ data: opts.captureLabelData, error: null }),
            insert: (payload: unknown) => {
              hoisted.captureLabelInsert(payload)
              // Return error for 409 test
              if ((payload as { label_id: string }).label_id === 'label-dup') {
                return chain({ data: null, error: { code: '23505', message: 'duplicate' } })
              }
              return chain({ data: null, error: null })
            },
          }
        }
        return {
          select: () => chain({ data: [], error: null }),
          insert: (payload: unknown) => {
            hoisted.captureLabelInsert(payload)
            if ((payload as { label_id: string }).label_id === 'label-dup') {
              return chain({ data: null, error: { code: '23505', message: 'duplicate' } })
            }
            return chain({ data: null, error: null })
          },
        }
      }
      return chain({ data: null, error: null })
    },
    rpc: vi.fn(),
  }
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

// Import route handlers after mocking
const { GET, POST } = await import(
  '@/app/api/account/captures/[id]/labels/route'
)

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function getReq(): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/captures/capture-1/labels',
    method: 'GET',
  }) as unknown as NextRequest
}

function postReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/captures/capture-1/labels',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.captureLabelInsert.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeFakeSupabase({ captureData: { id: 'capture-1' } }),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  })
})

// ─── GET ────────────────────────────────────────────────────────────────────

describe('GET /api/account/captures/[id]/labels', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await GET(getReq(), makeParams('capture-1'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when capture not found in workspace', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce({
      supabase: makeFakeSupabase({ captureData: null }),
      user: { id: 'user-1' },
      workspaceId: 'workspace-1',
    })
    const res = await GET(getReq(), makeParams('capture-1'))
    expect(res.status).toBe(404)
  })

  it('returns empty labels array when no labels attached', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce({
      supabase: makeFakeSupabase({
        captureData: { id: 'capture-1' },
        captureLabelData: [],
      }),
      user: { id: 'user-1' },
      workspaceId: 'workspace-1',
    })
    const res = await GET(getReq(), makeParams('capture-1'))
    expect(res.status).toBe(200)
    const body = await readJson<{ labels: unknown[] }>(res)
    expect(body.labels).toEqual([])
  })

  it('returns labels when attached', async () => {
    const fakeLabels = [
      { label: { id: 'label-1', name: 'Bug', color: '#ff0000' } },
      { label: { id: 'label-2', name: 'Feature', color: '#00ff00' } },
    ]
    hoisted.requireWorkspace.mockResolvedValueOnce({
      supabase: makeFakeSupabase({
        captureData: { id: 'capture-1' },
        captureLabelData: fakeLabels,
      }),
      user: { id: 'user-1' },
      workspaceId: 'workspace-1',
    })
    const res = await GET(getReq(), makeParams('capture-1'))
    expect(res.status).toBe(200)
    const body = await readJson<{ labels: { id: string; name: string }[] }>(res)
    expect(body.labels).toHaveLength(2)
    expect(body.labels[0]).toMatchObject({ id: 'label-1', name: 'Bug' })
    expect(body.labels[1]).toMatchObject({ id: 'label-2', name: 'Feature' })
  })
})

// ─── POST ───────────────────────────────────────────────────────────────────

describe('POST /api/account/captures/[id]/labels', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await POST(postReq({ label_id: 'label-1' }), makeParams('capture-1'))
    expect(res.status).toBe(401)
    expect(hoisted.captureLabelInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when label_id is missing', async () => {
    const res = await POST(postReq({}), makeParams('capture-1'))
    expect(res.status).toBe(400)
    expect(hoisted.captureLabelInsert).not.toHaveBeenCalled()
  })

  it('returns 404 when capture not found in workspace', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce({
      supabase: makeFakeSupabase({ captureData: null }),
      user: { id: 'user-1' },
      workspaceId: 'workspace-1',
    })
    const res = await POST(postReq({ label_id: 'label-1' }), makeParams('capture-1'))
    expect(res.status).toBe(404)
    expect(hoisted.captureLabelInsert).not.toHaveBeenCalled()
  })

  it('returns 409 when label is already attached', async () => {
    const res = await POST(postReq({ label_id: 'label-dup' }), makeParams('capture-1'))
    expect(res.status).toBe(409)
  })

  it('returns 200 on success and inserts into capture_label', async () => {
    const res = await POST(postReq({ label_id: 'label-1' }), makeParams('capture-1'))
    expect(res.status).toBe(200)
    const body = await readJson<{ success: boolean }>(res)
    expect(body.success).toBe(true)
    expect(hoisted.captureLabelInsert).toHaveBeenCalledWith({
      capture_id: 'capture-1',
      label_id: 'label-1',
    })
  })
})
