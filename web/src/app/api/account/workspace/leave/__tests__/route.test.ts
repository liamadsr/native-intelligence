/**
 * Tests for POST /api/account/workspace/leave.
 *
 * Invariants locked in:
 *  - The target workspace comes from the request body (`workspace_id`), NOT the
 *    active-workspace cookie — so the profile page can leave any workspace the
 *    user belongs to, and Leave never silently targets the wrong one.
 *  - Membership is verified against THAT workspace, scoped to the caller's own
 *    user_id, on the caller's session.
 *  - The delete runs on the SERVICE client (RLS lets only an owner delete a
 *    member row, so on the session it deleted nothing and still said ok),
 *    pinned to the caller's own row in that workspace and to a non-owner one;
 *    the session client never deletes. Nothing else is written first: since
 *    migration 320 every reference to a member row lets it go (who applied a
 *    suggestion is set null; comments and drafts are kept).
 *  - Nothing deleted is a 409, never ok. Non-members get 403, owners get 403
 *    (must transfer first), and a missing workspace_id is a 400.
 *  - The active-workspace cookie is cleared only when the user leaves their
 *    currently-active workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  getCurrentWorkspaceId: vi.fn(async () => 'ws-active'),
  cookieDelete: vi.fn(),
}))

type Op = { table: string; kind: 'select' | 'update' | 'delete'; filters: Array<[string, string, unknown]>; values?: unknown }

/** A query chain that records what it was asked and answers `answer(op)`. */
function recordingClient(answer: (op: Op) => { data: unknown; error: { message: string } | null }) {
  const ops: Op[] = []
  const from = (table: string) => {
    const op: Op = { table, kind: 'select', filters: [] }
    ops.push(op)
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.update = (values: unknown) => ((op.kind = 'update'), (op.values = values), chain)
    chain.delete = () => ((op.kind = 'delete'), chain)
    chain.eq = (col: string, val: unknown) => (op.filters.push(['eq', col, val]), chain)
    chain.neq = (col: string, val: unknown) => (op.filters.push(['neq', col, val]), chain)
    chain.maybeSingle = async () => answer(op)
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer(op)).then(resolve)
    return chain
  }
  return { client: { from }, ops }
}

let memberRow: { id: string; role: string | null } | null = null
let memberReadError: { message: string } | null = null
let deletedRows: Array<{ id: string }> = [{ id: 'member-9' }]
let deleteError: { message: string } | null = null

const session = recordingClient((op) => (op.kind === 'select' ? { data: memberRow, error: memberReadError } : { data: null, error: null }))
const service = recordingClient(() => ({ data: deleteError ? null : deletedRows, error: deleteError }))

vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => ({ supabase: session.client, user: { id: 'user-1' } }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => service.client }))
vi.mock('@/lib/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace')>()
  return { ...actual, getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId }
})
vi.mock('next/headers', () => ({
  headers: async () => new Map(),
  cookies: async () => ({ delete: hoisted.cookieDelete }),
}))

import { POST } from '../route'

function makeRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

const serviceOp = (table: string) => service.ops.find((o) => o.table === table)

beforeEach(() => {
  memberRow = null
  memberReadError = null
  deletedRows = [{ id: 'member-9' }]
  deleteError = null
  session.ops.length = 0
  service.ops.length = 0
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-active')
  hoisted.cookieDelete.mockClear()
})

describe('POST /api/account/workspace/leave', () => {
  it('rejects a missing workspace_id with 400', async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it('a non-owner leaves: membership read on the session, their own row deleted on the service client', async () => {
    memberRow = { id: 'member-9', role: 'member' }
    const res = await POST(makeRequest({ workspace_id: 'ws-other' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // Membership lookup was scoped to the target workspace AND the caller's id.
    expect(session.ops).toEqual([
      { table: 'member', kind: 'select', filters: [['eq', 'user_id', 'user-1'], ['eq', 'workspace_id', 'ws-other']] },
    ])
    // Exactly this non-owner row is deleted, and nothing else is written.
    expect(serviceOp('member')).toEqual({
      table: 'member',
      kind: 'delete',
      filters: [
        ['eq', 'id', 'member-9'],
        ['eq', 'workspace_id', 'ws-other'],
        ['eq', 'user_id', 'user-1'],
        ['neq', 'role', 'owner'],
      ],
    })
    expect(service.ops.map((o) => o.table)).toEqual(['member'])
  })

  it('returns 403 when the user is not a member of the target workspace, and changes nothing', async () => {
    memberRow = null
    const res = await POST(makeRequest({ workspace_id: 'ws-other' }))
    expect(res.status).toBe(403)
    expect(service.ops).toEqual([])
  })

  it('blocks owners from leaving, and changes nothing', async () => {
    memberRow = { id: 'member-1', role: 'owner' }
    const res = await POST(makeRequest({ workspace_id: 'ws-other' }))
    expect(res.status).toBe(403)
    expect(service.ops).toEqual([])
  })

  it('nothing deleted (left already, or made an owner meanwhile) is a 409, never ok, and the cookie stays', async () => {
    memberRow = { id: 'member-9', role: 'member' }
    deletedRows = []
    const res = await POST(makeRequest({ workspace_id: 'ws-active' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'NOT_LEFT' })
    expect(hoisted.cookieDelete).not.toHaveBeenCalled()
  })

  it('a failed read or delete is a 500; a failed read deletes nothing', async () => {
    memberReadError = { message: 'db down' }
    expect((await POST(makeRequest({ workspace_id: 'ws-other' }))).status).toBe(500)
    expect(service.ops).toEqual([])

    memberReadError = null
    memberRow = { id: 'member-9', role: 'member' }
    deleteError = { message: 'db down' }
    expect((await POST(makeRequest({ workspace_id: 'ws-other' }))).status).toBe(500)
  })

  it('clears the cookie only when leaving the active workspace', async () => {
    memberRow = { id: 'member-9', role: 'member' }

    // Leaving a non-active workspace: cookie stays.
    await POST(makeRequest({ workspace_id: 'ws-other' }))
    expect(hoisted.cookieDelete).not.toHaveBeenCalled()

    // Leaving the active workspace: cookie is cleared.
    await POST(makeRequest({ workspace_id: 'ws-active' }))
    expect(hoisted.cookieDelete).toHaveBeenCalled()
  })
})
