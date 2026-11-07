import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvalTrace } from '../types'

const hoisted = vi.hoisted(() => ({ generateObject: vi.fn(), runUtilityTask: vi.fn() }))
vi.mock('ai', () => ({ generateObject: hoisted.generateObject }))
vi.mock('@/lib/ai/gateway', () => ({ aiModel: (s: string) => s }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.runUtilityTask }))

const {
  DEFAULT_JUDGE_MODEL_ID,
  judgeProposalQuality,
  judgeRubric,
  judgeSummary,
  judgeToolUsage,
  resolveJudgeModel,
  runJudges,
} = await import('../graders/judges')

function trace(overrides: Partial<EvalTrace> = {}): EvalTrace {
  return {
    mode: 'batch',
    speed: 'instant',
    driver: 'server',
    flushes: [
      {
        index: 0,
        t_ms: 0,
        chars: 40,
        chunk_text: '[Dana]: can you send the questionnaire?',
        response: { tool_calls: 1, tool_call_details: [{ tool: 'propose_change', args: {} }], duration_ms: 900 },
        nudges: [],
      },
    ],
    proposals_final: [
      {
        id: 'p1',
        entity_type: 'action',
        change_type: 'create',
        title: 'Send the questionnaire',
        display_text: 'Send Dana the security questionnaire',
        confidence: 0.9,
        status: 'pending',
        assignee_name: 'Liam',
        gate: { decision: 'stage', would_have_applied: true },
      },
    ],
    summary_final: 'Dana asked for the security questionnaire.',
    summary_source: 'model',
    title_final: 'Dana sync',
    commitments: [],
    reads: [],
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, model: 'x' },
    ...overrides,
  }
}

const verdict = (outcome: 'pass' | 'fail' | 'unknown') => ({
  object: { rationale: 'because', outcome, evidence_quote: 'quote' },
})

/** A verdict that also reports what the Gateway billed, the way a real
 *  `generateObject` result does. */
const pricedVerdict = (cost: string, tokens = { inputTokens: 900, outputTokens: 60 }) => ({
  object: { rationale: 'because', outcome: 'pass' as const, evidence_quote: 'quote' },
  usage: tokens,
  providerMetadata: { gateway: { marketCost: cost } },
})

beforeEach(() => {
  hoisted.generateObject.mockReset()
  hoisted.runUtilityTask.mockReset()
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key')
})

describe('resolveJudgeModel — never a hand-built provider/id string', () => {
  it('defaults to a frontier Anthropic model resolved through the catalog', () => {
    expect(resolveJudgeModel(null)).toBe('anthropic/claude-sonnet-4.5')
    expect(DEFAULT_JUDGE_MODEL_ID).toBe('claude-sonnet-4-5-20250929')
  })

  it('passes a suite-set slug through untouched when it already has a provider', () => {
    expect(resolveJudgeModel('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('the verdict schema puts rationale before outcome', () => {
  it('emits the model rationale as the check rationale and the quote as evidence', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('pass'))
    const { checks: [check] } = await judgeSummary({
      trace: trace(),
      expected: { summary: 'Must mention the questionnaire.' },
      judgeModel: null,
    })
    expect(check.outcome).toBe('pass')
    expect(check.rationale).toBe('because')
    expect(check.evidence).toEqual({ evidence_quote: 'quote' })

    // Rule 1 is structural: the schema's own key order is what makes the model
    // stream its reasoning before it commits.
    const schema = hoisted.generateObject.mock.calls[0][0].schema
    expect(Object.keys(schema.shape)).toEqual(['rationale', 'outcome', 'evidence_quote'])
  })

  it('keeps `unknown` as a first-class verdict rather than coercing it', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('unknown'))
    const { checks: [check] } = await judgeSummary({
      trace: trace(),
      expected: { summary: 'Anything.' },
      judgeModel: null,
    })
    expect(check.outcome).toBe('unknown')
  })
})

describe('judgeSummary', () => {
  it('emits nothing when the case states no summary expectation', async () => {
    expect(
      (await judgeSummary({ trace: trace(), expected: {}, judgeModel: null })).checks,
    ).toEqual([])
    expect(hoisted.generateObject).not.toHaveBeenCalled()
  })

  it('SKIPS — never fails — when the model never wrote a summary', async () => {
    const { checks: [check] } = await judgeSummary({
      trace: trace({ summary_source: 'none', summary_final: null }),
      expected: { summary: 'Must mention the questionnaire.' },
      judgeModel: null,
    })
    expect(check.outcome).toBe('skipped')
    expect(hoisted.generateObject).not.toHaveBeenCalled()
    // "stopped summarizing" and "summarizes badly" must not score the same.
    expect(check.rationale).toContain('nothing to judge')
  })
})

describe('missing credentials degrade to skipped, never to a fail or a crash', () => {
  beforeEach(() => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
  })

  it('skips every judge without spending a call', async () => {
    const { checks } = await runJudges({
      trace: trace(),
      expected: {
        summary: 'x',
        tool_usage: 'y',
        rubric: [{ key: 'r1', criterion: 'z' }],
      },
      judgeModel: null,
    })
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.every((c) => c.outcome === 'skipped')).toBe(true)
    expect(hoisted.generateObject).not.toHaveBeenCalled()
  })
})

describe('a failed judge call is skipped, not failed', () => {
  it('never turns a gateway outage into a regression', async () => {
    hoisted.generateObject.mockRejectedValue(new Error('502'))
    const { checks: [check] } = await judgeSummary({
      trace: trace(),
      expected: { summary: 'x' },
      judgeModel: null,
    })
    expect(check.outcome).toBe('skipped')
    expect(check.outcome).not.toBe('fail')
  })
})

describe('judgeProposalQuality', () => {
  it('skips when nothing was proposed — there is no extraction to judge', async () => {
    const { checks: [check] } = await judgeProposalQuality({
      trace: trace({ proposals_final: [] }),
      judgeModel: null,
    })
    expect(check.outcome).toBe('skipped')
    expect(hoisted.generateObject).not.toHaveBeenCalled()
  })

  it('judges the items against the TRANSCRIPT, not against the expected list', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('fail'))
    const { checks: [check] } = await judgeProposalQuality({ trace: trace(), judgeModel: null })
    expect(check.outcome).toBe('fail')
    const prompt = hoisted.generateObject.mock.calls[0][0].prompt as string
    expect(prompt).toContain('TRANSCRIPT')
    expect(prompt).toContain('Send Dana the security questionnaire')
  })
})

describe('judgeRubric — ONE call per criterion', () => {
  it('does not batch criteria into a single anchoring call', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('pass'))
    const { checks } = await judgeRubric({
      trace: trace(),
      expected: {
        rubric: [
          { key: 'a', criterion: 'never proposes for an outsider', severity: 'gate' },
          { key: 'b', criterion: 'stays quiet when nothing is said' },
        ],
      },
      judgeModel: null,
    })
    expect(hoisted.generateObject).toHaveBeenCalledTimes(2)
    expect(checks.map((c) => c.check_key)).toEqual(['rubric:a', 'rubric:b'])
    expect(checks[0].severity).toBe('gate')
    expect(checks[1].severity).toBe('soft')
  })

  it('emits nothing when the case carries no rubric', async () => {
    expect(
      (await judgeRubric({ trace: trace(), expected: {}, judgeModel: null })).checks,
    ).toEqual([])
  })
})

describe('judgeToolUsage', () => {
  it('shows the judge the tool names in order and nothing else', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('pass'))
    await judgeToolUsage({
      trace: trace(),
      expected: { tool_usage: 'Should not draft an email.' },
      judgeModel: null,
    })
    const prompt = hoisted.generateObject.mock.calls[0][0].prompt as string
    expect(prompt).toContain('propose_change')
    expect(prompt).toContain('Should not draft an email.')
  })
})

describe('runJudges', () => {
  it('emits one check per dimension the case actually asks about', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('pass'))
    const { checks } = await runJudges({
      trace: trace(),
      expected: { summary: 'x', rubric: [{ key: 'r', criterion: 'c' }] },
      judgeModel: null,
    })
    const keys = checks.map((c) => c.check_key).sort()
    // proposal quality always runs (there are proposals); tool_usage does not
    // (the case does not state one).
    expect(keys).toEqual(['judge_proposal_quality', 'judge_summary', 'rubric:r'])
  })
})

/**
 * DEFECT 2b — a batch trial's judges saw nothing.
 *
 * `transcriptOf(trace)` joins the flush log's `chunk_text`, and the batch path
 * built its one flush with an EMPTY one (the route reads the transcript
 * server-side). On DEV that made judge_summary and judge_proposal_quality both
 * return `unknown` with rationales saying no transcript was provided. The fix
 * is two-sided: the batch flush now carries the text (run-trial.test.ts), and
 * a judge prefers an explicitly passed transcript over the flush log.
 */
describe('the judges read an explicit transcript when one is passed', () => {
  const emptyFlushBatchTrace = () =>
    trace({
      flushes: [
        {
          index: 0,
          t_ms: 0,
          chars: 0,
          chunk_text: '',
          response: { tool_calls: 0, tool_call_details: [], duration_ms: 10 },
          nudges: [],
        },
      ],
    })

  it('judgeSummary falls back to the flush log only when no transcript is given', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('pass'))
    await judgeSummary({
      trace: emptyFlushBatchTrace(),
      expected: { summary: 'x' },
      judgeModel: null,
      transcript: '[Dana]: we need the security questionnaire by Friday.',
    })
    const prompt = hoisted.generateObject.mock.calls[0][0].prompt as string
    expect(prompt).toContain('we need the security questionnaire by Friday')
    // The empty-flush trace would have produced a bare "TRANSCRIPT:" header.
    expect(prompt).not.toMatch(/TRANSCRIPT:\n\n/)
  })

  it('runJudges threads the transcript into every judge that reads one', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('pass'))
    await runJudges({
      trace: emptyFlushBatchTrace(),
      expected: { summary: 'x', rubric: [{ key: 'r', criterion: 'c' }] },
      judgeModel: null,
      transcript: '[Dana]: send the questionnaire.',
    })
    const prompts = hoisted.generateObject.mock.calls.map((c) => c[0].prompt as string)
    // summary, proposal quality, rubric — every prompt that carries a
    // TRANSCRIPT section carries a NON-EMPTY one.
    const withTranscript = prompts.filter((p) => p.includes('TRANSCRIPT:'))
    expect(withTranscript.length).toBe(3)
    expect(withTranscript.every((p) => p.includes('send the questionnaire.'))).toBe(true)
  })

  it('still reconstructs from the flush log when no transcript is passed', async () => {
    hoisted.generateObject.mockResolvedValue(verdict('pass'))
    await judgeSummary({ trace: trace(), expected: { summary: 'x' }, judgeModel: null })
    const prompt = hoisted.generateObject.mock.calls[0][0].prompt as string
    expect(prompt).toContain('can you send the questionnaire?')
  })
})

/**
 * DEFECT 3 — judge cost was generated and discarded.
 *
 * The DEV run reported $0.000368 (the DeepSeek target call) while three
 * frontier judge calls had run. Spec §6.4: judge cost is billed to the run.
 */
describe('judge cost is read off the Gateway and summed', () => {
  it('reports one call\'s cost and tokens', async () => {
    hoisted.generateObject.mockResolvedValue(pricedVerdict('0.0042'))
    const { usage } = await judgeSummary({
      trace: trace(),
      expected: { summary: 'x' },
      judgeModel: null,
    })
    expect(usage.cost_usd).toBeCloseTo(0.0042, 8)
    expect(usage.tokens_in).toBe(900)
    expect(usage.tokens_out).toBe(60)
    expect(usage.calls).toBe(1)
  })

  it('sums every judge call across runJudges', async () => {
    hoisted.generateObject.mockResolvedValue(pricedVerdict('0.001'))
    const { usage } = await runJudges({
      trace: trace(),
      expected: {
        summary: 'x',
        tool_usage: 'y',
        rubric: [{ key: 'a', criterion: 'c1' }, { key: 'b', criterion: 'c2' }],
      },
      judgeModel: null,
    })
    // summary + proposal quality + tool usage + two rubric criteria.
    expect(usage.calls).toBe(5)
    expect(usage.cost_usd).toBeCloseTo(0.005, 8)
  })

  it('falls back to a zero cost but KEEPS the tokens when the Gateway reports none', async () => {
    hoisted.generateObject.mockResolvedValue({
      object: { rationale: 'r', outcome: 'pass', evidence_quote: 'q' },
      usage: { inputTokens: 120, outputTokens: 8 },
      providerMetadata: {},
    })
    const { usage } = await judgeSummary({
      trace: trace(),
      expected: { summary: 'x' },
      judgeModel: null,
    })
    expect(usage.cost_usd).toBe(0)
    expect(usage.tokens_in).toBe(120)
    expect(usage.tokens_out).toBe(8)
  })

  it('charges nothing for a judge call that failed or was skipped', async () => {
    hoisted.generateObject.mockRejectedValue(new Error('502'))
    const failed = await judgeSummary({
      trace: trace(),
      expected: { summary: 'x' },
      judgeModel: null,
    })
    expect(failed.usage).toEqual({ cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 })

    const skippedResult = await judgeSummary({
      trace: trace({ summary_source: 'none', summary_final: null }),
      expected: { summary: 'x' },
      judgeModel: null,
    })
    expect(skippedResult.usage.calls).toBe(0)
  })
})

describe("on the run starter's own ChatGPT plan", () => {
  const plan = { userId: 'u-free', workspaceId: 'ws-1' }

  it('every judge runs on the plan (eval_judge, its main model), never the Gateway, at no cost', async () => {
    hoisted.runUtilityTask.mockResolvedValue({
      text: '', model: 'chatgpt-plan/gpt-6.1-sol',
      usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
      object: { rationale: 'because', outcome: 'pass', evidence_quote: 'quote' },
    })
    // No Gateway credentials at all: a plan judge doesn't need them.
    vi.stubEnv('AI_GATEWAY_API_KEY', '')
    const { checks, usage } = await runJudges({
      trace: trace(), plan, judgeModel: null,
      expected: {
        summary: 'Must mention the questionnaire.',
        tool_usage: 'Proposes the follow-up.',
        rubric: [{ key: 'r1', criterion: 'Names the owner.' }, { key: 'r2', criterion: 'Names the date.' }],
      } as never,
    })
    // Summary, proposal quality, tool usage and both rubric items: five judge calls, all on the plan.
    expect(hoisted.runUtilityTask.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(hoisted.generateObject).not.toHaveBeenCalled()
    expect(hoisted.runUtilityTask).toHaveBeenCalled()
    for (const [args] of hoisted.runUtilityTask.mock.calls as Array<[Record<string, unknown>]>) {
      expect(args).toMatchObject({ kind: 'eval_judge', chatgptPlan: true, planModel: 'gpt-6.1-sol', userId: 'u-free', workspaceId: 'ws-1' })
      expect(String(args.message)).toMatch(/^## Your instructions/)
    }
    expect(checks.filter((c) => c.outcome === 'pass').length).toBeGreaterThan(0)
    expect(usage.cost_usd).toBe(0)
    expect(usage.tokens_in).toBeGreaterThan(0)
  })

  it('a failed plan judge is skipped, never a fail', async () => {
    hoisted.runUtilityTask.mockRejectedValue(new Error('[utility] eval_judge session failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { checks: [check] } = await judgeSummary({ trace: trace(), plan, expected: { summary: 'x' }, judgeModel: null })
    expect(check.outcome).toBe('skipped')
    warn.mockRestore()
  })
})
