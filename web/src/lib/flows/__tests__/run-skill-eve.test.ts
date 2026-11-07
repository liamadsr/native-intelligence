/**
 * Executor-branch tests for the eve run_skill runtime (Phase 2):
 *   - usage/cost summing from step.completed events (faithful mapping);
 *   - tool-call counting from actions.requested;
 *   - runViaEve dispatch: prose vs verdict (outputSchema), TASK mode, timeout
 *     signal, failure surfacing — with eve/client + the task-session helper mocked;
 *   - WS-4c verdict salvage: a verdict committed (result.completed) before the
 *     session failed / the stream aborted is returned, not lost;
 *   - the live tool-call hook (Activity panel step text, names only);
 *   - the wall stops the SERVER session (cancelTaskSession) and the run token
 *     is minted to expire shortly after the wall.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'

const SECRET = 'test-internal-secret-abcdefghij'

// ── Mock eve/client (client construction) + the task-session helper (dispatch) ─
// runViaEve builds a Client (mount + auth headers asserted below), then dispatches
// through createTaskSession — which is what carries `mode: 'task'`. We mock the
// helper so the suite is independent of the network AND assert the run went
// through the task-mode path (never the mode-less typed send()).
const h = vi.hoisted(() => {
  const createTaskSessionMock = vi.fn()
  const cancelTaskSessionMock = vi.fn(async () => true)
  const retireTaskSessionMock = vi.fn(async () => true)
  const ClientMock = vi.fn(() => ({ /* opaque handle passed to createTaskSession */ }))
  return { createTaskSessionMock, cancelTaskSessionMock, retireTaskSessionMock, ClientMock }
})
const { createTaskSessionMock, cancelTaskSessionMock, retireTaskSessionMock, ClientMock } = h
vi.mock('eve/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('eve/client')>()), Client: h.ClientMock }))
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: h.createTaskSessionMock,
  cancelTaskSession: h.cancelTaskSessionMock,
  retireTaskSession: h.retireTaskSessionMock,
}))

import {
  sumEveUsage,
  countEveToolCalls,
  runViaEve,
  committedResult,
  EveRunTimeoutError,
  EveSessionFailedError,
  RUN_TOKEN_WALL_MARGIN_MS,
  CANCELLED_TURN_REASON,
} from '../run-skill-eve'
import { verifyRunToken } from '../skill-run-token'
import type { SkillRunSpec } from '../run-skill'

function stepCompleted(input: number, output: number, costUsd?: number): HandleMessageStreamEvent {
  return {
    type: 'step.completed',
    data: {
      finishReason: 'stop',
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
      usage: { inputTokens: input, outputTokens: output, ...(costUsd != null ? { costUsd } : {}) },
    },
  } as HandleMessageStreamEvent
}

function actionsRequested(count: number): HandleMessageStreamEvent {
  return {
    type: 'actions.requested',
    data: { actions: Array.from({ length: count }, () => ({})), sequence: 0, stepIndex: 0, turnId: 't' },
  } as unknown as HandleMessageStreamEvent
}

describe('sumEveUsage', () => {
  it('sums tokens and cost across step.completed events', () => {
    const events = [stepCompleted(100, 50, 0.001), stepCompleted(200, 80, 0.002)]
    const u = sumEveUsage(events)
    expect(u.inputTokens).toBe(300)
    expect(u.outputTokens).toBe(130)
    expect(u.costUsd).toBeCloseTo(0.003)
    expect(u.steps).toBe(2)
  })

  it('leaves cost null when NO step reports a cost (RPC pricing fallback)', () => {
    const events = [stepCompleted(100, 50), stepCompleted(200, 80)]
    const u = sumEveUsage(events)
    expect(u.inputTokens).toBe(300)
    expect(u.outputTokens).toBe(130)
    expect(u.costUsd).toBeNull()
    expect(u.steps).toBe(2)
  })

  it('a cost on only SOME token-spending steps is partial → null (the chat rule)', () => {
    const u = sumEveUsage([stepCompleted(100, 50, 0.001), stepCompleted(200, 80, 0)])
    expect(u.costUsd).toBeNull()
    expect(u.inputTokens).toBe(300)
  })

  it('an Exa-contaminated run drops eve’s cost and reports the Exa spend as webSearchCostUsd', () => {
    const exa = {
      type: 'action.result',
      data: {
        result: { kind: 'tool-result', callId: 'ws1', toolName: 'web_search', output: { results: [], costDollars: { total: 0.007 } } },
        sequence: 0,
        stepIndex: 0,
        status: 'completed',
        turnId: 't',
      },
    } as unknown as HandleMessageStreamEvent
    const u = sumEveUsage([exa, stepCompleted(8100, 120, 0.007)])
    expect(u.costUsd).toBeNull()
    expect(u.webSearchCostUsd).toBeCloseTo(0.007)
    expect(u.inputTokens).toBe(8100)
  })

  it('ignores non-step events', () => {
    const events = [
      { type: 'message.appended', data: {} } as HandleMessageStreamEvent,
      stepCompleted(10, 5, 0.0001),
    ]
    const u = sumEveUsage(events)
    expect(u.steps).toBe(1)
    expect(u.inputTokens).toBe(10)
  })
})

describe('countEveToolCalls', () => {
  it('sums actions across actions.requested events', () => {
    expect(countEveToolCalls([actionsRequested(2), actionsRequested(3)])).toBe(5)
  })
  it('is zero with no tool calls', () => {
    expect(countEveToolCalls([stepCompleted(1, 1)])).toBe(0)
  })
})

// ── runViaEve dispatch ──────────────────────────────────────────────────────
function baseSpec(over: Partial<SkillRunSpec> = {}): SkillRunSpec {
  return {
    runAsUserId: 'user-1',
    workspaceId: 'ws-1',
    skillId: 'skill-1',
    skillName: 'Test Skill',
    skillUpdatedAt: null,
    systemPrompt: 'SYS',
    userMessage: 'do the thing',
    ceiling: ['list_actions', 'get_document'],
    activeTools: ['list_actions'],
    model: 'claude-haiku-4-5-20251001',
    mode: 'report',
    deliver: {},
    templateTitleDefault: 'Test Skill — 2026-07-10',
    outputContract: 'prose',
    ...over,
  }
}

/** A createTaskSession stub whose result() resolves to the given MessageResult. */
function mockTaskSession(result: {
  status: string
  message?: string
  data?: unknown
  events?: HandleMessageStreamEvent[]
}) {
  createTaskSessionMock.mockResolvedValue({
    sessionId: 'sess-1',
    result: async () => ({
      status: result.status,
      message: result.message,
      data: result.data,
      events: result.events ?? [],
      inputRequests: [],
      sessionId: 'sess-1',
    }),
  })
}

describe('runViaEve', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    createTaskSessionMock.mockReset()
    ClientMock.mockClear()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('prose run: dispatches the userMessage in TASK mode (NO outputSchema), returns text + usage', async () => {
    mockTaskSession({
      status: 'completed',
      message: 'the written report',
      events: [stepCompleted(100, 200, 0.005), actionsRequested(1)],
    })

    const res = await runViaEve({
      spec: baseSpec(),
      hasCapture: false,
      timeoutMs: 120_000,
    })

    expect(res.text).toBe('the written report')
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(res.costUsd).toBeCloseTo(0.005)
    expect(res.toolCalls).toBe(1)
    expect(res.steps).toBe(1)
    expect(res.verdict).toBeNull()
    expect(res.empty).toBe(false)

    // Dispatch went through createTaskSession (the TASK-mode path), NOT the
    // mode-less typed send(): userMessage as message, NO outputSchema for prose.
    expect(createTaskSessionMock).toHaveBeenCalledTimes(1)
    const [clientArg, payload] = createTaskSessionMock.mock.calls[0]
    expect(clientArg).toBe(ClientMock.mock.results[0].value)
    expect(payload.message).toBe('do the thing')
    expect(payload.outputSchema).toBeUndefined()
    expect(payload.signal).toBeInstanceOf(AbortSignal)

    // The mount + secret headers are wired.
    const clientOpts = (ClientMock.mock.calls[0] as unknown[])[0] as {
      host: string
      headers: Record<string, string>
      redirect: string
    }
    // eve 0.58+ mounts named agents at /eve/<name>/v1/* (the pre-0.58
    // /eve/agents/<name>/eve/v1/* shape now 404s).
    expect(new URL(clientOpts.host).pathname).toBe('/eve/skill-runner')
    expect(clientOpts.headers['x-skill-run-secret']).toBe(SECRET)
    expect(clientOpts.headers['x-skill-run-token']).toBeTruthy()
    expect(clientOpts.redirect).toBe('error')
  })

  it('verdict run: requests an outputSchema and returns result.data as the verdict', async () => {
    const verdict = { decisions: [], needs_user: [], summary: 'nothing to do' }
    mockTaskSession({ status: 'completed', data: verdict, events: [stepCompleted(50, 20, 0.001)] })

    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: true,
      timeoutMs: 240_000,
    })

    expect(res.verdict).toEqual(verdict)
    expect(res.empty).toBe(false)
    const payload = createTaskSessionMock.mock.calls[0][1]
    expect(payload.outputSchema).toBeDefined()
  })

  it('verdict run with SPARSE data (needs_user omitted) → normalized to full RunVerdict shape', async () => {
    // needs_user is optional in verdictOutputSchema — a schema-valid eve result
    // may omit it. The bare `as RunVerdict` cast used to let that undefined
    // reach applyVerdict's iteration ("needs_user is not iterable", prod crash
    // recurring since 2026-07-13).
    mockTaskSession({
      status: 'completed',
      data: { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.9 }], summary: 's' },
      events: [stepCompleted(50, 20, 0.001)],
    })
    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: true,
      timeoutMs: 240_000,
    })
    expect(res.verdict).not.toBeNull()
    expect(res.verdict!.needs_user).toEqual([])
    expect(res.verdict!.decisions).toHaveLength(1)
    expect(res.empty).toBe(false)
  })

  it('verdict run with no data → verdict null, empty true', async () => {
    mockTaskSession({ status: 'completed', data: undefined, events: [] })
    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: false,
      timeoutMs: 240_000,
    })
    expect(res.verdict).toBeNull()
    expect(res.empty).toBe(true)
  })

  it('throws when the eve session failed', async () => {
    mockTaskSession({ status: 'failed', data: undefined, events: [] })
    await expect(
      runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 }),
    ).rejects.toThrow(/eve session failed/)
  })

  it("carries eve's reason when the skill-runner refused to run without its spec", async () => {
    // What eve streams when the model resolver throws: MODEL_SELECTION_FAILED on
    // the step, the turn and the session, and no model step.
    const reason = '[skill-runner] no run spec for this session (its prompt and tools could not be loaded) — refusing to run the skill blind'
    const failed = (type: string) =>
      ({ type, data: { code: 'MODEL_SELECTION_FAILED', message: reason, sequence: 0, stepIndex: 0, turnId: 't' } }) as unknown as HandleMessageStreamEvent
    mockTaskSession({ status: 'failed', data: undefined, events: [failed('step.failed'), failed('turn.failed'), failed('session.failed')] })
    const run = runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
    await expect(run).rejects.toBeInstanceOf(EveSessionFailedError)
    await expect(run).rejects.toThrow(`eve session failed: ${reason}`)
  })

  it('throws when the internal secret is unset', async () => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    await expect(
      runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 }),
    ).rejects.toThrow(/RUN_SKILL_INTERNAL_SECRET/)
  })
})

// ── WS-4c verdict salvage ───────────────────────────────────────────────────

function resultCompleted(result: unknown): HandleMessageStreamEvent {
  return {
    type: 'result.completed',
    data: { result, sequence: 0, stepIndex: 0, turnId: 't' },
  } as unknown as HandleMessageStreamEvent
}

function toolCalls(...names: string[]): HandleMessageStreamEvent {
  return {
    type: 'actions.requested',
    data: {
      actions: names.map((toolName, i) => ({ kind: 'tool-call', toolName, callId: `c${i}` })),
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
    },
  } as unknown as HandleMessageStreamEvent
}

type TaskPayload = { onEvent?: (ev: HandleMessageStreamEvent) => void; signal: AbortSignal }

/**
 * A createTaskSession stub that STREAMS `events` through the payload's onEvent
 * tap (as the real helper does) and then either resolves `final` or throws
 * `error` from result() — the aborted-stream case result() cannot report on.
 */
function streamingTaskSession(
  events: HandleMessageStreamEvent[],
  outcome: { error: Error } | { final: { status: string; message?: string; data?: unknown } },
) {
  createTaskSessionMock.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
    sessionId: 'sess-1',
    result: async () => {
      for (const ev of events) payload.onEvent?.(ev)
      if ('error' in outcome) throw outcome.error
      return { ...outcome.final, events, inputRequests: [], sessionId: 'sess-1' }
    },
  }))
}

const COMMITTED = {
  decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.9 }],
  summary: 'Triaged 1 item.',
}

describe('committedResult', () => {
  it('returns the LAST result.completed payload (what MessageResult.data is built from)', () => {
    expect(committedResult([resultCompleted({ a: 1 }), stepCompleted(1, 1), resultCompleted({ a: 2 })])).toEqual({ a: 2 })
  })
  it('is undefined when nothing was committed', () => {
    expect(committedResult([stepCompleted(1, 1)])).toBeUndefined()
  })
})

/**
 * Fixture order follows eve's protocol: `result.completed` is the FINALIZED
 * payload, emitted once just before the turn boundary (eve docs
 * guides/client/output-schema, concepts/sessions-runs-and-streaming). So a
 * salvageable abort is one landing in the short gap after it, and the
 * committed result is the last event streamed. The case eve CANNOT recover (the
 * wall hits mid-sweep, before finalization) is the "nothing committed" test
 * below. It still loses the sweep; the retired gateway salvage did not.
 */
describe('runViaEve — WS-4c verdict salvage', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    createTaskSessionMock.mockReset()
    cancelTaskSessionMock.mockClear()
    ClientMock.mockClear()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('stream aborts on the timeout AFTER the verdict was committed → verdict returned, salvaged partial', async () => {
    streamingTaskSession(
      [stepCompleted(100, 40, 0.002), toolCalls('get_action_suggestions'), stepCompleted(10, 5), resultCompleted(COMMITTED)],
      { error: new Error('This operation was aborted') },
    )
    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: true,
      timeoutMs: 240_000,
    })
    // The model's decisions survive — normalized (needs_user was omitted).
    expect(res.verdict).toEqual({ ...COMMITTED, needs_user: [] })
    expect(res.salvaged).toEqual({ partial: true, error: 'This operation was aborted' })
    expect(res.empty).toBe(false)
    // Usage covers every step observed before the abort (billed, not dropped).
    expect(res.usage).toEqual({ inputTokens: 110, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(res.costUsd).toBeCloseTo(0.002)
    expect(res.steps).toBe(2)
    expect(res.toolCalls).toBe(1)
  })

  it('a salvaged verdict run still sees its Exa spend (action.result is in the salvage set): eve’s cost is NOT trusted', async () => {
    const exaResult = {
      type: 'action.result',
      data: {
        result: { kind: 'tool-result', callId: 'ws1', toolName: 'web_search', output: { results: [], costDollars: { total: 0.007 } } },
        sequence: 0,
        stepIndex: 0,
        status: 'completed',
        turnId: 't',
      },
    } as unknown as HandleMessageStreamEvent
    streamingTaskSession(
      [toolCalls('web_search'), exaResult, stepCompleted(8100, 120, 0.007), resultCompleted(COMMITTED)],
      { error: new Error('This operation was aborted') },
    )
    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: true,
      timeoutMs: 240_000,
    })
    expect(res.salvaged).toEqual({ partial: true, error: 'This operation was aborted' })
    // Without the action.result the salvage would trust eve's Exa-contaminated 0.007.
    expect(res.costUsd).toBeNull()
    expect(res.webSearchCostUsd).toBeCloseTo(0.007)
    expect(res.usage).toEqual({ inputTokens: 8100, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('the wall-clock abort itself marks the salvage partial, whatever the error text', async () => {
    vi.useFakeTimers()
    try {
      createTaskSessionMock.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
        sessionId: 'sess-1',
        result: () =>
          new Promise((_resolve, reject) => {
            payload.onEvent?.(resultCompleted(COMMITTED))
            payload.signal.addEventListener('abort', () => reject(new Error('stream closed')))
          }),
      }))
      const pending = runViaEve({
        spec: baseSpec({ outputContract: 'verdict' }),
          hasCapture: false,
        timeoutMs: 240_000,
      })
      await vi.advanceTimersByTimeAsync(240_000)
      const res = await pending
      expect(res.salvaged).toEqual({ partial: true, error: 'stream closed' })
      expect(res.verdict?.summary).toBe('Triaged 1 item.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a FAILED session that committed its verdict first → salvaged, not partial', async () => {
    streamingTaskSession([stepCompleted(20, 10), resultCompleted(COMMITTED)], {
      final: { status: 'failed', data: COMMITTED },
    })
    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: false,
      timeoutMs: 240_000,
    })
    expect(res.verdict?.decisions).toHaveLength(1)
    expect(res.salvaged).toEqual({ partial: false, error: 'eve session failed' })
  })

  it('a verdict run that hits the wall MID-SWEEP (nothing finalized yet) still throws — eve cannot salvage this', async () => {
    streamingTaskSession([stepCompleted(20, 10), toolCalls('get_action_suggestions'), stepCompleted(30, 12)], {
      error: new Error('This operation was aborted'),
    })
    await expect(
      runViaEve({
        spec: baseSpec({ outputContract: 'verdict' }),
          hasCapture: false,
        timeoutMs: 240_000,
      }),
    ).rejects.toThrow(/aborted/)
  })

  it('a failed verdict session with nothing committed still throws', async () => {
    streamingTaskSession([stepCompleted(20, 10)], { final: { status: 'failed', data: undefined } })
    await expect(
      runViaEve({
        spec: baseSpec({ outputContract: 'verdict' }),
          hasCapture: false,
        timeoutMs: 240_000,
      }),
    ).rejects.toThrow(/eve session failed/)
  })

  it('a PROSE run is never salvaged — an abort throws', async () => {
    streamingTaskSession([resultCompleted({ anything: true })], { error: new Error('This operation was aborted') })
    await expect(
      runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 }),
    ).rejects.toThrow(/aborted/)
  })

  /**
   * eve's REAL abort behaviour: an aborted signal ends the stream quietly (no
   * throw), and result() reports the partial run as status 'completed' (no
   * boundary event → summarizeTurnEvents' default). This stub does exactly
   * that at the wall, so these tests pin the path prod actually takes.
   */
  function quietAbortAtWall(events: HandleMessageStreamEvent[]) {
    createTaskSessionMock.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
      sessionId: 'sess-1',
      result: () =>
        new Promise((resolve) => {
          for (const ev of events) payload.onEvent?.(ev)
          payload.signal.addEventListener('abort', () =>
            resolve({ status: 'completed', data: undefined, message: undefined, events, inputRequests: [], sessionId: 'sess-1' }),
          )
        }),
    }))
  }

  it("the wall on eve's quiet abort (stream ends, no throw): the server session is cancelled and the run times out, billed", async () => {
    vi.useFakeTimers()
    try {
      quietAbortAtWall([stepCompleted(20, 10, 0.002), toolCalls('get_action_suggestions'), stepCompleted(30, 12, 0.003)])
      const pending = runViaEve({ spec: baseSpec({ outputContract: 'verdict' }), hasCapture: false, timeoutMs: 480_000 })
      const settled = pending.then(
        () => null,
        (e: unknown) => e,
      )
      await vi.advanceTimersByTimeAsync(480_000)
      const err = await settled
      expect(err).toBeInstanceOf(EveRunTimeoutError)
      expect((err as Error).message).toMatch(/timeout/)
      expect((err as EveRunTimeoutError).timeoutMs).toBe(480_000)
      expect((err as EveRunTimeoutError).spent).toMatchObject({
        usage: { inputTokens: 50, outputTokens: 22 },
        toolCalls: 1,
        steps: 2,
      })
      expect((err as EveRunTimeoutError).spent.costUsd).toBeCloseTo(0.005)
      expect(cancelTaskSessionMock).toHaveBeenCalledWith(expect.anything(), 'sess-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it("the wall on eve's quiet abort AFTER the verdict committed: salvaged, partial, and the session cancelled", async () => {
    vi.useFakeTimers()
    try {
      quietAbortAtWall([stepCompleted(20, 10), resultCompleted(COMMITTED)])
      const pending = runViaEve({ spec: baseSpec({ outputContract: 'verdict' }), hasCapture: false, timeoutMs: 480_000 })
      await vi.advanceTimersByTimeAsync(480_000)
      const res = await pending
      expect(res.verdict?.summary).toBe('Triaged 1 item.')
      expect(res.salvaged?.partial).toBe(true)
      expect(cancelTaskSessionMock).toHaveBeenCalledWith(expect.anything(), 'sess-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it("a PROSE run on eve's quiet abort times out and cancels the session (an act run must not keep writing)", async () => {
    vi.useFakeTimers()
    try {
      quietAbortAtWall([stepCompleted(20, 10), toolCalls('update_action')])
      const pending = runViaEve({ spec: baseSpec({ mode: 'act' }), hasCapture: false, timeoutMs: 120_000 })
      const settled = pending.then(
        () => null,
        (e: unknown) => e,
      )
      await vi.advanceTimersByTimeAsync(120_000)
      expect(await settled).toBeInstanceOf(EveRunTimeoutError)
      expect(cancelTaskSessionMock).toHaveBeenCalledWith(expect.anything(), 'sess-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a thrown abort at OUR wall is the same typed timeout, carrying the spend', async () => {
    vi.useFakeTimers()
    try {
      createTaskSessionMock.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
        sessionId: 'sess-1',
        result: () =>
          new Promise((_resolve, reject) => {
            payload.onEvent?.(stepCompleted(40, 8))
            payload.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
          }),
      }))
      const settled = runViaEve({ spec: baseSpec({ outputContract: 'verdict' }), hasCapture: false, timeoutMs: 480_000 }).then(
        () => null,
        (e: unknown) => e,
      )
      await vi.advanceTimersByTimeAsync(480_000)
      const err = await settled
      expect(err).toBeInstanceOf(EveRunTimeoutError)
      expect((err as EveRunTimeoutError).spent.usage.inputTokens).toBe(40)
      expect(cancelTaskSessionMock).toHaveBeenCalledWith(expect.anything(), 'sess-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a clean completion carries no salvage flag', async () => {
    streamingTaskSession([resultCompleted(COMMITTED)], { final: { status: 'completed', data: COMMITTED } })
    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: false,
      timeoutMs: 240_000,
    })
    expect(res.salvaged).toBeUndefined()
    expect(res.verdict?.summary).toBe('Triaged 1 item.')
  })
})

describe('runViaEve — live tool-call hook', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    createTaskSessionMock.mockReset()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('reports each step’s tool-call NAMES as they stream', async () => {
    streamingTaskSession([toolCalls('list_actions', 'get_document'), stepCompleted(1, 1), toolCalls('find')], {
      final: { status: 'completed', message: 'done' },
    })
    const seen: string[][] = []
    await runViaEve({
      spec: baseSpec(),
      hasCapture: false,
      timeoutMs: 120_000,
      onToolCalls: (names) => seen.push(names),
    })
    expect(seen).toEqual([['list_actions', 'get_document'], ['find']])
  })
})

describe('runViaEve — the wall stops the server session', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    createTaskSessionMock.mockReset()
    cancelTaskSessionMock.mockClear()
    ClientMock.mockClear()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  /** The opaque client instance runViaEve built (what cancel must target). */
  function builtClient(): unknown {
    return ClientMock.mock.results[0]?.value
  }

  it('a wall-clock abort cancels the durable session (prose run, nothing to salvage)', async () => {
    vi.useFakeTimers()
    try {
      createTaskSessionMock.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
        sessionId: 'sess-wall',
        result: () =>
          new Promise((_resolve, reject) => {
            payload.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
          }),
      }))
      const pending = runViaEve({
        spec: baseSpec({ mode: 'act' }),
          hasCapture: false,
        timeoutMs: 120_000,
      })
      const settled = expect(pending).rejects.toThrow(EveRunTimeoutError)
      await vi.advanceTimersByTimeAsync(120_000)
      await settled
      expect(cancelTaskSessionMock).toHaveBeenCalledTimes(1)
      expect(cancelTaskSessionMock).toHaveBeenCalledWith(builtClient(), 'sess-wall')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a salvaged verdict still cancels the session before returning', async () => {
    streamingTaskSession([stepCompleted(5, 5), resultCompleted(COMMITTED)], {
      error: new Error('This operation was aborted'),
    })
    const res = await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: false,
      timeoutMs: 240_000,
    })
    expect(res.salvaged?.partial).toBe(true)
    expect(cancelTaskSessionMock).toHaveBeenCalledWith(builtClient(), 'sess-1')
  })

  it('a transport error mid-stream also cancels (the run is reported over either way)', async () => {
    streamingTaskSession([stepCompleted(5, 5)], { error: new Error('socket hang up') })
    await expect(
      runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 }),
    ).rejects.toThrow(/socket hang up/)
    expect(cancelTaskSessionMock).toHaveBeenCalledWith(builtClient(), 'sess-1')
  })

  it('a failed create POST has no session to cancel', async () => {
    createTaskSessionMock.mockRejectedValue(new Error('eve task-session create failed (500)'))
    await expect(
      runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 }),
    ).rejects.toThrow(/create failed/)
    expect(cancelTaskSessionMock).not.toHaveBeenCalled()
  })

  it('a one-shot whose turn eve held on a prompt (eve 0.70+ turn.waiting) fails the run and stops the held turn', async () => {
    // eve 0.67 removed task mode: nothing fails closed, so a HITL prompt parks
    // the turn and the response ends at turn.waiting with the request open.
    createTaskSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      result: async () => ({
        status: 'waiting',
        message: undefined,
        data: undefined,
        events: [{ type: 'turn.waiting', data: { on: 'input', turnId: 't', sequence: 1 } } as unknown as HandleMessageStreamEvent],
        inputRequests: [{ requestId: 'r1', kind: 'approval' }],
        sessionId: 'sess-1',
      }),
    })
    await expect(runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })).rejects.toThrow()
    expect(cancelTaskSessionMock).toHaveBeenCalledWith(builtClient(), 'sess-1')
  })

  it('a turn cancelled before it finished (a hook’s ctx.cancel()) fails the run, never reads as a success', async () => {
    const ev = (type: string) => ({ type, data: { turnId: 't', sequence: 1 } }) as unknown as HandleMessageStreamEvent
    mockTaskSession({ status: 'waiting', events: [ev('turn.started'), ev('turn.cancelled'), ev('session.waiting')] })
    await expect(runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })).rejects.toThrow(CANCELLED_TURN_REASON)
  })

  it('every one-shot run retires its parked session once it is over (eve 0.67+ parks every session)', async () => {
    retireTaskSessionMock.mockClear()
    mockTaskSession({ status: 'completed', message: 'ok', events: [] })
    await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
    expect(retireTaskSessionMock).toHaveBeenCalledWith(builtClient(), 'sess-1')
    retireTaskSessionMock.mockClear()
    streamingTaskSession([stepCompleted(1, 1)], { final: { status: 'failed' } })
    await expect(runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })).rejects.toThrow()
    expect(retireTaskSessionMock).toHaveBeenCalledWith(builtClient(), 'sess-1')
  })

  it('a clean completion and a terminal failed session are NOT cancelled (already settled)', async () => {
    streamingTaskSession([resultCompleted(COMMITTED)], { final: { status: 'completed', data: COMMITTED } })
    await runViaEve({
      spec: baseSpec({ outputContract: 'verdict' }),
      hasCapture: false,
      timeoutMs: 240_000,
    })
    streamingTaskSession([stepCompleted(1, 1)], { final: { status: 'failed' } })
    await expect(
      runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 }),
    ).rejects.toThrow(/eve session failed/)
    expect(cancelTaskSessionMock).not.toHaveBeenCalled()
  })

  it('mints the run token to expire at the wall plus a margin, not the 10-minute maximum', async () => {
    const now = 1_800_000_000_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      mockTaskSession({ status: 'completed', message: 'ok', events: [] })
      await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
      const opts = (ClientMock.mock.calls[0] as unknown as [{ headers: Record<string, string> }])[0]
      const claims = verifyRunToken(opts.headers['x-skill-run-token'])
      expect(claims?.exp).toBe(now + 120_000 + RUN_TOKEN_WALL_MARGIN_MS)
    } finally {
      spy.mockRestore()
    }
  })

  it('a test_flow dry run mints dryRun into the token; a real run never does (F1)', async () => {
    mockTaskSession({ status: 'completed', message: 'ok', events: [] })
    await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 60_000, dryRun: true })
    mockTaskSession({ status: 'completed', message: 'ok', events: [] })
    await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 60_000 })
    const claimsOf = (i: number) =>
      verifyRunToken((ClientMock.mock.calls[i] as unknown as [{ headers: Record<string, string> }])[0].headers['x-skill-run-token'])
    expect(claimsOf(0)?.dryRun).toBe(true)
    expect(claimsOf(1)?.dryRun).toBeUndefined()
  })

  // The dynamic import below loads run-skill's whole module graph; on a loaded
  // build machine that alone can take longer than vitest's 5 s default.
  it("a verdict run's token outlives its full 480s wall: the 10-minute maximum never cuts it short", async () => {
    // Imported before the clock is frozen: module init runs on real time.
    const { serverTimeoutMsForSpec } = await import('../run-skill')
    const now = 1_800_000_000_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const wall = serverTimeoutMsForSpec({ outputContract: 'verdict' })
      mockTaskSession({ status: 'completed', data: { summary: 's', decisions: [], needs_user: [] }, events: [] })
      await runViaEve({ spec: baseSpec({ outputContract: 'verdict' }), hasCapture: false, timeoutMs: wall })
      const opts = (ClientMock.mock.calls[0] as unknown as [{ headers: Record<string, string> }])[0]
      const claims = verifyRunToken(opts.headers['x-skill-run-token'])
      expect(claims?.exp).toBe(now + wall + RUN_TOKEN_WALL_MARGIN_MS)
    } finally {
      spy.mockRestore()
    }
  }, 30_000) // the cold dynamic import of run-skill alone can pass 5 s on a loaded machine
})

describe('runViaEve — dispatch origin (this deployment, through Deployment Protection)', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    createTaskSessionMock.mockReset()
    ClientMock.mockClear()
    mockTaskSession({ status: 'completed', message: 'ok', events: [] })
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    vi.unstubAllEnvs()
  })
  const clientOpts = () =>
    (ClientMock.mock.calls[0] as unknown as [{ host: string; headers: Record<string, string> }])[0]

  it("on Vercel dispatches to THIS deployment (VERCEL_URL), never the production NEXT_PUBLIC_APP_URL, with the bypass header", async () => {
    vi.stubEnv('VERCEL_URL', 'dial8-git-branch.vercel.app')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass-123')
    await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
    expect(clientOpts().host).toBe('https://dial8-git-branch.vercel.app/eve/skill-runner')
    expect(clientOpts().headers['x-vercel-protection-bypass']).toBe('bypass-123')
  })

  it('off Vercel uses NEXT_PUBLIC_APP_URL and sends no bypass header without a secret', async () => {
    vi.stubEnv('VERCEL_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
    await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
    expect(clientOpts().host).toBe('http://localhost:3000/eve/skill-runner')
    expect(clientOpts().headers).not.toHaveProperty('x-vercel-protection-bypass')
  })
})

describe('runViaEve — the 12-step cap (main: stopWhen isStepCount(12))', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    createTaskSessionMock.mockReset()
    cancelTaskSessionMock.mockClear()
    ClientMock.mockClear()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  const stepStarted = (i: number) =>
    ({ type: 'step.started', data: { stepIndex: i, modelId: 'm', sequence: 0, turnId: 't' } }) as unknown as HandleMessageStreamEvent
  const messageCompleted = (message: string, finishReason = 'tool-calls') =>
    ({ type: 'message.completed', data: { message, finishReason, sequence: 0, stepIndex: 0, turnId: 't' } }) as unknown as HandleMessageStreamEvent

  /** n full steps (started → narration → completed), then more step.started until the tap aborts. */
  function steps(n: number): HandleMessageStreamEvent[] {
    const out: HandleMessageStreamEvent[] = []
    for (let i = 0; i < n; i++) out.push(stepStarted(i), messageCompleted(`step ${i + 1} text`), stepCompleted(100, 10))
    return out
  }

  /** Streams events through onEvent; honors the abort the way the real stream does. */
  function abortableSession(events: HandleMessageStreamEvent[]) {
    createTaskSessionMock.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
      sessionId: 'sess-cap',
      result: async () => {
        for (const ev of events) {
          if (payload.signal.aborted) throw new Error('This operation was aborted')
          payload.onEvent?.(ev)
        }
        if (payload.signal.aborted) throw new Error('This operation was aborted')
        return { status: 'completed', message: 'late', events, inputRequests: [], sessionId: 'sess-cap' }
      },
    }))
  }

  it('the 13th step.started ends a prose run: session cancelled, 12 steps billed, the 12th step text delivered', async () => {
    abortableSession([...steps(12), stepStarted(12), stepCompleted(999, 999)])
    const res = await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
    expect(res.stepCapped).toBe(true)
    expect(cancelTaskSessionMock).toHaveBeenCalledWith(expect.anything(), 'sess-cap')
    expect(res.steps).toBe(12)
    expect(res.usage.inputTokens).toBe(1200)
    expect(res.text).toBe('step 12 text')
    expect(res.empty).toBe(false)
  })

  it('a capped verdict run delivers its committed verdict, else null (the verdict walk records it missing)', async () => {
    abortableSession([...steps(12), stepStarted(12)])
    const res = await runViaEve({ spec: baseSpec({ outputContract: 'verdict' }), hasCapture: false, timeoutMs: 240_000 })
    expect(res.stepCapped).toBe(true)
    expect(res.verdict).toBeNull()
    expect(res.empty).toBe(true)
    expect(res.steps).toBe(12)
  })

  it("the skill-runner's step-cap hook failing the session at step 13 is the same capped result, not a thrown failure", async () => {
    streamingTaskSession(steps(12), { final: { status: 'failed' } })
    const res = await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
    expect(res.stepCapped).toBe(true)
    expect(res.steps).toBe(12)
  })

  it('12 steps that finish normally are not capped', async () => {
    abortableSession(steps(12))
    const res = await runViaEve({ spec: baseSpec(), hasCapture: false, timeoutMs: 120_000 })
    expect(res.stepCapped).toBeUndefined()
    expect(cancelTaskSessionMock).not.toHaveBeenCalled()
  })

  it('the server cap equals the skill-runner hook cap', async () => {
    const { SKILL_RUN_MAX_STEPS } = await import('../run-skill-eve')
    const hook = await import('../../../../agents/skill-runner/hooks/step-cap')
    expect(SKILL_RUN_MAX_STEPS).toBe(12)
    expect(hook.SKILL_RUN_MAX_STEPS).toBe(SKILL_RUN_MAX_STEPS)
  })
})
