/**
 * Tests for the §8 contact_id workspace-ownership hardening on
 * POST /api/account/voice-enrollments.
 *
 * Before this, a member could enroll a voiceprint onto a contact_id from
 * ANOTHER workspace (voice_enrollment RLS is workspace-wide FOR ALL, so the
 * insert itself wouldn't stop it — the documented poisoning gap). The POST now
 * validates every posted contact_id belongs to the caller's workspace before
 * writing — PER ROW: foreign rows (enrollments AND confirmations) are skipped
 * (reported via skippedCount/skippedContactIds), valid rows still write. This
 * avoids the data-loss regression where one stale contact_id 403'd the whole
 * batch and dropped every valid enrollment at stop. This route keeps its legacy
 * auth style (createClient + getCurrentWorkspaceId), so we mock those.
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

import { POST } from '@/app/api/account/voice-enrollments/route'

const WORKSPACE_ID = 'ws-1'

interface Captured {
  inserted?: Record<string, unknown>[]
}

/**
 * @param ownedContactIds the contact rows the ownership `.in()` read returns
 * @param selfContactId one of them that is the caller's own member-linked contact
 */
function makeSupabase(ownedContactIds: string[], captured: Captured, selfContactId?: string) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    from: (table: string) => {
      if (table === 'contact') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          in: () => b,
          then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
            Promise.resolve(
              resolve({
                data: ownedContactIds.map((id) => ({ id, member_id: id === selfContactId ? 'member-self' : null })),
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
      if (table === 'voice_enrollment') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          insert: (rows: Record<string, unknown>[]) => {
            captured.inserted = rows
            return Promise.resolve({ error: null })
          },
        })
        return b
      }
      // voice_contact_trust — read (single) then insert/update, both no-op.
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        single: () => Promise.resolve({ data: null, error: null }),
        insert: () => Promise.resolve({ error: null }),
        update: () => b,
      })
      return b
    },
  }
}

function req(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/voice-enrollments',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const EMB = [0.1, 0.2, 0.3]

beforeEach(() => {
  hoisted.createClient.mockReset()
  hoisted.getCurrentWorkspaceId.mockReset()
  hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
})

it('skips the sole foreign enrollment but still returns 200 (nothing inserted)', async () => {
  const captured: Captured = {}
  // The ownership read returns NO owned contacts → the posted id is foreign.
  hoisted.createClient.mockResolvedValue(makeSupabase([], captured))
  const res = await POST(
    req({ enrollments: [{ contact_id: 'foreign-contact', embedding: EMB }] }),
  )
  expect(res.status).toBe(200)
  const body = await readJson<{
    created: number
    skippedCount: number
    skippedContactIds: string[]
  }>(res)
  // Never inserted — the security property holds row-wise.
  expect(captured.inserted).toBeUndefined()
  expect(body.created).toBe(0)
  expect(body.skippedCount).toBe(1)
  expect(body.skippedContactIds).toEqual(['foreign-contact'])
})

it('inserts when every posted contact_id belongs to the workspace', async () => {
  const captured: Captured = {}
  hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a', 'contact-b'], captured))
  const res = await POST(
    req({
      enrollments: [
        { contact_id: 'contact-a', embedding: EMB },
        { contact_id: 'contact-b', embedding: EMB },
      ],
    }),
  )
  expect(res.status).toBe(200)
  const body = await readJson<{ created: number; skippedCount: number }>(res)
  expect(body.created).toBe(2)
  expect(body.skippedCount).toBe(0)
  expect(captured.inserted?.length).toBe(2)
})

it('inserts valid enrollments and skips only the foreign one in a mixed batch', async () => {
  // Regression for the batch-level 403: one stale contact_id must NOT drop every
  // valid enrollment saved at stop. Only 'contact-a' is owned.
  const captured: Captured = {}
  hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a'], captured))
  const res = await POST(
    req({
      enrollments: [
        { contact_id: 'contact-a', embedding: EMB },
        { contact_id: 'foreign-contact', embedding: EMB },
      ],
    }),
  )
  expect(res.status).toBe(200)
  const body = await readJson<{
    created: number
    skippedCount: number
    skippedContactIds: string[]
  }>(res)
  expect(body.created).toBe(1)
  expect(captured.inserted?.length).toBe(1)
  expect((captured.inserted?.[0] as { contact_id: string }).contact_id).toBe('contact-a')
  expect(body.skippedCount).toBe(1)
  expect(body.skippedContactIds).toEqual(['foreign-contact'])
})

it('skips a foreign confirmation-only contact_id but still returns 200', async () => {
  const captured: Captured = {}
  hoisted.createClient.mockResolvedValue(makeSupabase([], captured))
  const res = await POST(req({ confirmations: [{ contact_id: 'foreign-contact' }] }))
  expect(res.status).toBe(200)
  const body = await readJson<{ confirmed: number; skippedCount: number }>(res)
  expect(body.confirmed).toBe(0)
  expect(body.skippedCount).toBe(1)
})

it('confirms an owned contact while skipping a foreign confirmation in the same batch', async () => {
  const captured: Captured = {}
  hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a'], captured))
  const res = await POST(
    req({
      confirmations: [{ contact_id: 'contact-a' }, { contact_id: 'foreign-contact' }],
    }),
  )
  expect(res.status).toBe(200)
  const body = await readJson<{ confirmed: number; skippedCount: number }>(res)
  expect(body.confirmed).toBe(1)
  expect(body.skippedCount).toBe(1)
})

it("never enrolls the caller's own member-linked contact: their voice lives in their owner-only profile (issue 11)", async () => {
  const captured: Captured = {}
  hoisted.createClient.mockResolvedValue(makeSupabase(['contact-a', 'contact-me'], captured, 'contact-me'))
  const res = await POST(
    req({
      enrollments: [
        { contact_id: 'contact-a', embedding: EMB },
        { contact_id: 'contact-me', embedding: EMB },
      ],
      confirmations: [{ contact_id: 'contact-me' }],
    }),
  )
  expect(res.status).toBe(200)
  const body = await readJson<{ created: number; skippedContactIds: string[] }>(res)
  expect(captured.inserted?.map((r) => r.contact_id)).toEqual(['contact-a'])
  expect(body.skippedContactIds).toEqual(['contact-me'])
})
