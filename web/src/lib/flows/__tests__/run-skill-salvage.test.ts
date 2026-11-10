/**
 * WS-4c — the verdict-run salvage + wall-timeout bump, on the eve server runtime
 * (the ONLY server runtime since the gateway branch was deleted, WS-3a).
 *
 * The load-bearing property: when a verdict-class run's eve session aborts on
 * the timeout — or fails — AFTER the model already committed its verdict (a
 * `result.completed` event on the stream), the executor applies that verdict
 * through deliverVerdictRun instead of throwing the whole sweep away, and stamps
 * the ledger summary as partial on a timeout. It also proves the verdict-class
 * wall is 480s (not the 240s prose wall), and that a timeout with NO committed
 * verdict still fails cleanly.
 *
 * The executor is heavy plumbing; we mock the I/O boundary (service client, the
 * eve task session, the apply walk) and drive the real
 * assemble → runSpecViaEve → runViaEve → salvage → deliverVerdictRun flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import type { RunVerdict } from '../verdict-apply'
import type { FlowAction } from '../types'

type TaskPayload = { onEvent?: (ev: HandleMessageStreamEvent) => void; signal: AbortSignal }

const h = vi.hoisted(() => ({
  retireTaskSession: vi.fn(async () => true),
  createTaskSession: vi.fn(),
  cancelTaskSession: vi.fn(async () => true),
  applyVerdict: vi.fn(),
  logUsage: vi.fn(async () => {}),
  createNotification: vi.fn(async () => {}),
  /** The skill row's output contract (verdict unless a test flips it). */
  outputContract: 'verdict' as 'verdict' | 'prose',
  /** Every table an insert went to (the prose document, a notification row…). */
  inserts: [] as string[],
}))

vi.mock('eve/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('eve/client')>()), Client: vi.fn(() => ({})) }))
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: h.createTaskSession,
  cancelTaskSession: h.cancelTaskSession,
  retireTaskSession: h.retireTaskSession,
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'limit', 'gte', 'is', 'update']) {
        c[m] = () => c
      }
      c.insert = () => {
        h.inserts.push(table)
        return c
      }
      c.maybeSingle = async () => {
        if (table === 'recipe') {
          return {
            data: {
              id: 'skill-1',
              name: 'Proposal Triage',
              system_prompt: 'triage the queue',
              updated_at: null,
              agent_config: { output_contract: h.outputContract },
            },
            error: null,
          }
        }
        if (table === 'member') return { data: { id: 'm1' }, error: null }
        return { data: null, error: null }
      }
      c.single = async () => ({ data: null, error: null })
      return c
    }
    return {
      from: (t: string) => chain(t),
      rpc: async () => ({ data: [{ allowed: true }], error: null }),
    }
  },
}))

vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: async () => 'base system prompt' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: h.logUsage }))
vi.mock('../context-pack', () => ({ buildContextPack: async () => '' }))
vi.mock('../verdict-apply', () => ({
  applyVerdict: h.applyVerdict,
  resolveTrust: () => ({
    auto_apply: false,
    min_confidence: 0.85,
    allow_external: false,
    max_cards_per_run: 3,
    outreach_draft_cards: true,
  }),
}))
vi.mock('@/lib/notifications', () => ({
  createNotification: h.createNotification,
}))

const { createRunSkillExecutor, runSpecViaEve } = await import('../run-skill')
const { phraseForToolNames } = await import('@/lib/work/step-phrases')

const VERDICT: RunVerdict = {
  decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.9, is_mine_explicit: true }],
  needs_user: [],
  summary: 'Triaged 1 item.',
}

function verdictAction(): FlowAction {
  return {
    id: 'a1',
    type: 'run_skill',
    config: { skill_id: 'skill-1', mode: 'act' } as unknown as FlowAction['config'],
    condition: null,
    parent_id: null,
    enabled: true,
    bearer_token_encrypted: null,
  }
}

function step(input: number, output: number): HandleMessageStreamEvent {
  return {
    type: 'step.completed',
    data: { finishReason: 'tool-calls', sequence: 0, stepIndex: 0, turnId: 't', usage: { inputTokens: input, outputTokens: output } },
  } as unknown as HandleMessageStreamEvent
}

function committed(verdict: RunVerdict): HandleMessageStreamEvent {
  return {
    type: 'result.completed',
    data: { result: verdict, sequence: 0, stepIndex: 0, turnId: 't' },
  } as unknown as HandleMessageStreamEvent
}

/** The eve task session streams `events` (through the onEvent tap), then its
 *  result() either throws `error` (aborted stream) or resolves `final`. */
function eveSession(
  events: HandleMessageStreamEvent[],
  outcome: { error: Error } | { final: { status: string; data?: unknown } },
) {
  h.createTaskSession.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
    sessionId: 'sess-1',
    result: async () => {
      for (const ev of events) payload.onEvent?.(ev)
      if ('error' in outcome) throw outcome.error
      return { ...outcome.final, events, inputRequests: [], sessionId: 'sess-1', message: '' }
    },
  }))
}

const ctx = {
  entity: null,
  trigger: {
    type: 'capture_processed' as const,
    entity_type: null,
    from_status_id: null,
    to_status_id: null,
    fired_at: '2026-07-08T00:00:00.000Z',
  },
  appBaseUrl: 'https://nativeintelligence.dev',
  capture: null,
}

afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = 'test-internal-secret-abcdefghij'
  h.createTaskSession.mockReset()
  h.cancelTaskSession.mockClear()
  h.applyVerdict.mockReset()
  h.logUsage.mockClear()
  h.createNotification.mockClear()
  h.outputContract = 'verdict'
  h.inserts = []
  h.applyVerdict.mockImplementation(async (v: RunVerdict) => ({
    summary: v.summary,
    entries: [],
    cards_surfaced: 0,
    cards_deduped: 0,
    cards_failed: 0,
    cards_overflow: 0,
    revoked_count: 0,
    submitted: v,
  }))
})

describe('WS-4c verdict salvage (eve)', () => {
  it('applies the committed verdict on a timeout, marking the ledger partial', async () => {
    eveSession([step(300, 120), committed(VERDICT)], {
      error: new Error('The operation was aborted due to timeout'),
    })

    const executor = createRunSkillExecutor({
      workspaceId: 'ws-1',
      runAsUserId: 'user-1',
      flowId: 'flow-1',
      fireId: 'evt-1',
      flowRunId: 'run-1',
    })
    const result = await executor(verdictAction(), ctx)

    // The whole run is NOT failed — the verdict was salvaged and applied.
    expect(result.status).toBe('success')
    expect(h.applyVerdict).toHaveBeenCalledOnce()
    // deliverVerdictRun ran the apply walk on the EXACT committed verdict.
    expect(h.applyVerdict.mock.calls[0][0]).toEqual(VERDICT)
    // The ledger records the truncation; the model's own summary is preserved.
    expect(result.verdict?.summary).toBe('Triaged 1 item. [partial: run timed out]')
    // The steps the run DID consume before the abort are billed, under the
    // unchanged feature key.
    expect(h.logUsage).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ feature: 'flow_run_skill', inputTokens: 300, outputTokens: 120 }),
    )
    // The timed-out session was stopped server-side, not just detached.
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-1')
  })

  it('a FAILED session that committed its verdict first is applied, not stamped partial', async () => {
    eveSession([step(50, 20), committed(VERDICT)], { final: { status: 'failed', data: VERDICT } })

    const executor = createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })
    const result = await executor(verdictAction(), ctx)

    expect(result.status).toBe('success')
    expect(h.applyVerdict).toHaveBeenCalledOnce()
    expect(h.applyVerdict.mock.calls[0][0]).toEqual(VERDICT)
    expect(result.verdict?.summary).toBe('Triaged 1 item.')
  })

  it('uses the 480s verdict-class wall (not the 240s prose wall)', async () => {
    eveSession([committed(VERDICT)], { error: new Error('aborted') })
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    const executor = createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })
    await executor(verdictAction(), ctx)

    expect(timeoutSpy.mock.calls.some(([, ms]) => ms === 480_000)).toBe(true)
    expect(timeoutSpy.mock.calls.some(([, ms]) => ms === 240_000)).toBe(false)
    timeoutSpy.mockRestore()
  })

  it('a timeout with NO committed verdict fails cleanly (no salvage)', async () => {
    eveSession([step(10, 5)], { error: new Error('The operation was aborted due to timeout') })

    const executor = createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })
    const result = await executor(verdictAction(), ctx)

    expect(result.status).toBe('failed')
    expect(result.error_message).toContain('timed out after 480000ms')
    expect(h.applyVerdict).not.toHaveBeenCalled()
    expect(result.verdict).toBeUndefined()
  })
})

// The Sep 28 sweep, as prod ran it: eve's client ends the stream quietly when
// the wall aborts it (no throw), and result() reads the partial run as a
// 'completed' turn with no verdict. It used to come back as a SUCCESS, "No
// verdict was submitted.", with the durable session never cancelled.
describe("the wall on eve's quiet abort (the sweep's real failure)", () => {
  function quietAbortAtWall(events: HandleMessageStreamEvent[]) {
    h.createTaskSession.mockImplementation(async (_client: unknown, payload: TaskPayload) => ({
      sessionId: 'sess-1',
      result: () =>
        new Promise((resolve) => {
          for (const ev of events) payload.onEvent?.(ev)
          payload.signal.addEventListener('abort', () =>
            resolve({ status: 'completed', data: undefined, message: '', events, inputRequests: [], sessionId: 'sess-1' }),
          )
        }),
    }))
  }

  it('is a failed, timed-out run (not a "success" with no verdict), its session cancelled, its steps billed', async () => {
    vi.useFakeTimers()
    try {
      quietAbortAtWall([step(20_000, 2_000), step(25_000, 2_500), step(31_000, 2_000)])
      const executor = createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })
      const pending = executor(verdictAction(), ctx)
      await vi.advanceTimersByTimeAsync(480_000)
      const result = await pending

      expect(result.status).toBe('failed')
      expect(result.error_message).toBe('Skill run timed out after 480000ms')
      expect(result.verdict).toBeUndefined()
      expect(h.applyVerdict).not.toHaveBeenCalled()
      expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-1')
      expect(h.logUsage).toHaveBeenCalledTimes(1)
      expect(h.logUsage).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          feature: 'flow_run_skill',
          inputTokens: 76_000,
          outputTokens: 6_500,
          metadata: expect.objectContaining({ timed_out: true, wall_ms: 480_000, steps: 3, output_contract: 'verdict' }),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a verdict committed before the wall is still applied, stamped partial', async () => {
    vi.useFakeTimers()
    try {
      quietAbortAtWall([step(10, 5), committed(VERDICT)])
      const executor = createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })
      const pending = executor(verdictAction(), ctx)
      await vi.advanceTimersByTimeAsync(480_000)
      const result = await pending
      expect(result.status).toBe('success')
      expect(h.applyVerdict).toHaveBeenCalledOnce()
      expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-1')
    } finally {
      vi.useRealTimers()
    }
  })
})

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

describe('runSpecViaEve wiring', () => {
  it("feeds each step's tool calls to the fire's Activity row as a phrase (names only)", async () => {
    eveSession([toolCalls('list_actions'), step(10, 5), toolCalls('get_document', 'find'), committed(VERDICT)], {
      final: { status: 'completed', data: VERDICT },
    })
    const work = { id: null, inert: true, step: vi.fn(async () => {}), mute: vi.fn(async () => {}) }

    const executor = createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1', work: work as never })
    const result = await executor(verdictAction(), ctx)

    expect(result.status).toBe('success')
    const expected = [phraseForToolNames(['list_actions']), phraseForToolNames(['get_document', 'find'])]
    expect(expected.every((p) => typeof p === 'string' && p.length > 0)).toBe(true)
    expect(work.step.mock.calls.map((c) => (c as unknown[])[0])).toEqual(expected)
  })

  it('refuses a spec whose tenancy differs from the delivery/billing tenancy (no session starts)', async () => {
    const spec = {
      workspaceId: 'ws-OTHER',
      runAsUserId: 'user-1',
      outputContract: 'prose',
      userMessage: 'm',
    } as never
    const base = {
      supabase: {} as never,
      spec,
      runAsUserId: 'user-1',
      workspaceId: 'ws-1',
      fireId: null,
      flowRunId: null,
      captureTitle: null,
      actionId: 'a1',
      appBaseUrl: 'https://nativeintelligence.dev',
      hasCapture: false,
      timeoutMs: 120_000,
      startedAt: Date.now(),
    }
    await expect(runSpecViaEve(base)).rejects.toThrow(/tenancy mismatch/)
    await expect(
      runSpecViaEve({ ...base, spec: { ...(spec as object), workspaceId: 'ws-1', runAsUserId: 'user-2' } as never }),
    ).rejects.toThrow(/tenancy mismatch/)
    expect(h.createTaskSession).not.toHaveBeenCalled()
  })
})

describe('skill-run usage rows record the Exa web_search spend (webSearchCostUsd) — both delivery paths', () => {
  const exaResult = (total: number): HandleMessageStreamEvent =>
    ({
      type: 'action.result',
      data: {
        result: { kind: 'tool-result', callId: 'ws1', toolName: 'web_search', output: { results: [], costDollars: { total } } },
        sequence: 0,
        stepIndex: 0,
        status: 'completed',
        turnId: 't',
      },
    }) as unknown as HandleMessageStreamEvent
  const costedStep = (input: number, output: number, costUsd: number): HandleMessageStreamEvent =>
    ({
      type: 'step.completed',
      data: { finishReason: 'stop', sequence: 0, stepIndex: 0, turnId: 't', usage: { inputTokens: input, outputTokens: output, costUsd } },
    }) as unknown as HandleMessageStreamEvent
  const proseDone = (text: string): HandleMessageStreamEvent =>
    ({ type: 'message.completed', data: { finishReason: 'stop', message: text, sequence: 0, stepIndex: 0, turnId: 't' } }) as unknown as HandleMessageStreamEvent
  const usageRow = () => {
    const call = h.logUsage.mock.calls.find((c) => {
      const params = (c as unknown[])[1] as { feature?: string } | undefined
      return params?.feature === 'flow_run_skill'
    }) as unknown as [string, { costUsd?: number; metadata: Record<string, unknown> }] | undefined
    expect(call).toBeDefined()
    return call![1]
  }

  it('verdict path (deliverVerdictRun): an Exa run records webSearchCostUsd and bills tokens at list price', async () => {
    eveSession([toolCalls('web_search'), exaResult(0.007), costedStep(8100, 120, 0.007), committed(VERDICT)], {
      final: { status: 'completed', data: VERDICT },
    })
    const result = await createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })(verdictAction(), ctx)
    expect(result.status).toBe('success')
    const row = usageRow()
    expect(row.metadata.webSearchCostUsd).toBeCloseTo(0.007)
    expect(row.costUsd).toBeUndefined()
  })

  it('verdict path: a run without web_search carries no webSearchCostUsd key (and keeps eve’s trusted cost)', async () => {
    eveSession([costedStep(300, 120, 0.002), committed(VERDICT)], { final: { status: 'completed', data: VERDICT } })
    await createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })(verdictAction(), ctx)
    const row = usageRow()
    expect(row.metadata).not.toHaveProperty('webSearchCostUsd')
    expect(row.costUsd).toBeCloseTo(0.002)
  })

  it('prose path (runSpecViaEve → deliverSkillOutput): an Exa run records webSearchCostUsd; none → no key', async () => {
    h.outputContract = 'prose'
    eveSession([toolCalls('web_search'), exaResult(0.007), costedStep(8100, 120, 0.007), proseDone('Here is the brief.')], {
      final: { status: 'completed' },
    })
    await createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })(verdictAction(), ctx)
    const exaRow = usageRow()
    expect(exaRow.metadata.webSearchCostUsd).toBeCloseTo(0.007)
    expect(exaRow.metadata.runtime).toBe('eve')
    expect(exaRow.costUsd).toBeUndefined()

    h.logUsage.mockClear()
    eveSession([costedStep(300, 120, 0.002), proseDone('Done.')], { final: { status: 'completed' } })
    await createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })(verdictAction(), ctx)
    expect(usageRow().metadata).not.toHaveProperty('webSearchCostUsd')
  })
})

describe('a skill-runner that refused to run without its spec', () => {
  // What eve streams when the skill-runner's model resolver throws (agents/
  // skill-runner/agent.ts NO_SPEC): MODEL_SELECTION_FAILED on the step, the
  // turn and the session, and no model step.
  const refusal = (reason: string) =>
    (['step.failed', 'turn.failed', 'session.failed'] as const).map(
      (type) =>
        ({ type, data: { code: 'MODEL_SELECTION_FAILED', message: reason, sequence: 0, stepIndex: 0, turnId: 't' } }) as unknown as HandleMessageStreamEvent,
    )
  const NO_SPEC = '[skill-runner] no run spec for this session (its prompt and tools could not be loaded) — refusing to run the skill blind'

  for (const contract of ['prose', 'verdict'] as const) {
    it(`${contract}: a FAILED run carrying the reason, with no document, no notification and nothing billed`, async () => {
      h.outputContract = contract
      eveSession(refusal(NO_SPEC), { final: { status: 'failed' } })
      const result = await createRunSkillExecutor({
        workspaceId: 'ws-1',
        runAsUserId: 'user-1',
        flowId: 'flow-1',
        fireId: 'evt-1',
        flowRunId: 'run-1',
      })(verdictAction(), ctx)

      expect(h.createTaskSession).toHaveBeenCalledOnce()
      expect(result.status).toBe('failed')
      expect(result.error_message).toBe(`eve session failed: ${NO_SPEC}`)
      expect(result.output_document_id).toBeNull()
      expect(h.inserts).toEqual([])
      expect(h.applyVerdict).not.toHaveBeenCalled()
      expect(h.createNotification).not.toHaveBeenCalled()
      expect(h.logUsage).not.toHaveBeenCalled()
    })
  }

  it("a reason that mentions a timeout is reported as it is, not as the run's wall", async () => {
    h.outputContract = 'prose'
    eveSession(refusal('provider request timeout'), { final: { status: 'failed' } })
    const result = await createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1' })(verdictAction(), ctx)
    expect(result.status).toBe('failed')
    expect(result.error_message).toBe('eve session failed: provider request timeout')
  })
})

describe('the flow deadline: every run_skill wall fires inside the request budget', () => {
  it('fails a verdict run up front when not even its 240s minimum wall fits (nothing starts, nothing bills)', async () => {
    const executor = createRunSkillExecutor({
      workspaceId: 'ws-1',
      runAsUserId: 'user-1',
      flowId: 'flow-1',
      fireId: 'evt-1',
      flowRunId: 'run-1',
      deadlineMs: Date.now() + 100_000,
    })
    const result = await executor(verdictAction(), ctx)
    expect(result.status).toBe('failed')
    expect(result.error_message).toMatch(/Not enough time left/)
    expect(h.createTaskSession).not.toHaveBeenCalled()
    expect(h.logUsage).not.toHaveBeenCalled()
  })

  it('starts a verdict run when its minimum wall fits', async () => {
    eveSession([step(10, 5), committed(VERDICT)], { final: { status: 'completed', data: VERDICT } })
    const executor = createRunSkillExecutor({
      workspaceId: 'ws-1',
      runAsUserId: 'user-1',
      flowId: 'flow-1',
      fireId: 'evt-1',
      flowRunId: 'run-1',
      deadlineMs: Date.now() + 250_000,
    })
    const result = await executor(verdictAction(), ctx)
    expect(result.status).toBe('success')
    expect(h.createTaskSession).toHaveBeenCalledOnce()
  })
})

describe('wallWithinDeadline / flowRunDeadlineMs', () => {
  it('caps a prose wall at the time left, and refuses under the 30s minimum', async () => {
    const { wallWithinDeadline, MIN_SERVER_WALL_MS } = await import('../run-skill')
    const now = 1_000_000
    expect(wallWithinDeadline({ outputContract: 'prose' }, now + 500_000, now)).toBe(240_000)
    expect(wallWithinDeadline({ outputContract: 'prose' }, now + 60_000, now)).toBe(60_000)
    expect(wallWithinDeadline({ outputContract: 'prose' }, now + MIN_SERVER_WALL_MS - 1, now)).toBeNull()
  })

  it('a verdict run gets its full 480s wall when the budget has it, and never starts under 240s', async () => {
    const { wallWithinDeadline, MIN_VERDICT_WALL_MS } = await import('../run-skill')
    const now = 1_000_000
    expect(wallWithinDeadline({ outputContract: 'verdict' }, now + 555_000, now)).toBe(480_000)
    expect(wallWithinDeadline({ outputContract: 'verdict' }, now + 300_000, now)).toBe(300_000)
    expect(wallWithinDeadline({ outputContract: 'verdict' }, now + MIN_VERDICT_WALL_MS, now)).toBe(240_000)
    expect(wallWithinDeadline({ outputContract: 'verdict' }, now + MIN_VERDICT_WALL_MS - 1, now)).toBeNull()
  })

  it("the /api/inngest budget fits the full verdict wall: the triage sweep is never cut to less", async () => {
    const { wallWithinDeadline, flowRunDeadlineMs, serverTimeoutMsForSpec } = await import('../run-skill')
    const start = 1_000_000
    expect(wallWithinDeadline({ outputContract: 'verdict' }, flowRunDeadlineMs(start), start)).toBe(
      serverTimeoutMsForSpec({ outputContract: 'verdict' }),
    )
  })

  it('the /api/inngest budget fits a full prose wall for every run_skill a flow may enable', async () => {
    // The Morning brief, Session Prep, Weekly Groom and Commitment Reconciler
    // loops were cut at the old 120s wall. Each prose run that uses its whole
    // wall must still leave the next one its whole wall.
    const { wallWithinDeadline, flowRunDeadlineMs, serverTimeoutMsForSpec } = await import('../run-skill')
    const { MAX_ENABLED_RUN_SKILL_ACTIONS } = await import('../queries')
    const prose = serverTimeoutMsForSpec({ outputContract: 'prose' })
    expect(prose).toBe(240_000)
    const start = 1_000_000
    const deadline = flowRunDeadlineMs(start)
    let now = start
    for (let i = 0; i < MAX_ENABLED_RUN_SKILL_ACTIONS; i++) {
      expect(wallWithinDeadline({ outputContract: 'prose' }, deadline, now)).toBe(prose)
      now += prose
    }
  })

  it("is measured from the request start against /api/inngest's maxDuration, minus the tail reserve", async () => {
    const { flowRunDeadlineMs, INNGEST_FUNCTION_BUDGET_MS, FLOW_TAIL_RESERVE_MS } = await import('../run-skill')
    const { readFileSync } = await import('node:fs')
    const route = readFileSync(new URL('../../../app/api/inngest/route.ts', import.meta.url), 'utf8')
    const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1])
    expect(INNGEST_FUNCTION_BUDGET_MS).toBe(maxDuration * 1000)
    expect(flowRunDeadlineMs(0)).toBe(INNGEST_FUNCTION_BUDGET_MS - FLOW_TAIL_RESERVE_MS)
  })

  it("the test-fire route measures from its own maxDuration, not /api/inngest's", async () => {
    const { FLOW_TAIL_RESERVE_MS } = await import('../run-skill')
    const { readFileSync } = await import('node:fs')
    const route = readFileSync(new URL('../../../app/api/account/flows/[id]/fire/route.ts', import.meta.url), 'utf8')
    expect(route).toMatch(/flowRunDeadlineMs\(Date\.now\(\), maxDuration \* 1000\)/)
    const { flowRunDeadlineMs } = await import('../run-skill')
    expect(flowRunDeadlineMs(0, 300_000)).toBe(300_000 - FLOW_TAIL_RESERVE_MS)
  })
})
