/**
 * Eval isolation for the live-agent `record_commitment` tool (evals spec §5.1).
 *
 * WHAT THIS GUARDS: on an EVAL capture (a synthetic mock meeting) the tool must
 * return a synthetic success and touch NOTHING. The dangerous half is the
 * `match_claims` dedupe, which runs BEFORE the insert: on a ≥0.92 cosine match
 * it attaches provenance to an EXISTING, real claim — so a mock sales call would
 * graft itself onto the knowledge graph without ever inserting a row of its own.
 * A test that only asserted "no claim row was inserted" would pass while that
 * happened, which is why every collaborator is asserted un-called here.
 *
 * These run the real `record_commitment` execute() with the embedding, dedupe,
 * provenance and person-resolution collaborators mocked, so the assertions are
 * about what the tool DID, not about a stubbed return value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

const { mockEmbed, mockAttachProvenance, mockResolvePerson, mockRpc, mockFrom, mockInsert } =
  vi.hoisted(() => ({
    mockEmbed: vi.fn(async () => [0.1, 0.2]),
    mockAttachProvenance: vi.fn(async () => undefined),
    mockResolvePerson: vi.fn(async () => ({
      name: 'Sarah Chen',
      memberId: 'member-sarah',
      contactId: null,
      unresolvedLabel: false,
      selfReference: false,
    })),
    mockRpc: vi.fn(async () => ({ data: [], error: null })),
    mockFrom: vi.fn(),
    mockInsert: vi.fn(),
  }))

vi.mock('@/lib/ai/embeddings', () => ({ embed: mockEmbed }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: mockAttachProvenance }))
vi.mock('@/lib/live-agent/speaker-resolution', () => ({
  resolvePersonForCapture: mockResolvePerson,
}))
// record_commitment never reaches these, but createLiveAgentTools imports them
// at module load — stub so the import graph resolves without real deps.
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  updateAppliedEntity: vi.fn(),
  deleteAppliedEntity: vi.fn(),
}))
vi.mock('@/lib/live-agent/nudge-channel', () => ({ broadcastNudge: vi.fn(async () => true) }))
vi.mock('@/lib/live-agent/conversation-writer', () => ({
  appendAgentMessage: vi.fn(async () => ({ written: true })),
  hasPendingLiveQuestion: vi.fn(async () => false),
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/mcp-client/adapter', () => ({
  namespacedToolName: (s: string, t: string) => `mcp__${s}__${t}`,
}))

import { createLiveAgentTools } from '../tools'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const CAPTURE_ID = 'cap-1'
const MEMBER_ME = 'member-me'
const EXEC_OPTS = { toolCallId: 'tc-1', messages: [], context: {} } satisfies ToolExecutionOptions<
  Record<string, unknown>
>

const ARGS = {
  person_name: 'Sarah Chen',
  commitment: 'send the Q3 deck by Friday',
  trigger_quote: "I'll send the Q3 deck by Friday",
  confidence: 0.9,
}

/**
 * A Supabase stub whose every table op records the call and resolves empty,
 * except the capture read, which returns `capture` (who can see the meeting).
 */
function makeSupabase(capture: { visibility: string; user_id: string } | null = null) {
  mockFrom.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {
      insert: (...args: unknown[]) => {
        mockInsert(table, ...args)
        return {
          select: () => ({ single: async () => ({ data: { id: 'claim-new' }, error: null }) }),
        }
      },
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data: table === 'captures' && capture ? { started_at: null, created_at: null, ...capture } : null,
        error: null,
      }),
      single: async () => ({ data: null, error: null }),
    }
    return chain
  })
  return { from: mockFrom, rpc: mockRpc } as never
}

function tools(isEvalCapture: boolean, capture: { visibility: string; user_id: string } | null = null) {
  return createLiveAgentTools(
    USER_ID,
    makeSupabase(capture),
    WORKSPACE_ID,
    CAPTURE_ID,
    null,
    null,
    MEMBER_ME,
    'Liam Alizadeh',
    null,
    { isEvalCapture },
  )
}

beforeEach(() => {
  mockEmbed.mockClear()
  mockAttachProvenance.mockClear()
  mockResolvePerson.mockClear()
  mockRpc.mockClear().mockResolvedValue({ data: [], error: null })
  mockFrom.mockReset()
  mockInsert.mockReset()
})

describe('record_commitment — eval capture', () => {
  it('returns a synthetic success shaped for the trace', async () => {
    const res = await tools(true).record_commitment.execute!(ARGS, EXEC_OPTS)

    // The model must see an ORDINARY success so the turn proceeds exactly as it
    // would on a real call; `eval_suppressed` is the marker the runner reads.
    expect(res).toEqual({
      success: true,
      claim_id: null,
      eval_suppressed: true,
      text: 'Sarah Chen committed to send the Q3 deck by Friday',
      subject: 'Sarah Chen',
    })
  })

  it('never embeds, never calls match_claims, never writes a claim or provenance', async () => {
    await tools(true).record_commitment.execute!(ARGS, EXEC_OPTS)

    // The dedupe is the leak path — it attaches a mock call's provenance to an
    // EXISTING real claim without inserting anything of its own.
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockAttachProvenance).not.toHaveBeenCalled()
    expect(mockEmbed).not.toHaveBeenCalled()
    // No claim, no claim_chunks — no table touched at all on this path.
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    // It short-circuits ahead of person resolution too, so a mock name can't
    // fuzzy-match a real member and drag them into the trial.
    expect(mockResolvePerson).not.toHaveBeenCalled()
  })
})

describe('record_commitment — real capture (unchanged)', () => {
  it('still resolves the person, embeds, dedupes and writes the claim', async () => {
    const res = (await tools(false).record_commitment.execute!(ARGS, EXEC_OPTS)) as {
      success: boolean
      claim_id: string
      eval_suppressed?: boolean
    }

    expect(res.success).toBe(true)
    expect(res.claim_id).toBe('claim-new')
    // The eval marker must never appear on the real path.
    expect(res.eval_suppressed).toBeUndefined()

    expect(mockResolvePerson).toHaveBeenCalledTimes(1)
    expect(mockEmbed).toHaveBeenCalledTimes(1)
    // The capture read returned nothing here, so the dedupe can't know who
    // sees the meeting: it falls back to no requester (shared claims only).
    expect(mockRpc).toHaveBeenCalledWith('match_claims', expect.objectContaining({
      p_workspace_id: WORKSPACE_ID,
      p_requesting_user_id: null,
    }))
    expect(mockAttachProvenance).toHaveBeenCalledTimes(1)
    const insertedTables = mockInsert.mock.calls.map((c) => c[0])
    expect(insertedTables).toContain('claim')
    expect(insertedTables).toContain('claim_chunks')
  })

  it('defaults to the real path when no options object is passed', async () => {
    // The nine-positional call sites that predate the flag must be untouched.
    const legacy = createLiveAgentTools(
      USER_ID,
      makeSupabase(),
      WORKSPACE_ID,
      CAPTURE_ID,
      null,
      null,
      MEMBER_ME,
      'Liam Alizadeh',
      null,
    )
    const res = (await legacy.record_commitment.execute!(ARGS, EXEC_OPTS)) as {
      claim_id: string
      eval_suppressed?: boolean
    }
    expect(res.claim_id).toBe('claim-new')
    expect(res.eval_suppressed).toBeUndefined()
  })
})

// Dedupe never widens a claim (2026-10-18): a hit attaches this capture to the
// existing claim, and under the any-visible-source rule a wider source would
// widen it. So match_claims is asked as the capture's own audience.
describe('record_commitment — dedupe is scoped to the capture audience', () => {
  const OWNER = 'u-owner'

  it("a private capture dedupes as its owner (sees the owner's private claims)", async () => {
    await tools(false, { visibility: 'private', user_id: OWNER }).record_commitment.execute!(ARGS, EXEC_OPTS)
    expect(mockRpc).toHaveBeenCalledWith('match_claims', expect.objectContaining({ p_requesting_user_id: OWNER }))
  })

  it('a workspace capture dedupes with no requester (shared claims only)', async () => {
    await tools(false, { visibility: 'workspace', user_id: OWNER }).record_commitment.execute!(ARGS, EXEC_OPTS)
    expect(mockRpc).toHaveBeenCalledWith('match_claims', expect.objectContaining({ p_requesting_user_id: null }))
  })

  it('a private capture whose committer is a CRM contact dedupes with no requester (the contact edge is readable by all)', async () => {
    mockResolvePerson.mockResolvedValueOnce({
      name: 'Dana Park',
      memberId: null,
      contactId: 'contact-dana',
      unresolvedLabel: false,
      selfReference: false,
    } as never)
    await tools(false, { visibility: 'private', user_id: OWNER }).record_commitment.execute!(ARGS, EXEC_OPTS)
    expect(mockRpc).toHaveBeenCalledWith('match_claims', expect.objectContaining({ p_requesting_user_id: null }))
  })

  it('a workspace capture never attaches to a private claim: a match only it can see is never offered', async () => {
    // match_claims answers like the real RPC: the owner's private claim is a
    // hit only when asked as the owner.
    mockRpc.mockImplementation((async (_fn: string, args: { p_requesting_user_id: string | null }) => ({
      data: args.p_requesting_user_id === OWNER ? [{ claim_id: 'claim-private' }] : [],
      error: null,
    })) as never)
    const res = (await tools(false, { visibility: 'workspace', user_id: OWNER }).record_commitment.execute!(ARGS, EXEC_OPTS)) as {
      claim_id: string
      deduplicated?: boolean
    }
    expect(res.claim_id).toBe('claim-new')
    expect(res.deduplicated).toBeUndefined()
    expect(mockAttachProvenance).toHaveBeenCalledTimes(1)
    expect(mockAttachProvenance).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ claimId: 'claim-private' }))
  })

  it("a private capture still attaches to its owner's private claim", async () => {
    mockRpc.mockImplementation((async (_fn: string, args: { p_requesting_user_id: string | null }) => ({
      data: args.p_requesting_user_id === OWNER ? [{ claim_id: 'claim-private' }] : [],
      error: null,
    })) as never)
    const res = (await tools(false, { visibility: 'private', user_id: OWNER }).record_commitment.execute!(ARGS, EXEC_OPTS)) as {
      claim_id: string
      deduplicated?: boolean
    }
    expect(res).toMatchObject({ claim_id: 'claim-private', deduplicated: true })
    expect(mockAttachProvenance).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ claimId: 'claim-private' }))
    expect(mockInsert).not.toHaveBeenCalled()
  })
})
