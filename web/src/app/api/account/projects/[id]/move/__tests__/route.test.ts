import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/account/projects/[id]/move.
 *
 * The route is a thin wrapper around the `move_project` Postgres RPC
 * (migration 221). These tests lock in the HTTP-status mapping for each
 * errcode the RPC raises — including P0005, the default project that can
 * never move — the body validation (which must never reach the RPC), and the
 * exact argument object handed to it.
 */

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireUser: hoisted.requireUser,
}))

const { POST } = await import('@/app/api/account/projects/[id]/move/route')

function buildReq(body: unknown) {
  return new Request('https://dial8.ai/api/account/projects/p1/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: 'p1' })

const okResult = {
  project_id: 'p1',
  source_workspace_id: 'w1',
  destination_workspace_id: 'w2',
  destination_team_id: 't2',
  counts: { moved_actions: 4, moved_documents: 2, renumbered: 1 },
}

beforeEach(() => {
  hoisted.requireUser.mockReset()
  hoisted.rpc.mockReset()
  hoisted.requireUser.mockResolvedValue({
    supabase: { rpc: hoisted.rpc },
    user: { id: 'user-1' },
  })
})

describe('POST /api/account/projects/[id]/move', () => {
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

  it('returns 400 when destination_team_id is not a non-empty string', async () => {
    for (const bad of [42, '', { id: 't2' }]) {
      const res = await POST(
        buildReq({ destination_workspace_id: 'w2', destination_team_id: bad }),
        { params },
      )
      expect(res.status).toBe(400)
    }
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when move_documents is not a boolean', async () => {
    const res = await POST(
      buildReq({ destination_workspace_id: 'w2', move_documents: 'yes' }),
      { params },
    )
    expect(res.status).toBe(400)
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
    expect(body.error).toBe('Project not found')
  })

  it('maps RPC P0003 (no destination team) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0003',
        message: 'destination workspace has no team with a default workflow state',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('no team')
  })

  it('maps RPC P0004 (ids span workspaces) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0004', message: 'action ids must all exist in one workspace' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
  })

  it('maps RPC P0005 (default project) to 400 with the dedicated message', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0005',
        message: 'the default project cannot be moved',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('The default project cannot be moved')
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
    expect(body.error).not.toContain('nope')
  })

  it('maps the 360 product-doc refusal (42501) to its own 403 line', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'only an owner or admin can move a project holding the workspace product doc' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Only a workspace owner or admin can move a project that holds the workspace product doc')
  })

  it('maps RPC 42501 (insufficient rights) to 403 with sanitized message', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '42501',
        message:
          'moving this requires workspace admin rights (workspace 3f6b2c11-0000-4000-8000-000000000001)',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe(
      'You need admin rights (or ownership of this item) to move it',
    )
    expect(body.error).not.toContain('3f6b2c11-0000-4000-8000-000000000001')
  })

  it('maps RPC 23505 (unique violation) to 400 without leaking the constraint', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "actions_identifier_workspace_idx"',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('conflicting record')
    expect(body.error).not.toContain('actions_identifier_workspace_idx')
  })

  it('returns 503 SCHEMA_CACHE_STALE when PostgREST cannot find the function', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: undefined,
        message: 'Could not find the function public.move_project in the schema cache',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('SCHEMA_CACHE_STALE')
    expect(body.error).toContain('retry')
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

  it('defaults move_documents to true and destination_team_id to null', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_project', {
      p_project_id: 'p1',
      p_destination_workspace_id: 'w2',
      p_destination_team_id: null,
      p_move_documents: true,
    })
  })

  it('passes the caller options through to the RPC verbatim', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })
    const res = await POST(
      buildReq({
        destination_workspace_id: 'w2',
        destination_team_id: 't2',
        move_documents: false,
      }),
      { params },
    )
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_project', {
      p_project_id: 'p1',
      p_destination_workspace_id: 'w2',
      p_destination_team_id: 't2',
      p_move_documents: false,
    })
  })

  it('returns the RPC result verbatim on the happy path', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(okResult)
  })
})
