import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/account/captures/[id]/move.
 *
 * The route is a thin wrapper around the `move_capture` Postgres RPC.
 * These tests lock in the HTTP-status mapping for each Postgres errcode
 * the RPC raises, the happy path, and the artifact-migration options
 * (confirmed_action_ids / move_claims / move_contacts) added in migration
 * 155 — validation plus exact passthrough to the RPC.
 *
 * Since migration 221 the route does NO storage work (the attachments bucket
 * authorizes via the attachments row), so the mock exposes only auth + rpc.
 */

const hoisted = vi.hoisted(() => {
  return {
    getUser: vi.fn(),
    rpc: vi.fn(),
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    rpc: hoisted.rpc,
  }),
}))

const { POST } = await import('@/app/api/account/captures/[id]/move/route')

function buildReq(body: unknown) {
  return new Request(
    'https://dial8.ai/api/account/captures/c1/move',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  )
}

const params = Promise.resolve({ id: 'c1' })

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.rpc.mockReset()
  hoisted.getUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  })
})

describe('POST /api/account/captures/[id]/move', () => {
  it('returns 401 when unauthenticated, and never calls the RPC', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when destination_workspace_id is missing', async () => {
    const res = await POST(buildReq({}), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('BAD_REQUEST')
  })

  it('returns 400 on invalid JSON body', async () => {
    const res = await POST(buildReq('not-json'), { params })
    expect(res.status).toBe(400)
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

  it('maps RPC P0002 (not found) to 404', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'capture not found' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(404)
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

  it('maps RPC 42501 (not a member) to 403 with sanitized message', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'not a member of workspace abc-123' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(403)
    const body = await res.json()
    // Raw message contains workspace id; route must NOT leak it.
    expect(body.error).toBe('You need admin rights (or ownership of this item) to move it')
    expect(body.error).not.toContain('abc-123')
  })

  it('maps RPC 23505 (unique violation, e.g. identifier collision) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "actions_identifier_workspace_idx"',
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('conflicting record')
    // Raw Postgres constraint name should not leak.
    expect(body.error).not.toContain('actions_identifier_workspace_idx')
  })

  it('returns 503 SCHEMA_CACHE_STALE when PostgREST cannot find the function', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: undefined,
        message: "Could not find the function public.move_capture in the schema cache",
      },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('SCHEMA_CACHE_STALE')
    expect(body.error).toContain('retry')
  })

  it('returns 500 with generic message on unknown RPC error', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '08006', message: 'connection failure to db host 10.0.0.5' },
    })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Move failed')
    // Internal connection details must not leak.
    expect(body.error).not.toContain('10.0.0.5')
  })

  it('returns 500 when RPC returns no data and no error (null payload)', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: null })
    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(500)
  })

  it('returns 200 with the RPC payload on happy path', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: {
        capture_id: 'c1',
        source_workspace_id: 'w1',
        destination_workspace_id: 'w2',
        counts: {
          unlinked_actions: 0,
          moved_suggested_actions: 0,
          moved_confirmed_actions: 0,
          moved_decisions: 0,
          moved_proposed_changes: 0,
          moved_claims: 0,
          shared_claims_left: 0,
          copied_contacts: 0,
        },
      },
      error: null,
    })

    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(200)

    // Omitted artifact options fall back to safe defaults: no confirmed
    // actions move without an explicit selection; claims and contacts do.
    expect(hoisted.rpc).toHaveBeenCalledWith('move_capture', {
      p_capture_id: 'c1',
      p_destination_workspace_id: 'w2',
      p_confirmed_action_ids: [],
      p_move_claims: true,
      p_move_contacts: true,
    })

    const body = await res.json()
    expect(body).toEqual({
      capture_id: 'c1',
      source_workspace_id: 'w1',
      destination_workspace_id: 'w2',
      counts: {
        unlinked_actions: 0,
        moved_suggested_actions: 0,
        moved_confirmed_actions: 0,
        moved_decisions: 0,
        moved_proposed_changes: 0,
        moved_claims: 0,
        shared_claims_left: 0,
        copied_contacts: 0,
      },
    })
  })

  it('surfaces unlinked_actions count when accepted actions stay behind', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: {
        capture_id: 'c1',
        source_workspace_id: 'w1',
        destination_workspace_id: 'w2',
        counts: {
          unlinked_actions: 3,
          moved_suggested_actions: 2,
          moved_decisions: 1,
          moved_proposed_changes: 5,
        },
      },
      error: null,
    })

    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.counts.unlinked_actions).toBe(3)
    expect(body.counts.moved_decisions).toBe(1)
  })

  it('passes the v3 counts (shares, labels, external tasks) through verbatim', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: {
        capture_id: 'c1',
        source_workspace_id: 'w1',
        destination_workspace_id: 'w2',
        counts: {
          unlinked_actions: 0,
          attachments: 2,
          shares_deactivated: 1,
          ai_threads_unlinked: 1,
          external_tasks_severed: 3,
          labels_remapped: 4,
          labels_removed: 1,
          renumbered: 1,
          identifier_map: { 'ENG-4': 'GEN-9' },
        },
      },
      error: null,
    })

    const res = await POST(buildReq({ destination_workspace_id: 'w2' }), { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.counts.shares_deactivated).toBe(1)
    expect(body.counts.external_tasks_severed).toBe(3)
    expect(body.counts.identifier_map).toEqual({ 'ENG-4': 'GEN-9' })
    // The storage copy is gone with migration 221: no attachment bookkeeping
    // leaks back into the response.
    expect(body.attachments_moved).toBeUndefined()
    expect(body.attachments_failed).toBeUndefined()
  })

  it('passes the artifact selections through to the RPC verbatim (deduped)', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: {
        capture_id: 'c1',
        source_workspace_id: 'w1',
        destination_workspace_id: 'w2',
        counts: {
          unlinked_actions: 1,
          moved_suggested_actions: 0,
          moved_confirmed_actions: 2,
          moved_decisions: 0,
          moved_proposed_changes: 0,
          moved_claims: 0,
          shared_claims_left: 0,
          copied_contacts: 0,
        },
      },
      error: null,
    })

    const res = await POST(
      buildReq({
        destination_workspace_id: 'w2',
        confirmed_action_ids: ['act-1', 'act-2', 'act-1'],
        move_claims: false,
        move_contacts: false,
      }),
      { params },
    )
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_capture', {
      p_capture_id: 'c1',
      p_destination_workspace_id: 'w2',
      p_confirmed_action_ids: ['act-1', 'act-2'],
      p_move_claims: false,
      p_move_contacts: false,
    })
  })

  it('surfaces the new artifact counts in the response', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: {
        capture_id: 'c1',
        source_workspace_id: 'w1',
        destination_workspace_id: 'w2',
        counts: {
          unlinked_actions: 1,
          moved_suggested_actions: 2,
          moved_confirmed_actions: 3,
          moved_decisions: 1,
          moved_proposed_changes: 4,
          moved_claims: 5,
          shared_claims_left: 2,
          copied_contacts: 6,
        },
      },
      error: null,
    })

    const res = await POST(
      buildReq({ destination_workspace_id: 'w2', confirmed_action_ids: ['a', 'b', 'c'] }),
      { params },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.counts.moved_confirmed_actions).toBe(3)
    expect(body.counts.moved_claims).toBe(5)
    expect(body.counts.shared_claims_left).toBe(2)
    expect(body.counts.copied_contacts).toBe(6)
  })

  it('returns 400 when confirmed_action_ids is not an array of strings', async () => {
    for (const bad of ['act-1', { id: 'act-1' }, [42], [''], [null]]) {
      const res = await POST(
        buildReq({ destination_workspace_id: 'w2', confirmed_action_ids: bad }),
        { params },
      )
      expect(res.status).toBe(400)
    }
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when confirmed_action_ids exceeds the size cap', async () => {
    const res = await POST(
      buildReq({
        destination_workspace_id: 'w2',
        confirmed_action_ids: Array.from({ length: 501 }, (_, i) => `act-${i}`),
      }),
      { params },
    )
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when move_claims / move_contacts are not booleans', async () => {
    for (const body of [
      { destination_workspace_id: 'w2', move_claims: 'yes' },
      { destination_workspace_id: 'w2', move_contacts: 1 },
    ]) {
      const res = await POST(buildReq(body), { params })
      expect(res.status).toBe(400)
    }
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('maps RPC 22P02 (malformed UUID in confirmed_action_ids) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' },
    })
    const res = await POST(
      buildReq({ destination_workspace_id: 'w2', confirmed_action_ids: ['not-a-uuid'] }),
      { params },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('UUID')
  })

  it('maps RPC P0004 (invalid confirmed action ids) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0004',
        message:
          'confirmed_action_ids contains an id that is not a confirmed action of this capture',
      },
    })
    const res = await POST(
      buildReq({ destination_workspace_id: 'w2', confirmed_action_ids: ['not-mine'] }),
      { params },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('confirmed actions')
  })
})
