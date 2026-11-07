/**
 * agentRunExecute + agentRunCancel tests (eve is the ONLY cloud coding runtime).
 *
 * agentRunExecute's load-bearing properties:
 *   - BOTH origins dispatch through the eve watcher (runAgentViaEve): an
 *     action-origin run AND a flow-origin run (action_id NULL) — the flow-origin
 *     gap that used to force the retired Vercel-Sandbox branch is closed.
 *   - Runnability is decided by the SAME spec build the spec route serves
 *     (buildAgentRunSpec); an unrunnable run is settled failed with the build's
 *     origin-aware reason, CAS-guarded, and no eve session is created.
 *   - A deployment without the internal secret fails the run with a clear cause
 *     rather than throwing into a retry.
 *   - The GitHub token in the built spec never lands in step output (Inngest
 *     persists step results in its run history).
 *   - An already-terminal run short-circuits (idempotent replay).
 *
 * agentRunExecute is a closure passed to inngest.createFunction; we capture it by
 * stubbing createFunction, mock every heavy edge (service client, spec build, the
 * eve watcher, the ledger mirror), and drive the handler with the shared step mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

// ── Capture the two Inngest function handlers as they're created ─────────────
const h = vi.hoisted(() => {
  const handlers: Record<string, unknown> = {}
  return {
    handlers,
    runAgentViaEve: vi.fn(
      async (): Promise<{ settled: 'failed' | 'canceled' | null; sessionId: string | null; pending?: { nextIndex: number } }> => ({
        settled: null,
        sessionId: 'sess-eve',
      }),
    ),
    startAgentEveSession: vi.fn(async () => ({ sessionId: 'sess-eve', stamped: true })),
    cancelEveCodingSession: vi.fn(async (): Promise<string> => 'accepted'),
    cancelEveWorkSession: vi.fn(async (): Promise<string> => 'accepted'),
    order: [] as string[],
    buildAgentRunSpec: vi.fn(),
    internalSecret: vi.fn((): string | null => 'secret'),
    mirrorAgentRunStatus: vi.fn(async () => {}),
    fromImpl: vi.fn(),
    send: vi.fn(async () => ({ ids: [] })),
    precheckBeforeSandbox: vi.fn(async (): Promise<{ parked: boolean; ran: boolean }> => ({ parked: false, ran: false })),
    // Whether the run's person is on their own ChatGPT plan (the free tier).
    chatgptPlanFor: vi.fn(async (_userId: unknown) => false),
  }
})

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: h.send,
    createFunction: (config: { id: string }, handler: unknown) => {
      h.handlers[config.id] = handler
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: h.fromImpl }) }))
vi.mock('@/lib/agent-run/spec-rebuild', async (importOriginal) => ({
  // The REAL not-live set: the dispatcher and the spec route share one list.
  NOT_LIVE_STATUSES: (await importOriginal<typeof import('@/lib/agent-run/spec-rebuild')>()).NOT_LIVE_STATUSES,
  buildAgentRunSpec: h.buildAgentRunSpec,
  AGENT_RUN_NOT_FOUND: 'agent_run not found',
}))
vi.mock('@/lib/agent-run/agent-run-token', () => ({ internalSecret: h.internalSecret }))
vi.mock('@/lib/agent-run/run-agent-eve', () => ({
  runAgentViaEve: h.runAgentViaEve,
  startAgentEveSession: h.startAgentEveSession,
  cancelEveCodingSession: h.cancelEveCodingSession,
  EVE_SANDBOX_PREFIX: 'eve:',
}))
vi.mock('@/lib/agent-run/run-work-eve', () => ({ cancelEveWorkSession: h.cancelEveWorkSession }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ mirrorAgentRunStatus: h.mirrorAgentRunStatus }))
vi.mock('@/lib/coding/precheck', () => ({ precheckBeforeSandbox: h.precheckBeforeSandbox }))
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: h.chatgptPlanFor }))

import { CHATGPT_PLAN_NO_CODING_REASON } from '@/lib/chatgpt/plan-models'
const { NO_INTERNAL_SECRET_REASON, WATCH_STEP_BUDGET_MS, MAX_WATCH_STEPS, reapStaleAgentRuns, STALE_RUN_REASON } =
  await import('../agent-run-functions')
const agentRunExecute = h.handlers['agent-run-execute'] as (arg: {
  event: { data: { agent_run_id: string; workspace_id: string } }
  step: StepMock
}) => Promise<unknown>
const agentRunCancel = h.handlers['agent-run-cancel'] as (arg: {
  event: { data: { agent_run_id: string; workspace_id: string; reason?: string | null } }
  step: StepMock
}) => Promise<unknown>

/**
 * Shared Inngest step mock: .run(name, fn) executes fn (durable steps are
 * transparent here) and every step method throws if called from inside a
 * step.run callback — that nesting deadlocks in production.
 */
const step = createStepMock()

const GITHUB_TOKEN = 'ghp_secret_do_not_persist'
const SPEC = {
  systemPrompt: 'SYS',
  taskPrompt: 'TASK',
  model: 'anthropic/claude-sonnet-4.5',
  repoFullName: 'owner/repo',
  baseBranch: 'main',
  branchName: 'dial8/eng-1-run-1',
  networkAccess: 'trusted',
  setupScript: null,
  envVars: {},
  githubToken: GITHUB_TOKEN,
}

function runnable(actionId: string | null) {
  return {
    ok: true,
    origin: actionId ? 'action' : 'flow',
    run: { actionId, triggeredBy: 'user-1' },
    spec: SPEC,
  }
}

function unrunnable(actionId: string | null, reason: string) {
  return { ok: false, origin: actionId ? 'action' : 'flow', run: { actionId, triggeredBy: 'user-1' }, reason }
}

/**
 * Fake service client for agentRunExecute's own writes/reads: the precondition
 * failed-write (a CAS against `liveStatus`), the idempotency guard read, and the
 * action stamp. Records every write.
 */
/** The CAS IN-list every agent_run settle must carry — all four terminals. */
const TERMINAL_IN_LIST = '(pr_open,completed,failed,canceled)'

function buildFrom(opts: { guardStatus?: string; liveStatus?: string; guardStatuses?: string[] } = {}) {
  const guardStatus = opts.guardStatus ?? 'queued'
  // Successive guard reads (one per handler invocation) — proves the guard is
  // read fresh on a replay, not memoized.
  const guardQueue = [...(opts.guardStatuses ?? [])]
  const liveStatus = opts.liveStatus ?? 'queued'
  // EVERY update is recorded (attempted), with its CAS guard, its IN-list, and
  // its eq filters. `took` models the DB: a guarded write takes only when the
  // live row is outside the IN-list; an UNGUARDED write always takes — so a
  // test can tell "the CAS refused it" from "no write was attempted".
  const attempts: Array<{
    table: string
    patch: Record<string, unknown>
    casGuarded: boolean
    notInList: string | null
    eqs: Record<string, unknown>
    took: boolean
  }> = []
  const from = vi.fn((table: string) => {
    if (table === 'agent_run') {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { status: guardQueue.shift() ?? guardStatus, pr_url: null }, error: null }),
        update: (patch: Record<string, unknown>) => {
          const attempt = { table, patch, casGuarded: false, notInList: null as string | null, eqs: {} as Record<string, unknown>, took: false }
          attempts.push(attempt)
          const upd: Record<string, unknown> = {}
          Object.assign(upd, {
            eq: (col: string, val: unknown) => {
              attempt.eqs[col] = val
              return upd
            },
            not: (col: string, op: string, list: string) => {
              if (col === 'status' && op === 'in') {
                attempt.casGuarded = true
                attempt.notInList = list
              }
              return upd
            },
            select: async () => {
              const listed = attempt.notInList
                ? attempt.notInList.replace(/[()]/g, '').split(',')
                : []
              attempt.took = attempt.casGuarded ? !listed.includes(liveStatus) : true
              if (attempt.took) h.order.push(`agent_run:${Object.keys(patch).join(',')}`)
              return { data: attempt.took ? [{ id: 'run-1' }] : [], error: null }
            },
          })
          return upd
        },
      })
      return chain
    }
    return {
      update: (patch: Record<string, unknown>) => {
        attempts.push({ table, patch, casGuarded: false, notInList: null, eqs: {}, took: true })
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }
  })
  const writes = () => attempts.filter((a) => a.took)
  return { from, attempts, writes }
}

const EVENT = { data: { agent_run_id: 'run-1', workspace_id: 'ws-1' } }

describe('agentRunExecute — eve dispatch for both origins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.internalSecret.mockReturnValue('secret')
    h.order.length = 0
    h.runAgentViaEve.mockImplementation(async () => {
      h.order.push('runAgentViaEve')
      return { settled: null, sessionId: 'sess-eve' }
    })
    h.startAgentEveSession.mockImplementation(async () => {
      h.order.push('startAgentEveSession')
      return { sessionId: 'sess-eve', stamped: true }
    })
  })
  afterEach(() => vi.clearAllMocks())

  it('action-origin → eve watcher, tenancy from the loaded run', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom().from)

    const res = await agentRunExecute({ event: EVENT, step })

    expect(h.buildAgentRunSpec).toHaveBeenCalledWith(expect.anything(), { agentRunId: 'run-1', workspaceId: 'ws-1' })
    expect(h.runAgentViaEve).toHaveBeenCalledTimes(1)
    expect(h.runAgentViaEve).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }),
    )
    expect(res).toMatchObject({ ok: true, sessionId: 'sess-eve' })
  })

  it('FLOW-origin (action_id NULL) → the SAME eve watcher path', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable(null))
    h.fromImpl.mockImplementation(buildFrom().from)

    const res = await agentRunExecute({ event: EVENT, step })

    expect(h.runAgentViaEve).toHaveBeenCalledTimes(1)
    expect(h.runAgentViaEve).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }),
    )
    expect(res).toMatchObject({ ok: true, sessionId: 'sess-eve' })
  })

  it('a watcher-settled failure reports ok:false', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable(null))
    h.fromImpl.mockImplementation(buildFrom().from)
    h.runAgentViaEve.mockResolvedValue({ settled: 'failed', sessionId: 'sess-eve' })

    const res = await agentRunExecute({ event: EVENT, step })
    expect(res).toMatchObject({ ok: false, settled: 'failed' })
  })

  it('never persists the GitHub token in step output', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom().from)

    await agentRunExecute({ event: EVENT, step })

    const outputs = await Promise.all(step.run.mock.results.map((r) => r.value))
    expect(outputs.length).toBeGreaterThan(0)
    expect(JSON.stringify(outputs)).not.toContain(GITHUB_TOKEN)
  })

  it('flow-origin precondition failure → failed (CAS-guarded) with the build reason; no eve, no action stamp', async () => {
    const reason = 'No repository for this run — set a repo on the run_agent action (or enable "use triggering action context").'
    h.buildAgentRunSpec.mockResolvedValue(unrunnable(null, reason))
    const { from, writes } = buildFrom()
    h.fromImpl.mockImplementation(from)

    const res = await agentRunExecute({ event: EVENT, step })

    expect(res).toEqual({ ok: false, reason })
    expect(h.runAgentViaEve).not.toHaveBeenCalled()
    const failed = writes().find((w) => w.table === 'agent_run')
    expect(failed?.patch).toMatchObject({ status: 'failed', error_message: reason })
    expect(failed?.casGuarded).toBe(true)
    // The guard excludes EVERY terminal status, and the write is tenancy-scoped.
    expect(failed?.notInList).toBe(TERMINAL_IN_LIST)
    expect(failed?.eqs).toMatchObject({ id: 'run-1', workspace_id: 'ws-1' })
    expect(writes().find((w) => w.table === 'actions')).toBeUndefined()
    expect(h.mirrorAgentRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      { agentRunId: 'run-1', workspaceId: 'ws-1' },
      { status: 'failed', error: reason },
    )
  })

  it('action-origin precondition failure also stamps the action failed', async () => {
    h.buildAgentRunSpec.mockResolvedValue(unrunnable('action-1', 'The assigned agent could not be loaded.'))
    const { from, writes } = buildFrom()
    h.fromImpl.mockImplementation(from)

    await agentRunExecute({ event: EVENT, step })

    expect(h.runAgentViaEve).not.toHaveBeenCalled()
    expect(writes().find((w) => w.table === 'actions')?.patch).toEqual({ agent_run_status: 'failed' })
  })

  it('a precondition failure never overwrites an already-terminal run (CAS misses → no stamp, no mirror)', async () => {
    h.buildAgentRunSpec.mockResolvedValue(unrunnable('action-1', 'No GitHub token for the user who started the run — connect GitHub.'))
    const { from, attempts, writes } = buildFrom({ liveStatus: 'pr_open' })
    h.fromImpl.mockImplementation(from)

    await agentRunExecute({ event: EVENT, step })

    // The failed-write WAS attempted, and only its CAS kept it off the row: the
    // fake takes an unguarded write unconditionally, so dropping the guard (or
    // 'pr_open' from its IN-list) turns this red.
    const attempted = attempts.filter((a) => a.table === 'agent_run')
    expect(attempted).toHaveLength(1)
    expect(attempted[0].patch).toMatchObject({ status: 'failed' })
    expect(attempted[0].notInList).toBe(TERMINAL_IN_LIST)
    expect(writes()).toEqual([])
    expect(h.mirrorAgentRunStatus).not.toHaveBeenCalled()
  })

  it('no internal secret → the run fails with a clear cause instead of throwing', async () => {
    h.internalSecret.mockReturnValue(null)
    h.buildAgentRunSpec.mockResolvedValue(runnable(null))
    const { from, writes } = buildFrom()
    h.fromImpl.mockImplementation(from)

    const res = await agentRunExecute({ event: EVENT, step })

    expect(res).toEqual({ ok: false, reason: NO_INTERNAL_SECRET_REASON })
    expect(h.runAgentViaEve).not.toHaveBeenCalled()
    expect(writes().find((w) => w.table === 'agent_run')?.patch).toMatchObject({
      status: 'failed',
      error_message: NO_INTERNAL_SECRET_REASON,
    })
  })

  it("a person on their own ChatGPT plan never gets a coding run: failed with why, before the pre-check or any sandbox", async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.chatgptPlanFor.mockResolvedValueOnce(true)
    const { from, writes } = buildFrom()
    h.fromImpl.mockImplementation(from)

    const res = await agentRunExecute({ event: EVENT, step })

    expect(res).toEqual({ ok: false, reason: CHATGPT_PLAN_NO_CODING_REASON })
    expect(h.precheckBeforeSandbox).not.toHaveBeenCalled()
    expect(h.startAgentEveSession).not.toHaveBeenCalled()
    expect(h.runAgentViaEve).not.toHaveBeenCalled()
    expect(writes().find((w) => w.table === 'agent_run')?.patch).toMatchObject({
      status: 'failed',
      error_message: CHATGPT_PLAN_NO_CODING_REASON,
    })
  })

  it('a missing agent_run row throws (Inngest retry), never dispatches', async () => {
    h.buildAgentRunSpec.mockResolvedValue({ ok: false, reason: 'agent_run not found', origin: null, run: null })
    h.fromImpl.mockImplementation(buildFrom().from)

    await expect(agentRunExecute({ event: EVENT, step })).rejects.toThrow('agent_run not found')
    expect(h.runAgentViaEve).not.toHaveBeenCalled()
  })

  it("stamps the spec's repo onto the row (CAS-guarded, tenancy-scoped) BEFORE the session starts", async () => {
    // An action-origin row inserted by a run_agent flow action carries the flow
    // config's repo (acme/tools); the spec clones the action's project repo
    // (acme/app). The outcome route opens the PR on the ROW's repo, so the row
    // must be re-stamped with the cloned repo first.
    h.buildAgentRunSpec.mockResolvedValue({ ...runnable('action-1'), spec: { ...SPEC, repoFullName: 'acme/app' } })
    const { from, writes } = buildFrom()
    h.fromImpl.mockImplementation(from)

    await agentRunExecute({ event: EVENT, step })

    const stamp = writes().find((w) => w.table === 'agent_run' && 'repo_full_name' in w.patch)
    expect(stamp?.patch).toEqual({ repo_full_name: 'acme/app' })
    expect(stamp?.casGuarded).toBe(true)
    expect(stamp?.notInList).toBe(TERMINAL_IN_LIST)
    expect(stamp?.eqs).toMatchObject({ id: 'run-1', workspace_id: 'ws-1' })
    expect(h.order).toEqual(['agent_run:repo_full_name', 'startAgentEveSession', 'runAgentViaEve'])
  })

  it('stamps flow-origin runs too (the row repo IS the spec repo; the write is a no-op in effect)', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable(null))
    const { from, writes } = buildFrom()
    h.fromImpl.mockImplementation(from)

    await agentRunExecute({ event: EVENT, step })

    expect(writes().find((w) => 'repo_full_name' in w.patch)?.patch).toEqual({ repo_full_name: 'owner/repo' })
  })

  it('an unrunnable run is never stamped', async () => {
    h.buildAgentRunSpec.mockResolvedValue(unrunnable('action-1', 'The assigned agent could not be loaded.'))
    const { from, attempts } = buildFrom()
    h.fromImpl.mockImplementation(from)

    await agentRunExecute({ event: EVENT, step })

    expect(attempts.find((a) => 'repo_full_name' in a.patch)).toBeUndefined()
  })

  it('an already-terminal run short-circuits (idempotent replay) without a second session', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    const { from, attempts } = buildFrom({ guardStatus: 'pr_open' })
    h.fromImpl.mockImplementation(from)
    const res = await agentRunExecute({ event: EVENT, step })

    expect(res).toMatchObject({ ok: true, alreadySettled: true })
    expect(h.runAgentViaEve).not.toHaveBeenCalled()
    // A settled row is not re-stamped either.
    expect(attempts.find((a) => 'repo_full_name' in a.patch)).toBeUndefined()
  })

  it('a row already canceling (Stop before dispatch) never reaches the eve session', async () => {
    // The spec route 404s a canceling row, so a session started now would run
    // spec-less (default model, no persona, deny-all sandbox). Start nothing and
    // write nothing — agentRunCancel owns the canceling → canceled settle.
    h.buildAgentRunSpec.mockResolvedValue(runnable(null))
    const { from, attempts } = buildFrom({ guardStatus: 'canceling', liveStatus: 'canceling' })
    h.fromImpl.mockImplementation(from)
    const res = await agentRunExecute({ event: EVENT, step })

    expect(res).toEqual({ ok: false, canceled: true })
    expect(h.runAgentViaEve).not.toHaveBeenCalled()
    expect(attempts).toEqual([])
  })
})

/**
 * A step mock that MEMOIZES completed step.run results by id across handler
 * invocations, like Inngest does on a retry/replay. A step whose callback threw
 * (the request was killed mid-step) is not memoized and re-runs.
 */
function memoizingStep() {
  const done = new Map<string, unknown>()
  const run = vi.fn(async (id: string, fn: () => unknown) => {
    if (done.has(id)) return done.get(id)
    const out = await fn()
    done.set(id, out)
    return out
  })
  return { run } as unknown as StepMock
}

describe('agentRunExecute — one session per run, watched across requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.internalSecret.mockReturnValue('secret')
    h.startAgentEveSession.mockResolvedValue({ sessionId: 'sess-eve', stamped: true })
    h.runAgentViaEve.mockResolvedValue({ settled: null, sessionId: 'sess-eve' })
  })

  it('creates the session in its own step, then watches it by id with a per-request budget', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom().from)
    const memo = memoizingStep()

    await agentRunExecute({ event: EVENT, step: memo })

    const ids = (memo.run as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0])
    expect(ids).toContain('create-eve-session')
    expect(ids).toContain('watch-eve-session-0')
    expect(h.runAgentViaEve).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-eve', fromIndex: 0, budgetMs: WATCH_STEP_BUDGET_MS, stamped: true }),
    )
    expect(WATCH_STEP_BUDGET_MS).toBeLessThan(300_000)
  })

  it('a run longer than one watch continues from where the last watch stopped', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom().from)
    h.runAgentViaEve
      .mockResolvedValueOnce({ settled: null, sessionId: 'sess-eve', pending: { nextIndex: 40 } })
      .mockResolvedValueOnce({ settled: null, sessionId: 'sess-eve', pending: { nextIndex: 95 } })
      .mockResolvedValueOnce({ settled: null, sessionId: 'sess-eve' })

    const res = await agentRunExecute({ event: EVENT, step: memoizingStep() })

    expect(h.startAgentEveSession).toHaveBeenCalledTimes(1)
    expect(h.runAgentViaEve.mock.calls.map((c) => (c as unknown as [{ fromIndex: number }])[0].fromIndex)).toEqual([0, 40, 95])
    expect(res).toMatchObject({ ok: true, sessionId: 'sess-eve' })
  })

  it('an Inngest retry after a killed request re-attaches to the SAME session (no second agent, no supersede)', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom({ guardStatuses: ['queued', 'running'] }).from)
    const memo = memoizingStep()
    h.runAgentViaEve.mockRejectedValueOnce(new Error('FUNCTION_INVOCATION_TIMEOUT'))

    await expect(agentRunExecute({ event: EVENT, step: memo })).rejects.toThrow('FUNCTION_INVOCATION_TIMEOUT')
    await agentRunExecute({ event: EVENT, step: memo }) // the retry

    expect(h.startAgentEveSession).toHaveBeenCalledTimes(1)
    const sessions = h.runAgentViaEve.mock.calls.map((c) => (c as unknown as [{ sessionId: string }])[0].sessionId)
    expect(sessions).toEqual(['sess-eve', 'sess-eve'])
  })

  it('the idempotency guard is read fresh on a replay: a run that settled meanwhile is not watched again', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom({ guardStatuses: ['running', 'pr_open'] }).from)
    const memo = memoizingStep()
    h.runAgentViaEve.mockRejectedValueOnce(new Error('killed'))

    await expect(agentRunExecute({ event: EVENT, step: memo })).rejects.toThrow('killed')
    const res = await agentRunExecute({ event: EVENT, step: memo })

    expect(res).toMatchObject({ alreadySettled: true })
    expect(h.runAgentViaEve).toHaveBeenCalledTimes(1)
  })

  it('a run the pre-check parked on its questions starts no session (P10 F5)', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom().from)
    h.precheckBeforeSandbox.mockResolvedValueOnce({ parked: true, ran: true })

    const res = await agentRunExecute({ event: EVENT, step: memoizingStep() })

    expect(res).toMatchObject({ ok: false, parked: true, needsClarification: true })
    expect(h.startAgentEveSession).not.toHaveBeenCalled()
    expect(h.runAgentViaEve).not.toHaveBeenCalled()
  })

  it('a retry while parked on a question starts nothing', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom({ guardStatuses: ['needs_input'] }).from)

    const res = await agentRunExecute({ event: EVENT, step: memoizingStep() })

    expect(res).toMatchObject({ ok: false, parked: true })
    expect(h.precheckBeforeSandbox).not.toHaveBeenCalled()
    expect(h.startAgentEveSession).not.toHaveBeenCalled()
  })

  it('stops watching after the token lifetime and leaves the row to the reaper', async () => {
    h.buildAgentRunSpec.mockResolvedValue(runnable('action-1'))
    h.fromImpl.mockImplementation(buildFrom().from)
    h.runAgentViaEve.mockResolvedValue({ settled: null, sessionId: 'sess-eve', pending: { nextIndex: 1 } })

    const res = await agentRunExecute({ event: EVENT, step: memoizingStep() })

    expect(h.runAgentViaEve).toHaveBeenCalledTimes(MAX_WATCH_STEPS)
    expect(res).toMatchObject({ ok: false, watchExhausted: true })
  })
})

describe('reapStaleAgentRuns', () => {
  const NOW = Date.parse('2026-09-25T12:00:00Z')

  function reaperDb(rows: Array<Record<string, unknown>>, liveStatus = 'running', parentRunId: string | null = null) {
    const filters: Record<string, unknown> = {}
    const writes: Array<{ table: string; patch: Record<string, unknown>; took?: boolean }> = []
    const from = vi.fn((table: string) => {
      const c: Record<string, unknown> = {}
      let patch: Record<string, unknown> | null = null
      Object.assign(c, {
        select: () => c,
        eq: (col: string, v: unknown) => ((filters[`eq:${col}`] = v), c),
        in: (col: string, v: unknown) => ((filters[`in:${col}`] = v), c),
        or: (expr: string) => ((filters.or = expr), c),
        limit: async () => ({ data: rows, error: null }),
        update: (p: Record<string, unknown>) => ((patch = p), c),
        // emitChildSettled's read of the reaped run's parent.
        maybeSingle: async () => ({ data: { parent_run_id: parentRunId }, error: null }),
      })
      if (table === 'agent_run') {
        // The CAS update resolves through .select('id').
        c.select = () =>
          patch
            ? (() => {
                const took = ['queued', 'running'].includes(liveStatus)
                writes.push({ table, patch: patch!, took })
                return Promise.resolve({ data: took ? [{ id: 'x' }] : [], error: null })
              })()
            : c
      } else {
        c.eq = () => {
          writes.push({ table, patch: patch! })
          return Promise.resolve({ error: null })
        }
      }
      return c
    })
    return { client: { from } as never, filters, writes }
  }

  beforeEach(() => vi.clearAllMocks())

  it('a reaped delegated child tells its parent, so the parent is never left waiting on it', async () => {
    const db = reaperDb(
      [{ id: 'child-9', workspace_id: 'ws-1', kind: 'workspace', status: 'queued', sandbox_id: null, action_id: null, triggered_by: 'u' }],
      'queued',
      'parent-9',
    )
    expect(await reapStaleAgentRuns(db.client, NOW)).toBe(1)
    expect(h.send).toHaveBeenCalledWith({
      id: 'child-settled:child-9',
      name: 'work/run.child_settled',
      data: { agent_run_id: 'parent-9', child_run_id: 'child-9', workspace_id: 'ws-1' },
    })
  })

  it('fails queued/running CODING rows older than 90 min (coalesce(started_at, created_at)), CAS-guarded, and cancels their eve session', async () => {
    const db = reaperDb([
      { id: 'run-9', workspace_id: 'ws-1', kind: 'coding', status: 'running', sandbox_id: 'eve:sess-9', action_id: 'action-9', triggered_by: 'u' },
    ])
    const n = await reapStaleAgentRuns(db.client, NOW)

    expect(n).toBe(1)
    const cutoff = new Date(NOW - 90 * 60 * 1000).toISOString()
    // Both run kinds are reaped (A2 residual): a stale work run has no other reaper.
    expect(db.filters['in:kind']).toEqual(['coding', 'workspace'])
    expect(db.filters['in:status']).toEqual(['queued', 'running'])
    expect(db.filters.or).toBe(`started_at.lt.${cutoff},and(started_at.is.null,created_at.lt.${cutoff})`)
    expect(db.writes.find((w) => w.table === 'agent_run')?.patch).toMatchObject({ status: 'failed', error_message: STALE_RUN_REASON })
    expect(db.writes.find((w) => w.table === 'actions')?.patch).toEqual({ agent_run_status: 'failed' })
    expect(h.cancelEveCodingSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-9', agentRunId: 'run-9' }))
    expect(h.cancelEveWorkSession).not.toHaveBeenCalled()
    expect(h.mirrorAgentRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      { agentRunId: 'run-9', workspaceId: 'ws-1' },
      { status: 'failed', error: STALE_RUN_REASON },
    )
  })

  it('a stale WORK run (kind=workspace) is failed the same way and its session is canceled on the work-agent mount', async () => {
    const db = reaperDb([
      { id: 'run-w', workspace_id: 'ws-1', kind: 'workspace', status: 'running', sandbox_id: 'eve:sess-w', action_id: 'action-w', triggered_by: 'u' },
    ])
    expect(await reapStaleAgentRuns(db.client, NOW)).toBe(1)
    expect(db.writes.find((w) => w.table === 'agent_run')?.patch).toMatchObject({ status: 'failed', error_message: STALE_RUN_REASON })
    expect(db.writes.find((w) => w.table === 'actions')?.patch).toEqual({ agent_run_status: 'failed' })
    expect(h.cancelEveWorkSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-w', agentRunId: 'run-w', workspaceId: 'ws-1', userId: 'u' }),
    )
    expect(h.cancelEveCodingSession).not.toHaveBeenCalled()
    expect(h.mirrorAgentRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      { agentRunId: 'run-w', workspaceId: 'ws-1' },
      { status: 'failed', error: STALE_RUN_REASON },
    )
  })

  it('a stale work run with no eve stamp is failed without a session cancel', async () => {
    const db = reaperDb([{ id: 'run-w2', workspace_id: 'ws-1', kind: 'workspace', status: 'queued', sandbox_id: null, action_id: null }])
    expect(await reapStaleAgentRuns(db.client, NOW)).toBe(1)
    expect(h.cancelEveWorkSession).not.toHaveBeenCalled()
    expect(h.cancelEveCodingSession).not.toHaveBeenCalled()
  })

  it('a row that settled in the meantime (CAS miss) is left alone', async () => {
    const db = reaperDb([{ id: 'run-9', workspace_id: 'ws-1', kind: 'coding', status: 'running', sandbox_id: 'eve:s', action_id: 'a' }], 'pr_open')
    expect(await reapStaleAgentRuns(db.client, NOW)).toBe(0)
    expect(h.cancelEveCodingSession).not.toHaveBeenCalled()
    expect(h.mirrorAgentRunStatus).not.toHaveBeenCalled()
  })
})

/**
 * F3 — agentRunCancel's settle-canceled write is a CAS: the non-terminal guard lives
 * IN the UPDATE's WHERE (`.not('status','in',(terminal))`), NOT read off the memoized
 * load-run status, so a run that settled completed in the load→settle gap (or on an
 * Inngest retry replaying the memoized load) is NEVER resurrected as canceled. The
 * action is reset to idle ONLY when the cancel write actually took a row.
 */
describe('agentRunCancel — CAS-guarded settle', () => {
  const CANCEL_EVENT = { data: { agent_run_id: 'run-1', workspace_id: 'ws-1' } }

  /**
   * `loadStatus` is what the memoized load-run read returns. `liveStatus` is the
   * row's ACTUAL status at write time (the winner of any race) — the CAS
   * `.not('status','in',(terminal))` matches a row only when liveStatus is
   * non-terminal. Records agent_run + actions writes.
   */
  function buildCancelFrom(opts: {
    loadStatus: string
    liveStatus?: string
    actionId?: string | null
    sandboxId?: string | null
    kind?: string
    /** In-flight delegated children of the run (the subtree cancel's read). */
    children?: string[]
    /** The run's own parent, when it is a delegated child. */
    parentRunId?: string | null
  }) {
    const liveStatus = opts.liveStatus ?? opts.loadStatus
    const actionId = opts.actionId === undefined ? 'action-1' : opts.actionId
    const terminal = ['pr_open', 'completed', 'failed', 'canceled']
    const writes: Array<{ table: string; patch: Record<string, unknown> }> = []

    const from = vi.fn((table: string) => {
      if (table === 'agent_run') {
        const chain: Record<string, unknown> = {}
        let notTerminalGuard = false
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          not: (col: string, op: string) => {
            if (col === 'status' && op === 'in') notTerminalGuard = true
            return chain
          },
          // The subtree cancel's read of in-flight children.
          in: async () => ({ data: (opts.children ?? []).map((id) => ({ id })), error: null }),
          // emitChildSettled's read of the run's own parent.
          maybeSingle: async () => ({ data: { parent_run_id: opts.parentRunId ?? null }, error: null }),
          single: async () => ({
            data: {
              id: 'run-1',
              status: opts.loadStatus,
              sandbox_id: opts.sandboxId === undefined ? 'eve:sess-1' : opts.sandboxId,
              action_id: actionId,
              kind: opts.kind ?? 'coding',
              triggered_by: 'user-7',
            },
            error: null,
          }),
          update: (patch: Record<string, unknown>) => {
            const upd: Record<string, unknown> = {}
            let childId: string | null = null
            Object.assign(upd, {
              eq: (col: string, v: string) => {
                if (col === 'id' && v !== 'run-1') childId = v
                return upd
              },
              not: (col: string, op: string) => {
                if (col === 'status' && op === 'in') notTerminalGuard = true
                return upd
              },
              in: () => upd,
              select: async () => {
                // A child's CAS to canceling (the subtree cancel) always takes here.
                if (childId) {
                  writes.push({ table: 'agent_run', patch: { ...patch, id: childId } })
                  return { data: [{ id: childId }], error: null }
                }
                // The CAS takes iff the guard is present AND the live row is non-terminal.
                const took = notTerminalGuard && !terminal.includes(liveStatus)
                if (took) writes.push({ table: 'agent_run', patch })
                return { data: took ? [{ id: 'run-1' }] : [], error: null }
              },
            })
            return upd
          },
        })
        return chain
      }
      if (table === 'tracked_job') {
        // The work ledger's lookup after a won cancel (`findWork`: select → eq →
        // order → limit → maybeSingle). No row here: the mirror is a no-op.
        const lchain: Record<string, unknown> = {}
        Object.assign(lchain, {
          select: () => lchain,
          eq: () => lchain,
          order: () => lchain,
          limit: () => lchain,
          maybeSingle: async () => ({ data: null, error: null }),
        })
        return lchain
      }
      // actions mirror
      const achain: Record<string, unknown> = {}
      Object.assign(achain, {
        update: (patch: Record<string, unknown>) => {
          writes.push({ table: 'actions', patch })
          return { eq: () => Promise.resolve({ error: null }) }
        },
      })
      return achain
    })
    return { from, writes }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => vi.clearAllMocks())

  it('cancels a live (running) run: writes canceled + resets the action to idle', async () => {
    const { from, writes } = buildCancelFrom({ loadStatus: 'running', liveStatus: 'running' })
    h.fromImpl.mockImplementation(from)
    await agentRunCancel({ event: CANCEL_EVENT, step })

    const cancelWrite = writes.find((w) => w.table === 'agent_run' && w.patch.status === 'canceled')
    expect(cancelWrite).toBeDefined()
    expect(cancelWrite!.patch.pending_input).toBeNull()
    const actionReset = writes.find((w) => w.table === 'actions' && w.patch.agent_run_status === 'idle')
    expect(actionReset).toBeDefined()
  })

  it('stopping a run stops the work it handed over: each in-flight child is flipped to canceling and sent its own cancel', async () => {
    const { from, writes } = buildCancelFrom({ loadStatus: 'needs_input', liveStatus: 'needs_input', kind: 'workspace', children: ['child-1', 'child-2'] })
    h.fromImpl.mockImplementation(from)
    await agentRunCancel({ event: CANCEL_EVENT, step })

    const flipped = writes.filter((w) => w.table === 'agent_run' && w.patch.status === 'canceling').map((w) => w.patch.id)
    expect(flipped).toEqual(['child-1', 'child-2'])
    expect(h.send).toHaveBeenCalledWith([
      { name: 'agent/run.cancel', data: { agent_run_id: 'child-1', workspace_id: 'ws-1', reason: 'The run that handed this over was stopped' } },
      { name: 'agent/run.cancel', data: { agent_run_id: 'child-2', workspace_id: 'ws-1', reason: 'The run that handed this over was stopped' } },
    ])
  })

  it('a canceled delegated child tells its parent (work/run.child_settled)', async () => {
    const { from } = buildCancelFrom({ loadStatus: 'running', liveStatus: 'running', kind: 'workspace', parentRunId: 'parent-1' })
    h.fromImpl.mockImplementation(from)
    await agentRunCancel({ event: CANCEL_EVENT, step })
    expect(h.send).toHaveBeenCalledWith({
      id: 'child-settled:run-1',
      name: 'work/run.child_settled',
      data: { agent_run_id: 'parent-1', child_run_id: 'run-1', workspace_id: 'ws-1' },
    })
  })

  it('does NOT clobber a run that completed in the load→settle gap (CAS misses, no action reset)', async () => {
    // load-run read 'running' (memoized), but the row is actually 'completed' now.
    const { from, writes } = buildCancelFrom({ loadStatus: 'running', liveStatus: 'completed' })
    h.fromImpl.mockImplementation(from)
    await agentRunCancel({ event: CANCEL_EVENT, step })

    // The CAS matched 0 rows → NO canceled write, NO action reset (the completed
    // winner owns the action state + its "ready for review" notification).
    expect(writes.find((w) => w.table === 'agent_run')).toBeUndefined()
    expect(writes.find((w) => w.table === 'actions')).toBeUndefined()
  })

  it("a coding run's eve session is cancelled server-side (turn + tasks) so Stop preempts the agent", async () => {
    const { from } = buildCancelFrom({ loadStatus: 'running', sandboxId: 'eve:sess-9' })
    h.fromImpl.mockImplementation(from)
    const res = await agentRunCancel({ event: CANCEL_EVENT, step })
    expect(res).toEqual({ ok: true, eveSession: true, sessionCancel: 'accepted' })
    expect(h.cancelEveCodingSession).toHaveBeenCalledTimes(1)
    expect(h.cancelEveCodingSession).toHaveBeenCalledWith({
      sessionId: 'sess-9',
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-7',
    })
    // It ran as its own durable step.
    expect(step.run.mock.calls.map((c) => c[0])).toContain('cancel-eve-session')
  })

  it('cancels the session even when a watcher already settled the row (lost CAS)', async () => {
    const { from, writes } = buildCancelFrom({ loadStatus: 'canceling', liveStatus: 'canceled', sandboxId: 'eve:sess-9' })
    h.fromImpl.mockImplementation(from)
    await agentRunCancel({ event: CANCEL_EVENT, step })
    expect(writes).toEqual([])
    expect(h.cancelEveCodingSession).toHaveBeenCalledTimes(1)
  })

  it("a work run (kind='workspace') has its session cancelled on the WORK-agent mount, never the coding one (Stop must stop)", async () => {
    const { from, writes } = buildCancelFrom({ loadStatus: 'running', sandboxId: 'eve:sess-9', kind: 'workspace' })
    h.fromImpl.mockImplementation(from)
    const res = await agentRunCancel({ event: CANCEL_EVENT, step })
    expect(res).toEqual({ ok: true, eveSession: true, sessionCancel: 'accepted' })
    expect(h.cancelEveWorkSession).toHaveBeenCalledTimes(1)
    expect(h.cancelEveWorkSession).toHaveBeenCalledWith({
      sessionId: 'sess-9',
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-7',
    })
    expect(h.cancelEveCodingSession).not.toHaveBeenCalled()
    // The row still settles canceled with its park released.
    const cancelWrite = writes.find((w) => w.table === 'agent_run' && w.patch.status === 'canceled')
    expect(cancelWrite?.patch.pending_input).toBeNull()
    expect(cancelWrite?.patch.error_message).toBe('Canceled by user')
    expect(h.mirrorAgentRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      { agentRunId: 'run-1', workspaceId: 'ws-1' },
      { status: 'canceled', reason: 'Canceled by user' },
    )
  })

  it("a parked work run (needs_input) is cancelled the same way: the session cancel runs and the park is released", async () => {
    const { from, writes } = buildCancelFrom({ loadStatus: 'needs_input', sandboxId: 'eve:sess-p', kind: 'workspace' })
    h.fromImpl.mockImplementation(from)
    await agentRunCancel({ event: CANCEL_EVENT, step })
    expect(h.cancelEveWorkSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-p' }))
    const cancelWrite = writes.find((w) => w.table === 'agent_run' && w.patch.status === 'canceled')
    expect(cancelWrite).toBeDefined()
    expect(cancelWrite!.patch.pending_input).toBeNull()
  })

  it('the event may carry a reason (the workspace kill switch names itself); it lands on the row and the ledger', async () => {
    const { from, writes } = buildCancelFrom({ loadStatus: 'running', sandboxId: 'eve:sess-9', kind: 'workspace' })
    h.fromImpl.mockImplementation(from)
    await agentRunCancel({
      event: { ...CANCEL_EVENT, data: { ...CANCEL_EVENT.data, reason: 'Canceled: agent autonomy was switched off for this workspace' } },
      step,
    })
    const cancelWrite = writes.find((w) => w.table === 'agent_run' && w.patch.status === 'canceled')
    expect(cancelWrite?.patch.error_message).toBe('Canceled: agent autonomy was switched off for this workspace')
    expect(h.mirrorAgentRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { status: 'canceled', reason: 'Canceled: agent autonomy was switched off for this workspace' },
    )
  })

  it('still settles a run with no sandbox id yet (canceled while queued); no session to cancel', async () => {
    const { from, writes } = buildCancelFrom({ loadStatus: 'queued', sandboxId: null })
    h.fromImpl.mockImplementation(from)
    const res = await agentRunCancel({ event: CANCEL_EVENT, step })
    expect(res).toEqual({ ok: true, eveSession: false, sessionCancel: null })
    expect(writes.find((w) => w.table === 'agent_run' && w.patch.status === 'canceled')).toBeDefined()
    expect(h.cancelEveCodingSession).not.toHaveBeenCalled()
  })

  it('a bare (retired-runner) sandbox id is not treated as an eve session', async () => {
    const { from } = buildCancelFrom({ loadStatus: 'running', sandboxId: 'sbx_legacy' })
    h.fromImpl.mockImplementation(from)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await agentRunCancel({ event: CANCEL_EVENT, step })
    expect(res).toEqual({ ok: true, eveSession: false, sessionCancel: null })
    expect(h.cancelEveCodingSession).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
