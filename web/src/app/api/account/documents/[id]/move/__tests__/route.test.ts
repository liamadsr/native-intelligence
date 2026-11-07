import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/account/documents/[id]/move.
 *
 * The route is a thin wrapper around the `move_document` Postgres RPC
 * (migration 221). These tests lock in the HTTP-status mapping for each
 * errcode the RPC raises, the `move_claims` validation + default, and the
 * exact argument object the RPC receives.
 */

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireUser: hoisted.requireUser,
}))

const { POST } = await import('@/app/api/account/documents/[id]/move/route')

function buildReq(body: unknown) {
  return new Request('https://dial8.ai/api/account/documents/d1/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: 'd1' })

const okResult = {
  document_id: 'd1',
  source_workspace_id: 'w1',
  destination_workspace_id: 'w2',
  counts: {
    moved_claims: 2,
    shared_claims_left: 1,
    shares_deactivated: 1,
    drafts_discarded: 3,
  },
}

beforeEach(() => {
  hoisted.requireUser.mockReset()
  hoisted.rpc.mockReset()
  hoisted.requireUser.mockResolvedValue({
    supabase: { rpc: hoisted.rpc },
    user: { id: 'user-1' },
  })
})

describe('POST /api/account/documents/[id]/move', () => {
  it('returns 401 when unauthenticated, and never calls the RPC', async () => {
    hoisted.requireUser.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 on invalid JSON body', async () => {
    const res = await POST(buildReq('not-json'), { params })
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when destination_workspace_id is missing', async () => {
    const res = await POST(buildReq({}), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('BAD_REQUEST')
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when move_claims is not a boolean', async () => {
    for (const bad of ['yes', 1, null]) {
      const res = await POST(
        buildReq({ destination_workspace_id: 'w2', move_claims: bad }),
        { params },
      )
      expect(res.status).toBe(400)
    }
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('maps RPC P0002 (not found) to 404', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'not found' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Document not found')
  })

  it('maps RPC 22023 (same workspace) to 400 with sanitized message', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'destination is the same workspace' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Source and destination workspace are the same')
  })

  it('maps RPC 22P02 (malformed UUID) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22P02', message: 'invalid input syntax for type uuid: "nope"' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'nope' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('UUID')
  })

  it('maps the 360 product-doc refusal (42501) to its own 403 line', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'only an owner or admin can move the workspace product doc' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Only a workspace owner or admin can move the workspace product doc')
  })

  it('maps RPC 42501 (insufficient rights) to 403 without leaking ids', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '42501',
        message: 'not authorized in destination workspace 9a1e-not-a-secret-uuid',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe(
      'You need admin rights (or ownership of this item) to move it',
    )
    expect(body.error).not.toContain('9a1e-not-a-secret-uuid')
  })

  it('maps RPC 23505 (unique violation) to 400 without leaking the constraint', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "document_slug_key"',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('conflicting record')
    expect(body.error).not.toContain('document_slug_key')
  })

  it('returns 503 SCHEMA_CACHE_STALE when PostgREST cannot find the function', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: undefined,
        message: 'Could not find the function public.move_document in the schema cache',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('SCHEMA_CACHE_STALE')
  })

  it('returns 500 with a generic message on an unknown RPC error', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '08006', message: 'connection failure to db host 10.0.0.5' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Move failed')
    expect(body.error).not.toContain('10.0.0.5')
  })

  it('returns 500 when the RPC returns no data and no error', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: null })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(500)
  })

  it('defaults move_claims to true', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_document', {
      p_document_id: 'd1',
      p_destination_workspace_id: 'w2',
      p_move_claims: true,
    })
  })

  it('passes move_claims: false through and returns the RPC result verbatim', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })
    const res = await POST(
      buildReq({ destination_workspace_id: 'w2', move_claims: false }),
      { params },
    )
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_document', {
      p_document_id: 'd1',
      p_destination_workspace_id: 'w2',
      p_move_claims: false,
    })
    const body = await res.json()
    expect(body).toEqual(okResult)
  })
})
