import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filterArgs, makeFakeSupabase, type Captured, type FakeResult } from './fake-supabase'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: [] })),
  mirrorQueued: vi.fn(async () => ({})),
  settleFromRow: vi.fn(async () => {}),
  onPlan: vi.fn(async (_userId: string) => false),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
// Whether the person runs on their own ChatGPT plan (src/lib/chatgpt/plan-route.ts).
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: hoisted.onPlan }))
// The work-ledger mirror (Sequence row 6); its own suite covers what it writes.
vi.mock('@/lib/work/eval-run-mirror', () => ({
  mirrorEvalRunQueued: hoisted.mirrorQueued,
  settleEvalWorkFromRow: hoisted.settleFromRow,
}))

const { cancelEvalRun, computePromptHash, EVAL_RUN_REQUESTED, EvalRunError, MONTHLY_EVAL_BUDGET_USD, startEvalRun } =
  await import('../start-run')

const SUITE = 'suite-1'
const WS = 'ws-1'
const USER = 'user-1'

interface Fixture {
  suite?: unknown
  cases?: unknown[]
  recipe?: unknown
  monthRuns?: Array<{ cost_usd: number }>
  /** Drives `monthToDateSpendUsd`'s fail-OPEN branch, which nothing else can. */
  monthError?: { message: string }
  insert?: FakeResult
  existingRun?: unknown
}

function fixture(f: Fixture = {}) {
  return makeFakeSupabase((q: Captured): FakeResult => {
    if (q.table === 'eval_suite') {
      return {
        data:
          f.suite === undefined
            ? { id: SUITE, workspace_id: WS, target_recipe_id: 'recipe-1', judge_model: null }
            : f.suite,
      }
    }
    if (q.table === 'eval_case') {
      return { data: f.cases ?? [{ id: 'case-1', modes: ['batch', 'live'] }] }
    }
    if (q.table === 'recipe') {
      return {
        data:
          f.recipe === undefined
            ? { system_prompt: 'You are a sales agent.', agent_config: { a: 1 }, model: 'deepseek-v4-flash' }
            : f.recipe,
      }
    }
    if (q.table === 'eval_run') {
      if (q.op === 'insert') return f.insert ?? { data: { id: 'run-1', estimated_cost_usd: 0.13 } }
      if (q.op === 'update') return { data: null }
      // Two different reads hit eval_run on a select: the month-to-date spend
      // (a gte on started_at) and the adopt re-read (an `in` on status).
      const isAdopt = q.filters.some((x) => x.method === 'in')
      if (isAdopt) return { data: f.existingRun ?? null }
      if (f.monthError) return { data: null, error: f.monthError }
      return { data: f.monthRuns ?? [] }
    }
    return { data: null }
  })
}

beforeEach(() => {
  hoisted.send.mockClear()
  hoisted.mirrorQueued.mockClear()
  hoisted.settleFromRow.mockClear()
  hoisted.onPlan.mockReset()
  hoisted.onPlan.mockResolvedValue(false)
})

describe('computePromptHash', () => {
  it('is stable for the same three inputs and changes when any one does', () => {
    const base = { systemPrompt: 'a', model: 'm', agentConfig: { x: 1 } }
    const h = computePromptHash(base)
    expect(computePromptHash(base)).toBe(h)
    expect(computePromptHash({ ...base, systemPrompt: 'b' })).not.toBe(h)
    expect(computePromptHash({ ...base, model: 'n' })).not.toBe(h)
    expect(computePromptHash({ ...base, agentConfig: { x: 2 } })).not.toBe(h)
  })

  it('collapses nulls to the empty string, so an unset model and a "" model are one prompt', () => {
    expect(computePromptHash({ systemPrompt: null, model: null, agentConfig: null })).toBe(
      computePromptHash({ systemPrompt: '', model: '', agentConfig: null }),
    )
    // And is NOT the literal "null" — which would split the sparkline on nothing.
    expect(computePromptHash({ systemPrompt: null, model: null, agentConfig: null })).not.toBe(
      computePromptHash({ systemPrompt: 'null', model: 'null', agentConfig: null }),
    )
  })

  it('is a sha256 hex digest', () => {
    expect(computePromptHash({ systemPrompt: 'a', model: null, agentConfig: null })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('startEvalRun', () => {
  it('denormalizes the LIVE recipe snapshot and its hash onto the row', async () => {
    const { client, queries } = fixture()
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' })

    const insert = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!
    const payload = insert.payload as Record<string, unknown>
    expect(payload.target_system_prompt).toBe('You are a sales agent.')
    expect(payload.target_agent_config).toEqual({ a: 1 })
    expect(payload.target_model).toBe('deepseek-v4-flash')
    expect(payload.target_prompt_hash).toBe(
      computePromptHash({
        systemPrompt: 'You are a sales agent.',
        model: 'deepseek-v4-flash',
        agentConfig: { a: 1 },
      }),
    )
    expect(payload.status).toBe('queued')
    expect(payload.started_by).toBe(USER)
  })

  // The trials and the judges run on the person's own plan: their run costs
  // Native Intelligence nothing, so it's priced at $0 with a $0 ceiling (the lane stops it
  // should it ever spend).
  it('queues a run for a person on their own ChatGPT plan, priced at $0 with a $0 ceiling', async () => {
    hoisted.onPlan.mockResolvedValue(true)
    const { client, queries } = fixture({ insert: { data: { id: 'run-1', estimated_cost_usd: 0 } } })
    const out = await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' })
    expect(hoisted.onPlan).toHaveBeenCalledWith(USER, { attempts: 2, failClosed: true })
    expect(out.estimated_cost_usd).toBe(0)
    const insert = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!
    expect(insert.payload).toMatchObject({ estimated_cost_usd: 0, max_cost_usd: 0 })
    expect(hoisted.send).toHaveBeenCalled()
  })

  it('fails closed: a plan check that cannot be read queues nothing', async () => {
    hoisted.onPlan.mockRejectedValue(new Error('ChatGPT plan check failed: db down'))
    const { client, queries } = fixture()
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' }),
    ).rejects.toMatchObject({ code: 'EVAL_USAGE_UNAVAILABLE' })
    expect(queries).toEqual([])
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  /** The snapshot read is on the SERVICE client, so only the predicate keeps a
   *  foreign recipe's system prompt off a row this workspace can read. A target
   *  that does not resolve fails the START — snapshotting nulls instead would
   *  grade every case against an empty prompt and call the result a run. */
  it('refuses to start when the suite target does not resolve for the suite workspace', async () => {
    const { client, queries } = fixture({ recipe: null })
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' }),
    ).rejects.toMatchObject({ code: 'EVAL_TARGET_NOT_FOUND' })
    expect(queries.some((q) => q.table === 'eval_run' && q.op === 'insert')).toBe(false)
  })

  it('scopes the snapshot read to system recipes or the suite workspace', async () => {
    const { client, queries } = fixture()
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' })
    const recipeRead = queries.find((q) => q.table === 'recipe')!
    expect(filterArgs(recipeRead, 'or')).toEqual([[`is_system.eq.true,workspace_id.eq.${WS}`]])
  })

  it('writes the priced case_ids onto progress so the lane cannot drift', async () => {
    const { client, queries } = fixture({
      cases: [
        { id: 'c1', modes: ['batch'] },
        { id: 'c2', modes: ['batch'] },
      ],
    })
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' })
    const payload = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!.payload as {
      progress: { case_ids: string[]; cases_total: number; trials_total: number }
    }
    expect(payload.progress.case_ids).toEqual(['c1', 'c2'])
    expect(payload.progress.cases_total).toBe(2)
    expect(payload.progress.trials_total).toBe(2)
  })

  it('excludes cases that do not declare this mode', async () => {
    const { client, queries } = fixture({
      cases: [
        { id: 'batch-only', modes: ['batch'] },
        { id: 'both', modes: ['batch', 'live'] },
      ],
    })
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'live' })
    const payload = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!.payload as {
      progress: { case_ids: string[] }
    }
    expect(payload.progress.case_ids).toEqual(['both'])
  })

  // A private case is readable only by its creator, but a run's trials and
  // checks are readable by every member: someone else's run must not execute
  // it and republish its transcript.
  it("skips another member's PRIVATE case, and runs the starter's own", async () => {
    const { client, queries } = fixture({
      cases: [
        { id: 'shared', modes: ['live'], visibility: 'workspace', created_by: 'someone-else' },
        { id: 'theirs-private', modes: ['live'], visibility: 'private', created_by: 'someone-else' },
        { id: 'mine-private', modes: ['live'], visibility: 'private', created_by: USER },
        { id: 'orphan-private', modes: ['live'], visibility: 'private', created_by: null },
      ],
    })
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'live' })
    const read = queries.find((q) => q.table === 'eval_case')!
    expect(String(filterArgs(read, 'select')[0][0])).toContain('visibility')
    expect(String(filterArgs(read, 'select')[0][0])).toContain('created_by')
    const payload = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!.payload as {
      progress: { case_ids: string[] }
    }
    expect(payload.progress.case_ids).toEqual(['shared', 'mine-private'])
  })

  it('refuses to start when the only cases are other members\' private ones', async () => {
    const { client } = fixture({
      cases: [{ id: 'theirs-private', modes: ['live'], visibility: 'private', created_by: 'someone-else' }],
    })
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'live' }),
    ).rejects.toMatchObject({ code: 'EVAL_NO_CASES' })
  })

  it('treats an empty modes array as "runs in every mode"', async () => {
    const { client, queries } = fixture({ cases: [{ id: 'c1', modes: [] }] })
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'live' })
    const payload = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!.payload as {
      progress: { case_ids: string[] }
    }
    expect(payload.progress.case_ids).toEqual(['c1'])
  })

  it('sets max_cost_usd to 3x the estimate', async () => {
    const { client, queries } = fixture()
    const { estimated_cost_usd } = await startEvalRun(client, {
      workspaceId: WS,
      userId: USER,
      suiteId: SUITE,
      mode: 'batch',
    })
    const payload = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!.payload as {
      max_cost_usd: number
      estimated_cost_usd: number
    }
    expect(payload.estimated_cost_usd).toBe(estimated_cost_usd)
    expect(payload.max_cost_usd).toBeCloseTo(estimated_cost_usd * 3, 6)
  })

  it('emits eval/run.requested AFTER the row exists', async () => {
    const { client } = fixture()
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' })
    expect(hoisted.send).toHaveBeenCalledWith({
      name: EVAL_RUN_REQUESTED,
      data: { run_id: 'run-1', workspace_id: WS },
    })
    expect(EVAL_RUN_REQUESTED).toBe('eval/run.requested')
  })

  it('queues the run’s Activity row from the inserted row, before the event', async () => {
    const { client } = fixture()
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' })
    expect(hoisted.mirrorQueued).toHaveBeenCalledTimes(1)
    expect(hoisted.mirrorQueued).toHaveBeenCalledWith(client, { id: 'run-1', estimated_cost_usd: 0.13 })
    expect(hoisted.mirrorQueued.mock.invocationCallOrder[0]).toBeLessThan(hoisted.send.mock.invocationCallOrder[0])
  })

  it('refuses a run that would cross the monthly cap, and does NOT insert', async () => {
    const { client, queries } = fixture({ monthRuns: [{ cost_usd: MONTHLY_EVAL_BUDGET_USD }] })
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' }),
    ).rejects.toMatchObject({ code: 'EVAL_BUDGET_EXCEEDED' })
    expect(queries.some((q) => q.table === 'eval_run' && q.op === 'insert')).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('fails OPEN when the spend read errors — one bad aggregate must not wall the workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, queries } = fixture({ monthError: { message: 'aggregate timeout' } })
    const out = await startEvalRun(client, {
      workspaceId: WS,
      userId: USER,
      suiteId: SUITE,
      mode: 'batch',
    })
    // The branch was actually ENTERED — without this the test passes on the
    // happy path and any change to fail CLOSED stays green.
    expect(warn).toHaveBeenCalledWith(
      '[evals] month-to-date spend read failed:',
      'aggregate timeout',
    )
    // And the run still started: the row was inserted and the event sent.
    expect(out.adopted).toBe(false)
    expect(queries.some((q) => q.table === 'eval_run' && q.op === 'insert')).toBe(true)
    expect(hoisted.send).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a spend read that errors is NOT read as the cap being crossed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The same error shape, with a per-run ceiling already at the monthly cap:
    // a fail-CLOSED implementation (throw, or Infinity) refuses here.
    const { client } = fixture({ monthError: { message: 'boom' } })
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' }),
    ).resolves.toMatchObject({ adopted: false })
    warn.mockRestore()
  })

  it('ADOPTS the in-flight run on the 23505 rather than erroring', async () => {
    const { client } = fixture({
      insert: { data: null, error: { message: 'duplicate key', code: '23505' } },
      existingRun: { id: 'run-live', estimated_cost_usd: 0.42 },
    })
    const out = await startEvalRun(client, {
      workspaceId: WS,
      userId: USER,
      suiteId: SUITE,
      mode: 'batch',
    })
    expect(out.adopted).toBe(true)
    expect(out.run).toMatchObject({ id: 'run-live' })
    expect(out.estimated_cost_usd).toBe(0.42)
    // An adopted run is already queued — a second event would double-execute it.
    expect(hoisted.send).not.toHaveBeenCalled()
    // …and it already has its Activity row, from the start that inserted it.
    expect(hoisted.mirrorQueued).not.toHaveBeenCalled()
  })

  it('throws rather than reporting an adopted run with nothing attached', async () => {
    const { client } = fixture({
      insert: { data: null, error: { message: 'duplicate key', code: '23505' } },
      existingRun: null,
    })
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' }),
    ).rejects.toMatchObject({ code: 'EVAL_RUN_INSERT_FAILED' })
  })

  it('refuses an unknown suite before spending a query on cases', async () => {
    const { client, queries } = fixture({ suite: null })
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' }),
    ).rejects.toMatchObject({ code: 'EVAL_SUITE_NOT_FOUND' })
    expect(queries.some((q) => q.table === 'eval_case')).toBe(false)
  })

  it('refuses a suite with no cases in this mode', async () => {
    const { client } = fixture({ cases: [] })
    await expect(
      startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' }),
    ).rejects.toBeInstanceOf(EvalRunError)
  })

  it('scopes the suite lookup to the workspace — a suite id alone is not authorisation', async () => {
    const { client, queries } = fixture()
    await startEvalRun(client, { workspaceId: WS, userId: USER, suiteId: SUITE, mode: 'batch' })
    const suiteQuery = queries.find((q) => q.table === 'eval_suite')!
    expect(suiteQuery.filters.some((f) => f.method === 'eq' && f.args[0] === 'workspace_id' && f.args[1] === WS)).toBe(true)
  })

  it('defaults speed to instant and trials to 1, and floors a silly trial count', async () => {
    const { client, queries } = fixture()
    await startEvalRun(client, {
      workspaceId: WS,
      userId: USER,
      suiteId: SUITE,
      mode: 'live',
      trialsPerCase: 0,
    })
    const payload = queries.find((q) => q.table === 'eval_run' && q.op === 'insert')!.payload as {
      speed: string
      trials_per_case: number
      driver: string
    }
    expect(payload.speed).toBe('instant')
    expect(payload.trials_per_case).toBe(1)
    expect(payload.driver).toBe('server')
  })
})

describe('cancelEvalRun', () => {
  it('writes cancelled filtered to LIVE statuses so it cannot clobber a finished run', async () => {
    const { client, queries } = makeFakeSupabase((q): FakeResult => {
      if (q.table === 'eval_run' && q.op === 'update') return { data: { id: 'run-1', status: 'cancelled' } }
      return { data: null }
    })
    await cancelEvalRun(client, { workspaceId: WS, runId: 'run-1' })
    const update = queries.find((q) => q.table === 'eval_run' && q.op === 'update')!
    const inFilter = update.filters.find((f) => f.method === 'in')!
    expect(inFilter.args[1]).toEqual(['queued', 'running'])
    expect((update.payload as { error_code: string }).error_code).toBe('cancelled')
    // The cancel won, so the Activity row follows it.
    expect(hoisted.settleFromRow).toHaveBeenCalledWith(client, 'run-1')
  })

  it('reads the row back when zero rows updated, so "already finished" is not "not found"', async () => {
    const { client } = makeFakeSupabase((q): FakeResult => {
      if (q.table === 'eval_run' && q.op === 'update') return { data: null }
      if (q.table === 'eval_run') return { data: { id: 'run-1', status: 'completed' } }
      return { data: null }
    })
    const run = await cancelEvalRun(client, { workspaceId: WS, runId: 'run-1' })
    expect(run).toMatchObject({ status: 'completed' })
    // The cancel lost; the lane's own settle mirrored the ending.
    expect(hoisted.settleFromRow).not.toHaveBeenCalled()
  })

  it('throws EVAL_RUN_NOT_FOUND when the run is not in this workspace at all', async () => {
    const { client } = makeFakeSupabase((): FakeResult => ({ data: null }))
    await expect(cancelEvalRun(client, { workspaceId: WS, runId: 'nope' })).rejects.toMatchObject({
      code: 'EVAL_RUN_NOT_FOUND',
    })
  })
})
