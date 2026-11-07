/**
 * Tests for emitDecisionClaim — the decision → decision_summary claim mirror.
 *
 * Invariants locked in:
 *  - event_at is forward-filled from the capture's started_at (created_at
 *    fallback) on the claim INSERT — the mirror stamps the meeting's
 *    real-world time, not mirror-run time (mig 180 semantics; this path was
 *    the one writer missed by the original forward-fill, found live on PROD).
 *  - eventAt rides into attachClaimProvenance's ProvenanceSource so
 *    corroboration keeps LEAST semantics.
 *  - An unresolvable capture leaves event_at NULL (honestly unknown-time),
 *    never mirror-run time.
 *  - The exact-text + same-capture-cite dedupe guard still short-circuits
 *    before any insert.
 *
 * Vitest unit tests (no network, no DB).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const attachClaimProvenance = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ errors: [] })),
)
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance }))
vi.mock('@/lib/ai/embeddings', () => ({
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}))

import { emitDecisionClaim } from '../emit-decision-claim'

const WS = 'ws-1'
const CAPTURE = 'cap-1'
const STARTED = '2026-07-09T15:12:49.548Z'
const CREATED = '2026-07-09T16:00:00.000Z'

interface StubOpts {
  capture?: {
    started_at: string | null
    created_at: string | null
    metadata?: Record<string, unknown> | null
  } | null
  existingClaimIds?: string[]
  existingCite?: boolean
}

/** Chainable stub: records claim inserts, serves the dedupe + capture fetches. */
function stubSupabase(opts: StubOpts = {}) {
  const claimInserts: Record<string, unknown>[] = []
  const chunkInserts: Record<string, unknown>[] = []

  const from = vi.fn((table: string) => {
    if (table === 'claim') {
      return {
        // dedupe-guard select chain: .select().eq().eq().eq() → thenable
        select: vi.fn(() => {
          const chain = {
            eq: vi.fn(() => chain),
            then: (cb: (v: unknown) => unknown) =>
              Promise.resolve({
                data: (opts.existingClaimIds ?? []).map((id) => ({ id })),
                error: null,
              }).then(cb),
          }
          return chain
        }),
        insert: vi.fn((row: Record<string, unknown>) => {
          claimInserts.push(row)
          return {
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: { id: 'new-claim-1' }, error: null })),
            })),
          }
        }),
      }
    }
    if (table === 'entity_link') {
      const chain = {
        eq: vi.fn(() => chain),
        in: vi.fn(() => chain),
        limit: vi.fn(async () => ({
          data: opts.existingCite ? [{ source_id: 'old-claim' }] : [],
          error: null,
        })),
      }
      return { select: vi.fn(() => chain) }
    }
    if (table === 'captures') {
      const chain = {
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({
          data: opts.capture === undefined ? { started_at: STARTED, created_at: CREATED } : opts.capture,
          error: null,
        })),
      }
      return { select: vi.fn(() => chain) }
    }
    if (table === 'claim_chunks') {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          chunkInserts.push(row)
          return { data: null, error: null }
        }),
      }
    }
    throw new Error(`unexpected table ${table}`)
  })

  return { supabase: { from } as never, claimInserts, chunkInserts }
}

function baseArgs(supabase: never) {
  return {
    supabase,
    workspaceId: WS,
    memberId: 'member-1',
    userId: 'user-1',
    text: 'We will ship the v2 API on Friday',
    captureId: CAPTURE,
    projectId: null,
    confirmation: 'confirmed' as const,
  }
}

beforeEach(() => {
  attachClaimProvenance.mockClear()
})

describe('emitDecisionClaim event_at forward-fill', () => {
  it('stamps the capture started_at as event_at on the claim insert', async () => {
    const { supabase, claimInserts } = stubSupabase()
    await emitDecisionClaim(baseArgs(supabase))
    expect(claimInserts).toHaveLength(1)
    expect(claimInserts[0].event_at).toBe(STARTED)
    expect(claimInserts[0].type).toBe('decision_summary')
  })

  it('falls back to capture created_at when started_at is null', async () => {
    const { supabase, claimInserts } = stubSupabase({
      capture: { started_at: null, created_at: CREATED },
    })
    await emitDecisionClaim(baseArgs(supabase))
    expect(claimInserts[0].event_at).toBe(CREATED)
  })

  it('leaves event_at null when the capture row cannot be resolved', async () => {
    const { supabase, claimInserts } = stubSupabase({ capture: null })
    await emitDecisionClaim(baseArgs(supabase))
    expect(claimInserts).toHaveLength(1)
    expect(claimInserts[0].event_at).toBeNull()
  })

  it('passes eventAt through to attachClaimProvenance for LEAST semantics', async () => {
    const { supabase } = stubSupabase()
    await emitDecisionClaim(baseArgs(supabase))
    expect(attachClaimProvenance).toHaveBeenCalledTimes(1)
    const arg = attachClaimProvenance.mock.calls[0][1] as {
      sources: { source_type: string; source_id: string; eventAt?: string | null }[]
    }
    expect(arg.sources).toEqual([
      { source_type: 'capture', source_id: CAPTURE, relation: 'cites', eventAt: STARTED },
    ])
  })

  it('dedupe guard still short-circuits before any insert', async () => {
    const { supabase, claimInserts } = stubSupabase({
      existingClaimIds: ['old-claim'],
      existingCite: true,
    })
    await emitDecisionClaim(baseArgs(supabase))
    expect(claimInserts).toHaveLength(0)
    expect(attachClaimProvenance).not.toHaveBeenCalled()
  })

  it('never mirrors a demo capture decision (onboarding tutorial gate)', async () => {
    const { supabase, claimInserts } = stubSupabase({
      capture: { started_at: STARTED, created_at: CREATED, metadata: { demo: true } },
    })
    await emitDecisionClaim(baseArgs(supabase))
    expect(claimInserts).toHaveLength(0)
    expect(attachClaimProvenance).not.toHaveBeenCalled()
  })
})
