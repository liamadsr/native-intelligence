import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/account/actions/move.
 *
 * The route is a thin wrapper around the `move_actions` Postgres RPC
 * (migration 221). These tests lock in the request validation (which must
 * never reach the RPC), the exact RPC argument object, and the HTTP-status
 * mapping for every errcode the engine raises — including the sanitization
 * that keeps interpolated workspace/action ids out of error bodies.
 */

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    rpc: hoisted.rpc,
  }),
}))

const { POST } = await import('@/app/api/account/actions/move/route')

function buildReq(body: unknown) {
  return new Request('https://nativeintelligence.dev/api/account/actions/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const okResult = {
  action_ids: ['act-1'],
  source_workspace_id: 'w1',
  destination_workspace_id: 'w2',
  destination_team_id: 'team-2',
  counts: {
    moved_actions: 1,
    identifier_map: {},
    renumbered: 0,
    assignees_translated: 0,
    assignees_dropped: 0,
    labels_remapped: 0,
    labels_removed: 0,
    external_tasks_severed: 0,
    agent_runs_removed: 0,
    comments_translated: 0,
    attachments_moved: 0,
    links_moved: 0,
    links_severed: 0,
  },
}

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.rpc.mockReset()
  hoisted.getUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  })
})

describe('POST /api/account/actions/move', () => {
  it('returns 401 when unauthenticated, and never calls the RPC', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 on invalid JSON body', async () => {
    const res = await POST(buildReq('not-json'))
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when destination_workspace_id is missing', async () => {
    const res = await POST(buildReq({ action_ids: ['act-1'] }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('BAD_REQUEST')
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when action_ids is not an array of non-empty strings', async () => {
    for (const bad of [undefined, 'act-1', { id: 'act-1' }, [42], [''], [null]]) {
      const res = await POST(
        buildReq({ action_ids: bad, destination_workspace_id: 'w2' }),
      )
      expect(res.status).toBe(400)
    }
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when action_ids is empty (after dedupe)', async () => {
    const res = await POST(
      buildReq({ action_ids: [], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when action_ids exceeds the size cap', async () => {
    const res = await POST(
      buildReq({
        action_ids: Array.from({ length: 501 }, (_, i) => `act-${i}`),
        destination_workspace_id: 'w2',
      }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when destination_team_id is not a non-empty string', async () => {
    for (const bad of [42, '', { id: 't' }]) {
      const res = await POST(
        buildReq({
          action_ids: ['act-1'],
          destination_workspace_id: 'w2',
          destination_team_id: bad,
        }),
      )
      expect(res.status).toBe(400)
    }
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('calls the RPC with the exact argument object (deduped, null team)', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })

    const res = await POST(
      buildReq({
        action_ids: ['act-1', 'act-2', 'act-1'],
        destination_workspace_id: 'w2',
      }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_actions', {
      p_action_ids: ['act-1', 'act-2'],
      p_destination_workspace_id: 'w2',
      p_destination_team_id: null,
    })
  })

  it('passes an explicit destination_team_id through', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: okResult, error: null })

    const res = await POST(
      buildReq({
        action_ids: ['act-1'],
        destination_workspace_id: 'w2',
        destination_team_id: 'team-2',
      }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledWith('move_actions', {
      p_action_ids: ['act-1'],
      p_destination_workspace_id: 'w2',
      p_destination_team_id: 'team-2',
    })
  })

  it('returns the RPC result verbatim on the happy path', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: {
        ...okResult,
        counts: {
          ...okResult.counts,
          moved_actions: 2,
          renumbered: 1,
          identifier_map: { 'ENG-4': 'GEN-19' },
          external_tasks_severed: 1,
          agent_runs_removed: 2,
          links_severed: 3,
        },
      },
      error: null,
    })

    const res = await POST(
      buildReq({ action_ids: ['act-1', 'act-2'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.action_ids).toEqual(['act-1'])
    expect(body.destination_team_id).toBe('team-2')
    expect(body.counts.moved_actions).toBe(2)
    expect(body.counts.identifier_map).toEqual({ 'ENG-4': 'GEN-19' })
    expect(body.counts.external_tasks_severed).toBe(1)
    expect(body.counts.agent_runs_removed).toBe(2)
    expect(body.counts.links_severed).toBe(3)
  })

  it('maps RPC P0002 (not found / no source membership) to 404', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'not found' },
    })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Actions not found')
  })

  it('maps RPC P0003 (no destination team) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0003',
        message: 'destination workspace 9f1 has no team with a default workflow state',
      },
    })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('no team')
    expect(body.error).not.toContain('9f1')
  })

  it('maps RPC P0004 (ids spanning workspaces) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0004',
        message: 'action ids must all exist in one workspace',
      },
    })
    const res = await POST(
      buildReq({ action_ids: ['act-1', 'act-2'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('same workspace')
  })

  it('maps RPC 22023 (same workspace) to 400 with a sanitized message', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'destination is the same workspace' },
    })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Source and destination workspace are the same')
  })

  it('maps RPC 22P02 (malformed uuid) to 400', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '22P02',
        message: 'invalid input syntax for type uuid: "not-a-uuid"',
      },
    })
    const res = await POST(
      buildReq({ action_ids: ['not-a-uuid'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('UUID')
    expect(body.error).not.toContain('not-a-uuid')
  })

  it('maps RPC 42501 (insufficient rights) to 403 without leaking ids', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '42501',
        message: 'user 11111111-2222-3333-4444-555555555555 may not move these actions',
      },
    })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe(
      'You need admin rights (or ownership of this item) to move it',
    )
    expect(body.error).not.toContain('11111111-2222-3333-4444-555555555555')
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
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
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
        message: 'Could not find the function public.move_actions in the schema cache',
      },
    })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('SCHEMA_CACHE_STALE')
    expect(body.error).toContain('retry')
  })

  it('returns 500 with a generic message on unknown RPC error', async () => {
    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '08006', message: 'connection failure to db host 10.0.0.5' },
    })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Move failed')
    expect(body.error).not.toContain('10.0.0.5')
  })

  it('returns 500 when the RPC returns no data and no error', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: null })
    const res = await POST(
      buildReq({ action_ids: ['act-1'], destination_workspace_id: 'w2' }),
    )
    expect(res.status).toBe(500)
  })
})
