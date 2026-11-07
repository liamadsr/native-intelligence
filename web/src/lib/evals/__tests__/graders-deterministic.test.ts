import { describe, expect, it } from 'vitest'
import {
  gradeDeterministic,
  gradeDirectives,
  gradeGateRecorded,
  gradeStepCeiling,
  gradeSummaryWritten,
  gradeTools,
  hitStepCeiling,
} from '../graders/deterministic'
import { BATCH_STEP_CEILING, LIVE_STEP_CEILING } from '../run-trial'
import type { EvalTrace, FlushRecord, TraceProposal } from '../types'

function flush(overrides: Partial<FlushRecord> = {}): FlushRecord {
  return {
    index: 0,
    t_ms: 0,
    chars: 100,
    chunk_text: '[Dana]: we should send the questionnaire',
    response: { tool_calls: 0, tool_call_details: [], duration_ms: 1200 },
    nudges: [],
    ...overrides,
  }
}

function trace(overrides: Partial<EvalTrace> = {}): EvalTrace {
  return {
    mode: 'live',
    speed: 'instant',
    driver: 'server',
    flushes: [flush()],
    proposals_final: [],
    summary_final: null,
    summary_source: 'none',
    title_final: null,
    commitments: [],
    reads: [],
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, model: 'x' },
    ...overrides,
  }
}

function proposal(overrides: Partial<TraceProposal> = {}): TraceProposal {
  return {
    id: 'p1',
    entity_type: 'action',
    change_type: 'create',
    title: 'Send the questionnaire',
    display_text: 'Send Dana the security questionnaire',
    confidence: 0.9,
    status: 'pending',
    gate: { decision: 'stage', would_have_applied: false },
    ...overrides,
  }
}

const withCalls = (tools: string[]) =>
  trace({
    flushes: [
      flush({
        response: {
          tool_calls: tools.length,
          tool_call_details: tools.map((tool) => ({ tool, args: {} })),
          duration_ms: 900,
        },
      }),
    ],
  })

describe('gradeTools', () => {
  it('returns nothing when the case declares no tool expectations', () => {
    expect(gradeTools(trace(), {})).toEqual([])
  })

  it('passes must_call when the tool was called and fails when it was not', () => {
    const [hit] = gradeTools(withCalls(['propose_change']), { tools: { must_call: ['propose_change'] } })
    expect(hit.outcome).toBe('pass')
    const [miss] = gradeTools(withCalls([]), { tools: { must_call: ['propose_change'] } })
    expect(miss.outcome).toBe('fail')
    expect(miss.check_key).toBe('tool_called:propose_change')
  })

  it('makes an external must_not_call a GATE — the invariant-5 tools', () => {
    const [check] = gradeTools(withCalls(['propose_mcp_call']), {
      tools: { must_not_call: ['propose_mcp_call'] },
    })
    expect(check.outcome).toBe('fail')
    expect(check.severity).toBe('gate')
  })

  it('keeps an ordinary must_not_call soft', () => {
    const [check] = gradeTools(withCalls(['list_projects']), {
      tools: { must_not_call: ['list_projects'] },
    })
    expect(check.outcome).toBe('fail')
    expect(check.severity).toBe('soft')
  })

  it('counts calls across EVERY flush for max_calls, not just the last', () => {
    const t = trace({
      flushes: [
        flush({ response: { tool_calls: 2, tool_call_details: [{ tool: 'a', args: {} }, { tool: 'b', args: {} }], duration_ms: 1 } }),
        flush({ index: 1, response: { tool_calls: 2, tool_call_details: [{ tool: 'c', args: {} }, { tool: 'd', args: {} }], duration_ms: 1 } }),
      ],
    })
    const [check] = gradeTools(t, { tools: { max_calls: 3 } })
    expect(check.outcome).toBe('fail')
    expect(check.score).toBe(4)
    expect(check.threshold).toBe(3)
  })
})

describe('gradeSummaryWritten', () => {
  it('reads the TRACE, not captures.ai_summary — the safety net is skipped for evals', () => {
    // summary_final is set but no tool wrote it: the honest answer is "no".
    const check = gradeSummaryWritten(
      trace({ summary_final: 'a summary from somewhere', summary_source: 'none' }),
    )
    expect(check.outcome).toBe('fail')
  })

  it('passes when the model wrote one', () => {
    expect(gradeSummaryWritten(trace({ summary_source: 'model' })).outcome).toBe('pass')
  })

  it('is a GATE in batch and soft in live', () => {
    expect(gradeSummaryWritten(trace({ mode: 'batch' })).severity).toBe('gate')
    expect(gradeSummaryWritten(trace({ mode: 'live' })).severity).toBe('soft')
  })
})

describe('gradeGateRecorded — the isolation canary', () => {
  it('is ALWAYS a gate severity', () => {
    expect(gradeGateRecorded(trace()).severity).toBe('gate')
    expect(gradeGateRecorded(trace({ proposals_final: [proposal()] })).severity).toBe('gate')
  })

  it('passes with no proposals — nothing to gate is not a failure', () => {
    expect(gradeGateRecorded(trace({ proposals_final: [] })).outcome).toBe('pass')
  })

  it('FAILS when a proposal carries no gate object — the auto-apply block never ran', () => {
    const check = gradeGateRecorded(
      trace({ proposals_final: [proposal(), proposal({ id: 'p2', gate: undefined })] }),
    )
    expect(check.outcome).toBe('fail')
    expect((check.evidence as { missing_ids: string[] }).missing_ids).toEqual(['p2'])
  })

  it('records the counterfactual — which proposals WOULD have auto-applied', () => {
    const check = gradeGateRecorded(
      trace({
        proposals_final: [
          proposal({ id: 'a', gate: { decision: 'stage', would_have_applied: true } }),
          proposal({ id: 'b', gate: { decision: 'stage', would_have_applied: false } }),
        ],
      }),
    )
    expect(check.outcome).toBe('pass')
    expect((check.evidence as { would_have_applied_ids: string[] }).would_have_applied_ids).toEqual(['a'])
  })
})

describe('step ceiling', () => {
  it('needs BOTH a tool-calls finish and the ceiling — either alone is a normal turn', () => {
    expect(hitStepCeiling(flush({ finish_reason: 'stop', steps_used: LIVE_STEP_CEILING }), 'live')).toBe(false)
    expect(hitStepCeiling(flush({ finish_reason: 'tool-calls', steps_used: 5 }), 'live')).toBe(false)
    expect(hitStepCeiling(flush({ finish_reason: 'tool-calls', steps_used: LIVE_STEP_CEILING }), 'live')).toBe(true)
  })

  it('uses the mode’s own ceiling — 20 live, 50 batch', () => {
    const f = flush({ finish_reason: 'tool-calls', steps_used: LIVE_STEP_CEILING })
    expect(hitStepCeiling(f, 'live')).toBe(true)
    // The same 20 steps in batch is nowhere near its 50-step ceiling.
    expect(hitStepCeiling(f, 'batch')).toBe(false)
    expect(hitStepCeiling(flush({ finish_reason: 'tool-calls', steps_used: BATCH_STEP_CEILING }), 'batch')).toBe(true)
  })

  it('is a gate that names the truncated flushes', () => {
    const check = gradeStepCeiling(
      trace({
        flushes: [
          flush({ index: 0, finish_reason: 'stop', steps_used: 3 }),
          flush({ index: 1, finish_reason: 'tool-calls', steps_used: LIVE_STEP_CEILING }),
        ],
      }),
    )
    expect(check.outcome).toBe('fail')
    expect(check.severity).toBe('gate')
    expect((check.evidence as { truncated_indices: number[] }).truncated_indices).toEqual([1])
  })
})

describe('gradeDeterministic', () => {
  it('threads proposalsUnknown out when a flush was truncated', () => {
    const clean = gradeDeterministic(trace(), {})
    expect(clean.proposalsUnknown).toBe(false)

    const truncated = gradeDeterministic(
      trace({ flushes: [flush({ finish_reason: 'tool-calls', steps_used: LIVE_STEP_CEILING })] }),
      {},
    )
    expect(truncated.proposalsUnknown).toBe(true)
  })

  it('always emits gate_recorded and no_step_ceiling_hit, even for a case with no expectations', () => {
    const keys = gradeDeterministic(trace(), {}).checks.map((c) => c.check_key)
    expect(keys).toContain('gate_recorded')
    expect(keys).toContain('no_step_ceiling_hit')
    expect(keys).toContain('model_wrote_summary')
  })
})

/** The directive grader (live-agent messaging L5): did what the user asked
 *  the note-taker to record make it into the record. */
describe('gradeDirectives', () => {
  const BUDGET = { key: 'budget', text: 'Dana owns the budget', must_contain: ['Dana', 'budget'] }
  const injected = (status: 'pending' | 'consumed' | 'expired' | null = 'consumed') => ({
    key: 'budget',
    id: 'dir-1',
    text: 'Dana owns the budget',
    after_chunk: 0,
    status,
    consumed_session: status === 'consumed' ? 'sess-9' : null,
  })
  const proposal = (over: Partial<TraceProposal>): TraceProposal => ({
    id: 'p-1',
    entity_type: 'action',
    change_type: 'create',
    title: null,
    display_text: '',
    confidence: 0.9,
    status: 'pending',
    ...over,
  })

  it('passes when every phrase is in the summary, case and whitespace aside', () => {
    const [c] = gradeDirectives(
      trace({ summary_final: 'Agreed: DANA   owns the\nBudget for Q4.', directives: [injected()] }),
      // A phrase that spans the line break and the run of spaces, both ways round.
      { directives: [{ ...BUDGET, must_contain: ['Dana owns', 'owns  the budget'] }] },
    )
    expect(c).toMatchObject({
      dimension: 'summary',
      grader: 'directive_recorded',
      check_key: 'directive_recorded:budget',
      severity: 'soft',
      outcome: 'pass',
      score: 1,
    })
    expect(c.label).toBe('Records "Dana owns the budget"')
    expect(c.evidence).toMatchObject({ status: 'consumed', consumed_session: 'sess-9', missing: [] })
  })

  it('counts a proposal as the record too (a directive that is a commitment)', () => {
    const [c] = gradeDirectives(
      trace({
        summary_final: null,
        proposals_final: [proposal({ title: 'Dana to own the', display_text: 'budget review' })],
        directives: [injected()],
      }),
      { directives: [BUDGET] },
    )
    expect(c.outcome).toBe('pass')
  })

  it('fails with the phrases that are missing, and says why from the status', () => {
    const [read] = gradeDirectives(trace({ summary_final: 'Dana spoke.', directives: [injected('consumed')] }), {
      directives: [BUDGET],
    })
    expect(read).toMatchObject({ outcome: 'fail', score: 0.5 })
    expect(read.evidence).toMatchObject({ found: ['Dana'], missing: ['budget'] })
    expect(read.rationale).toContain('"budget"')
    expect(read.rationale).toContain('a record-writing turn read it')

    const [unread] = gradeDirectives(trace({ summary_final: null, directives: [injected('pending')] }), {
      directives: [BUDGET],
    })
    expect(unread.outcome).toBe('fail')
    expect(unread.rationale).toContain('no record-writing turn read it')

    const [unknownStatus] = gradeDirectives(trace({ summary_final: null, directives: [injected(null)] }), {
      directives: [BUDGET],
    })
    expect(unknownStatus.rationale).toContain('could not be read back')
  })

  it('a directive the trial never reached is unknown, not a miss', () => {
    const [c] = gradeDirectives(trace({ summary_final: 'Dana owns the budget', directives: [] }), {
      directives: [BUDGET],
    })
    expect(c.outcome).toBe('unknown')
  })

  it('takes the case severity, and truncates a long label', () => {
    const long = 'x'.repeat(80)
    const [c] = gradeDirectives(trace({ summary_final: long, directives: [{ ...injected(), text: long }] }), {
      directives: [{ ...BUDGET, text: long, must_contain: [long], severity: 'gate' }],
    })
    expect(c.severity).toBe('gate')
    expect(c.label).toBe(`Records "${'x'.repeat(57)}…"`)
  })

  it('no directives in the case: no checks, and gradeDeterministic includes them when there are', () => {
    expect(gradeDirectives(trace(), {})).toEqual([])
    const { checks } = gradeDeterministic(trace({ summary_final: 'Dana owns the budget', directives: [injected()] }), {
      directives: [BUDGET],
    })
    expect(checks.map((c) => c.check_key)).toContain('directive_recorded:budget')
  })
})
