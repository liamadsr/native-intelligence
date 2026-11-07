import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/account/initiatives/[id]/move.
 *
 * The route is a thin wrapper around the `move_initiative` Postgres RPC
 * (migration 221). There is no preflight for initiatives, so this is the only
 * place the errcode → HTTP mapping and the leak-free error copy are pinned.
 */

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireUser: hoisted.requireUser,
}))

const { POST } = await import('@/app/api/account/initiatives/[id]/move/route')

function buildReq(body: unknown) {
  return new Request('https://dial8.ai/api/account/initiatives/i1/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: 'i1' })

const okResult = {
  initiative_id: 'i1',
  source_workspace_id: 'w1',
  destination_workspace_id: 'w2',
  counts: {
    projects_unlinked: 3,
    labels_remapped: 1,
    labels_removed: 2,
    views_deleted: 1,
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

describe('POST /api/account/initiatives/[id]/move', () => {
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

  it('returns 400 when destination_workspace_id is missing or not a string', async () => {
    for (const body of [{}, { destination_workspace_id: 42 }, { destination_workspace_id: '' }]) {
      const res = await POST(buildReq(body), { params })
      expect(res.status).toBe(400)
      const parsed = await res.json()
      expect(parsed.code).toBe('BAD_REQUEST')
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
    expect(body.error).toBe('Initiative not found')
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

  it('maps RPC 42501 (insufficient rights) to 403 without leaking ids', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '42501',
        message: 'not authorized in destination workspace 11111111-2222-3333-4444-555555555555',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe(
      'You need admin rights (or ownership of this item) to move it',
    )
    expect(body.error).not.toContain('11111111-2222-3333-4444-555555555555')
  })

  it('maps RPC 23505 (unique violation) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "initiative_name_key"',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('conflicting record')
    expect(body.error).not.toContain('initiative_name_key')
  })

  it('returns 503 SCHEMA_CACHE_STALE when PostgREST cannot find the function', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: undefined,
        message: 'Could not find the function public.move_initiative in the schema cache',
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

  it('calls the RPC with the exact argument object and returns it verbatim', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_initiative', {
      p_initiative_id: 'i1',
      p_destination_workspace_id: 'w2',
    })
    const body = await res.json()
    expect(body).toEqual(okResult)
  })
})
