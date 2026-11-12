/**
 * Tests for POST /api/account/captures/[id]/self-binding.
 *
 * The client asserts a speaker label matched the user's voiceprint; the server
 * NEVER trusts that — it re-verifies the posted embeddings against the caller's
 * OWN stored prototypes before granting self_binding='voice'
 * (docs/plans/voice-enrollment-implementation.md §3). These tests pin:
 *   - ownership: 403 when captures.user_id !== user.id (workspace membership
 *     alone is not enough)
 *   - re-verification: 422 when the posted embeddings don't clear
 *     SELF_VERIFY_THRESHOLD against stored prototypes; grant carries the
 *     server-computed confidence
 *   - CAS atomicity: a single conditional UPDATE gated on
 *     .in('self_binding', ['none','position']) — position→voice grants,
 *     confirmed→voice returns granted:false (CAS matched 0 rows)
 *   - 404 when no self row exists
 *
 * The Supabase fake serves these shapes off one `.from()`:
 *   - captures  → `.select().eq().maybeSingle()`  (ownership probe)
 *   - user_voice_profile → `.select().eq()` thenable (stored rows)
 *   - capture_participant self probe → `.select().eq().eq().maybeSingle()`
 *   - capture_participant label-release → `.update().eq().eq().eq()` thenable
 *     (clears the posted label off any NON-self row — no `.in()`/`.select()`)
 *   - capture_participant grant → `.update().eq().eq().in().select()` thenable
 * Each `.from('capture_participant')` gets a FRESH chain so the release and the
 * grant UPDATE are tracked independently (the route calls .from() per op).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { EMBEDDING_DIM } from '@/lib/voice-profile/types'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

import { POST } from '@/app/api/account/captures/[id]/self-binding/route'

const USER_ID = 'user-1'
const CAPTURE_ID = 'cap-1'

/** A basis embedding: 1 at index `k`, 0 elsewhere. Two different k's are orthogonal. */
function basis(k: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[k] = 1
  return v
}

interface Captured {
  /** Payload of the GRANT update (self_binding:'voice', ...). */
  updatePayload?: Record<string, unknown>
  updateFilters: { self_bindingIn?: string[]; captureId?: string; isSelf?: boolean }
  /** Count of GRANT updates only (the conditional CAS). */
  updateCount: number
  /** Payload of the LABEL-RELEASE update ({ speaker_label: null }). */
  releasePayload?: Record<string, unknown>
  /** Filters the label-release update applied (capture_id / is_self / speaker_label). */
  releaseFilters: { captureId?: string; isSelf?: unknown; speakerLabel?: string }
  /** Count of label-release updates. */
  releaseCount: number
}

interface FakeOpts {
  captureOwnerId?: string | null // null → capture not found
  profileRows?: { embedding: number[]; quality: number; session_id: string; created_at: string }[]
  selfRow?: { id: string } | null // null → no self participant row
  /** rows the grant UPDATE returns (CAS result). Empty → CAS miss. */
  grantReturns?: { id: string }[]
  /** error the label-release UPDATE should surface (drives the 500 path). */
  releaseError?: { message: string }
  /** The capture is a call the recorder heard (roster rows, migration 587). */
  callRoster?: boolean
}

function makeSupabase(opts: FakeOpts, captured: Captured) {
  return {
    from: (table: string) => {
      if (table === 'captures') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          maybeSingle: () =>
            Promise.resolve({
              data:
                opts.captureOwnerId == null
                  ? null
                  : { id: CAPTURE_ID, user_id: opts.captureOwnerId },
              error: null,
            }),
        })
        return b
      }
      if (table === 'user_voice_profile') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
            Promise.resolve(resolve({ data: opts.profileRows ?? [], error: null })),
        })
        return b
      }
      // capture_participant — a FRESH chain per .from() call so the self-probe,
      // the label-release UPDATE and the grant UPDATE are tracked independently.
      // Chain-local state distinguishes release (no `.in()`) from grant.
      const b: Record<string, unknown> = {}
      const local: {
        isUpdate: boolean
        payload?: Record<string, unknown>
        sawIn: boolean
        eqCols: Record<string, unknown>
      } = { isUpdate: false, sawIn: false, eqCols: {} }
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => {
          local.eqCols[col] = val
          return b
        },
        in: (_col: string, vals: string[]) => {
          local.sawIn = true
          captured.updateFilters.self_bindingIn = vals
          return b
        },
        maybeSingle: () =>
          Promise.resolve({ data: opts.selfRow === undefined ? { id: 'self-1' } : opts.selfRow, error: null }),
        limit: () => b,
        update: (payload: Record<string, unknown>) => {
          local.isUpdate = true
          local.payload = payload
          return b
        },
        then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
          if (local.isUpdate && local.sawIn) {
            // Grant CAS (has `.in('self_binding', ...)`).
            captured.updateCount++
            captured.updatePayload = local.payload
            return Promise.resolve(resolve({ data: opts.grantReturns ?? [{ id: 'self-1' }], error: null }))
          }
          if (local.isUpdate) {
            // Label-release UPDATE (no `.in()`).
            captured.releaseCount++
            captured.releasePayload = local.payload
            captured.releaseFilters = {
              captureId: local.eqCols['capture_id'] as string,
              isSelf: local.eqCols['is_self'],
              speakerLabel: local.eqCols['speaker_label'] as string,
            }
            return Promise.resolve(resolve({ data: null, error: opts.releaseError ?? null }))
          }
          // The roster probe (callRosterSetsSpeakers): a call the recorder heard has roster rows.
          if (local.eqCols['source'] === 'call_roster') {
            return Promise.resolve(resolve({ data: opts.callRoster ? [{ id: 'roster-1' }] : [], error: null }))
          }
          // A bare read thenable (unused here) resolves empty.
          return Promise.resolve(resolve({ data: null, error: null }))
        },
      })
      return b
    },
  }
}

function auth(opts: FakeOpts, captured: Captured) {
  return {
    supabase: makeSupabase(opts, captured),
    user: { id: USER_ID, email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: 'mem-1', role: 'owner' },
  }
}

function freshCaptured(): Captured {
  return { updateFilters: {}, updateCount: 0, releaseFilters: {}, releaseCount: 0 }
}

function req(body: unknown): NextRequest {
  return buildRequest({
    url: `https://nativeintelligence.dev/api/account/captures/${CAPTURE_ID}/self-binding`,
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const params = Promise.resolve({ id: CAPTURE_ID })

// Two matching embeddings (identical to the stored prototype → cosine 1.0).
const matchingBody = { speaker_label: 'local_1', embeddings: [basis(0), basis(0)] }
// A profile whose single session prototype is basis(0).
const profileRows = [
  { embedding: basis(0), quality: 0.9, session_id: 's1', created_at: '2026-07-15T10:00:00Z' },
]

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
})

describe('ownership', () => {
  it('403 when the capture belongs to another user', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: 'someone-else', profileRows }, captured))
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(403)
    // Never reached the grant.
    expect(captured.updateCount).toBe(0)
  })

  it('403 when the capture does not exist', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: null, profileRows }, captured))
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(403)
  })
})

describe('body validation', () => {
  it('400 with fewer than 2 embeddings', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows }, captured))
    const res = await POST(req({ speaker_label: 'local_1', embeddings: [basis(0)] }), { params })
    expect(res.status).toBe(400)
  })

  it('400 with a wrong-dimension embedding', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows }, captured))
    const res = await POST(req({ speaker_label: 'local_1', embeddings: [[1, 2], [3, 4]] }), { params })
    expect(res.status).toBe(400)
  })

  it('400 with a missing speaker_label', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows }, captured))
    const res = await POST(req({ embeddings: [basis(0), basis(0)] }), { params })
    expect(res.status).toBe(400)
  })
})

describe('server re-verification', () => {
  it('422 when the profile is empty (nothing to verify against)', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows: [] }, captured))
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(422)
    const body = await readJson<{ granted: boolean }>(res)
    expect(body.granted).toBe(false)
    expect(captured.updateCount).toBe(0)
  })

  it('422 when posted embeddings do not clear the threshold', async () => {
    const captured = freshCaptured()
    // Posted embeddings are orthogonal to the stored prototype → cosine 0.
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows }, captured))
    const res = await POST(
      req({ speaker_label: 'local_1', embeddings: [basis(1), basis(2)] }),
      { params },
    )
    expect(res.status).toBe(422)
    const body = await readJson<{ granted: boolean }>(res)
    expect(body.granted).toBe(false)
    expect(captured.updateCount).toBe(0)
  })

  it('422 when only ONE embedding matches (needs 2)', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows }, captured))
    const res = await POST(
      req({ speaker_label: 'local_1', embeddings: [basis(0), basis(9)] }),
      { params },
    )
    expect(res.status).toBe(422)
    expect(captured.updateCount).toBe(0)
  })

  it('grants and carries the server-computed confidence', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows }, captured))
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(200)
    const body = await readJson<{ granted: boolean }>(res)
    expect(body.granted).toBe(true)
    // The grant is a single conditional UPDATE carrying the server confidence.
    expect(captured.updateCount).toBe(1)
    expect(captured.updatePayload?.self_binding).toBe('voice')
    expect(captured.updatePayload?.speaker_label).toBe('local_1')
    expect(captured.updatePayload?.voice_match_confidence).toBeCloseTo(1, 5)
    // CAS guard restricts to none/position — never clobbers confirmed/voice.
    expect(captured.updateFilters.self_bindingIn).toEqual(['none', 'position'])
  })
})

describe('CAS atomicity', () => {
  it('404 when no self participant row exists', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ captureOwnerId: USER_ID, profileRows, selfRow: null }, captured),
    )
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(404)
    expect(captured.updateCount).toBe(0)
  })

  it('granted:false (200) when the CAS matches 0 rows (already confirmed/voice)', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ captureOwnerId: USER_ID, profileRows, grantReturns: [] }, captured),
    )
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(200)
    const body = await readJson<{ granted: boolean; reason?: string }>(res)
    expect(body.granted).toBe(false)
    expect(body.reason).toBeTruthy()
    // Still exactly ONE grant update attempt — no read-then-write.
    expect(captured.updateCount).toBe(1)
  })

  it('409 on a call the recorder heard: its speakers come from the call, nothing is written', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows, callRoster: true }, captured))
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(409)
    expect((await readJson<{ code?: string }>(res)).code).toBe('SPEAKERS_FROM_CALL')
    expect(captured.updateCount).toBe(0)
    expect(captured.releaseCount).toBe(0)
  })
})

describe('label-uniqueness (finding 4)', () => {
  it('releases the posted label off any NON-self row before granting', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(auth({ captureOwnerId: USER_ID, profileRows }, captured))
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(200)
    // The label-release UPDATE ran exactly once BEFORE the grant, nulling the
    // speaker_label on the NON-self echo row (is_self=false) for this capture
    // so two rows never share the label.
    expect(captured.releaseCount).toBe(1)
    expect(captured.releasePayload).toEqual({ speaker_label: null })
    expect(captured.releaseFilters.captureId).toBe(CAPTURE_ID)
    expect(captured.releaseFilters.isSelf).toBe(false)
    expect(captured.releaseFilters.speakerLabel).toBe('local_1')
    // The grant still runs — the self row takes the label.
    expect(captured.updateCount).toBe(1)
    expect(captured.updatePayload?.speaker_label).toBe('local_1')
  })

  it('500 when the label-release UPDATE errors (never reaches the grant)', async () => {
    const captured = freshCaptured()
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ captureOwnerId: USER_ID, profileRows, releaseError: { message: 'boom' } }, captured),
    )
    const res = await POST(req(matchingBody), { params })
    expect(res.status).toBe(500)
    expect(captured.releaseCount).toBe(1)
    // Bailed before the grant CAS.
    expect(captured.updateCount).toBe(0)
  })
})
