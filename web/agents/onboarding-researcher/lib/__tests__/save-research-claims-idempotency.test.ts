import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from 'eve/tools'
import { deriveClaimId } from '../claim-id'

/**
 * Replay-idempotency tests for save_research_claims.
 *
 * eve re-runs an interrupted step's whole tool call on resume. The `claim`
 * table (migration 109) has no unique constraint to dedupe on, so a bare
 * `.insert()` would re-insert the same claim under a fresh random UUID on every
 * replay. The fix derives a DETERMINISTIC claim id from stable session inputs and
 * upserts on `id` with `ignoreDuplicates`, so a replay is a no-op.
 *
 * These tests assert:
 *   (a) the same tool call run twice derives the SAME claim id AND writes via an
 *       upsert whose options (onConflict:'id', ignoreDuplicates) make a replay
 *       incapable of duplicating, and the claim_source re-attaches to that same id;
 *   (b) different claim content derives DIFFERENT ids;
 *   (c) the id derivation itself is deterministic / injective over its inputs.
 */

// ── Recording fake supabase service client that ALSO captures upsert options ──
interface Recorded {
  table: string
  op: 'insert' | 'upsert' | 'select'
  payload?: Record<string, unknown>
  options?: Record<string, unknown>
  filters: Record<string, unknown>
}

let recorded: Recorded[]
let readResponses: Record<string, { data: unknown; error: unknown }>

function makeQuery(table: string) {
  const filters: Record<string, unknown> = {}
  const q: Record<string, unknown> = {}

  q.select = () => {
    recorded.push({ table, op: 'select', filters })
    return q
  }
  q.eq = (col: string, val: unknown) => {
    filters[col] = val
    return q
  }
  q.maybeSingle = async () => readResponses[`${table}:select`] ?? { data: null, error: null }
  // ignoreDuplicates upserts return no row, so the tool must NOT depend on a
  // returned row — mirror that: resolve with { error } only.
  q.upsert = (payload: Record<string, unknown>, options?: Record<string, unknown>) => {
    recorded.push({ table, op: 'upsert', payload, options, filters })
    return Promise.resolve({ error: readResponses[`${table}:upsert-error`]?.error ?? null })
  }
  return q
}

const fakeService = { from: (table: string) => makeQuery(table) }

vi.mock('../tool-context.js', async () => {
  const actual = await vi.importActual<typeof import('../tool-context')>('../tool-context')
  return { ...actual, serviceClient: () => fakeService }
})

import saveResearchClaims from '../../tools/save_research_claims'

function ctxWith(args: {
  workspaceId: string
  sessionId?: string
  turnId?: string
}): ToolContext {
  return {
    session: {
      id: args.sessionId ?? 'sess-1',
      auth: {
        current: {
          authenticator: 'app',
          principalId: 'real-user',
          principalType: 'user',
          attributes: { workspaceId: args.workspaceId },
        },
        initiator: null,
      },
      turn: { id: args.turnId ?? 'turn-1', sequence: 1 },
    },
    callId: 'call-abc',
  } as unknown as ToolContext
}

beforeEach(() => {
  recorded = []
  readResponses = {}
})

const ONE_CLAIM = {
  claims: [
    {
      text: 'Vercel builds developer tools',
      type: 'fact' as const,
      source_url: 'https://vercel.com',
      excerpt: 'x',
    },
  ],
}

describe('save_research_claims — replay idempotency', () => {
  it('re-running the SAME tool call upserts the SAME claim id and cannot duplicate', async () => {
    readResponses['member:select'] = { data: { id: 'member-1' }, error: null }
    const ctx = ctxWith({ workspaceId: 'real-ws' })

    // First execution.
    const first = await saveResearchClaims.execute!(ONE_CLAIM, ctx)
    expect((first as { success: boolean }).success).toBe(true)
    const firstClaim = recorded.find((r) => r.table === 'claim' && r.op === 'upsert')

    // The claim write is an upsert whose options make a replay a no-op.
    expect(firstClaim?.options).toEqual(
      expect.objectContaining({ onConflict: 'id', ignoreDuplicates: true })
    )
    const firstId = firstClaim?.payload?.id as string
    expect(firstId).toBeTruthy()

    // claim_source re-attaches to that exact claim id (no orphan on replay).
    const firstSource = recorded.find((r) => r.table === 'claim_source' && r.op === 'upsert')
    expect(firstSource?.payload?.claim_id).toBe(firstId)

    // Second execution — SAME ctx (same session + turn) and SAME input = a replay.
    recorded = []
    const second = await saveResearchClaims.execute!(ONE_CLAIM, ctx)
    expect((second as { success: boolean }).success).toBe(true)
    const secondClaim = recorded.find((r) => r.table === 'claim' && r.op === 'upsert')
    const secondId = secondClaim?.payload?.id as string

    // Deterministic id: the replay targets the SAME primary key, so with
    // ignoreDuplicates the DB write is a no-op — no duplicate row can be created.
    expect(secondId).toBe(firstId)
    const secondSource = recorded.find((r) => r.table === 'claim_source' && r.op === 'upsert')
    expect(secondSource?.payload?.claim_id).toBe(firstId)
  })

  it('DIFFERENT claim content derives a DIFFERENT id', async () => {
    readResponses['member:select'] = { data: { id: 'member-1' }, error: null }
    const ctx = ctxWith({ workspaceId: 'real-ws' })

    await saveResearchClaims.execute!(ONE_CLAIM, ctx)
    const idA = recorded.find((r) => r.table === 'claim' && r.op === 'upsert')?.payload?.id

    recorded = []
    await saveResearchClaims.execute!(
      {
        claims: [
          {
            text: 'Vercel was founded in 2015',
            type: 'fact' as const,
            source_url: 'https://vercel.com',
            excerpt: 'y',
          },
        ],
      },
      ctx
    )
    const idB = recorded.find((r) => r.table === 'claim' && r.op === 'upsert')?.payload?.id

    expect(idA).toBeTruthy()
    expect(idB).toBeTruthy()
    expect(idB).not.toBe(idA)
  })

  it('collapses content-identical claims WITHIN one call: one upsert, honest savedCount', async () => {
    // Two claims with identical (type, text, source_url) hash to the SAME
    // claimId; the second upsert would silently no-op. The tool must collapse
    // them before writing and report the count of rows that actually exist.
    readResponses['member:select'] = { data: { id: 'member-1' }, error: null }
    const ctx = ctxWith({ workspaceId: 'real-ws' })

    const result = await saveResearchClaims.execute!(
      { claims: [ONE_CLAIM.claims[0], { ...ONE_CLAIM.claims[0] }] },
      ctx
    )

    // Exactly one claim row written (and one provenance row for it).
    const claimUpserts = recorded.filter((r) => r.table === 'claim' && r.op === 'upsert')
    expect(claimUpserts).toHaveLength(1)
    const sourceUpserts = recorded.filter((r) => r.table === 'claim_source' && r.op === 'upsert')
    expect(sourceUpserts).toHaveLength(1)

    // The response reflects reality: 1 saved, and the collapse is surfaced so
    // the model isn't misled into believing two rows exist.
    const body = result as {
      success: boolean
      savedCount: number
      claims: unknown[]
      duplicatesCollapsed?: number
      message: string
    }
    expect(body.success).toBe(true)
    expect(body.savedCount).toBe(1)
    expect(body.claims).toHaveLength(1)
    expect(body.duplicatesCollapsed).toBe(1)
    expect(body.message).toContain('Saved 1 claim')
    expect(body.message).toContain('1 duplicate claim with identical content collapsed')
  })

  it('the SAME claim in a different turn/session derives a different id', async () => {
    readResponses['member:select'] = { data: { id: 'member-1' }, error: null }

    await saveResearchClaims.execute!(ONE_CLAIM, ctxWith({ workspaceId: 'real-ws', turnId: 'turn-1' }))
    const idTurn1 = recorded.find((r) => r.table === 'claim' && r.op === 'upsert')?.payload?.id

    recorded = []
    await saveResearchClaims.execute!(ONE_CLAIM, ctxWith({ workspaceId: 'real-ws', turnId: 'turn-2' }))
    const idTurn2 = recorded.find((r) => r.table === 'claim' && r.op === 'upsert')?.payload?.id

    expect(idTurn1).not.toBe(idTurn2)
  })
})

describe('deriveClaimId — determinism & shape', () => {
  const base = {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    workspaceId: 'ws-1',
    type: 'fact',
    text: 'A durable fact',
    sourceUrl: 'https://example.com',
  }

  it('is deterministic: identical inputs → identical id', () => {
    expect(deriveClaimId(base)).toBe(deriveClaimId({ ...base }))
  })

  it('produces a syntactically valid v5-formatted UUID', () => {
    const id = deriveClaimId(base)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('changing any single input changes the id', () => {
    const baseId = deriveClaimId(base)
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      const mutated = { ...base, [key]: base[key] + '_x' }
      expect(deriveClaimId(mutated)).not.toBe(baseId)
    }
  })

  it('does not confuse field boundaries (delimiter injection)', () => {
    // Moving a character across the text/sourceUrl boundary must not collide.
    const a = deriveClaimId({ ...base, text: 'ab', sourceUrl: 'cd' })
    const b = deriveClaimId({ ...base, text: 'a', sourceUrl: 'bcd' })
    expect(a).not.toBe(b)
  })
})
