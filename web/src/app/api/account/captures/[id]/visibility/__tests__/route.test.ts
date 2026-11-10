/**
 * PATCH /api/account/captures/[id]/visibility — capture scope ("Workspace" vs
 * "Only me").
 *
 * The load-bearing property is the EXPLICIT creator check. The general capture
 * PATCH is workspace-scoped on purpose (teammates edit each other's metadata),
 * so scope changes live here and must be refused for non-creators with a 403
 * rather than silently no-op'ing through RLS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  updateSpy: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

const CAPTURE_ID = 'cap-abc-123'
const WORKSPACE_ID = 'ws-test-1'
const CREATOR_ID = 'user-1'

/**
 * Fake supabase where `captures` serves BOTH the creator pre-fetch
 * (.select().eq().eq().maybeSingle()) and the update
 * (.update().eq().eq().eq().select().single()).
 */
function makeFakeSupabase(captureRow: { id: string; user_id: string } | null) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: captureRow, error: null }),
    single: async () => ({
      data: { id: CAPTURE_ID, visibility: hoisted.updateSpy.mock.calls.at(-1)?.[0]?.visibility },
      error: null,
    }),
    update: (fields: Record<string, unknown>) => {
      hoisted.updateSpy(fields)
      return chain
    },
  }
  return {
    from: () => chain,
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
  }
}

function authFor(
  captureRow: { id: string; user_id: string } | null,
  requesterId = CREATOR_ID,
) {
  return {
    supabase: makeFakeSupabase(captureRow),
    user: { id: requesterId },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  }
}

function patchReq(body: unknown): NextRequest {
  return buildRequest({
    url: `https://nativeintelligence.dev/api/account/captures/${CAPTURE_ID}/visibility`,
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

const { PATCH } = await import('@/app/api/account/captures/[id]/visibility/route')

const routeParams = { params: Promise.resolve({ id: CAPTURE_ID }) }

describe('PATCH /api/account/captures/[id]/visibility', () => {
  beforeEach(() => {
    hoisted.requireWorkspace.mockReset()
    hoisted.updateSpy.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const res = await PATCH(patchReq({ visibility: 'private' }), routeParams)
    expect(res.status).toBe(401)
  })

  it('lets the creator flip a capture to private', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authFor({ id: CAPTURE_ID, user_id: CREATOR_ID }, CREATOR_ID),
    )
    const res = await PATCH(patchReq({ visibility: 'private' }), routeParams)
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).toHaveBeenCalledWith({ visibility: 'private' })
    const json = await readJson<{ capture: { id: string; visibility: string } }>(res)
    expect(json.capture).toEqual({ id: CAPTURE_ID, visibility: 'private' })
  })

  it('lets the creator flip a capture back to workspace', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authFor({ id: CAPTURE_ID, user_id: CREATOR_ID }, CREATOR_ID),
    )
    const res = await PATCH(patchReq({ visibility: 'workspace' }), routeParams)
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).toHaveBeenCalledWith({ visibility: 'workspace' })
  })

  it('returns 403 for a workspace member who did NOT create the capture', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authFor({ id: CAPTURE_ID, user_id: CREATOR_ID }, 'user-other'),
    )
    const res = await PATCH(patchReq({ visibility: 'private' }), routeParams)
    expect(res.status).toBe(403)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('returns 404 when the capture is not in this workspace', async () => {
    hoisted.requireWorkspace.mockResolvedValue(authFor(null))
    const res = await PATCH(patchReq({ visibility: 'private' }), routeParams)
    expect(res.status).toBe(404)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('returns 400 for a visibility value outside the enum', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authFor({ id: CAPTURE_ID, user_id: CREATOR_ID }, CREATOR_ID),
    )
    const res = await PATCH(patchReq({ visibility: 'team' }), routeParams)
    expect(res.status).toBe(400)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when visibility is missing entirely', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authFor({ id: CAPTURE_ID, user_id: CREATOR_ID }, CREATOR_ID),
    )
    const res = await PATCH(patchReq({}), routeParams)
    expect(res.status).toBe(400)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })
})
