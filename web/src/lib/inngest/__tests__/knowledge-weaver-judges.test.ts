/**
 * The knowledge weaver's bounded Jev judgments, with the existing structured
 * utility sessions retained for unresolved candidates:
 *   - the claim↔claim judge   → kind 'knowledge_weaver_judge'      (PairVerdicts)
 *   - the pooled anchor judge → kind 'knowledge_weaver_anchor_link' (AnchorVerdict)
 *
 * Pinned:
 *   - each task message is BYTE-IDENTICAL to the prompt the pre-port
 *     generateObject call sent (the system prompts' parity is pinned in the
 *     utility spec route tests);
 *   - the workspace's once-resolved knowledge model is passed through (no
 *     per-call settings read) and is what logUsage records;
 *   - usage rows keep their feature strings, durationMs 0 and metadata, and are
 *     written ONLY when the workspace has an owner — an unowned workspace's
 *     calls are still attributed to the workspace at the Gateway (userId null);
 *   - a judge failure throws to the caller, whose per-claim catch keeps it
 *     non-fatal (unchanged).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  runUtilityTask: vi.fn(),
  runDecision: vi.fn(),
  logUsage: vi.fn(async (..._a: unknown[]) => undefined),
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})) } }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.runUtilityTask }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: hoisted.runDecision }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: hoisted.logUsage }))

const { anchorJudgeMessage, pairJudgeMessage, runAnchorJudge, runPairJudge } = await import('../knowledge-weaver')

const CANDIDATES = [
  { claim_id: 'c-2', claim_text: 'Renewal price is $99.' },
  { claim_id: 'c-3', claim_text: 'Renewal closes in October.' },
]

const ANCHORS = [
  { entity_type: 'company', entity_id: 'co-1', name: 'Northwind', description: 'x'.repeat(500), similarity: 0.7 },
  { entity_type: 'project', entity_id: 'p-1', name: 'Q3 renewal', description: null, similarity: 0.6 },
]

function ok(object: unknown) {
  hoisted.runUtilityTask.mockResolvedValue({
    object,
    text: '',
    model: 'claude-sonnet-4-5-20250929',
    usage: { inputTokens: 210, outputTokens: 40, costUsd: null, steps: 1 },
  })
}

beforeEach(() => {
  hoisted.runUtilityTask.mockReset()
  hoisted.runDecision.mockReset().mockResolvedValue({ status: 'escalate', reason: 'uncertain' })
  hoisted.logUsage.mockClear()
})

describe('weaver judge messages — byte-identical to the pre-port prompts', () => {
  it('claim↔claim judge', () => {
    expect(pairJudgeMessage('Renewal price is $109.', CANDIDATES)).toBe(
      'NEW claim:\nRenewal price is $109.\n\nCANDIDATES:\n' +
        '- candidate_id c-2: Renewal price is $99.\n' +
        '- candidate_id c-3: Renewal closes in October.',
    )
  })

  it('anchor judge (descriptions capped at 400 chars, omitted when null)', () => {
    expect(anchorJudgeMessage('Northwind wants a discount.', ANCHORS)).toBe(
      'CLAIM:\nNorthwind wants a discount.\n\nCANDIDATE ANCHORS:\n' +
        `- [company] co-1: Northwind — ${'x'.repeat(400)}\n` +
        '- [project] p-1: Q3 renewal',
    )
  })
})

describe('runPairJudge', () => {
  it('one knowledge_weaver_judge session on the once-resolved model; usage logged for the owner', async () => {
    const verdicts = { verdicts: [{ candidate_id: 'c-2', relation: 'contradicts' }] }
    ok(verdicts)
    const out = await runPairJudge({
      ws: 'ws-1',
      knowledgeModel: 'claude-sonnet-4-5-20250929',
      ownerUserId: 'owner-1',
      claimText: 'Renewal price is $109.',
      candidates: CANDIDATES,
    })
    expect(out).toEqual(verdicts)

    const args = hoisted.runUtilityTask.mock.calls[0][0]
    expect(args).toMatchObject({
      kind: 'knowledge_weaver_judge',
      model: 'claude-sonnet-4-5-20250929',
      workspaceId: 'ws-1',
      userId: 'owner-1',
      message: pairJudgeMessage('Renewal price is $109.', CANDIDATES),
    })
    expect(args.supabase).toBeUndefined()
    expect(args.outputSchema.safeParse(verdicts).success).toBe(true)

    expect(hoisted.logUsage).toHaveBeenCalledWith('owner-1', {
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      feature: 'knowledge_weaver_judge',
      inputTokens: 210,
      outputTokens: 40,
      durationMs: 0,
      costUsd: undefined,
      metadata: { workspace_id: 'ws-1' },
    })
  })

  it('an unowned workspace: Gateway attribution only (userId null), no usage row', async () => {
    ok({ verdicts: [] })
    await runPairJudge({ ws: 'ws-1', knowledgeModel: 'deepseek-v4-flash', ownerUserId: undefined, claimText: 'x', candidates: CANDIDATES })
    expect(hoisted.runUtilityTask.mock.calls[0][0].userId).toBeNull()
    expect(hoisted.runDecision).not.toHaveBeenCalled()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('throws on a failed judge, logging nothing', async () => {
    hoisted.runUtilityTask.mockRejectedValue(new Error('[utility] knowledge_weaver_judge session failed'))
    await expect(
      runPairJudge({ ws: 'ws-1', knowledgeModel: 'm', ownerUserId: 'owner-1', claimText: 'x', candidates: CANDIDATES }),
    ).rejects.toThrow(/knowledge_weaver_judge/)
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })
})

describe('runAnchorJudge', () => {
  it('one knowledge_weaver_anchor_link session; usage metadata carries the phase fields', async () => {
    const verdict = { anchor_type: 'company', anchor_id: 'co-1' }
    ok(verdict)
    const out = await runAnchorJudge({
      ws: 'ws-1',
      knowledgeModel: 'claude-sonnet-4-5-20250929',
      ownerUserId: 'owner-1',
      claimText: 'Northwind wants a discount.',
      candidates: ANCHORS,
      usageMetadata: { phase: 'backfill' },
    })
    expect(out).toEqual(verdict)

    const args = hoisted.runUtilityTask.mock.calls[0][0]
    expect(args).toMatchObject({
      kind: 'knowledge_weaver_anchor_link',
      model: 'claude-sonnet-4-5-20250929',
      workspaceId: 'ws-1',
      userId: 'owner-1',
      message: anchorJudgeMessage('Northwind wants a discount.', ANCHORS),
    })
    expect(args.outputSchema.safeParse({ anchor_type: null, anchor_id: null }).success).toBe(true)

    expect(hoisted.logUsage).toHaveBeenCalledWith('owner-1', {
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      feature: 'knowledge_weaver_anchor_link',
      inputTokens: 210,
      outputTokens: 40,
      durationMs: 0,
      costUsd: undefined,
      metadata: { workspace_id: 'ws-1', phase: 'backfill' },
    })
  })

  it('an unowned workspace logs no usage', async () => {
    ok({ anchor_type: null, anchor_id: null })
    await runAnchorJudge({ ws: 'ws-1', knowledgeModel: 'm', ownerUserId: undefined, claimText: 'x', candidates: ANCHORS, usageMetadata: {} })
    expect(hoisted.runDecision).not.toHaveBeenCalled()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })
})

describe('Jev judgments avoid generation only for accepted, valid candidate decisions', () => {
  const pairArgs = { ws: 'ws-1', knowledgeModel: 'm', ownerUserId: 'owner-1', claimId: 'new-claim', claimText: 'Renewal price is $109.', candidates: CANDIDATES }
  const anchorArgs = { ...pairArgs, candidates: ANCHORS, usageMetadata: { phase: 'backfill' } }
  const accepted = (value: unknown) => ({ status: 'accepted', value })
  const fiveCandidates = Array.from({ length: 5 }, (_, index) => ({ claim_id: `c-${index}`, claim_text: `Claim ${index}` }))
  const verdicts = (candidates: typeof CANDIDATES, relation = 'related_to') => ({
    verdicts: candidates.map(candidate => ({ candidate_id: candidate.claim_id, relation })),
  })

  it.each([
    { anchor_type: 'company', anchor_id: 'co-1' },
    { anchor_type: null, anchor_id: null },
  ])('returns an accepted anchor choice without utility generation or duplicate usage logging: %j', async value => {
    hoisted.runDecision.mockResolvedValue(accepted(value))
    expect(await runAnchorJudge(anchorArgs)).toEqual(value)
    expect(hoisted.runDecision).toHaveBeenCalledWith('knowledge.anchor', {
      claimText: pairArgs.claimText,
      candidates: ANCHORS.map(({ entity_type, entity_id, name, description }) => ({ entity_type, entity_id, name, description: description?.slice(0, 400) ?? null })),
    }, { userId: 'owner-1', workspaceId: 'ws-1', runId: 'new-claim' })
    expect(hoisted.runUtilityTask).not.toHaveBeenCalled()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'escalate', reason: 'not_authorized' },
    { status: 'escalate', reason: 'accounting_unavailable' },
    { status: 'cancelled', reason: 'caller_cancelled' },
    accepted({ anchor_type: 'project', anchor_id: 'co-1' }),
    accepted({ anchor_type: null, anchor_id: 'co-1' }),
    accepted({ anchor_type: 'company', anchor_id: 'not-offered' }),
  ])('keeps the existing anchor judge for unavailable or invalid choices: %j', async decision => {
    hoisted.runDecision.mockResolvedValue(decision)
    ok({ anchor_type: 'project', anchor_id: 'p-1' })
    expect(await runAnchorJudge(anchorArgs)).toEqual({ anchor_type: 'project', anchor_id: 'p-1' })
    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(1)
  })

  it('falls back when the shared decision service throws', async () => {
    hoisted.runDecision.mockRejectedValue(new Error('decision unavailable'))
    ok({ anchor_type: null, anchor_id: null })
    expect(await runAnchorJudge(anchorArgs)).toEqual({ anchor_type: null, anchor_id: null })
    ok(verdicts(CANDIDATES))
    expect(await runPairJudge(pairArgs)).toEqual(verdicts(CANDIDATES))
  })

  it('evaluates five pairs as two serial batches within the four-question limit', async () => {
    let inFlight = 0
    hoisted.runDecision.mockImplementation(async (_kind, input) => {
      inFlight += 1
      expect(inFlight).toBe(1)
      expect(input.candidates.length).toBeLessThanOrEqual(4)
      await Promise.resolve()
      inFlight -= 1
      return accepted(verdicts(input.candidates))
    })
    expect(await runPairJudge({ ...pairArgs, candidates: fiveCandidates })).toEqual(verdicts(fiveCandidates))
    expect(hoisted.runDecision.mock.calls.map(call => call[1].candidates.length)).toEqual([4, 1])
    expect(hoisted.runDecision.mock.calls[0][2]).toEqual({ userId: 'owner-1', workspaceId: 'ws-1', runId: 'new-claim' })
    expect(hoisted.runUtilityTask).not.toHaveBeenCalled()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('generates only unresolved pairs and prevents that fallback from overruling accepted pairs', async () => {
    hoisted.runDecision.mockResolvedValueOnce(accepted(verdicts(fiveCandidates.slice(0, 4))))
    ok({ verdicts: [
      { candidate_id: 'c-4', relation: 'none' },
      { candidate_id: 'c-0', relation: 'duplicate' },
      { candidate_id: 'not-offered', relation: 'contradicts' },
    ] })
    const result = await runPairJudge({ ...pairArgs, candidates: fiveCandidates })
    expect(result).toEqual({ verdicts: [...verdicts(fiveCandidates.slice(0, 4)).verdicts, { candidate_id: 'c-4', relation: 'none' }] })
    expect(hoisted.runUtilityTask.mock.calls[0][0].message).toBe(pairJudgeMessage(pairArgs.claimText, [fiveCandidates[4]]))
    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(1)
    expect(hoisted.logUsage).toHaveBeenCalledTimes(1)
  })

  it.each([
    { verdicts: [{ candidate_id: 'c-2', relation: 'related_to' }] },
    { verdicts: [{ candidate_id: 'c-2', relation: 'related_to' }, { candidate_id: 'c-2', relation: 'none' }] },
    { verdicts: [{ candidate_id: 'c-2', relation: 'related_to' }, { candidate_id: 'invented', relation: 'none' }] },
    { verdicts: [{ candidate_id: 'c-2', relation: 'bogus' }, { candidate_id: 'c-3', relation: 'none' }] },
  ])('does not accept a partial, duplicate, invented or invalid batch: %j', async value => {
    hoisted.runDecision.mockResolvedValue(accepted(value))
    ok(verdicts(CANDIDATES, 'none'))
    expect(await runPairJudge(pairArgs)).toEqual(verdicts(CANDIDATES, 'none'))
    expect(hoisted.runUtilityTask.mock.calls[0][0].message).toBe(pairJudgeMessage(pairArgs.claimText, CANDIDATES))
  })

  it('retains a valid accepted batch when generation of the unresolved batch fails', async () => {
    hoisted.runDecision.mockResolvedValueOnce(accepted(verdicts(fiveCandidates.slice(0, 4))))
    hoisted.runUtilityTask.mockRejectedValue(new Error('utility failed'))
    expect(await runPairJudge({ ...pairArgs, candidates: fiveCandidates })).toEqual(verdicts(fiveCandidates.slice(0, 4)))
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('does not create unbounded decision fanout for more candidates than the existing weaver cap', async () => {
    const candidates = [...fiveCandidates, { claim_id: 'c-5', claim_text: 'Extra' }]
    ok(verdicts(candidates))
    expect(await runPairJudge({ ...pairArgs, candidates })).toEqual(verdicts(candidates))
    expect(hoisted.runDecision).not.toHaveBeenCalled()
    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(1)
  })
})
