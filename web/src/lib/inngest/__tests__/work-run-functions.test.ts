/**
 * Handler tests for the WORK-RUN Inngest functions (Loops v3 — Phase 1-2
 * work-run-execute + Phase 3 work-run-resume;
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md).
 *
 * These functions are closures passed to inngest.createFunction; we capture them
 * by stubbing createFunction, mock the service client + the run-work-eve driver,
 * and drive the handler directly.
 *
 * The load-bearing properties:
 *   - ONE RUN = ONE EVE SESSION. The session is created in its own memoized step
 *     and then watched in budgeted steps that re-attach by id (the /api/inngest
 *     request budget is 300s; a turn can be longer). An Inngest retry after a
 *     killed request replays the memoized session id and keeps watching it —
 *     never a second agent on the same task (precondition A1 of
 *     docs/plans/agent-orchestration-investigation.md).
 *   - The idempotency guard is read FRESH on every replay, never from the
 *     memoized context: a run that settled meanwhile is not watched again.
 *   - A watch that returns `pending` hands the next watch its resume index and
 *     any park it saw.
 *   - work-run-resume answers the approval in its own memoized step and then
 *     watches the resumed turn in the same loop; a run that is no longer
 *     queued (canceled/settled in the gap) is a no-op, and a non-workspace or
 *     missing run is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorkRunBrief } from '@/lib/agent-run/run-work-eve'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

const h = vi.hoisted(() => {
  const handlers: Record<string, unknown> = {}
  return {
    handlers,
    startWorkEveSession: vi.fn(async (_args: unknown) => ({
      sessionId: 'sess-eve',
      stamped: true,
      reused: false,
      fromIndex: 0,
    })),
    watchWorkEveSession: vi.fn(
      async (
        _args: unknown,
      ): Promise<{
        settled: 'failed' | 'canceled' | 'needs_input' | null
        sessionId: string | null
        pending?: { nextIndex: number; pendingInput: unknown }
      }> => ({ settled: null, sessionId: 'sess-eve' }),
    ),
    resumeWorkEveSession: vi.fn(
      async (
        _args: unknown,
      ): Promise<
        | { kind: 'resumed'; sessionId: string; fromIndex: number }
        | { kind: 'skipped'; sessionId: string | null; settled: 'failed' | null }
      > => ({ kind: 'resumed', sessionId: 'sess-eve', fromIndex: 7 }),
    ),
    releaseDelegationPark: vi.fn(
      async (
        _args: unknown,
      ): Promise<
        | { kind: 'resumed'; sessionId: string; fromIndex: number }
        | { kind: 'skipped' | 'waiting'; sessionId: string | null; settled: 'failed' | null }
      > => ({ kind: 'resumed', sessionId: 'sess-eve', fromIndex: 11 }),
    ),
    fromImpl: vi.fn(),
    // package_visible_to RPC (mig 238 drift-window re-check in
    // loadPackageContext). Default: every declared package is still visible.
    rpcImpl: vi.fn(
      async (_fn: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => ({
        data: true,
        error: null,
      }),
    ),
    mirrorAgentRunStatus: vi.fn(async () => {}),
    // B PR 4: the brief's source (provenance.ts, tested on its own).
    loadBriefSource: vi.fn(async (_sb: unknown, _args: Record<string, unknown>): Promise<unknown> => undefined),
    // Row 15: the teammate's memory (agent-memory.ts, tested on its own).
    loadTeammateMemory: vi.fn(async (_sb: unknown, _args: Record<string, unknown>): Promise<unknown> => undefined),
    // Extra per-table rows for executeDb's non-agent_run reads.
    tableRows: {} as Record<string, Record<string, unknown> | null>,
  }
})

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, handler: unknown) => {
      h.handlers[config.id] = handler
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ from: h.fromImpl, rpc: h.rpcImpl }),
}))
vi.mock('@/lib/agent-run/run-work-eve', () => ({
  startWorkEveSession: h.startWorkEveSession,
  watchWorkEveSession: h.watchWorkEveSession,
  resumeWorkEveSession: h.resumeWorkEveSession,
  releaseDelegationPark: h.releaseDelegationPark,
}))
vi.mock('@/lib/work/agent-run-mirror', () => ({ mirrorAgentRunStatus: h.mirrorAgentRunStatus }))
vi.mock('@/lib/work/provenance', () => ({ loadBriefSource: h.loadBriefSource }))
vi.mock('@/lib/work/agent-memory', () => ({ loadTeammateMemory: h.loadTeammateMemory }))

const { WORK_WATCH_STEP_BUDGET_MS, MAX_WORK_WATCH_STEPS } = await import('@/lib/inngest/work-run-functions')

type Handler = (arg: { event: { data: Record<string, unknown> }; step: StepMock }) => Promise<unknown>
const executeHandler = () => h.handlers['work-run-execute'] as Handler
const resumeHandler = () => h.handlers['work-run-resume'] as Handler
const childSettledHandler = () => h.handlers['work-run-child-settled'] as Handler

const EVENT = { data: { agent_run_id: 'run-1', workspace_id: 'ws-1' } }

/**
 * A step mock that MEMOIZES completed step.run results by id across handler
 * invocations, like Inngest does on a retry/replay. A step whose callback threw
 * (the request was killed mid-step) is not memoized and re-runs.
 */
function memoizingStep(): StepMock {
  const done = new Map<string, unknown>()
  const run = vi.fn(async (id: string, fn: () => unknown) => {
    if (done.has(id)) return done.get(id)
    const out = await fn()
    done.set(id, out)
    return out
  })
  return { run } as unknown as StepMock
}

function stepIds(step: StepMock): string[] {
  return (step.run as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0])
}

/**
 * A stateful agent_run row for the execute handler: the memoized context read
 * sees it once; every later `.maybeSingle()` on agent_run is the FRESH guard read.
 * Other tables answer empty.
 */
function executeDb(init: Partial<Record<string, unknown>> = {}) {
  const row: Record<string, unknown> = {
    id: 'run-1',
    status: 'queued',
    kind: 'workspace',
    task_prompt: 'Draft a follow-up email to Randy about GA access.',
    resources: [],
    triggered_by: 'user-1',
    attention_item_id: null,
    action_id: null,
    sandbox_id: null,
    ...init,
  }
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = []
  h.fromImpl.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      not: () => chain,
      update: (patch: Record<string, unknown>) => {
        updates.push({ table, patch })
        if (table === 'agent_run') Object.assign(row, patch)
        return chain
      },
      maybeSingle: () => Promise.resolve({ data: table === 'agent_run' ? { ...row } : (h.tableRows[table] ?? null), error: null }),
      single: () => Promise.resolve({ data: table === 'agent_run' ? { ...row } : null, error: null }),
      then: (r: (x: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
    }
    return chain
  })
  return { row, updates }
}

describe('workRunExecute — one session per run, watched across requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.fromImpl.mockReset()
    h.startWorkEveSession.mockResolvedValue({ sessionId: 'sess-eve', stamped: true, reused: false, fromIndex: 0 })
    h.watchWorkEveSession.mockResolvedValue({ settled: null, sessionId: 'sess-eve' })
  })

  it('creates the session in its own step with the brief, then watches it by id with a per-request budget', async () => {
    executeDb()
    const step = memoizingStep()

    const res = await executeHandler()({ event: EVENT, step })

    expect(stepIds(step)).toEqual(['load-work-context', 'create-eve-session', 'watch-eve-session-0'])
    const startArg = h.startWorkEveSession.mock.calls[0][0] as { brief: WorkRunBrief; userId: string }
    expect(startArg.userId).toBe('user-1')
    expect(startArg.brief.task).toBe('Draft a follow-up email to Randy about GA access.')
    expect(h.watchWorkEveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-eve', fromIndex: 0, budgetMs: WORK_WATCH_STEP_BUDGET_MS, carriedPendingInput: null }),
    )
    // The watch budget must fit inside /api/inngest's maxDuration (300s).
    expect(WORK_WATCH_STEP_BUDGET_MS).toBeLessThan(300_000)
    expect(res).toMatchObject({ ok: true, settled: null, sessionId: 'sess-eve' })
  })

  it('B PR 4: the brief names the teammate and carries where the work came from', async () => {
    h.tableRows = { ai_team_member: { name: 'Quill', role: 'writer' } }
    const source = { quote: 'draft the Q3 kickoff note', captureId: 'cap-1', captureTitle: 'Sync w/ Cori', excerpt: 'Cori: could you draft the Q3 kickoff note?' }
    h.loadBriefSource.mockResolvedValueOnce(source)
    executeDb({ ai_team_member_id: 'tm-quill' })
    await executeHandler()({ event: EVENT, step: memoizingStep() })
    const brief = (h.startWorkEveSession.mock.calls[0][0] as { brief: WorkRunBrief }).brief
    expect(brief.teammate).toEqual({ name: 'Quill', role: 'writer' })
    expect(brief.source).toEqual(source)
    expect(h.loadBriefSource).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', agentRunId: 'run-1', triggeredBy: 'user-1' })
    h.tableRows = {}
  })

  it('B PR 4: with no teammate and no provenance the brief is exactly as before', async () => {
    executeDb()
    await executeHandler()({ event: EVENT, step: memoizingStep() })
    const brief = (h.startWorkEveSession.mock.calls[0][0] as { brief: WorkRunBrief }).brief
    expect('teammate' in brief).toBe(false)
    expect('source' in brief).toBe(false)
    // Row 15: no teammate, no memory read.
    expect('memory' in brief).toBe(false)
    expect(h.loadTeammateMemory).not.toHaveBeenCalled()
  })

  it("row 15: the brief carries what the teammate remembers, recalled for the run's user", async () => {
    h.tableRows = { ai_team_member: { name: 'Quill', role: 'writer' } }
    const memory = [{ kind: 'preference', text: 'Dana wants kickoff notes as three bullets.' }]
    h.loadTeammateMemory.mockResolvedValueOnce(memory)
    executeDb({ ai_team_member_id: 'tm-quill' })
    await executeHandler()({ event: EVENT, step: memoizingStep() })
    const brief = (h.startWorkEveSession.mock.calls[0][0] as { brief: WorkRunBrief }).brief
    expect(brief.memory).toEqual(memory)
    expect(h.loadTeammateMemory).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', teammateId: 'tm-quill', userId: 'user-1' })
    h.tableRows = {}
  })

  it('row 15: a teammate with nothing remembered leaves memory out', async () => {
    h.tableRows = { ai_team_member: { name: 'Quill', role: 'writer' } }
    executeDb({ ai_team_member_id: 'tm-quill' })
    await executeHandler()({ event: EVENT, step: memoizingStep() })
    const brief = (h.startWorkEveSession.mock.calls[0][0] as { brief: WorkRunBrief }).brief
    expect(brief.teammate).toEqual({ name: 'Quill', role: 'writer' })
    expect('memory' in brief).toBe(false)
    h.tableRows = {}
  })

  it('a turn longer than one watch continues from where the last watch stopped, carrying a park it saw', async () => {
    executeDb()
    const pendingInput = { requestId: 'req-1', approveOptionId: 'approve', denyOptionId: 'cancel', questions: [], askedAt: 'x' }
    h.watchWorkEveSession
      .mockResolvedValueOnce({ settled: null, sessionId: 'sess-eve', pending: { nextIndex: 40, pendingInput: null } })
      .mockResolvedValueOnce({ settled: null, sessionId: 'sess-eve', pending: { nextIndex: 95, pendingInput } })
      .mockResolvedValueOnce({ settled: 'needs_input', sessionId: 'sess-eve' })

    const res = await executeHandler()({ event: EVENT, step: memoizingStep() })

    expect(h.startWorkEveSession).toHaveBeenCalledTimes(1)
    const calls = h.watchWorkEveSession.mock.calls.map(
      (c) => (c as unknown as [{ fromIndex: number; carriedPendingInput: unknown }])[0],
    )
    expect(calls.map((c) => c.fromIndex)).toEqual([0, 40, 95])
    expect(calls.map((c) => c.carriedPendingInput)).toEqual([null, null, pendingInput])
    expect(res).toMatchObject({ ok: true, settled: 'needs_input' })
  })

  it('A1: an Inngest retry after a killed request re-attaches to the SAME session — no second agent', async () => {
    const { row } = executeDb()
    const step = memoizingStep()
    // Attempt 1: the session exists (row running + stamped), then the request dies
    // mid-watch — the watch step is NOT memoized.
    h.watchWorkEveSession.mockImplementationOnce(async () => {
      row.status = 'running'
      row.sandbox_id = 'eve:sess-eve'
      throw new Error('FUNCTION_INVOCATION_TIMEOUT')
    })

    await expect(executeHandler()({ event: EVENT, step })).rejects.toThrow('FUNCTION_INVOCATION_TIMEOUT')
    await executeHandler()({ event: EVENT, step }) // the retry

    // The create step replayed its memoized result; the watch re-attached by id.
    expect(h.startWorkEveSession).toHaveBeenCalledTimes(1)
    const sessions = h.watchWorkEveSession.mock.calls.map((c) => (c as unknown as [{ sessionId: string }])[0].sessionId)
    expect(sessions).toEqual(['sess-eve', 'sess-eve'])
  })

  it('a reused session (an earlier attempt stamped it before the create step memoized) is watched from its persisted cursor', async () => {
    executeDb({ status: 'running', sandbox_id: 'eve:sess-prior' })
    h.startWorkEveSession.mockResolvedValueOnce({ sessionId: 'sess-prior', stamped: true, reused: true, fromIndex: 33 })

    await executeHandler()({ event: EVENT, step: memoizingStep() })

    expect(h.watchWorkEveSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-prior', fromIndex: 33 }))
  })

  it('the idempotency guard is read fresh on a replay: a run that settled meanwhile is not watched again', async () => {
    const { row } = executeDb()
    const step = memoizingStep()
    h.watchWorkEveSession.mockImplementationOnce(async () => {
      row.status = 'completed' // finish_work landed, then the request died
      throw new Error('killed')
    })

    await expect(executeHandler()({ event: EVENT, step })).rejects.toThrow('killed')
    const res = await executeHandler()({ event: EVENT, step })

    expect(res).toMatchObject({ alreadySettled: true })
    expect(h.watchWorkEveSession).toHaveBeenCalledTimes(1)
  })

  it('a replay against a run that parked (needs_input) starts and watches nothing — the resume function owns it', async () => {
    executeDb({ status: 'needs_input', sandbox_id: 'eve:sess-eve' })

    const res = await executeHandler()({ event: EVENT, step: memoizingStep() })

    expect(res).toMatchObject({ skipped: true, status: 'needs_input' })
    expect(h.startWorkEveSession).not.toHaveBeenCalled()
    expect(h.watchWorkEveSession).not.toHaveBeenCalled()
  })

  it('a run with no task is settled failed before any session is created', async () => {
    executeDb({ task_prompt: '   ' })

    const res = await executeHandler()({ event: EVENT, step: memoizingStep() })

    expect(res).toMatchObject({ ok: false, reason: 'no task' })
    expect(h.startWorkEveSession).not.toHaveBeenCalled()
    expect(h.mirrorAgentRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      { agentRunId: 'run-1', workspaceId: 'ws-1' },
      expect.objectContaining({ status: 'failed' }),
    )
  })

  it('stops watching after the step cap and leaves the row to the reaper', async () => {
    executeDb()
    h.watchWorkEveSession.mockResolvedValue({ settled: null, sessionId: 'sess-eve', pending: { nextIndex: 1, pendingInput: null } })

    const res = await executeHandler()({ event: EVENT, step: memoizingStep() })

    expect(h.watchWorkEveSession).toHaveBeenCalledTimes(MAX_WORK_WATCH_STEPS)
    expect(res).toMatchObject({ ok: false, watchExhausted: true })
  })
})

/** A one-row agent_run read stub for the resume handler's load. */
function resumeDb(run: Record<string, unknown> | null) {
  h.fromImpl.mockImplementation((table: string) => {
    if (table !== 'agent_run') throw new Error(`unexpected table ${table}`)
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: run, error: null }),
    }
    return chain
  })
}

describe('workRunResume handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.fromImpl.mockReset()
    h.resumeWorkEveSession.mockResolvedValue({ kind: 'resumed', sessionId: 'sess-eve', fromIndex: 7 })
    h.watchWorkEveSession.mockResolvedValue({ settled: null, sessionId: 'sess-eve' })
  })

  it('answers the park in its own memoized step, forwarding the response + request_id, then watches from the resumed cursor', async () => {
    resumeDb({ status: 'queued', kind: 'workspace', triggered_by: 'user-1' })
    const response = { answers: [{ question: 'Which env?', answer: 'Staging' }] }
    const step = memoizingStep()

    const res = (await resumeHandler()({
      event: { data: { agent_run_id: 'run-1', workspace_id: 'ws-1', response, request_id: 'req-42' } },
      step,
    })) as { ok: boolean }

    expect(stepIds(step)).toEqual(['resume-eve-session', 'watch-eve-session-0'])
    expect(h.resumeWorkEveSession).toHaveBeenCalledTimes(1)
    const arg = h.resumeWorkEveSession.mock.calls[0][0] as Record<string, unknown>
    expect(arg.agentRunId).toBe('run-1')
    expect(arg.workspaceId).toBe('ws-1')
    expect(arg.userId).toBe('user-1')
    expect(arg.response).toEqual(response)
    // The answered question's requestId rides through so the driver can reject a
    // stale at-least-once duplicate (F4).
    expect(arg.expectedRequestId).toBe('req-42')
    expect(h.watchWorkEveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-eve', fromIndex: 7, budgetMs: WORK_WATCH_STEP_BUDGET_MS }),
    )
    expect(res.ok).toBe(true)
  })

  it('forwards a null expectedRequestId when the event carries no request_id (legacy)', async () => {
    resumeDb({ status: 'queued', kind: 'workspace', triggered_by: 'user-1' })
    await resumeHandler()({
      event: { data: { agent_run_id: 'run-1', workspace_id: 'ws-1', response: {} } },
      step: memoizingStep(),
    })
    const arg = h.resumeWorkEveSession.mock.calls[0][0] as Record<string, unknown>
    expect(arg.expectedRequestId).toBeNull()
  })

  it('a retry after a killed request replays the memoized resume and keeps watching the same session', async () => {
    const run: Record<string, unknown> = { status: 'queued', kind: 'workspace', triggered_by: 'user-1' }
    resumeDb(run)
    const step = memoizingStep()
    const event = { data: { agent_run_id: 'run-1', workspace_id: 'ws-1', response: {}, request_id: 'req-42' } }
    h.watchWorkEveSession.mockImplementationOnce(async () => {
      run.status = 'running' // the resume step's CAS took before the request died
      throw new Error('FUNCTION_INVOCATION_TIMEOUT')
    })

    await expect(resumeHandler()({ event, step })).rejects.toThrow('FUNCTION_INVOCATION_TIMEOUT')
    await resumeHandler()({ event, step })

    expect(h.resumeWorkEveSession).toHaveBeenCalledTimes(1)
    expect(h.watchWorkEveSession).toHaveBeenCalledTimes(2)
  })

  it('a skipped resume (stale duplicate / no session / CAS lost) watches nothing', async () => {
    resumeDb({ status: 'queued', kind: 'workspace', triggered_by: 'user-1' })
    h.resumeWorkEveSession.mockResolvedValueOnce({ kind: 'skipped', sessionId: 'sess-eve', settled: 'failed' })

    const res = await resumeHandler()({
      event: { data: { agent_run_id: 'run-1', workspace_id: 'ws-1', response: {} } },
      step: memoizingStep(),
    })

    expect(res).toMatchObject({ ok: false, settled: 'failed' })
    expect(h.watchWorkEveSession).not.toHaveBeenCalled()
  })

  it('no-ops when the run is not queued (canceled/settled in the gap)', async () => {
    resumeDb({ status: 'canceled', kind: 'workspace', triggered_by: 'user-1' })
    const res = (await resumeHandler()({
      event: { data: { agent_run_id: 'run-1', workspace_id: 'ws-1', response: {} } },
      step: memoizingStep(),
    })) as { ok: boolean; reason?: string }
    expect(h.resumeWorkEveSession).not.toHaveBeenCalled()
    expect(res.ok).toBe(true)
    expect(res.reason).toBe('run not queued for resume')
  })

  it('refuses a non-workspace run and a missing run', async () => {
    resumeDb({ status: 'queued', kind: 'coding', triggered_by: 'user-1' })
    const res1 = (await resumeHandler()({
      event: { data: { agent_run_id: 'run-1', workspace_id: 'ws-1', response: {} } },
      step: memoizingStep(),
    })) as { ok: boolean; reason?: string }
    expect(res1).toMatchObject({ ok: false, reason: 'not a workspace run' })

    resumeDb(null)
    const res2 = (await resumeHandler()({
      event: { data: { agent_run_id: 'run-1', workspace_id: 'ws-1', response: {} } },
      step: memoizingStep(),
    })) as { ok: boolean; reason?: string }
    expect(res2).toMatchObject({ ok: false, reason: 'run not found' })
    expect(h.resumeWorkEveSession).not.toHaveBeenCalled()
  })
})

describe('workRunChildSettled — a delegated child settled: release the parent, then watch it', () => {
  const CHILD_EVENT = { data: { agent_run_id: 'run-1', child_run_id: 'child-1', workspace_id: 'ws-1' } }
  beforeEach(() => {
    vi.clearAllMocks()
    h.fromImpl.mockReset()
    h.releaseDelegationPark.mockResolvedValue({ kind: 'resumed', sessionId: 'sess-eve', fromIndex: 11 })
    h.watchWorkEveSession.mockResolvedValue({ settled: null, sessionId: 'sess-eve' })
  })

  it('releases the park in its own memoized step, then watches the resumed turn as the run-as user', async () => {
    resumeDb({ status: 'needs_input', kind: 'workspace', triggered_by: 'user-1' })
    const step = memoizingStep()
    const res = (await childSettledHandler()({ event: CHILD_EVENT, step })) as { ok: boolean }

    expect(stepIds(step)).toEqual(['release-parent', 'watch-eve-session-0'])
    expect(h.releaseDelegationPark).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'run-1', workspaceId: 'ws-1' }))
    expect(h.watchWorkEveSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunId: 'run-1', userId: 'user-1', sessionId: 'sess-eve', fromIndex: 11 }),
    )
    expect(res.ok).toBe(true)
  })

  it('a retry replays the memoized release and never answers the park twice', async () => {
    resumeDb({ status: 'running', kind: 'workspace', triggered_by: 'user-1' })
    const step = memoizingStep()
    h.watchWorkEveSession.mockImplementationOnce(async () => {
      throw new Error('FUNCTION_INVOCATION_TIMEOUT')
    })
    await expect(childSettledHandler()({ event: CHILD_EVENT, step })).rejects.toThrow('FUNCTION_INVOCATION_TIMEOUT')
    await childSettledHandler()({ event: CHILD_EVENT, step })
    expect(h.releaseDelegationPark).toHaveBeenCalledTimes(1)
    expect(h.watchWorkEveSession).toHaveBeenCalledTimes(2)
  })

  it('watches nothing while another child is still running, or when there is nothing to release', async () => {
    resumeDb({ status: 'needs_input', kind: 'workspace', triggered_by: 'user-1' })
    h.releaseDelegationPark.mockResolvedValueOnce({ kind: 'waiting', sessionId: 'sess-eve', settled: null })
    expect(await childSettledHandler()({ event: CHILD_EVENT, step: memoizingStep() })).toMatchObject({ ok: true, released: 'waiting' })
    h.releaseDelegationPark.mockResolvedValueOnce({ kind: 'skipped', sessionId: null, settled: 'failed' })
    expect(await childSettledHandler()({ event: CHILD_EVENT, step: memoizingStep() })).toMatchObject({ ok: false, released: 'skipped' })
    expect(h.watchWorkEveSession).not.toHaveBeenCalled()
  })

  it('refuses a parent that is not a work run, or is gone', async () => {
    resumeDb({ status: 'needs_input', kind: 'coding', triggered_by: 'user-1' })
    expect(await childSettledHandler()({ event: CHILD_EVENT, step: memoizingStep() })).toMatchObject({ ok: false })
    resumeDb(null)
    expect(await childSettledHandler()({ event: CHILD_EVENT, step: memoizingStep() })).toMatchObject({ ok: false })
    expect(h.releaseDelegationPark).not.toHaveBeenCalled()
  })
})
