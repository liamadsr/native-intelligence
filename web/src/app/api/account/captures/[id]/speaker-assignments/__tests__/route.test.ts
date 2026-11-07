/**
 * Tests for the §8 contact_id workspace-ownership hardening on
 * POST /api/account/captures/[id]/speaker-assignments.
 *
 * A member could previously point a capture participant at a contact_id from
 * another workspace (capture_participant RLS is workspace-wide FOR ALL). The
 * POST now validates every posted contact_id belongs to the caller's workspace
 * before linking — PER ROW: foreign rows are skipped (reported via
 * skippedCount/skippedContactIds), valid rows still process. This avoids the
 * data-loss regression where one stale contact_id (e.g. a contact deleted
 * mid-meeting) 403'd the whole batch and nuked every speaker link at stop.
 * Legacy auth (createClient + getCurrentWorkspaceId) is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  createClient: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: hoisted.createClient }))
vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
  WORKSPACE_COOKIE: 'ws',
  WORKSPACE_HEADER: 'x-ws',
}))

import { POST } from '@/app/api/account/captures/[id]/speaker-assignments/route'

const WORKSPACE_ID = 'ws-1'
const CAPTURE_ID = 'cap-1'

interface Captured {
  participantInserts: number
  participantUpdates: number
}

/**
 * @param ownedContactIds contact rows the ownership `.in()` read returns
 * @param captureFound    whether the capture ownership probe finds the capture
 */
function makeSupabase(
  ownedContactIds: string[],
  captured: Captured,
  captureFound = true,
  self: { contactId?: string; boundLabel?: string } = {},
) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    from: (table: string) => {
      if (table === 'captures') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          single: () =>
            Promise.resolve({
              data: captureFound ? { id: CAPTURE_ID } : null,
              error: captureFound ? null : { message: 'not found' },
            }),
        })
        return b
      }
      if (table === 'contact') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          in: () => b,
          then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
            Promise.resolve(
              resolve({
                data: ownedContactIds.map((id) => ({ id, member_id: id === self.contactId ? 'member-self' : null })),
                error: null,
              }),
            ),
        })
        return b
      }
      if (table === 'member') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          maybeSingle: () => Promise.resolve({ data: { id: 'member-self' }, error: null }),
        })
        return b
      }
      // capture_participant — existing-row probe + insert/update.
      const b: Record<string, unknown> = {}
      let label: unknown = null
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'speaker_label') label = val
          return b
        },
        maybeSingle: () =>
          Promise.resolve({
            data: self.boundLabel && label === self.boundLabel ? { id: 'self-row', is_self: true } : null,
            error: null,
          }),
        insert: () => {
          captured.participantInserts++
          return Promise.resolve({ error: null })
        },
        update: () => {
          captured.participantUpdates++
          return b
        },
      })
      return b
    },
  }
}

function req(body: unknown): NextRequest {
  return buildRequest({
    url: `https://dial8.ai/api/account/captures/${CAPTURE_ID}/speaker-assignments`,
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const params = Promise.resolve({ id: CAPTURE_ID })

function freshCaptured(): Captured {
  return { participantInserts: 0, participantUpdates: 0 }
}

beforeEach(() => {
  hoisted.createClient.mockReset()
  hoisted.getCurrentWorkspaceId.mockReset()
  hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
})

it('skips the sole foreign contact_id but still returns 200 (single-item request links nothing)', async () => {
  const captured = freshCaptured()
  hoisted.createClient.mockResolvedValue(makeSupabase([], captured))
  const res = await POST(
    req({
      assignments: [
        { speaker_label: 'remote_1', contact_id: 'foreign-contact', contact_name: 'X' },
      ],
    }),
    { params },
  )
  expect(res.status).toBe(200)
  const body = await readJson<{
    results: unknown[]
    skippedCount: number
    skippedContactIds: string[]
  }>(res)
  // The foreign contact is dropped, not linked — the security property holds.
  expect(captured.participantInserts).toBe(0)
  expect(captured.participantUpdates).toBe(0)
  expect(body.results.length).toBe(0)
  expect(body.skippedCount).toBe(1)
  expect(body.skippedContactIds).toEqual(['foreign-contact'])
})

it('links participants when every posted contact_id belongs to the workspace', async () => {
  const captured = freshCaptured()
  hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a'], captured))
  const res = await POST(
    req({
      assignments: [
        { speaker_label: 'remote_1', contact_id: 'contact-a', contact_name: 'A', voice_match_confidence: 0.9 },
      ],
    }),
    { params },
  )
  expect(res.status).toBe(200)
  const body = await readJson<{ results: unknown[]; skippedCount: number }>(res)
  expect(body.results.length).toBe(1)
  expect(body.skippedCount).toBe(0)
  expect(captured.participantInserts).toBe(1)
})

it('processes valid rows and skips only the stale one in a mixed batch (no data-loss regression)', async () => {
  // Regression for the batch-level 403: one deleted/stale contact_id mid-meeting
  // must NOT nuke every other speaker link saved at stop. Only 'contact-a' and
  // 'contact-b' are owned; 'gone-contact' was deleted mid-meeting.
  const captured = freshCaptured()
  hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a', 'contact-b'], captured))
  const res = await POST(
    req({
      assignments: [
        { speaker_label: 'remote_1', contact_id: 'contact-a', contact_name: 'A' },
        { speaker_label: 'remote_2', contact_id: 'gone-contact', contact_name: 'Gone' },
        { speaker_label: 'remote_3', contact_id: 'contact-b', contact_name: 'B' },
      ],
    }),
    { params },
  )
  expect(res.status).toBe(200)
  const body = await readJson<{
    results: { speaker_label: string }[]
    skippedCount: number
    skippedContactIds: string[]
  }>(res)
  // The two valid speakers are linked; only the stale one is dropped.
  expect(captured.participantInserts).toBe(2)
  expect(body.results.map((r) => r.speaker_label).sort()).toEqual(['remote_1', 'remote_3'])
  expect(body.skippedCount).toBe(1)
  expect(body.skippedContactIds).toEqual(['gone-contact'])
})

it('links contact_id-less (external_name-only) rows without a workspace check', async () => {
  // A speaker with no contact_id links no cross-workspace row, so it always passes.
  const captured = freshCaptured()
  hoisted.createClient.mockResolvedValue(makeSupabase([], captured))
  const res = await POST(
    req({
      assignments: [
        { speaker_label: 'remote_1', contact_id: '', contact_name: 'Unknown guest' },
      ],
    }),
    { params },
  )
  expect(res.status).toBe(200)
  const body = await readJson<{ results: unknown[]; skippedCount: number }>(res)
  expect(captured.participantInserts).toBe(1)
  expect(body.results.length).toBe(1)
  expect(body.skippedCount).toBe(0)
})

describe("the user's own voice (followups issue 11)", () => {
  it("never links the caller's own member-linked contact as an attendee", async () => {
    const captured: Captured = { participantInserts: 0, participantUpdates: 0 }
    hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a', 'contact-me'], captured, true, { contactId: 'contact-me' }))
    const res = await POST(
      req({
        assignments: [
          { speaker_label: 'remote_1', contact_id: 'contact-a', contact_name: 'A' },
          { speaker_label: 'local_2', contact_id: 'contact-me', contact_name: 'Me' },
        ],
      }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    const body = await readJson<{ results: Array<{ speaker_label: string }>; skippedContactIds: string[] }>(res)
    expect(body.results.map((r) => r.speaker_label)).toEqual(['remote_1'])
    expect(body.skippedContactIds).toEqual(['contact-me'])
    expect(captured.participantInserts).toBe(1)
  })

  it("never overwrites a label already bound to the user's self row", async () => {
    const captured: Captured = { participantInserts: 0, participantUpdates: 0 }
    hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a'], captured, true, { boundLabel: 'local_1' }))
    const res = await POST(
      req({ assignments: [{ speaker_label: 'local_1', contact_id: 'contact-a', contact_name: 'A' }] }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    const body = await readJson<{ results: Array<{ speaker_label: string; action: string }> }>(res)
    expect(body.results).toEqual([{ speaker_label: 'local_1', action: 'skipped_self' }])
    expect(captured.participantUpdates).toBe(0)
    expect(captured.participantInserts).toBe(0)
  })
})
