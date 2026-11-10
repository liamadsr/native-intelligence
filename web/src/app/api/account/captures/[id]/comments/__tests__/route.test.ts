/**
 * Tests for GET/POST /api/account/captures/[id]/comments — perf phase 2
 * migration.
 *
 * Locked in: GET auths via requireWorkspace (401 passthrough + 404 outside
 * the workspace); POST auths via requireWorkspaceMember and uses the member
 * id from the AUTH CONTEXT as the comment author — the old separate
 * member-table query must not come back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceMember: vi.fn(),
  getAllComments: vi.fn(),
  createComment: vi.fn(),
  /** Tables touched via supabase.from — proves POST never queries member. */
  fromTables: [] as string[],
  captureRow: null as { id: string } | null,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/comments', () => ({
  getAllComments: hoisted.getAllComments,
  createComment: hoisted.createComment,
  resolveComment: vi.fn(),
  parseAnchorFields: vi.fn(() => undefined),
}))

vi.mock('@/lib/comment-notifications', () => ({
  sendCommentNotifications: vi.fn(),
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
      hoisted.fromTables.push(table)
      if (table === 'captures') return chain({ data: hoisted.captureRow, error: null })
      return chain({ data: null, error: null })
    },
  }
}

const { GET, POST } = await import('@/app/api/account/captures/[id]/comments/route')

function getReq(): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/captures/capture-1/comments',
    method: 'GET',
  }) as unknown as NextRequest
}

function postReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/captures/capture-1/comments',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const fakeParams = { params: Promise.resolve({ id: 'capture-1' }) }

function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.getAllComments.mockReset()
  hoisted.createComment.mockReset()
  hoisted.fromTables = []
  hoisted.captureRow = { id: 'capture-1' }

  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  })
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1' },
  })
  hoisted.getAllComments.mockResolvedValue({ comments: [{ id: 'comment-1' }], error: null })
  hoisted.createComment.mockResolvedValue({ comment: { id: 'comment-new' }, error: null })
})

describe('GET /api/account/captures/[id]/comments', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(unauthorizedResponse())
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(401)
    expect(hoisted.getAllComments).not.toHaveBeenCalled()
  })

  it('returns 404 when capture is outside the workspace', async () => {
    hoisted.captureRow = null
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(404)
    expect(hoisted.getAllComments).not.toHaveBeenCalled()
  })

  it('returns the comments payload', async () => {
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ comments: { id: string }[] }>(res)
    expect(body.comments).toEqual([{ id: 'comment-1' }])
  })
})

describe('POST /api/account/captures/[id]/comments', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(unauthorizedResponse())
    const res = await POST(postReq({ body: 'hi' }), fakeParams)
    expect(res.status).toBe(401)
    expect(hoisted.createComment).not.toHaveBeenCalled()
  })

  it('400s an empty body', async () => {
    const res = await POST(postReq({ body: '   ' }), fakeParams)
    expect(res.status).toBe(400)
    expect(hoisted.createComment).not.toHaveBeenCalled()
  })

  it('creates the comment as the auth-context member without a member-table query', async () => {
    const res = await POST(postReq({ body: 'hello there' }), fakeParams)
    expect(res.status).toBe(201)
    const body = await readJson<{ comment: { id: string } }>(res)
    expect(body.comment.id).toBe('comment-new')

    // Author comes from requireWorkspaceMember, not a fresh member query.
    expect(hoisted.createComment).toHaveBeenCalledWith(
      expect.anything(),
      'capture',
      'capture-1',
      'member-1',
      'hello there',
      undefined,
      undefined,
    )
    expect(hoisted.fromTables).not.toContain('member')
  })
})
