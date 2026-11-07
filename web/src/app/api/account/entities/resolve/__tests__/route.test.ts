import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  resolveMemberIdsForUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  actionsResult: { data: [] as Record<string, unknown>[], error: null as unknown },
}))

vi.mock('@/lib/api-auth', () => ({
  requireUser: hoisted.requireUser,
}))

vi.mock('@/lib/workspace', () => ({
  resolveMemberIdsForUser: hoisted.resolveMemberIdsForUser,
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
  WorkspaceLookupError: class WorkspaceLookupError extends Error {
    constructor(readonly kind: 'session_expired' | 'query_failed') {
      super(kind)
      this.name = 'WorkspaceLookupError'
    }
  },
}))

/** A chainable actions-query mock resolving to `hoisted.actionsResult`. */
function makeSupabase() {
  const q: {
    select: ReturnType<typeof vi.fn>
    in: ReturnType<typeof vi.fn>
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise<unknown>
  } = {
    select: vi.fn(() => q),
    in: vi.fn(() => q),
    then: (res, rej) => Promise.resolve(hoisted.actionsResult).then(res, rej),
  }
  return { from: vi.fn(() => q) }
}

function req(refs: string): NextRequest {
  return { nextUrl: new URL(`https://dial8.ai/api/account/entities/resolve?refs=${encodeURIComponent(refs)}`) } as unknown as NextRequest
}

function row(identifier: string, workspaceId: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${workspaceId}-${identifier}`,
    workspace_id: workspaceId,
    team_id: 'team-1',
    identifier,
    title: `Title ${identifier}`,
    status_id: 's1',
    assignee_id: null,
    assignee_contact_id: null,
    due_at: null,
    priority: null,
    project_id: null,
    workflow_state: { id: 's1', name: 'Backlog', category: 'backlog', color: '#111111' },
    assignee: null,
    project: null,
    ...over,
  }
}

const { GET } = await import('@/app/api/account/entities/resolve/route')

beforeEach(() => {
  hoisted.requireUser.mockReset()
  hoisted.resolveMemberIdsForUser.mockReset()
  hoisted.getCurrentWorkspaceId.mockReset()
  hoisted.actionsResult = { data: [], error: null }
  hoisted.requireUser.mockResolvedValue({ supabase: makeSupabase(), user: { id: 'user-1' } })
  hoisted.resolveMemberIdsForUser.mockResolvedValue([
    { memberId: 'm-a', workspaceId: 'ws-a' },
    { memberId: 'm-b', workspaceId: 'ws-b' },
  ])
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-a')
})

describe('GET /api/account/entities/resolve', () => {
  it('returns the auth Response when the user is not authenticated', async () => {
    hoisted.requireUser.mockResolvedValue(new Response('no', { status: 401 }))
    const res = await GET(req('GEN-1'))
    expect(res.status).toBe(401)
  })

  it('rejects more than 50 refs with a 400', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `GEN-${i + 1}`).join(',')
    const res = await GET(req(many))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_REQUEST')
  })

  it('returns an empty map when no refs are valid', async () => {
    const res = await GET(req('foo,123-4,A,,COVID'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ refs: {} })
  })

  it('returns an empty map when the user is in no workspaces', async () => {
    hoisted.resolveMemberIdsForUser.mockResolvedValue([])
    const res = await GET(req('GEN-1'))
    expect(await res.json()).toEqual({ refs: {} })
  })

  it('shapes a single match (status, assignee name, due_date, project)', async () => {
    hoisted.actionsResult = {
      data: [
        row('GEN-1', 'ws-a', {
          priority: 'high',
          due_at: '2026-10-08T12:00:00Z',
          assignee: { id: 'm1', display_name: 'Alice' },
          project: { id: 'p1', name: 'Launch' },
        }),
      ],
      error: null,
    }
    const res = await GET(req('gen-1'))
    const body = await res.json()
    expect(body.refs['GEN-1']).toEqual({
      id: 'id-ws-a-GEN-1',
      workspace_id: 'ws-a',
      team_id: 'team-1',
      identifier: 'GEN-1',
      title: 'Title GEN-1',
      status: { id: 's1', name: 'Backlog', category: 'backlog', color: '#111111' },
      assignee: { id: 'm1', name: 'Alice' },
      priority: 'high',
      due_date: '2026-10-08T12:00:00.000Z',
      project: { id: 'p1', name: 'Launch' },
    })
  })

  it('prefers the current workspace when an identifier is ambiguous', async () => {
    hoisted.actionsResult = { data: [row('GEN-1', 'ws-a'), row('GEN-1', 'ws-b')], error: null }
    hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-b')
    const res = await GET(req('GEN-1'))
    const body = await res.json()
    expect(body.refs['GEN-1'].workspace_id).toBe('ws-b')
  })

  it('omits an ambiguous identifier when the current workspace has no copy', async () => {
    hoisted.actionsResult = { data: [row('GEN-1', 'ws-a'), row('GEN-1', 'ws-b')], error: null }
    hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-c')
    const res = await GET(req('GEN-1'))
    const body = await res.json()
    expect(body.refs).toEqual({})
  })

  it('normalises embedded to-one arrays (PostgREST shape) into objects', async () => {
    hoisted.actionsResult = {
      data: [
        row('GEN-2', 'ws-a', {
          workflow_state: [{ id: 's2', name: 'Done', category: 'completed', color: null }],
          assignee: [{ id: 'm2', display_name: 'Bob' }],
          project: [{ id: 'p2', name: 'Ops' }],
        }),
      ],
      error: null,
    }
    const res = await GET(req('GEN-2'))
    const body = await res.json()
    expect(body.refs['GEN-2'].status).toEqual({ id: 's2', name: 'Done', category: 'completed', color: null })
    expect(body.refs['GEN-2'].assignee).toEqual({ id: 'm2', name: 'Bob' })
    expect(body.refs['GEN-2'].project).toEqual({ id: 'p2', name: 'Ops' })
  })
})
