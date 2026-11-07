/**
 * Integration tests for the Evals RUN routes.
 *
 * Same tier as `src/app/api/account/prospecting/__tests__/runs.test.ts`. What
 * is under test is the route's own job — ordering, and the mapping from a
 * typed lib failure to an HTTP status — not `startEvalRun`, which has its own
 * tests.
 *
 * The five behaviours that would otherwise be silent, and cost real money if
 * they broke:
 *
 *   - `checkUsageLimits` runs ONCE per run, at queue time (spec §5.1), and its
 *     thrown 429/503 Response is returned VERBATIM. Rewrapping it as a 500
 *     would tell an over-limit user the server broke; running it per trial is
 *     how a mid-run wall becomes a retry storm.
 *   - It runs AFTER the suite is resolved, so a cross-workspace id costs no
 *     billing probe — and BEFORE `startEvalRun`, so an over-limit user never
 *     gets a queued row.
 *   - `adopted: true` is a 202, not a 409. The unique index refused a second
 *     live run and the in-flight one came back; a double-click and a chat tool
 *     racing the UI must converge on one run.
 *   - EVAL_BUDGET_EXCEEDED → 409 `budget_exceeded`, with the code in the
 *     ENVELOPE (not `details`), because the UI branches on it.
 *   - A run that settled since the last poll is NOT cancellable: `cancelEvalRun`
 *     returns the settled row unchanged, and reporting that as cancelled would
 *     claim a finished result was thrown away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRequest } from '@/test/integration'
import { EvalRunError } from '@/lib/evals/start-run'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceFeature: vi.fn(),
  getServiceClient: vi.fn(),
  checkUsageLimits: vi.fn(),
  getSuite: vi.fn(),
  listRuns: vi.fn(),
  getRunDetail: vi.fn(),
  startEvalRun: vi.fn(),
  cancelEvalRun: vi.fn(),
  runSelect: vi.fn(),
}))

const WS = 'ws-1'
const USER = { id: 'user-1', email: 'ada@acme.test' }
const SUITE = { id: 'suite-1', workspace_id: WS, name: 'Sales Discovery' }
const RUN = { id: 'run-1', workspace_id: WS, suite_id: 'suite-1', status: 'queued', is_live: true }

const supabase = {
  from: (table: string) => {
    if (table !== 'eval_run') throw new Error(`unexpected table: ${table}`)
    return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: hoisted.runSelect }) }) }) }
  },
}
const service = { tag: 'service' }

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceFeature: hoisted.requireWorkspaceFeature,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: hoisted.getServiceClient }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: hoisted.checkUsageLimits }))
vi.mock('@/lib/evals/queries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/evals/queries')>('@/lib/evals/queries')
  return {
    ...actual,
    getSuite: hoisted.getSuite,
    listRuns: hoisted.listRuns,
    getRunDetail: hoisted.getRunDetail,
  }
})
vi.mock('@/lib/evals/start-run', async () => {
  const actual = await vi.importActual<typeof import('@/lib/evals/start-run')>(
    '@/lib/evals/start-run',
  )
  return {
    ...actual,
    startEvalRun: hoisted.startEvalRun,
    cancelEvalRun: hoisted.cancelEvalRun,
  }
})

const runsRoute = await import('@/app/api/account/evals/runs/route')
const runRoute = await import('@/app/api/account/evals/runs/[id]/route')
const cancelRoute = await import('@/app/api/account/evals/runs/[id]/cancel/route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function nextRequest(url: string, init: Parameters<typeof buildRequest>[0] = {}) {
  const req = buildRequest({ ...init, url })
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as never
}

const START_BODY = { suite_id: '11111111-1111-4111-8111-111111111111', mode: 'batch' }

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: USER, workspaceId: WS })
  // Evals is a hidden feature — every handler gates on it. Default the suite to
  // ON (null = pass through); the gate itself is covered by its own tests.
  hoisted.requireWorkspaceFeature.mockResolvedValue(null)
  hoisted.getServiceClient.mockReturnValue(service)
  hoisted.checkUsageLimits.mockResolvedValue(undefined)
  hoisted.getSuite.mockResolvedValue(SUITE)
  hoisted.listRuns.mockResolvedValue([])
  hoisted.runSelect.mockResolvedValue({ data: { id: 'run-1' }, error: null })
  hoisted.startEvalRun.mockResolvedValue({ run: RUN, adopted: false, estimated_cost_usd: 0.42 })
})

// ---------------------------------------------------------------------------
// GET /runs
// ---------------------------------------------------------------------------

describe('GET /api/account/evals/runs', () => {
  it('returns a suite run history', async () => {
    hoisted.listRuns.mockResolvedValue([RUN])
    const res = await runsRoute.GET(nextRequest('https://dial8.ai/x?suite_id=suite-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runs: [RUN] })
    expect(hoisted.listRuns).toHaveBeenCalledWith(supabase, 'suite-1', undefined)
  })

  it('passes ?limit through', async () => {
    await runsRoute.GET(nextRequest('https://dial8.ai/x?suite_id=suite-1&limit=5'))
    expect(hoisted.listRuns).toHaveBeenCalledWith(supabase, 'suite-1', 5)
  })

  // `Number.isFinite(Number(x))` accepted every one of these. '0' and '' are
  // the damaging pair: they hand listRuns an explicit `.limit(0)`, which
  // defeats its own default of 20 and answers 200 with an empty history a
  // suite that has runs does not have. '-5' reaches PostgREST, which errors
  // into the same silently-empty list.
  it.each(['0', '', '-5', '1.5', 'abc', ' '])(
    'falls back to the default rather than trusting ?limit=%j',
    async (raw) => {
      await runsRoute.GET(
        nextRequest(`https://dial8.ai/x?suite_id=suite-1&limit=${encodeURIComponent(raw)}`),
      )
      expect(hoisted.listRuns).toHaveBeenCalledWith(supabase, 'suite-1', undefined)
    },
  )

  // RUN_FIELDS carries target_system_prompt and target_agent_config, so an
  // unbounded limit is a megabyte response, not merely a long one.
  it('caps an oversized ?limit rather than reading every run', async () => {
    await runsRoute.GET(nextRequest('https://dial8.ai/x?suite_id=suite-1&limit=1000000'))
    expect(hoisted.listRuns).toHaveBeenCalledWith(supabase, 'suite-1', 100)
  })

  it('requires suite_id', async () => {
    const res = await runsRoute.GET(nextRequest('https://dial8.ai/x'))
    expect(res.status).toBe(400)
    expect(hoisted.listRuns).not.toHaveBeenCalled()
  })

  it('404s a cross-workspace suite_id — never 403', async () => {
    hoisted.getSuite.mockResolvedValue(null)
    const res = await runsRoute.GET(nextRequest('https://dial8.ai/x?suite_id=other'))
    expect(res.status).toBe(404)
    expect(hoisted.listRuns).not.toHaveBeenCalled()
  })

  it('propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await runsRoute.GET(nextRequest('https://dial8.ai/x?suite_id=suite-1'))
    expect(res.status).toBe(401)
    expect(hoisted.getSuite).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /runs
// ---------------------------------------------------------------------------

describe('POST /api/account/evals/runs', () => {
  it('queues a run and returns 202 with the estimate', async () => {
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ run: RUN, adopted: false, estimated_cost_usd: 0.42 })
    expect(hoisted.startEvalRun).toHaveBeenCalledWith(
      service,
      expect.objectContaining({
        workspaceId: WS,
        userId: USER.id,
        suiteId: START_BODY.suite_id,
        mode: 'batch',
      }),
    )
  })

  // Evals is a HIDDEN feature: the gate runs before the usage check and before
  // anything is queued, so a disabled workspace can never start a run.
  it('403s FEATURE_DISABLED when evals is off for the workspace', async () => {
    hoisted.requireWorkspaceFeature.mockResolvedValue(
      new Response(JSON.stringify({ error: 'off', code: 'FEATURE_DISABLED' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('FEATURE_DISABLED')
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
    expect(hoisted.checkUsageLimits).not.toHaveBeenCalled()
  })

  it('checks the usage limit exactly ONCE per run', async () => {
    await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(hoisted.checkUsageLimits).toHaveBeenCalledTimes(1)
    expect(hoisted.checkUsageLimits).toHaveBeenCalledWith(USER.id, undefined, { chatgptPlan: true })
  })

  it('returns the 429 from checkUsageLimits verbatim, without queueing', async () => {
    hoisted.checkUsageLimits.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: 'Usage limit exceeded', reason: 'monthly_cap' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'Usage limit exceeded', reason: 'monthly_cap' })
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
  })

  it('returns the 503 from checkUsageLimits verbatim, never as a 500', async () => {
    hoisted.checkUsageLimits.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: 'Usage check unavailable' }), { status: 503 }),
    )
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(503)
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
  })

  it('does not probe billing for a cross-workspace suite_id', async () => {
    hoisted.getSuite.mockResolvedValue(null)
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(404)
    expect(hoisted.checkUsageLimits).not.toHaveBeenCalled()
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
  })

  it('adopting an in-flight run is a 202, not a 409', async () => {
    hoisted.startEvalRun.mockResolvedValue({
      run: { ...RUN, status: 'running' },
      adopted: true,
      estimated_cost_usd: 0.42,
    })
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ adopted: true, run: { id: 'run-1' } })
  })

  it('maps EVAL_BUDGET_EXCEEDED to a 409 with the code in the envelope', async () => {
    hoisted.startEvalRun.mockRejectedValue(
      new EvalRunError('EVAL_BUDGET_EXCEEDED', 'Monthly eval budget of $100 reached'),
    )
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'Monthly eval budget of $100 reached',
      code: 'budget_exceeded',
    })
  })

  it('maps EVAL_NO_CASES to a 400 and EVAL_SUITE_NOT_FOUND to a 404', async () => {
    hoisted.startEvalRun.mockRejectedValue(
      new EvalRunError('EVAL_NO_CASES', 'This suite has no cases for that mode'),
    )
    expect(
      (await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))).status,
    ).toBe(400)

    hoisted.startEvalRun.mockRejectedValue(
      new EvalRunError('EVAL_SUITE_NOT_FOUND', 'Eval suite not found'),
    )
    expect(
      (await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))).status,
    ).toBe(404)
  })

  it('maps an unexpected throw to a 500 with no upstream text', async () => {
    hoisted.startEvalRun.mockRejectedValue(new Error('inngest send failed'))
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: START_BODY }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL' })
  })

  it('rejects an unknown mode before touching billing', async () => {
    const res = await runsRoute.POST(
      nextRequest('https://dial8.ai/x', { body: { ...START_BODY, mode: 'turbo' } }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.checkUsageLimits).not.toHaveBeenCalled()
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid suite_id and an out-of-range trials_per_case', async () => {
    expect(
      (
        await runsRoute.POST(
          nextRequest('https://dial8.ai/x', { body: { suite_id: 'suite-1', mode: 'batch' } }),
        )
      ).status,
    ).toBe(400)

    expect(
      (
        await runsRoute.POST(
          nextRequest('https://dial8.ai/x', { body: { ...START_BODY, trials_per_case: 99 } }),
        )
      ).status,
    ).toBe(400)
  })

  it('rejects an unparseable body before touching billing', async () => {
    const res = await runsRoute.POST(nextRequest('https://dial8.ai/x', { body: '{oops', raw: true }))
    expect(res.status).toBe(400)
    expect(hoisted.checkUsageLimits).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /runs/[id]
// ---------------------------------------------------------------------------

describe('GET /api/account/evals/runs/[id]', () => {
  it('returns the run with its trials', async () => {
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: [{ id: 'trial-1', checks: [] }] })
    const res = await runRoute.GET(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: RUN, trials: [{ id: 'trial-1', checks: [] }] })
  })

  it('404s an unknown run', async () => {
    hoisted.getRunDetail.mockResolvedValue(null)
    const res = await runRoute.GET(nextRequest('https://dial8.ai/x'), params('nope'))
    expect(res.status).toBe(404)
  })

  it('404s a run in another workspace — never 403, and never its trials', async () => {
    hoisted.getRunDetail.mockResolvedValue({
      run: { ...RUN, workspace_id: 'ws-other' },
      trials: [{ id: 'trial-1' }],
    })
    const res = await runRoute.GET(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// POST /runs/[id]/cancel
// ---------------------------------------------------------------------------

describe('POST /api/account/evals/runs/[id]/cancel', () => {
  it('cancels a live run', async () => {
    hoisted.cancelEvalRun.mockResolvedValue({ ...RUN, status: 'cancelled', is_live: false })
    const res = await cancelRoute.POST(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'cancelled' })
    expect(hoisted.cancelEvalRun).toHaveBeenCalledWith(service, { workspaceId: WS, runId: 'run-1' })
  })

  it('409s a run that settled since the last poll, rather than claiming it was cancelled', async () => {
    hoisted.cancelEvalRun.mockResolvedValue({ ...RUN, status: 'completed', is_live: false })
    const res = await cancelRoute.POST(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'NOT_CANCELABLE',
      details: { status: 'completed' },
    })
  })

  it('404s a cross-workspace run without calling the service client', async () => {
    hoisted.runSelect.mockResolvedValue({ data: null, error: null })
    const res = await cancelRoute.POST(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(404)
    expect(hoisted.cancelEvalRun).not.toHaveBeenCalled()
  })

  it('maps EVAL_RUN_NOT_FOUND from the lib to a 404', async () => {
    hoisted.cancelEvalRun.mockRejectedValue(new EvalRunError('EVAL_RUN_NOT_FOUND', 'Run not found'))
    const res = await cancelRoute.POST(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(404)
  })

  it('maps an unexpected throw to a 500', async () => {
    hoisted.cancelEvalRun.mockRejectedValue(new Error('boom'))
    const res = await cancelRoute.POST(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(500)
  })

  it('maps a read error to a 500 without cancelling anything', async () => {
    hoisted.runSelect.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    const res = await cancelRoute.POST(nextRequest('https://dial8.ai/x'), params('run-1'))
    expect(res.status).toBe(500)
    expect(hoisted.cancelEvalRun).not.toHaveBeenCalled()
  })
})
