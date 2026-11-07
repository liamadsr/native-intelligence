/**
 * Unit tests for the Evals route schemas.
 *
 * The route tests cover the status codes. This file covers the ONE property
 * that makes those status codes worth having: strictness. An `expected` block
 * is graded, not merely stored, so a key the schema silently drops becomes a
 * criterion that never fires — a case that passes because it expects nothing.
 * That failure is invisible in every screen, which is exactly why it is
 * asserted here rather than left to a route test to notice.
 */
import { describe, it, expect } from 'vitest'
import {
  CreateCaseFromCaptureSchema,
  CreateCaseSchema,
  CreateSuiteSchema,
  StartRunSchema,
  UpdateCaseSchema,
  UpdateSuiteSchema,
} from '../schemas'

const SCRIPT = [{ t_ms: 0, speaker: 'Ada', stream: 'mic' as const, text: 'Hi.' }]

describe('CreateSuiteSchema', () => {
  it('accepts the minimum a suite needs', () => {
    const parsed = CreateSuiteSchema.parse({ name: 'Sales Discovery', target_kind: 'agent' })
    expect(parsed).toEqual({ name: 'Sales Discovery', target_kind: 'agent' })
  })

  it('rejects an empty name, an unknown kind, and an unknown key', () => {
    expect(CreateSuiteSchema.safeParse({ name: '', target_kind: 'agent' }).success).toBe(false)
    expect(CreateSuiteSchema.safeParse({ name: 'X', target_kind: 'flow' }).success).toBe(false)
    expect(
      CreateSuiteSchema.safeParse({ name: 'X', target_kind: 'agent', nightly: true }).success,
    ).toBe(false)
  })

  it('accepts both suite kinds and no others', () => {
    for (const suite_kind of ['capability', 'regression']) {
      expect(CreateSuiteSchema.safeParse({ name: 'X', target_kind: 'agent', suite_kind }).success)
        .toBe(true)
    }
    expect(
      CreateSuiteSchema.safeParse({ name: 'X', target_kind: 'agent', suite_kind: 'smoke' }).success,
    ).toBe(false)
  })
})

describe('UpdateSuiteSchema', () => {
  it('accepts an empty patch — a toggle that raced should not 400', () => {
    expect(UpdateSuiteSchema.parse({})).toEqual({})
  })

  it('accepts an explicit null to clear judge_model', () => {
    expect(UpdateSuiteSchema.parse({ judge_model: null })).toEqual({ judge_model: null })
  })
})

describe('CreateCaseSchema', () => {
  it('defaults participants and expected so a bare script is enough', () => {
    const parsed = CreateCaseSchema.parse({ name: 'Stall on pricing', script: SCRIPT })
    expect(parsed.participants).toEqual([])
    expect(parsed.expected).toEqual({})
  })

  it('requires at least one script segment', () => {
    expect(CreateCaseSchema.safeParse({ name: 'X', script: [] }).success).toBe(false)
  })

  /**
   * `positionEvidenceHolds` grants the owner's position binding only for a mic
   * voice labeled exactly 'local_1', and `resolveSelfBinding` re-derives that
   * on every turn — so an is_self participant under any other label binds
   * nothing at all. The speaker map never resolves the owner, every
   * assignee-to-self expectation fails, and the case reads as an agent
   * regression rather than a mislabeled script. Rejected, not normalized:
   * rewriting the label would silently disagree with the script's speakers.
   */
  it("rejects an is_self participant that is not labeled 'local_1'", () => {
    const parsed = CreateCaseSchema.safeParse({
      name: 'X',
      script: SCRIPT,
      participants: [{ speaker_label: 'mic_a', display: 'Me', is_self: true }],
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts a self participant labeled 'local_1'", () => {
    expect(
      CreateCaseSchema.safeParse({
        name: 'X',
        script: SCRIPT,
        participants: [
          { speaker_label: 'local_1', display: 'Me', is_self: true },
          { speaker_label: 'remote_1', display: 'Dana' },
        ],
      }).success,
    ).toBe(true)
  })

  it('says nothing about a NON-self participant label', () => {
    expect(
      CreateCaseSchema.safeParse({
        name: 'X',
        script: SCRIPT,
        participants: [{ speaker_label: 'whoever', display: 'Dana' }],
      }).success,
    ).toBe(true)
  })

  it('applies the same rule to the PATCH body, so the two doors cannot drift', () => {
    expect(
      UpdateCaseSchema.safeParse({
        participants: [{ speaker_label: 'local_2', display: 'Me', is_self: true }],
      }).success,
    ).toBe(false)
  })

  it('pins the stream to mic or system — the split that drives chunk cadence', () => {
    for (const stream of ['mic', 'system']) {
      expect(
        CreateCaseSchema.safeParse({
          name: 'X',
          script: [{ t_ms: 0, speaker: 'A', stream, text: 'hi' }],
        }).success,
      ).toBe(true)
    }
    expect(
      CreateCaseSchema.safeParse({
        name: 'X',
        script: [{ t_ms: 0, speaker: 'A', stream: 'headset', text: 'hi' }],
      }).success,
    ).toBe(false)
  })

  it('rejects a negative or fractional t_ms', () => {
    expect(
      CreateCaseSchema.safeParse({
        name: 'X',
        script: [{ t_ms: -1, speaker: 'A', stream: 'mic', text: 'hi' }],
      }).success,
    ).toBe(false)
    expect(
      CreateCaseSchema.safeParse({
        name: 'X',
        script: [{ t_ms: 1.5, speaker: 'A', stream: 'mic', text: 'hi' }],
      }).success,
    ).toBe(false)
  })

  it('accepts a full expected block', () => {
    const expected = {
      proposals: [
        {
          key: 'send_questionnaire',
          entity_type: 'action',
          change_type: 'create',
          gist: 'Send Dana the security questionnaire',
          must_have: { assignee: 'self' },
          severity: 'gate' as const,
        },
      ],
      forbidden_proposals: [{ key: 'no_dana_owner', gist: 'Any commitment owned by Dana' }],
      nudges: [{ key: 'unanswered_q', after_chunk: 5, before_chunk: 8, about: 'the question' }],
      no_nudge_windows: [{ from_chunk: 0, to_chunk: 2 }],
      summary: 'Must state the prospect pushed back on price.',
      tool_usage: 'Should not call propose_mcp_call.',
      rubric: [{ key: 'no_outside_assignee', criterion: 'never assigns outside the meeting' }],
      answers: { which_project: 'The Northwind renewal' },
      tools: { must_call: ['propose_change'], must_not_call: ['propose_mcp_call'], max_calls: 12 },
    }
    const parsed = CreateCaseSchema.parse({ name: 'X', script: SCRIPT, expected })
    expect(parsed.expected).toEqual(expected)
  })

  it('rejects a MISSPELLED expected key rather than grading an empty expectation', () => {
    // The whole reason every schema here is strict. `proposal` (singular)
    // would be dropped, stored as `{}`, and the case would pass forever.
    expect(
      CreateCaseSchema.safeParse({ name: 'X', script: SCRIPT, expected: { proposal: [] } }).success,
    ).toBe(false)
    expect(
      CreateCaseSchema.safeParse({ name: 'X', script: SCRIPT, expected: { nudge: [] } }).success,
    ).toBe(false)
  })

  it('rejects an unknown severity and an expected item with no key', () => {
    expect(
      CreateCaseSchema.safeParse({
        name: 'X',
        script: SCRIPT,
        expected: { rubric: [{ key: 'k', criterion: 'c', severity: 'blocker' }] },
      }).success,
    ).toBe(false)
    expect(
      CreateCaseSchema.safeParse({
        name: 'X',
        script: SCRIPT,
        expected: { rubric: [{ criterion: 'c' }] },
      }).success,
    ).toBe(false)
  })

  it('rejects an empty modes array', () => {
    expect(CreateCaseSchema.safeParse({ name: 'X', script: SCRIPT, modes: [] }).success).toBe(false)
    expect(
      CreateCaseSchema.safeParse({ name: 'X', script: SCRIPT, modes: ['batch'] }).success,
    ).toBe(true)
  })
})

describe('expected.directives (live-agent messaging L5)', () => {
  const DIRECTIVE = { key: 'budget', text: 'Dana owns the budget', after_chunk: 2, must_contain: ['Dana'] }
  const parse = (directives: unknown[]) =>
    CreateCaseSchema.safeParse({ name: 'X', script: SCRIPT, expected: { directives } })

  it('accepts a directive, and the PATCH door does too', () => {
    expect(parse([DIRECTIVE]).success).toBe(true)
    expect(parse([{ key: 'b', text: 'T', must_contain: ['T'], severity: 'gate' }]).success).toBe(true)
    expect(UpdateCaseSchema.safeParse({ expected: { directives: [DIRECTIVE] } }).success).toBe(true)
  })

  it('refuses one that could only ever pass, or that the writer would refuse', () => {
    expect(parse([{ ...DIRECTIVE, must_contain: [] }]).success).toBe(false)
    expect(parse([{ ...DIRECTIVE, must_contain: ['  '] }]).success).toBe(false)
    expect(parse([{ ...DIRECTIVE, text: '   ' }]).success).toBe(false)
    expect(parse([{ ...DIRECTIVE, text: 'x'.repeat(501) }]).success).toBe(false)
    expect(parse([{ ...DIRECTIVE, after_chunk: -1 }]).success).toBe(false)
    expect(parse([{ ...DIRECTIVE, afterChunk: 2 }]).success).toBe(false)
  })
})

describe('UpdateCaseSchema', () => {
  it('accepts an empty patch and any single field', () => {
    expect(UpdateCaseSchema.parse({})).toEqual({})
    expect(UpdateCaseSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
    expect(UpdateCaseSchema.safeParse({ script: SCRIPT }).success).toBe(true)
  })

  it('applies the same strictness to expected on the PATCH door', () => {
    expect(UpdateCaseSchema.safeParse({ expected: { proposal: [] } }).success).toBe(false)
  })

  it('still refuses an empty script on an edit', () => {
    expect(UpdateCaseSchema.safeParse({ script: [] }).success).toBe(false)
  })
})

describe('StartRunSchema', () => {
  const SUITE_ID = '11111111-1111-4111-8111-111111111111'

  it('accepts a suite and a mode', () => {
    expect(StartRunSchema.parse({ suite_id: SUITE_ID, mode: 'live' })).toEqual({
      suite_id: SUITE_ID,
      mode: 'live',
    })
  })

  it('rejects a non-uuid suite_id — a run is expensive, an id typo should not queue one', () => {
    expect(StartRunSchema.safeParse({ suite_id: 'suite-1', mode: 'batch' }).success).toBe(false)
  })

  it('bounds trials_per_case at 10', () => {
    expect(StartRunSchema.safeParse({ suite_id: SUITE_ID, mode: 'batch', trials_per_case: 10 }).success)
      .toBe(true)
    expect(StartRunSchema.safeParse({ suite_id: SUITE_ID, mode: 'batch', trials_per_case: 11 }).success)
      .toBe(false)
    expect(StartRunSchema.safeParse({ suite_id: SUITE_ID, mode: 'batch', trials_per_case: 0 }).success)
      .toBe(false)
  })

  it('accepts each speed and rejects any other', () => {
    for (const speed of ['realtime', 'fast', 'instant']) {
      expect(StartRunSchema.safeParse({ suite_id: SUITE_ID, mode: 'live', speed }).success).toBe(true)
    }
    expect(
      StartRunSchema.safeParse({ suite_id: SUITE_ID, mode: 'live', speed: 'slow' }).success,
    ).toBe(false)
  })

  it('rejects an empty case_ids narrowing — it would silently run everything', () => {
    expect(StartRunSchema.safeParse({ suite_id: SUITE_ID, mode: 'batch', case_ids: [] }).success)
      .toBe(false)
  })
})

describe('expected: the sidekick nudge contract (goal, max_nudges, opening_brief)', () => {
  const parse = (expected: unknown) => CreateCaseSchema.safeParse({ name: 'X', script: SCRIPT, expected })

  it('accepts a goal, a nudge ceiling, an opening brief and a gated quiet window', () => {
    const parsed = parse({
      goal: '  Get to a signed pilot  ',
      max_nudges: 0,
      opening_brief: true,
      no_nudge_windows: [{ from_chunk: 0, to_chunk: 2, severity: 'gate' }],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.expected.goal).toBe('Get to a signed pilot')
  })

  it('refuses a goal past the meeting_goal limit, an empty goal, and a negative ceiling', () => {
    expect(parse({ goal: 'x'.repeat(501) }).success).toBe(false)
    expect(parse({ goal: '   ' }).success).toBe(false)
    expect(parse({ max_nudges: -1 }).success).toBe(false)
    expect(parse({ max_nudges: 1.5 }).success).toBe(false)
  })

  it('accepts a whole, non-negative max_nudge_lag_chunks (nudge_latency) and refuses anything else', () => {
    expect(parse({ max_nudge_lag_chunks: 0 }).success).toBe(true)
    expect(parse({ max_nudge_lag_chunks: 2 }).success).toBe(true)
    expect(parse({ max_nudge_lag_chunks: -1 }).success).toBe(false)
    expect(parse({ max_nudge_lag_chunks: 1.5 }).success).toBe(false)
    expect(parse({ max_nudge_lag_chunks: '1' }).success).toBe(false)
  })
})

describe('CreateCaseFromCaptureSchema', () => {
  it('takes a capture id and an optional name, nothing else', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(CreateCaseFromCaptureSchema.safeParse({ capture_id: id }).success).toBe(true)
    expect(CreateCaseFromCaptureSchema.safeParse({ capture_id: id, name: 'Acme replay' }).success).toBe(true)
    expect(CreateCaseFromCaptureSchema.safeParse({ capture_id: 'nope' }).success).toBe(false)
    expect(CreateCaseFromCaptureSchema.safeParse({ capture_id: id, expected: {} }).success).toBe(false)
  })
})

describe('expected.nudges windows', () => {
  const parse = (nudge: Record<string, unknown>) =>
    CreateCaseSchema.safeParse({ name: 'X', script: SCRIPT, expected: { nudges: [{ key: 'k', about: 'x', ...nudge }] } })

  it('accepts an inclusive window, a single chunk, and an open-ended one', () => {
    expect(parse({ after_chunk: 2, before_chunk: 5 }).success).toBe(true)
    expect(parse({ after_chunk: 3, before_chunk: 3 }).success).toBe(true)
    expect(parse({ after_chunk: 3 }).success).toBe(true)
    expect(parse({ before_chunk: 3 }).success).toBe(true)
  })

  it('refuses a window that ends before it starts', () => {
    const parsed = parse({ after_chunk: 5, before_chunk: 2 })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(['expected', 'nudges', 0, 'before_chunk'])
  })

  it('keeps the window strict about unknown keys', () => {
    expect(parse({ after: 1 }).success).toBe(false)
  })
})
