/**
 * The Evals run lane.
 *
 * The createFunction-capture pattern (canonical: prospecting-functions.test.ts):
 * `inngest.createFunction` is mocked so the config and handler are captured, and
 * the handler is invoked directly with `createStepMock()`.
 *
 * `createStepMock()` IS MANDATORY. Its AsyncLocalStorage tripwire is the only
 * thing that catches a `step.*` call made from inside a `step.run` callback —
 * which does not throw in production, it HANGS for minutes having done nothing
 * (the hubspot-push-sweep incident). This lane runs a step per trial inside a
 * loop, which is exactly the shape that invites the mistake, so every test here
 * goes through that mock and the tripwire is armed on every path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'
import type { EvalCaseRow } from '@/lib/evals/types'

type Handler = (ctx: unknown) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  registrations: [] as Array<{ config: Record<string, unknown>; handler: Handler }>,
  runTrial: vi.fn(),
  gradeTrial: vi.fn(),
  mintRunToken: vi.fn(async () => ({ token: 'd8d_run', tokenId: 'token-1' })),
  revokeRunToken: vi.fn(async () => {}),
  latestCompletedRun: vi.fn(async () => null),
  supabase: { from: vi.fn() },
  stepEvalWork: vi.fn(async () => {}),
  settleEvalWorkFromRow: vi.fn(async () => {}),
  onPlan: vi.fn(async (..._a: unknown[]) => false),
}))
// Whether the run's starter runs on their own ChatGPT plan (src/lib/chatgpt/plan-route.ts).
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: hoisted.onPlan }))

vi.mock('@/lib/inngest/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/inngest/client')>('@/lib/inngest/client')
  return {
    ...actual,
    inngest: {
      createFunction: (config: Record<string, unknown>, handler: Handler) => {
        hoisted.registrations.push({ config, handler })
        return { id: config.id }
      },
      send: vi.fn(),
    },
  }
})

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.supabase }))
// The run's Activity row (Sequence row 6); the mirror's own suite covers what
// it writes. Here: the lane steps it per trial and settles it from EVERY
// terminal write site.
vi.mock('@/lib/work/eval-run-mirror', () => ({
  stepEvalWork: hoisted.stepEvalWork,
  settleEvalWorkFromRow: hoisted.settleEvalWorkFromRow,
}))
vi.mock('@/lib/evals/graders', () => ({ gradeTrial: hoisted.gradeTrial }))
vi.mock('@/lib/evals/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/evals/queries')>()),
  latestCompletedRun: hoisted.latestCompletedRun,
}))
vi.mock('@/lib/evals/run-trial', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/evals/run-trial')>()),
  runTrial: hoisted.runTrial,
  mintRunToken: hoisted.mintRunToken,
  revokeRunToken: hoisted.revokeRunToken,
}))

const { EVAL_CONCURRENCY } = await import('@/lib/inngest/eval-functions')
const { LiveAgentHttpError } = await import('@/lib/evals/run-trial')
const { EVAL_RUN_REQUESTED } = await import('@/lib/evals/start-run')

const registration = () => {
  const found = hoisted.registrations.find((r) => r.config.id === 'eval-run-requested')
  if (!found) throw new Error('eval-run-requested was never registered')
  return found
}

const EVENT = { data: { run_id: 'run-1', workspace_id: 'ws-1' } }

const CASE: EvalCaseRow = {
  id: 'case-1',
  suite_id: 'suite-1',
  workspace_id: 'ws-1',
  name: 'Discovery call',
  capture_id: 'template-1',
  capture_is_eval: true,
  script: [],
  chunks: [],
  expected: {},
  modes: ['batch'],
  polarity: 'positive',
  seeded_from_capture_id: null,
  visibility: 'workspace',
  created_by: null,
  sort_order: 0,
  created_at: '2026-09-08T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
}

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: unknown
  filters: Array<{ method: string; args: unknown[] }>
}

interface Fixture {
  claim?: unknown[]
  cases?: EvalCaseRow[]
  /** Status the between-trial gate reads, per iteration. */
  gateStatus?: string[]
  monthRuns?: Array<{ cost_usd: number }>
  trialRow?: unknown
  /** The eval_trial INSERT resolves with no row (a CHECK violation, an FK not
   *  yet visible) while the driver itself succeeded. */
  trialInsertError?: { message: string }
  /** A person's cancel lands after the last between-trial gate: the settle's
   *  live-only write matches nothing and the run is already `cancelled`. */
  cancelledDuringLastTrial?: boolean
}

function fakeSupabase(f: Fixture = {}) {
  const recorded: Recorded[] = []
  let gateReads = 0

  hoisted.supabase.from = vi.fn((table: string) => {
    const rec: Recorded = { table, op: 'select', filters: [] }
    recorded.push(rec)
    const b: Record<string, unknown> = {}
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        rec.filters.push({ method: name, args })
        return b
      }

    const settle = async () => {
      if (rec.table === 'eval_run') {
        if (rec.op === 'update') {
          const selectsBack = rec.filters.some((x) => x.method === 'select')
          // The settle's two writes select back too: the live-only status write
          // (filtered `in status`) and the results-only write after a cancel.
          const isSettle = selectsBack && (rec.payload as { status?: string })?.status !== 'running'
          if (isSettle) {
            const liveOnly = rec.filters.some((x) => x.method === 'in')
            const matches = liveOnly ? !f.cancelledDuringLastTrial : Boolean(f.cancelledDuringLastTrial)
            return { data: matches ? [{ id: 'run-1' }] : [], error: null }
          }
          // The claim.
          if (selectsBack) {
            return {
              data: f.claim ?? [
                {
                  id: 'run-1',
                  suite_id: 'suite-1',
                  mode: 'batch',
                  speed: 'instant',
                  trials_per_case: 1,
                  target_recipe_id: 'recipe-1',
                  target_prompt_hash: 'hash-1',
                  target_model: 'deepseek-v4-flash',
                  max_cost_usd: 1,
                  progress: { case_ids: ['case-1'] },
                  started_by: 'user-1',
                  started_at: new Date().toISOString(),
                },
              ],
              error: null,
            }
          }
          return { data: null, error: null }
        }
        // Two reads: the gate's status probe (maybeSingle) and the month sum.
        const isMonth = rec.filters.some((x) => x.method === 'gte')
        if (isMonth) return { data: f.monthRuns ?? [], error: null }
        const status = f.gateStatus?.[gateReads++] ?? 'running'
        return { data: { status }, error: null }
      }
      if (rec.table === 'eval_suite') {
        return { data: { judge_model: 'claude-haiku-4-5-20251001', target_recipe_id: 'recipe-1' }, error: null }
      }
      if (rec.table === 'eval_case') return { data: f.cases ?? [CASE], error: null }
      if (rec.table === 'eval_trial') {
        if (rec.op === 'insert' && f.trialInsertError) {
          return { data: null, error: f.trialInsertError }
        }
        return { data: f.trialRow ?? { id: 'trial-1', trace: { flushes: [] } }, error: null }
      }
      return { data: null, error: null }
    }

    Object.assign(b, {
      select: chain('select'),
      insert: (p: unknown) => {
        rec.op = 'insert'
        rec.payload = p
        return b
      },
      update: (p: unknown) => {
        rec.op = 'update'
        rec.payload = p
        return b
      },
      eq: chain('eq'),
      in: chain('in'),
      gte: chain('gte'),
      order: chain('order'),
      limit: chain('limit'),
      maybeSingle: settle,
      single: settle,
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => settle().then(ok, err),
    })
    return b
  })

  return recorded
}

const okTrial = (cost = 0.01) => ({
  captureId: 'clone-1',
  durationMs: 1000,
  trace: {
    mode: 'batch',
    speed: 'instant',
    driver: 'server',
    flushes: [{ index: 0, t_ms: 0, chars: 1, chunk_text: '', response: { tool_calls: 0, tool_call_details: [], duration_ms: 1 }, nudges: [] }],
    proposals_final: [],
    summary_final: null,
    summary_source: 'none',
    title_final: null,
    commitments: [],
    reads: [],
    usage: { tokens_in: 100, tokens_out: 10, cost_usd: cost, model: 'm' },
  },
})

const run = (step = createStepMock()) => registration().handler({ event: EVENT, step })

const runUpdates = (recorded: Recorded[]) =>
  recorded.filter((r) => r.table === 'eval_run' && r.op === 'update')

/** The final settle write — the last eval_run update that carries a status. */
const settleUpdate = (recorded: Recorded[]) =>
  [...runUpdates(recorded)]
    .reverse()
    .find((r) => (r.payload as { status?: string })?.status !== 'running')!.payload as Record<
    string,
    unknown
  >

beforeEach(() => {
  hoisted.runTrial.mockReset()
  hoisted.gradeTrial.mockReset()
  hoisted.revokeRunToken.mockClear()
  hoisted.mintRunToken.mockClear()
  hoisted.latestCompletedRun.mockClear()
  hoisted.stepEvalWork.mockClear()
  hoisted.settleEvalWorkFromRow.mockClear()
  hoisted.onPlan.mockReset().mockResolvedValue(false)
  hoisted.runTrial.mockResolvedValue(okTrial())
  hoisted.gradeTrial.mockResolvedValue({
    checks: [{ dimension: 'proposals', severity: 'gate', outcome: 'pass' }],
    usage: { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 },
  })
})

describe('registration', () => {
  it('registers on eval/run.requested with one run in flight per workspace', () => {
    const { config } = registration()
    expect(config.id).toBe('eval-run-requested')
    expect(config.triggers).toEqual([{ event: EVAL_RUN_REQUESTED }])
    // ONE run per workspace, not four: two concurrent runs would race the
    // monthly cap check, each reading a spend total neither had written.
    expect(config.concurrency).toEqual([{ limit: 1, key: 'event.data.workspace_id' }])
    expect(EVAL_CONCURRENCY).toBe(1)
  })
})

describe('the claim', () => {
  it('exits idempotently when the row is no longer claimable', async () => {
    fakeSupabase({ claim: [] })
    expect(await run()).toEqual({ skipped: 'not_claimable', runId: 'run-1' })
    expect(hoisted.runTrial).not.toHaveBeenCalled()
    // Nothing was minted, so nothing needs revoking.
    expect(hoisted.mintRunToken).not.toHaveBeenCalled()
    // Another attempt owns the run, and its Activity row.
    expect(hoisted.stepEvalWork).not.toHaveBeenCalled()
    expect(hoisted.settleEvalWorkFromRow).not.toHaveBeenCalled()
  })

  it('accepts a row already at running — a retried attempt finds its own row', async () => {
    const recorded = fakeSupabase()
    await run()
    const claim = runUpdates(recorded)[0]
    expect(claim.filters.find((f) => f.method === 'in')!.args[1]).toEqual(['queued', 'running'])
  })

  it('ignores an event with missing ids rather than claiming something', async () => {
    fakeSupabase()
    const out = await registration().handler({ event: { data: {} }, step: createStepMock() })
    expect(out).toEqual({ skipped: 'missing_ids' })
  })

  it('fails the run when it has no starting user — no trial could authenticate', async () => {
    const recorded = fakeSupabase({
      claim: [{ id: 'run-1', suite_id: 's', mode: 'batch', speed: 'instant', trials_per_case: 1, target_recipe_id: null, target_prompt_hash: 'h', target_model: null, max_cost_usd: 1, progress: {}, started_by: null, started_at: new Date().toISOString() }],
    })
    const out = await run()
    expect(out).toMatchObject({ status: 'failed', error: 'no_run_starter' })
    expect(settleUpdate(recorded).error_code).toBe('no_run_starter')
    // failRun settles the Activity row from the row it just wrote.
    expect(hoisted.settleEvalWorkFromRow).toHaveBeenCalledWith(hoisted.supabase, 'run-1')
  })

  it("grades on the starter's own ChatGPT plan when they're on it (never Dial8's judges)", async () => {
    fakeSupabase()
    hoisted.onPlan.mockResolvedValue(true)
    await run()
    expect(hoisted.onPlan).toHaveBeenCalledWith(expect.any(String), { attempts: 2, failClosed: true })
    expect(hoisted.gradeTrial).toHaveBeenCalled()
    for (const call of hoisted.gradeTrial.mock.calls as unknown as Array<[unknown, { plan?: unknown; workspaceId: string }]>) {
      expect(call[1].plan).toEqual({ userId: expect.any(String), workspaceId: call[1].workspaceId })
    }
  })

  it('a paid starter is graded as before, with no plan', async () => {
    fakeSupabase()
    await run()
    expect(hoisted.gradeTrial).toHaveBeenCalled()
    for (const call of hoisted.gradeTrial.mock.calls as unknown as Array<[unknown, { plan?: unknown }]>) expect(call[1].plan).toBeUndefined()
  })

  it('a plan check that cannot be read never runs a trial or a judge, and settles the run (never left running)', async () => {
    const recorded = fakeSupabase()
    hoisted.onPlan.mockRejectedValue(new Error('ChatGPT plan check failed: db down'))
    expect(await run()).toMatchObject({ status: 'failed', error: 'usage_unavailable' })
    expect(settleUpdate(recorded).error_code).toBe('usage_unavailable')
    expect(hoisted.runTrial).not.toHaveBeenCalled()
    expect(hoisted.gradeTrial).not.toHaveBeenCalled()
  })

  it('a plan run priced at $0 (a $0 ceiling) completes every trial: on the plan they cost Dial8 nothing', async () => {
    fakeSupabase({
      claim: [
        {
          id: 'run-1', suite_id: 'suite-1', mode: 'batch', speed: 'instant', trials_per_case: 3,
          target_recipe_id: 'recipe-1', target_prompt_hash: 'h', target_model: null, max_cost_usd: 0,
          progress: { case_ids: ['case-1'] }, started_by: 'user-1', started_at: new Date().toISOString(),
        },
      ],
    })
    hoisted.onPlan.mockResolvedValue(true)
    hoisted.runTrial.mockResolvedValue(okTrial(0))
    await run()
    expect(hoisted.runTrial).toHaveBeenCalledTimes(3)
    expect(hoisted.gradeTrial).toHaveBeenCalledTimes(3)
  })
})

describe('the plan', () => {
  it('executes exactly the case_ids the run was PRICED for, never a re-query', async () => {
    const recorded = fakeSupabase()
    await run()
    const caseQuery = recorded.find((r) => r.table === 'eval_case')!
    expect(caseQuery.filters.find((f) => f.method === 'in')!.args).toEqual(['id', ['case-1']])
  })

  // Defense in depth behind startEvalRun: a private case is creator-only, and
  // this run's trials and checks are readable by every member.
  it("skips another member's PRIVATE case, and runs the starter's own", async () => {
    const recorded = fakeSupabase({
      cases: [
        CASE,
        { ...CASE, id: 'theirs-private', visibility: 'private', created_by: 'someone-else' },
        { ...CASE, id: 'mine-private', visibility: 'private', created_by: 'user-1' },
      ],
    })
    await run()
    const caseQuery = recorded.find((r) => r.table === 'eval_case')!
    expect(String(caseQuery.filters.find((f) => f.method === 'select')?.args[0] ?? '')).toContain('created_by')
    const ran = hoisted.runTrial.mock.calls.map((c) => (c[1] as { caseRow: EvalCaseRow }).caseRow.id)
    expect(ran).toEqual(['case-1', 'mine-private'])
  })

  it('fails as no_cases when every case is another member\'s private one', async () => {
    fakeSupabase({ cases: [{ ...CASE, visibility: 'private', created_by: 'someone-else' }] })
    expect(await run()).toMatchObject({ status: 'failed', error: 'no_cases' })
    expect(hoisted.runTrial).not.toHaveBeenCalled()
  })

  it('fails when the run has no cases at all', async () => {
    const recorded = fakeSupabase({ cases: [] })
    expect(await run()).toMatchObject({ status: 'failed', error: 'no_cases' })
    expect(settleUpdate(recorded).error_code).toBe('no_cases')
  })

  it('runs trials_per_case attempts of every case', async () => {
    fakeSupabase({
      claim: [
        {
          id: 'run-1', suite_id: 'suite-1', mode: 'batch', speed: 'instant', trials_per_case: 3,
          target_recipe_id: 'recipe-1', target_prompt_hash: 'h', target_model: null, max_cost_usd: 10,
          progress: { case_ids: ['case-1'] }, started_by: 'user-1', started_at: new Date().toISOString(),
        },
      ],
    })
    await run()
    expect(hoisted.runTrial).toHaveBeenCalledTimes(3)
    // trial_index distinguishes the attempts.
    expect(hoisted.runTrial.mock.calls.length).toBe(3)
  })
})

describe('the token', () => {
  it('mints ONE for the whole run and revokes it even when a trial throws', async () => {
    fakeSupabase()
    hoisted.runTrial.mockRejectedValue(new Error('boom'))
    await expect(run()).rejects.toThrow('boom')
    expect(hoisted.mintRunToken).toHaveBeenCalledTimes(1)
    expect(hoisted.revokeRunToken).toHaveBeenCalledWith(expect.anything(), 'token-1')
  })

  it('revokes it on the happy path too', async () => {
    fakeSupabase()
    await run()
    expect(hoisted.revokeRunToken).toHaveBeenCalledTimes(1)
  })
})

describe('trials', () => {
  it('stores and grades a completed trial, then stamps its outcome', async () => {
    const recorded = fakeSupabase()
    await run()
    const insert = recorded.find((r) => r.table === 'eval_trial' && r.op === 'insert')!
      .payload as Record<string, unknown>
    expect(insert).toMatchObject({ run_id: 'run-1', case_id: 'case-1', status: 'completed', capture_is_eval: true })
    expect(hoisted.gradeTrial).toHaveBeenCalledTimes(1)
    const outcomeUpdate = recorded.find((r) => r.table === 'eval_trial' && r.op === 'update')!
    expect((outcomeUpdate.payload as { outcome: string }).outcome).toBe('passed')
  })

  it('passes the SUITE judge model to the grader', async () => {
    fakeSupabase()
    await run()
    expect(hoisted.gradeTrial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ judgeModel: 'claude-haiku-4-5-20251001' }),
    )
  })

  it('stores an ERRORED trial without grading it — a harness failure is not a regression', async () => {
    const recorded = fakeSupabase()
    hoisted.runTrial.mockResolvedValue({ ...okTrial(), errorCode: 'empty_transcript', errorMessage: 'skipped' })
    const out = await run()

    const insert = recorded.find((r) => r.table === 'eval_trial' && r.op === 'insert')!
      .payload as Record<string, unknown>
    expect(insert.status).toBe('errored')
    expect(insert.outcome).toBe('errored')
    expect(insert.error_code).toBe('empty_transcript')
    expect(hoisted.gradeTrial).not.toHaveBeenCalled()
    // And the run does not claim to have passed while a case never ran.
    expect(out).toMatchObject({ status: 'completed' })
    expect(settleUpdate(recorded).outcome).toBe('failed')
  })

  it('writes progress and accumulated spend after EVERY trial', async () => {
    const recorded = fakeSupabase({
      claim: [
        { id: 'run-1', suite_id: 'suite-1', mode: 'batch', speed: 'instant', trials_per_case: 2, target_recipe_id: null, target_prompt_hash: 'h', target_model: null, max_cost_usd: 10, progress: { case_ids: ['case-1'] }, started_by: 'user-1', started_at: new Date().toISOString() },
      ],
    })
    hoisted.runTrial.mockResolvedValue(okTrial(0.02))
    await run()

    // The AFTER-trial write is the one that carries spend; the BEFORE-trial
    // stage write moves only the stage (see the DEFECT 4 test below).
    const progressWrites = runUpdates(recorded).filter(
      (r) =>
        (r.payload as { cost_usd?: number })?.cost_usd !== undefined &&
        (r.payload as { status?: string }).status === undefined,
    )
    expect(progressWrites).toHaveLength(2)
    expect((progressWrites[0].payload as { progress: { trials_done: number }; cost_usd: number }).progress.trials_done).toBe(1)
    expect((progressWrites[1].payload as { cost_usd: number }).cost_usd).toBeCloseTo(0.04, 6)
  })

  /**
   * DEFECT 4 — a one-case run read 'queued' the whole time it was running.
   * `start-run` writes 'queued', and the only other stage write happened AFTER
   * a trial finished, so nothing moved the rail while the trial was in flight.
   */
  it('writes the trial stage BEFORE running the trial, not only after', async () => {
    const recorded = fakeSupabase()
    hoisted.runTrial.mockImplementation(async () => {
      // Everything written up to this point is what a viewer would see WHILE
      // the trial runs.
      const stagesSoFar = runUpdates(recorded)
        .map((r) => (r.payload as { progress?: { stage?: string } })?.progress?.stage)
        .filter(Boolean)
      expect(stagesSoFar).toContain('trial 1 of 1')
      return okTrial()
    })
    await run()

    // The pre-trial write moves the stage without claiming the trial is done.
    const preTrial = runUpdates(recorded).find(
      (r) =>
        (r.payload as { progress?: { stage?: string } })?.progress?.stage === 'trial 1 of 1' &&
        (r.payload as { progress?: { trials_done?: number } })?.progress?.trials_done === 0,
    )
    expect(preTrial).toBeDefined()
    expect((preTrial!.payload as { cost_usd?: number }).cost_usd).toBeUndefined()

    // And the after-write still moves trials_done, so the count never rewinds.
    const postTrial = runUpdates(recorded).find(
      (r) => (r.payload as { progress?: { trials_done?: number } })?.progress?.trials_done === 1,
    )
    expect(postTrial).toBeDefined()
  })

  /**
   * DEFECT 3 — the judges' and matcher's spend never reached the run. The DEV
   * run reported the DeepSeek target call's $0.000368 while three frontier
   * judge calls had run.
   */
  it('adds the grading cost to the trial AND to the run total', async () => {
    const recorded = fakeSupabase()
    hoisted.runTrial.mockResolvedValue(okTrial(0.01))
    hoisted.gradeTrial.mockResolvedValue({
      checks: [{ dimension: 'proposals', severity: 'gate', outcome: 'pass' }],
      usage: { cost_usd: 0.005, tokens_in: 900, tokens_out: 60, calls: 3 },
    })
    await run()

    // The trial's own row absorbs it, with the breakdown on the trace.
    const trialUpdate = recorded.find((r) => r.table === 'eval_trial' && r.op === 'update')!
      .payload as {
      cost_usd: number
      tokens_in: number
      trace: { usage: { grading_cost_usd: number; cost_usd: number } }
    }
    expect(trialUpdate.cost_usd).toBeCloseTo(0.015, 8)
    expect(trialUpdate.tokens_in).toBe(1000)
    expect(trialUpdate.trace.usage.grading_cost_usd).toBeCloseTo(0.005, 8)
    // The target model's own cost stays readable next to it.
    expect(trialUpdate.trace.usage.cost_usd).toBeCloseTo(0.01, 8)

    // And the RUN's accumulator — the same number the budget checks read.
    expect(settleUpdate(recorded).cost_usd).toBeCloseTo(0.015, 8)
  })
})

describe('the three ways a run stops early', () => {
  it('BUDGET: cancels with error_code budget when spend crosses max_cost_usd', async () => {
    const recorded = fakeSupabase({
      claim: [
        { id: 'run-1', suite_id: 'suite-1', mode: 'batch', speed: 'instant', trials_per_case: 3, target_recipe_id: null, target_prompt_hash: 'h', target_model: null, max_cost_usd: 0.015, progress: { case_ids: ['case-1'] }, started_by: 'user-1', started_at: new Date().toISOString() },
      ],
    })
    hoisted.runTrial.mockResolvedValue(okTrial(0.02))
    const out = await run()

    // The first trial runs, its spend crosses the ceiling, the second is refused.
    expect(hoisted.runTrial).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ status: 'stopped', stopped: 'budget' })
    const settle = settleUpdate(recorded)
    expect(settle.status).toBe('cancelled')
    expect(settle.error_code).toBe('budget')
    // The completed trial's score survives — a stopped sweep is still readable.
    expect(settle.outcome).toBe('passed')
  })

  it('BUDGET: also stops on the workspace MONTHLY cap', async () => {
    const recorded = fakeSupabase({ monthRuns: [{ cost_usd: 500 }] })
    const out = await run()
    expect(hoisted.runTrial).not.toHaveBeenCalled()
    expect(out).toMatchObject({ stopped: 'budget' })
    expect(settleUpdate(recorded).error_code).toBe('budget')
  })

  it('USAGE WALL: a 429 fails the RUN with usage_limit and no retry', async () => {
    const recorded = fakeSupabase()
    hoisted.runTrial.mockRejectedValue(new LiveAgentHttpError(429, 'Usage limit exceeded'))
    // Thrown as NonRetriableError AFTER the row is settled.
    await expect(run()).rejects.toThrow(/usage wall/i)
    const settle = settleUpdate(recorded)
    expect(settle.status).toBe('failed')
    expect(settle.error_code).toBe('usage_limit')
  })

  it('USAGE WALL: a 503 is the same wall', async () => {
    const recorded = fakeSupabase()
    hoisted.runTrial.mockRejectedValue(new LiveAgentHttpError(503, 'Usage check unavailable'))
    await expect(run()).rejects.toThrow(/usage wall/i)
    expect(settleUpdate(recorded).error_code).toBe('usage_limit')
  })

  it('a NON-wall HTTP error is a real failure, not a usage wall', async () => {
    const recorded = fakeSupabase()
    hoisted.runTrial.mockRejectedValue(new LiveAgentHttpError(400, 'bad request'))
    await expect(run()).rejects.toThrow(/bad request/)
    // `harness_error`, not `usage_limit` — a 400 is the harness, not the plan.
    const settle = settleUpdate(recorded)
    expect(settle.status).toBe('failed')
    expect(settle.error_code).toBe('harness_error')
  })

  it('CANCELLED: a status written outside the handler stops the loop with partial results', async () => {
    const recorded = fakeSupabase({
      claim: [
        { id: 'run-1', suite_id: 'suite-1', mode: 'batch', speed: 'instant', trials_per_case: 3, target_recipe_id: null, target_prompt_hash: 'h', target_model: null, max_cost_usd: 10, progress: { case_ids: ['case-1'] }, started_by: 'user-1', started_at: new Date().toISOString() },
      ],
      gateStatus: ['running', 'cancelled'],
    })
    const out = await run()
    expect(hoisted.runTrial).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ stopped: 'cancelled' })
    expect(settleUpdate(recorded).status).toBe('cancelled')
  })
})

describe('settling', () => {
  it('resolves the baseline EXCLUDING this run’s own prompt hash', async () => {
    fakeSupabase()
    await run()
    expect(hoisted.latestCompletedRun).toHaveBeenCalledWith(
      expect.anything(),
      'suite-1',
      'batch',
      'hash-1',
    )
  })

  it('writes the completed status, outcome, scores, spend and duration', async () => {
    const recorded = fakeSupabase()
    hoisted.latestCompletedRun.mockResolvedValue({ id: 'baseline-1' } as never)
    await run()
    const settle = settleUpdate(recorded)
    expect(settle).toMatchObject({ status: 'completed', outcome: 'passed', baseline_run_id: 'baseline-1' })
    expect((settle.scores as Record<string, { rate: number }>).proposals.rate).toBe(1)
    expect(settle.duration_ms).toBeGreaterThanOrEqual(0)
    expect(settle.cost_usd).toBeCloseTo(0.01, 6)
  })

  it('steps the Activity row at the claim and after every trial, then settles it once from the stored row', async () => {
    fakeSupabase({
      claim: [
        {
          id: 'run-1', suite_id: 'suite-1', mode: 'batch', speed: 'instant', trials_per_case: 2,
          target_recipe_id: 'recipe-1', target_prompt_hash: 'hash-1', target_model: null, max_cost_usd: 1,
          progress: { case_ids: ['case-1'], trials_total: 2, trials_done: 0 }, started_by: 'user-1',
          started_at: new Date().toISOString(),
        },
      ],
    })
    await run()
    expect(hoisted.stepEvalWork.mock.calls).toEqual([
      [hoisted.supabase, 'run-1', 'Running 2 trials', { done: 0, total: 2 }],
      [hoisted.supabase, 'run-1', 'Trial 1 of 2 done', { done: 1, total: 2 }],
      [hoisted.supabase, 'run-1', 'Trial 2 of 2 done', { done: 2, total: 2 }],
    ])
    expect(hoisted.settleEvalWorkFromRow).toHaveBeenCalledTimes(1)
    expect(hoisted.settleEvalWorkFromRow).toHaveBeenCalledWith(hoisted.supabase, 'run-1')
    // After the last step — a settle is never followed by a step that reopens nothing.
    expect(hoisted.settleEvalWorkFromRow.mock.invocationCallOrder[0]).toBeGreaterThan(
      hoisted.stepEvalWork.mock.invocationCallOrder.at(-1)!,
    )
  })

  it('a claim with no priced total steps without numbers rather than "Running 0 trials"', async () => {
    fakeSupabase()
    await run()
    expect(hoisted.stepEvalWork.mock.calls[0]).toEqual([hoisted.supabase, 'run-1', 'Running trials', undefined])
  })

  it('moves the status only off a LIVE run', async () => {
    const recorded = fakeSupabase()
    await run()
    const write = runUpdates(recorded).find((r) => (r.payload as { status?: string })?.status === 'completed')!
    expect(write.filters).toContainEqual({ method: 'in', args: ['status', ['queued', 'running']] })
    // It won, so there is no results-only write after a cancel.
    const afterCancel = runUpdates(recorded).filter((r) =>
      r.filters.some((x) => x.method === 'eq' && x.args[0] === 'status' && x.args[1] === 'cancelled'),
    )
    expect(afterCancel).toHaveLength(0)
    expect(hoisted.settleEvalWorkFromRow).toHaveBeenCalledTimes(1)
  })

  it('a cancel that landed during the last trial stays cancelled, and the spend still lands', async () => {
    const recorded = fakeSupabase({ cancelledDuringLastTrial: true })
    const out = await run()
    // The run reads as stopped by the cancel, not completed.
    expect(out).toMatchObject({ status: 'stopped', stopped: 'cancelled' })

    const updates = runUpdates(recorded)
    const liveOnly = updates.find((r) => (r.payload as { status?: string })?.status === 'completed')!
    const after = updates[updates.length - 1]
    expect(after).not.toBe(liveOnly)
    // Only the measured results — never the status, the reason or the end time
    // the cancel wrote.
    const payload = after.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('error_code')
    expect(payload).not.toHaveProperty('error_message')
    expect(payload).not.toHaveProperty('ended_at')
    expect(payload.cost_usd).toBeCloseTo(0.01, 6)
    expect(payload).toMatchObject({ outcome: 'passed', progress: { trials_done: 1, stage: 'cancelled' } })
    expect(after.filters).toContainEqual({ method: 'eq', args: ['status', 'cancelled'] })
    // The ledger mirrors the stored row once, after both writes.
    expect(hoisted.settleEvalWorkFromRow).toHaveBeenCalledTimes(1)
  })

  it('rolls a soft failure up to scored, not failed', async () => {
    const recorded = fakeSupabase()
    hoisted.gradeTrial.mockResolvedValue({
      checks: [
        { dimension: 'proposals', severity: 'gate', outcome: 'pass' },
        { dimension: 'summary', severity: 'soft', outcome: 'fail' },
      ],
      usage: { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 },
    })
    await run()
    expect(settleUpdate(recorded).outcome).toBe('scored')
  })

  it('rolls a gate failure up to failed', async () => {
    const recorded = fakeSupabase()
    hoisted.gradeTrial.mockResolvedValue({
      checks: [{ dimension: 'gate', severity: 'gate', outcome: 'fail' }],
      usage: { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 },
    })
    await run()
    expect(settleUpdate(recorded).outcome).toBe('failed')
  })
})

describe('step discipline', () => {
  it('never calls a step tool from inside a step.run callback', async () => {
    // The tripwire lives in createStepMock: a nested call throws, and every
    // path in this file runs through it. Asserting the happy path completes is
    // asserting the tripwire never fired.
    fakeSupabase()
    const step = createStepMock()
    await expect(run(step)).resolves.toMatchObject({ status: 'completed' })
    expect(step.run.mock.calls.length).toBeGreaterThan(3)
  })

  it('names every step distinctly per trial so Inngest memoizes them apart', async () => {
    fakeSupabase({
      claim: [
        { id: 'run-1', suite_id: 'suite-1', mode: 'batch', speed: 'instant', trials_per_case: 2, target_recipe_id: null, target_prompt_hash: 'h', target_model: null, max_cost_usd: 10, progress: { case_ids: ['case-1'] }, started_by: 'user-1', started_at: new Date().toISOString() },
      ],
    })
    const step = createStepMock()
    await run(step)
    const ids = step.run.mock.calls.map((c) => c[0] as string)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('trial-0')
    expect(ids).toContain('trial-1')
  })
})

describe('a throw that is not the usage wall', () => {
  it('SETTLES the run failed rather than leaving it running forever', async () => {
    // `idx_eval_run_one_live` is a partial unique index on (suite_id, mode) for
    // queued|running, so a run abandoned at 'running' is adopted by every later
    // start of that suite+mode — the suite becomes unrunnable in that mode.
    const recorded = fakeSupabase()
    hoisted.runTrial.mockRejectedValue(new Error('clone blew up'))

    await expect(run()).rejects.toThrow(/clone blew up/)

    const fail = runUpdates(recorded).find(
      (r) => (r.payload as { status?: string })?.status === 'failed',
    )!
    expect(fail.payload).toMatchObject({ status: 'failed', error_code: 'harness_error' })
    expect((fail.payload as { error_message: string }).error_message).toContain('clone blew up')
    // Filtered so it can never clobber a status the handler already settled.
    expect(fail.filters.find((x) => x.method === 'in')!.args).toEqual([
      'status',
      ['queued', 'running'],
    ])
    expect(hoisted.settleEvalWorkFromRow).toHaveBeenCalledWith(hoisted.supabase, 'run-1')
  })

  it('does the same for a non-wall HTTP status', async () => {
    const recorded = fakeSupabase()
    hoisted.runTrial.mockRejectedValue(new LiveAgentHttpError(400, 'bad request'))
    await expect(run()).rejects.toThrow(/bad request/)
    expect(
      runUpdates(recorded).some((r) => (r.payload as { error_code?: string })?.error_code === 'harness_error'),
    ).toBe(true)
  })

  it('does NOT ask for a retry it cannot serve — the token is already revoked', async () => {
    // A retried attempt replays `mint-run-token` from memo and would POST with a
    // device_token row this handler deleted, 401ing every remaining trial.
    fakeSupabase()
    hoisted.runTrial.mockRejectedValue(new Error('boom'))
    const err = await run().catch((e: unknown) => e)
    expect((err as Error).name).toBe('NonRetriableError')
    expect(hoisted.revokeRunToken).toHaveBeenCalledWith(expect.anything(), 'token-1')
  })

  it('revokes the token exactly once, AFTER the run is settled', async () => {
    fakeSupabase()
    const step = createStepMock()
    await run(step)
    const ids = step.run.mock.calls.map((c) => c[0] as string)
    expect(ids.filter((id) => id === 'revoke-run-token')).toHaveLength(1)
    // Terminal exit, not mid-flight: the settle is what makes the run terminal,
    // and the credential must outlive every trial that could still replay.
    expect(ids.indexOf('revoke-run-token')).toBeLessThan(ids.indexOf('settle-run'))
    expect(ids.indexOf('revoke-run-token')).toBeGreaterThan(ids.indexOf('trial-0'))
  })
})

describe('a trial that could not be stored or graded', () => {
  it('is ERRORED, never a pass, when the eval_trial insert returns no row', async () => {
    const recorded = fakeSupabase({ trialInsertError: { message: 'check violation on trace' } })
    const out = await run()
    // Nothing to grade: there is no row to hang checks off.
    expect(hoisted.gradeTrial).not.toHaveBeenCalled()
    // And the run must not report green for a case that was never stored.
    expect(settleUpdate(recorded).outcome).toBe('failed')
    expect(out).toMatchObject({ outcome: 'failed' })
  })

  it('is ERRORED when the CHECKS could not be persisted', async () => {
    // gradeTrial computed drafts (which may have held failing gates) and could
    // not write them. An empty `checks` would roll up to `passed`.
    const recorded = fakeSupabase()
    hoisted.gradeTrial.mockResolvedValue({
      checks: [],
      usage: { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 },
      gradingFailed: true,
    })
    await run()

    const outcomeUpdate = recorded.find((r) => r.table === 'eval_trial' && r.op === 'update')!
      .payload as Record<string, unknown>
    expect(outcomeUpdate.status).toBe('errored')
    expect(outcomeUpdate.outcome).toBe('errored')
    expect(outcomeUpdate.error_code).toBe('grading_not_persisted')
    expect(settleUpdate(recorded).outcome).toBe('failed')
  })

  it('an ordinary empty check set still passes — nothing was dropped', async () => {
    const recorded = fakeSupabase()
    hoisted.gradeTrial.mockResolvedValue({
      checks: [],
      usage: { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 },
    })
    await run()
    const outcomeUpdate = recorded.find((r) => r.table === 'eval_trial' && r.op === 'update')!
      .payload as Record<string, unknown>
    expect(outcomeUpdate.outcome).toBe('passed')
    expect(outcomeUpdate.status).toBe('completed')
  })
})
