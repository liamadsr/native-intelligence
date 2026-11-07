/**
 * POST /api/account/captures/[id]/resume — unlock an ended capture to record
 * into it again (the capture panel's Resume, the recovery prompt, and a Start
 * on a meeting whose capture closed moments ago).
 *
 * Pinned:
 *   - the unlock clears ended_at and the transcript lock;
 *   - a reopened capture is unprocessed again: batch_processed_at is cleared
 *     (note-taker directives are taken again; its next end runs its pass) and
 *     so is a server close's metadata.finalized (a decline of THIS session is
 *     finished, not read as the earlier one's), other metadata kept;
 *   - a transcript-less placeholder for the same event is archived out of the
 *     way; a live capture with text is refused (409);
 *   - only the caller's own capture (404 otherwise).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase, type Row } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ getUser: vi.fn() }))
let fake: FakeSupabase

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => Object.assign(fake, { auth: { getUser: hoisted.getUser } }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => WS }))

const { POST } = await import('@/app/api/account/captures/[id]/resume/route')

const WS = 'f6000000-0000-4000-8000-000000000001'
const OWNER = 'a0000000-0000-4000-8000-000000000001'

function capture(over: Row = {}): Row {
  return {
    id: 'cap-1',
    workspace_id: WS,
    user_id: OWNER,
    calendar_event_id: 'evt-1',
    ended_at: '2026-10-19T20:52:34.102581+00:00',
    is_transcript_locked: true,
    batch_processed_at: '2026-10-19T20:53:40.000Z',
    transcript: '[local_1] so the round is a million pre-seed',
    status: 'active',
    metadata: {
      capture_mode: 'desktop_dual',
      finalized: { by: 'owner', reason: 'recovery_declined', at: '2026-10-19T20:52:50.000Z' },
    },
    ...over,
  }
}

function call(id = 'cap-1') {
  const request = buildRequest({
    url: `https://dial8.ai/api/account/captures/${id}/resume`,
    method: 'POST',
  }) as unknown as NextRequest
  return POST(request, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  fake = makeFakeSupabase()
  hoisted.getUser.mockReset().mockResolvedValue({ data: { user: { id: OWNER } } })
})

describe('POST resume', () => {
  it('unlocks the capture and makes it unprocessed again, keeping its other metadata', async () => {
    fake.seed('captures', [capture()])
    const res = await call()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ success: true })
    const [row] = fake.rows('captures')
    expect(row).toMatchObject({ ended_at: null, is_transcript_locked: false, batch_processed_at: null })
    expect(row.metadata).toEqual({ capture_mode: 'desktop_dual' })
  })

  it('archives a transcript-less placeholder for the same event out of the way', async () => {
    fake.seed('captures', [
      capture(),
      capture({ id: 'cap-pending', ended_at: null, transcript: null, batch_processed_at: null, metadata: {} }),
    ])
    expect((await call()).status).toBe(200)
    const byId = Object.fromEntries(fake.rows('captures').map((r) => [r.id, r]))
    expect(byId['cap-pending'].status).toBe('archived')
    expect(byId['cap-1'].ended_at).toBeNull()
  })

  it('refuses (409) while another capture of the meeting is recording', async () => {
    fake.seed('captures', [
      capture(),
      capture({ id: 'cap-live', ended_at: null, transcript: '[remote_1] still talking', metadata: {} }),
    ])
    const res = await call()
    expect(res.status).toBe(409)
    expect(fake.rows('captures').find((r) => r.id === 'cap-1')!.ended_at).not.toBeNull()
  })

  it('404s for a capture that is not the caller’s', async () => {
    fake.seed('captures', [capture({ user_id: 'someone-else' })])
    expect((await call()).status).toBe(404)
  })
})
