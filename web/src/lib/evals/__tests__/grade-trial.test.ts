import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type Captured, type FakeResult } from './fake-supabase'
import type { EvalCaseRow, EvalTrace, EvalTrialRow } from '../types'

const ZERO = { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 }

const hoisted = vi.hoisted(() => ({
  matchProposals: vi.fn(async () => ({
    checks: [],
    usage: { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 },
  })),
  runJudges: vi.fn(async () => ({
    checks: [],
    usage: { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 },
  })),
}))

vi.mock('../graders/match-proposals', () => ({ matchProposals: hoisted.matchProposals }))
vi.mock('../graders/judges', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../graders/judges')>()),
  runJudges: hoisted.runJudges,
}))

const { gradeTrial } = await import('../graders')

const WS = 'ws-1'

const TRACE: EvalTrace = {
  mode: 'batch',
  speed: 'instant',
  driver: 'server',
  flushes: [
    {
      index: 0,
      t_ms: 0,
      chars: 10,
      chunk_text: 'hello',
      response: { tool_calls: 0, tool_call_details: [], duration_ms: 100 },
      nudges: [],
    },
  ],
  proposals_final: [],
  summary_final: null,
  summary_source: 'none',
  title_final: null,
  commitments: [],
  reads: [],
  usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, model: 'm' },
}

const TRIAL = { id: 'trial-1', trace: TRACE } as EvalTrialRow
const CASE = {
  id: 'case-1',
  expected: {},
  script: [
    { t_ms: 0, stream: 'system', speaker: 'remote_1', text: 'Send me the questionnaire.' },
  ],
} as unknown as EvalCaseRow

function fixture(insert: FakeResult = { data: [{ id: 'check-1' }] }) {
  return makeFakeSupabase((q: Captured): FakeResult =>
    q.table === 'eval_check' && q.op === 'insert' ? insert : { data: null },
  )
}

beforeEach(() => {
  hoisted.matchProposals.mockReset()
  hoisted.runJudges.mockReset()
  hoisted.matchProposals.mockResolvedValue({ checks: [], usage: { ...ZERO } })
  hoisted.runJudges.mockResolvedValue({ checks: [], usage: { ...ZERO } })
})

describe('gradeTrial', () => {
  it('stamps trial_id and workspace_id on every row, so no grader can get scoping wrong', async () => {
    const { client, queries } = fixture()
    await gradeTrial(client, { trial: TRIAL, caseRow: CASE, judgeModel: null, workspaceId: WS })

    const rows = queries.find((q) => q.table === 'eval_check' && q.op === 'insert')!.payload as Array<
      Record<string, unknown>
    >
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.trial_id === 'trial-1' && r.workspace_id === WS)).toBe(true)
  })

  it('threads proposalsUnknown from the deterministic pass into the matcher', async () => {
    const truncated: EvalTrace = {
      ...TRACE,
      flushes: [{ ...TRACE.flushes[0], finish_reason: 'tool-calls', steps_used: 50 }],
    }
    const { client } = fixture()
    await gradeTrial(client, {
      trial: { ...TRIAL, trace: truncated },
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(hoisted.matchProposals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ proposalsUnknown: true }),
    )
  })

  it('passes the suite judge model through to the judges', async () => {
    const { client } = fixture()
    await gradeTrial(client, {
      trial: TRIAL,
      caseRow: CASE,
      judgeModel: 'anthropic/claude-haiku-4.5',
      workspaceId: WS,
    })
    expect(hoisted.runJudges).toHaveBeenCalledWith(
      expect.objectContaining({ judgeModel: 'anthropic/claude-haiku-4.5' }),
    )
  })

  it('grades NOTHING for a trial with no trace — an errored clone must not manufacture failures', async () => {
    const { client, queries } = fixture()
    const out = await gradeTrial(client, {
      trial: { ...TRIAL, trace: {} } as EvalTrialRow,
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(out.checks).toEqual([])
    expect(queries.some((q) => q.table === 'eval_check')).toBe(false)
    expect(hoisted.matchProposals).not.toHaveBeenCalled()
  })

  it('returns [] rather than throwing when the check insert fails — one Postgres hiccup must not re-bill a run', async () => {
    const { client } = fixture({ data: null, error: { message: 'insert denied' } })
    const out = await gradeTrial(client, {
      trial: TRIAL,
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(out.checks).toEqual([])
  })

  /**
   * DEFECT 2b — the judges saw an empty transcript on every batch trial, because
   * the only transcript they had was reconstructed from a flush log the batch
   * path left blank. `gradeTrial` now renders the case's own script and passes
   * it explicitly.
   */
  it('renders the case script and hands every judge an explicit transcript', async () => {
    const { client } = fixture()
    await gradeTrial(client, { trial: TRIAL, caseRow: CASE, judgeModel: null, workspaceId: WS })
    expect(hoisted.runJudges).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: '[remote_1]: Send me the questionnaire.' }),
    )
  })

  /**
   * DEFECT 3 — grading spend was generated and dropped on the floor. The DEV
   * run reported the target model's $0.000368 while three frontier judge calls
   * had run.
   */
  it('returns the judges\' and the matcher\'s cost summed', async () => {
    hoisted.runJudges.mockResolvedValue({
      checks: [],
      usage: { cost_usd: 0.0042, tokens_in: 900, tokens_out: 60, calls: 3 },
    })
    hoisted.matchProposals.mockResolvedValue({
      checks: [],
      usage: { cost_usd: 0.0009, tokens_in: 400, tokens_out: 30, calls: 1 },
    })

    const { client } = fixture()
    const { usage } = await gradeTrial(client, {
      trial: TRIAL,
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(usage.cost_usd).toBeCloseTo(0.0051, 8)
    expect(usage.tokens_in).toBe(1300)
    expect(usage.tokens_out).toBe(90)
    expect(usage.calls).toBe(4)
  })

  it('still reports the grading cost when the check insert fails — the money was spent either way', async () => {
    hoisted.runJudges.mockResolvedValue({
      checks: [],
      usage: { cost_usd: 0.002, tokens_in: 10, tokens_out: 1, calls: 1 },
    })
    const { client } = fixture({ data: null, error: { message: 'insert denied' } })
    const out = await gradeTrial(client, {
      trial: TRIAL,
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(out.checks).toEqual([])
    expect(out.usage.cost_usd).toBeCloseTo(0.002, 8)
  })
})

/**
 * DEFECT — an unstorable check set is not "no checks". `trialOutcomeFromChecks([])`
 * returns 'passed', so a trial whose gates actually failed would settle the run
 * green when the insert dropped the drafts that recorded it.
 */
describe('a check insert that fails is a HARNESS error, not a pass', () => {
  it('flags gradingFailed so the caller can stamp the trial errored', async () => {
    hoisted.matchProposals.mockResolvedValue({
      checks: [
        {
          dimension: 'proposals',
          grader: 'proposal_match',
          check_key: 'proposal:send_q',
          label: 'sends the questionnaire',
          severity: 'gate',
          outcome: 'fail',
          score: null,
          threshold: null,
          rationale: 'nothing matched',
          evidence: {},
          human_override: null,
          human_note: null,
        },
      ],
      usage: { ...ZERO },
    } as never)

    const { client } = fixture({ data: null, error: { message: 'insert denied' } })
    const out = await gradeTrial(client, {
      trial: TRIAL,
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(out.checks).toEqual([])
    expect(out.gradingFailed).toBe(true)
  })

  it('leaves the flag UNSET on the two legitimate empties, so they still pass', async () => {
    // No trace: the trial never ran, and nothing was computed to be dropped.
    const { client } = fixture()
    const noTrace = await gradeTrial(client, {
      trial: { ...TRIAL, trace: {} } as EvalTrialRow,
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(noTrace.gradingFailed).toBeUndefined()

    // A successful insert of real drafts.
    const ok = await gradeTrial(client, {
      trial: TRIAL,
      caseRow: CASE,
      judgeModel: null,
      workspaceId: WS,
    })
    expect(ok.gradingFailed).toBeUndefined()
  })
})
