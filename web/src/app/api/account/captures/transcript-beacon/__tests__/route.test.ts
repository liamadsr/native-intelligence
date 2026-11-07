/**
 * Tests for POST /api/account/captures/transcript-beacon.
 *
 * The beacon is the pagehide/beforeunload transcript flush (navigator.sendBeacon).
 * It must:
 *   - Apply the same no-shrink guard as the capture PATCH route
 *   - Never touch a locked (finalized) capture
 *   - Always return 200 (never penalize the beacon), even on bad input / errors
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

const CAPTURE_ID = 'cap-beacon-1'
const WORKSPACE_ID = 'ws-test-1'

function makeFakeSupabase(existing: string | null, locked = false) {
  const chain = {
    eq: () => chain,
    select: () => chain,
    single: async () => ({ data: { transcript: existing, is_transcript_locked: locked }, error: null }),
    update: (fields: Record<string, unknown>) => {
      hoisted.updateSpy(fields)
      return chain
    },
  }
  return {
    from: () => chain,
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    rpc: vi.fn(),
  }
}

function auth(existing: string | null, locked = false) {
  return {
    supabase: makeFakeSupabase(existing, locked),
    user: { id: 'user-1' },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  }
}

function beaconReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/captures/transcript-beacon',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const { POST } = await import('@/app/api/account/captures/transcript-beacon/route')

const LONG = '[remote_1] a long fifteen minute transcript that should not be clobbered'
const SHORT = '[remote_1] short'

describe('POST transcript-beacon', () => {
  beforeEach(() => {
    hoisted.updateSpy.mockClear()
    hoisted.requireWorkspace.mockResolvedValue(auth(null))
  })

  it('persists a growing transcript', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth(SHORT))
    const res = await POST(beaconReq({ capture_id: CAPTURE_ID, transcript: LONG }))
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).toHaveBeenCalledWith(expect.objectContaining({ transcript: LONG }))
  })

  it('BLOCKS a shorter transcript (no-shrink guard)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth(LONG))
    const res = await POST(beaconReq({ capture_id: CAPTURE_ID, transcript: SHORT }))
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('ignores an empty transcript payload', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth(LONG))
    const res = await POST(beaconReq({ capture_id: CAPTURE_ID, transcript: '' }))
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('never writes to a locked (finalized) capture', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth(SHORT, /* locked */ true))
    const res = await POST(beaconReq({ capture_id: CAPTURE_ID, transcript: LONG }))
    expect(res.status).toBe(200)
    const json = await readJson<{ locked: boolean }>(res)
    expect(json.locked).toBe(true)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('returns 200 (not an error) on missing capture_id', async () => {
    const res = await POST(beaconReq({ transcript: LONG }))
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const res = await POST(beaconReq({ capture_id: CAPTURE_ID, transcript: LONG }))
    expect(res.status).toBe(401)
  })
})
