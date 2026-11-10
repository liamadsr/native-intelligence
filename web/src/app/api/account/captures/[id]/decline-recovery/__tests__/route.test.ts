/**
 * POST /api/account/captures/[id]/decline-recovery — the recovery prompt's
 * "End capture". Pinned: the caller's own capture is closed as Stop closes it
 * (declineRecovery, covered in src/lib/captures/__tests__/abandoned.test.ts),
 * and one with a meeting in it gets the finalize event with
 * reason 'recovery_declined', once per capture; a blip is closed and nothing
 * sent; an ended capture is left alone; someone else's is a 404; a lost CAS is
 * a 409; a failed send still answers 'ended', processing false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase, type Row } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  send: vi.fn(),
}))
let fake: FakeSupabase

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.send, createFunction: (config: { id: string }) => ({ id: config.id }) },
}))

const { POST } = await import('@/app/api/account/captures/[id]/decline-recovery/route')
const { CAPTURE_ABANDONED_EVENT } = await import('@/lib/inngest/capture-finalizer')

const WS = 'f6000000-0000-4000-8000-000000000001'
const OWNER = 'a0000000-0000-4000-8000-000000000001'
const LAST_WRITE = '2026-09-28T21:28:00.000Z'
const ENDED = '2026-09-28T21:10:00.000Z'
const MEETING = '[local_1] the SIT wave slips a week, UAT stays on the 14th\n'.repeat(10)

function capture(over: Row = {}): Row {
  return {
    id: 'cap-1',
    workspace_id: WS,
    user_id: OWNER,
    started_at: '2026-09-28T21:00:00.000Z',
    updated_at: LAST_WRITE,
    ended_at: null,
    duration_seconds: null,
    live_mode: false,
    ai_summary: null,
    transcript: MEETING,
    metadata: {},
    is_eval: false,
    status: 'active',
    ...over,
  }
}

function call(id = 'cap-1') {
  const request = buildRequest({
    url: `https://nativeintelligence.dev/api/account/captures/${id}/decline-recovery`,
    method: 'POST',
  }) as unknown as NextRequest
  return POST(request, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  fake = makeFakeSupabase()
  hoisted.requireWorkspace.mockReset().mockResolvedValue({ supabase: fake, user: { id: OWNER }, workspaceId: WS })
  hoisted.send.mockReset().mockResolvedValue({ ids: ['e1'] })
})

describe('POST decline-recovery', () => {
  it('closes the caller’s capture and asks the finalizer to write it up', async () => {
    fake.seed('captures', [capture()])
    const res = await call()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ status: 'ended', processing: true })
    expect(fake.rows('captures')[0]).toMatchObject({
      ended_at: LAST_WRITE,
      duration_seconds: 28 * 60,
      metadata: { finalized: { by: 'owner', reason: 'recovery_declined' } },
    })
    expect(hoisted.send).toHaveBeenCalledWith({
      name: CAPTURE_ABANDONED_EVENT,
      // keyed by this close, so a capture resumed and declined again is
      // finished again rather than dropped as a repeat
      id: `capture-declined:cap-1:${LAST_WRITE}`,
      data: { capture_id: 'cap-1', workspace_id: WS, reason: 'recovery_declined' },
    })
  })

  it('a blip is closed and nothing is sent', async () => {
    fake.seed('captures', [capture({ transcript: 'hello?' })])
    expect(await readJson(await call())).toEqual({ status: 'ended', processing: false })
    expect(fake.rows('captures')[0].ended_at).not.toBeNull()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('an ended capture is left alone', async () => {
    fake.seed('captures', [capture({ ended_at: ENDED })])
    expect(await readJson(await call())).toEqual({ status: 'already_ended' })
    expect(fake.rows('captures')[0].ended_at).toBe(ENDED)
    expect(fake.rows('captures')[0].metadata).toEqual({})
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('someone else’s capture is a 404 and untouched', async () => {
    fake.seed('captures', [capture({ user_id: 'a0000000-0000-4000-8000-000000000009' })])
    expect((await call()).status).toBe(404)
    expect(fake.rows('captures')[0].ended_at).toBeNull()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('a failed send still ends the capture: processing false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.send.mockRejectedValueOnce(new Error('inngest down'))
    fake.seed('captures', [capture()])
    const res = await call()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ status: 'ended', processing: false })
    expect(fake.rows('captures')[0].ended_at).not.toBeNull()
  })

  it('auth failures pass through', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(new Response(null, { status: 401 }))
    expect((await call()).status).toBe(401)
  })
})
