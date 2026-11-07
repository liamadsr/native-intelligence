import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeResult } from './fake-supabase'
import type { EvalTrace, ExpectedOutcomes, TraceProposal } from '../types'

const hoisted = vi.hoisted(() => ({
  batchEmbed: vi.fn(),
  generateObject: vi.fn(),
  runUtilityTask: vi.fn(),
}))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.runUtilityTask }))

vi.mock('@/lib/ai/embeddings', () => ({ batchEmbed: hoisted.batchEmbed }))
vi.mock('ai', () => ({ generateObject: hoisted.generateObject }))
vi.mock('@/lib/ai/gateway', () => ({ aiModel: (s: string) => s }))
vi.mock('@/lib/ai/model-defaults', () => ({
  surfaceModelSlug: () => 'anthropic/claude-haiku-4.5',
}))

const { matchProposals } = await import('../graders/match-proposals')

const WS = 'ws-1'
const supabase = makeFakeSupabase((): FakeResult => ({ data: null })).client

function proposal(overrides: Partial<TraceProposal> = {}): TraceProposal {
  return {
    id: 'p1',
    entity_type: 'action',
    change_type: 'create',
    title: 'Email the security doc',
    display_text: 'Email the security doc over to Dana',
    confidence: 0.9,
    status: 'pending',
    assignee_name: 'Liam',
    gate: { decision: 'stage', would_have_applied: true },
    ...overrides,
  }
}

function trace(proposals: TraceProposal[]): EvalTrace {
  return {
    mode: 'batch',
    speed: 'instant',
    driver: 'server',
    flushes: [],
    proposals_final: proposals,
    summary_final: null,
    summary_source: 'none',
    title_final: null,
    commitments: [],
    reads: [],
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, model: 'x' },
  }
}

const EXPECTED: ExpectedOutcomes = {
  proposals: [
    {
      key: 'send_questionnaire',
      entity_type: 'action',
      change_type: 'create',
      gist: 'Send Dana the security questionnaire',
    },
  ],
}

/** Two vectors whose cosine is exactly `sim`, for driving the fallback floor. */
function vectorsWithCosine(sim: number): [number[], number[]] {
  return [
    [1, 0],
    [sim, Math.sqrt(Math.max(0, 1 - sim * sim))],
  ]
}

beforeEach(() => {
  hoisted.batchEmbed.mockReset()
  hoisted.generateObject.mockReset()
  hoisted.runUtilityTask.mockReset()
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key')
})

describe("matchProposals on the run starter's own ChatGPT plan", () => {
  it('the decider runs on the plan (eval_judge), never the Gateway, at no cost', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0]])
    hoisted.runUtilityTask.mockResolvedValue({
      text: '', model: 'chatgpt-plan/gpt-6.1-sol',
      usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'same work' }] },
    })
    const { checks, usage } = await matchProposals(supabase, {
      workspaceId: WS, trace: trace([proposal()]), expected: EXPECTED, plan: { userId: 'u-free', workspaceId: WS },
    })
    expect(hoisted.generateObject).not.toHaveBeenCalled()
    expect(hoisted.runUtilityTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'eval_judge', chatgptPlan: true, planModel: 'gpt-6.1-sol', userId: 'u-free' }))
    expect(checks.find((c) => c.check_key === 'proposal:send_questionnaire')!.outcome).toBe('pass')
    expect(usage.cost_usd).toBe(0)
  })
})

describe('matchProposals — the LLM decides, embeddings only shortlist', () => {
  it('passes a recall check when the decider says the paraphrase is the same item', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0]])
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'same work' }] },
    })

    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
    })
    const recall = checks.find((c) => c.check_key === 'proposal:send_questionnaire')!
    expect(recall.outcome).toBe('pass')
    expect(recall.severity).toBe('gate')
    expect((recall.evidence as { match_method: string }).match_method).toBe('llm')
    expect((recall.evidence as { matched_proposal_id: string }).matched_proposal_id).toBe('p1')
  })

  it('fails recall when the decider says no, even at a HIGH cosine', async () => {
    // Identical vectors — a cosine matcher would call this a match. The whole
    // point of layer 2 is that the cutoff does not decide.
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0]])
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: false, why: 'different deliverable' }] },
    })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
    })
    expect(checks.find((c) => c.check_key === 'proposal:send_questionnaire')!.outcome).toBe('fail')
  })

  it('records the shortlist in evidence so a matcher flip is explainable', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0], [0, 1]])
    hoisted.generateObject.mockResolvedValue({ object: { decisions: [] } })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal(), proposal({ id: 'p2', display_text: 'Book the follow-up' })]),
      expected: EXPECTED,
    })
    const evidence = checks[0].evidence as { candidates: Array<{ id: string; score: number }> }
    expect(evidence.candidates.map((c) => c.id)).toEqual(['p1', 'p2'])
    expect(evidence.candidates[0].score).toBeGreaterThan(evidence.candidates[1].score)
  })

  it('sends ONE batched decision call for many expected items, not one per pair', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [0, 1], [1, 0], [0, 1]])
    hoisted.generateObject.mockResolvedValue({ object: { decisions: [] } })
    await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal(), proposal({ id: 'p2' })]),
      expected: {
        proposals: [
          { key: 'a', entity_type: 'action', change_type: 'create', gist: 'A' },
          { key: 'b', entity_type: 'action', change_type: 'create', gist: 'B' },
        ],
      },
    })
    expect(hoisted.generateObject).toHaveBeenCalledTimes(1)
  })
})

describe('must_have is structural', () => {
  beforeEach(() => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0]])
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'same' }] },
    })
  })

  it('fails a matched pair whose entity_type is wrong', async () => {
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal({ entity_type: 'decision' })]),
      expected: {
        proposals: [{ ...EXPECTED.proposals![0], must_have: { entity_type: 'action' } }],
      },
    })
    const check = checks[0]
    expect(check.outcome).toBe('fail')
    expect(check.rationale).toContain('entity_type')
  })

  it('treats "assignee: self" as any non-empty assignee, and fails an unassigned one', async () => {
    const { checks: withOwner } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal({ assignee_name: 'Liam' })]),
      expected: { proposals: [{ ...EXPECTED.proposals![0], must_have: { assignee: 'self' } }] },
    })
    expect(withOwner[0].outcome).toBe('pass')

    const { checks: unowned } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal({ assignee_name: null })]),
      expected: { proposals: [{ ...EXPECTED.proposals![0], must_have: { assignee: 'self' } }] },
    })
    expect(unowned[0].outcome).toBe('fail')
  })

  it('fails an UNKNOWN must_have key rather than silently passing a typo', async () => {
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: { proposals: [{ ...EXPECTED.proposals![0], must_have: { assigne: 'self' } }] },
    })
    expect(checks[0].outcome).toBe('fail')
    expect(checks[0].rationale).toContain('unknown must_have field')
  })
})

describe('forbidden proposals', () => {
  it('FAILS as a gate when a forbidden gist matched something the agent proposed', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0]])
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'yes' }] },
    })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: { forbidden_proposals: [{ key: 'no_dana_owner', gist: 'Anything owned by Dana' }] },
    })
    const check = checks.find((c) => c.check_key === 'forbidden:no_dana_owner')!
    expect(check.outcome).toBe('fail')
    expect(check.severity).toBe('gate')
  })

  it('PASSES when nothing matched — the negative control the suite wanted', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [0, 1]])
    hoisted.generateObject.mockResolvedValue({ object: { decisions: [] } })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: { forbidden_proposals: [{ key: 'no_dana_owner', gist: 'Anything owned by Dana' }] },
    })
    expect(checks[0].outcome).toBe('pass')
  })

  it('emits nothing at all when the case declares no proposal expectations', async () => {
    expect(
      (await matchProposals(supabase, { workspaceId: WS, trace: trace([proposal()]), expected: {} }))
        .checks,
    ).toEqual([])
    expect(hoisted.generateObject).not.toHaveBeenCalled()
  })
})

describe('precision is soft, always', () => {
  it('reports unmatched proposals without gating on them', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0], [0, 1]])
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'yes' }] },
    })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal(), proposal({ id: 'p2', display_text: 'Something nobody asked for' })]),
      expected: EXPECTED,
    })
    const precision = checks.find((c) => c.check_key === 'proposal_precision')!
    expect(precision.severity).toBe('soft')
    expect(precision.outcome).toBe('fail')
    expect(precision.score).toBe(0.5)
  })

  /**
   * DEFECT — a forbidden match was added to the SAME `matchedIds` set the recall
   * loop fills, so the proposals a case explicitly bans counted as "expected"
   * and precision reported 1.0 on a trial that over-proposed exactly what the
   * suite forbade.
   */
  it('never counts a FORBIDDEN match as an expected proposal', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0], [1, 0], [1, 0]])
    // Expected key 0 matches proposal 0; forbidden key 1 matches proposal 1.
    hoisted.generateObject.mockResolvedValue({
      object: {
        decisions: [
          { expected_index: 0, candidate_index: 0, same: true, why: 'same work' },
          { expected_index: 1, candidate_index: 1, same: true, why: 'the banned one' },
        ],
      },
    })

    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([
        proposal(),
        proposal({ id: 'p2', display_text: 'Draft an email to the prospect' }),
      ]),
      expected: {
        ...EXPECTED,
        forbidden_proposals: [{ key: 'no_email', gist: 'drafts an email to the prospect' }],
      },
    })

    // The gate still fires — that part was never broken.
    expect(checks.find((c) => c.check_key === 'forbidden:no_email')!.outcome).toBe('fail')

    // And precision no longer reads 1.0 over 2 proposals. The forbidden one is
    // outside the check entirely (it already failed its own gate), so the one
    // remaining proposal matched its expected item.
    const precision = checks.find((c) => c.check_key === 'proposal_precision')!
    expect(precision.score).toBe(1)
    expect(precision.rationale).toBe('All 1 proposal(s) matched an expected item.')
    expect(
      (precision.evidence as { unexpected: Array<{ id: string }> }).unexpected.map((u) => u.id),
    ).toEqual([])
  })

  it('a forbidden match does not mask a genuinely unexpected proposal', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0], [1, 0], [1, 0], [1, 0]])
    hoisted.generateObject.mockResolvedValue({
      object: {
        decisions: [
          { expected_index: 0, candidate_index: 0, same: true, why: 'same work' },
          { expected_index: 1, candidate_index: 1, same: true, why: 'the banned one' },
        ],
      },
    })

    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([
        proposal(),
        proposal({ id: 'p2', display_text: 'Draft an email to the prospect' }),
        proposal({ id: 'p3', display_text: 'Something nobody asked for' }),
      ]),
      expected: {
        ...EXPECTED,
        forbidden_proposals: [{ key: 'no_email', gist: 'drafts an email to the prospect' }],
      },
    })

    const precision = checks.find((c) => c.check_key === 'proposal_precision')!
    expect(precision.outcome).toBe('fail')
    expect(precision.score).toBe(0.5)
    expect(
      (precision.evidence as { unexpected: Array<{ id: string }> }).unexpected.map((u) => u.id),
    ).toEqual(['p3'])
  })
})

describe('degradation', () => {
  it('falls back to a CONSERVATIVE cosine when the decider fails, and refuses a weak match', async () => {
    const [a, b] = vectorsWithCosine(0.7)
    hoisted.batchEmbed.mockResolvedValue([a, b])
    hoisted.generateObject.mockRejectedValue(new Error('gateway down'))

    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
    })
    expect(checks[0].outcome).toBe('fail')
    expect((checks[0].evidence as { match_method: string }).match_method).toBe('embedding_fallback')
  })

  it('accepts a STRONG cosine in the fallback', async () => {
    const [a, b] = vectorsWithCosine(0.95)
    hoisted.batchEmbed.mockResolvedValue([a, b])
    hoisted.generateObject.mockRejectedValue(new Error('gateway down'))

    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
    })
    expect(checks[0].outcome).toBe('pass')
    expect((checks[0].evidence as { match_method: string }).match_method).toBe('embedding_fallback')
  })

  it('still asks the decider when embeddings fail — a missing shortlist costs prompt size, not verdicts', async () => {
    hoisted.batchEmbed.mockRejectedValue(new Error('embeddings down'))
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'yes' }] },
    })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
    })
    expect(checks[0].outcome).toBe('pass')
    expect(hoisted.generateObject).toHaveBeenCalledTimes(1)
  })

  it('offers the decider EVERY proposal when embeddings fail, not just the first few', async () => {
    hoisted.batchEmbed.mockRejectedValue(new Error('embeddings down'))
    // The match is the 5th proposal: past any shortlist cut.
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 4, same: true, why: 'yes' }] },
    })
    const proposals = [1, 2, 3, 4, 5].map((n) => proposal({ id: `p${n}`, title: `Item ${n}`, display_text: `Item ${n}` }))
    const { checks } = await matchProposals(supabase, { workspaceId: WS, trace: trace(proposals), expected: EXPECTED })
    expect(String(hoisted.generateObject.mock.calls[0][0].prompt)).toContain('candidate_index=4')
    expect(checks[0].outcome).toBe('pass')
  })

  it('marks every expected item no_candidates — never a spurious call — when nothing was proposed', async () => {
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([]),
      expected: EXPECTED,
    })
    expect(checks[0].outcome).toBe('fail')
    expect((checks[0].evidence as { match_method: string }).match_method).toBe('no_candidates')
    expect(hoisted.batchEmbed).not.toHaveBeenCalled()
    expect(hoisted.generateObject).not.toHaveBeenCalled()
  })
})

describe('a truncated flush makes recall UNKNOWN, never a miss', () => {
  it('downgrades every recall and precision verdict', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [0, 1]])
    hoisted.generateObject.mockResolvedValue({ object: { decisions: [] } })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
      proposalsUnknown: true,
    })
    expect(checks.find((c) => c.check_key === 'proposal:send_questionnaire')!.outcome).toBe('unknown')
    expect(checks.find((c) => c.check_key === 'proposal_precision')!.outcome).toBe('unknown')
  })

  it('does NOT downgrade a forbidden check — a proposal that fired, fired', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0]])
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'yes' }] },
    })
    const { checks } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: { forbidden_proposals: [{ key: 'f', gist: 'forbidden thing' }] },
      proposalsUnknown: true,
    })
    expect(checks[0].outcome).toBe('fail')
  })
})

/**
 * DEFECT 3 — the matcher's decision call is grading spend too, and it was
 * discarded exactly the way the judges' was: the run's `cost_usd` reported only
 * the target model's call.
 */
describe('the decision call reports its Gateway cost', () => {
  it('returns the cost and tokens the decider billed', async () => {
    hoisted.batchEmbed.mockResolvedValue([[1, 0], [1, 0]])
    hoisted.generateObject.mockResolvedValue({
      object: { decisions: [{ expected_index: 0, candidate_index: 0, same: true, why: 'w' }] },
      usage: { inputTokens: 400, outputTokens: 30 },
      providerMetadata: { gateway: { marketCost: '0.0009' } },
    })

    const { usage } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
    })
    expect(usage.cost_usd).toBeCloseTo(0.0009, 8)
    expect(usage.tokens_in).toBe(400)
    expect(usage.tokens_out).toBe(30)
    expect(usage.calls).toBe(1)
  })

  it('charges nothing when there was no decision call to make', async () => {
    const { usage } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([]),
      expected: EXPECTED,
    })
    expect(usage).toEqual({ cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 })
    expect(hoisted.generateObject).not.toHaveBeenCalled()
  })

  it('charges nothing when the decider threw and the cosine fallback decided', async () => {
    hoisted.batchEmbed.mockResolvedValue(vectorsWithCosine(0.9))
    hoisted.generateObject.mockRejectedValue(new Error('502'))
    const { checks, usage } = await matchProposals(supabase, {
      workspaceId: WS,
      trace: trace([proposal()]),
      expected: EXPECTED,
    })
    expect(checks[0].evidence).toMatchObject({ match_method: 'embedding_fallback' })
    expect(usage.cost_usd).toBe(0)
    expect(usage.calls).toBe(0)
  })
})
