/**
 * Work-run usage → ai_usage_logs (followups issue 15): one row per model step,
 * keyed per step, billed to the run's user through logUsage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'

const h = vi.hoisted(() => ({ logUsageMock: vi.fn(async (_userId: string, _params: unknown) => 'logged') }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: h.logUsageMock }))

import {
  groupEventsBySteps,
  logWorkRunUsage,
  workRunStepUsages,
  workRunUsageKey,
  WORK_RUN_USAGE_FEATURE,
} from '../work-run-usage'

const MODEL = 'anthropic/claude-sonnet-4.5' // the Gateway slug a step runs; its app id is claude-sonnet-4-5-20250929

const ev = (e: unknown) => e as HandleMessageStreamEvent
const started = (turnId: string, stepIndex: number, modelId = MODEL, at?: string) =>
  ev({ type: 'step.started', data: { modelId, sequence: stepIndex, stepIndex, turnId }, ...(at ? { meta: { at } } : {}) })
const completed = (
  turnId: string,
  stepIndex: number,
  usage: Record<string, number>,
  opts: { at?: string; generationId?: string } = {},
) =>
  ev({
    type: 'step.completed',
    data: {
      finishReason: 'tool-calls',
      sequence: stepIndex,
      stepIndex,
      turnId,
      usage,
      ...(opts.generationId ? { providerMetadata: { gateway: { generationId: opts.generationId } } } : {}),
    },
    ...(opts.at ? { meta: { at: opts.at } } : {}),
  })
const exaResult = (total: number) => ev({ type: 'action.result', data: { result: { output: { costDollars: { total } } } } })
const textDelta = () => ev({ type: 'message.appended', data: { text: 'working' } })

function fakeSupabase(run: Record<string, unknown> | null, error: { message: string } | null = null) {
  const reads: Array<Record<string, unknown>> = []
  const builder = () => {
    const filters: Record<string, unknown> = {}
    const api = {
      select: () => api,
      eq: (k: string, v: unknown) => {
        filters[k] = v
        return api
      },
      maybeSingle: async () => {
        reads.push({ ...filters })
        return { data: run, error }
      },
    }
    return api
  }
  return { client: { from: vi.fn(() => builder()) } as never, reads }
}

beforeEach(() => {
  h.logUsageMock.mockReset()
  h.logUsageMock.mockResolvedValue('logged')
})

describe('groupEventsBySteps / workRunStepUsages', () => {
  it('splits a read into one group per model step, keeping each step’s action results with it', () => {
    const events = [
      textDelta(),
      started('t1', 0),
      completed('t1', 0, { inputTokens: 100, outputTokens: 10 }),
      exaResult(0.007),
      started('t1', 1, 'openai/gpt-5'),
      completed('t1', 1, { inputTokens: 200, outputTokens: 20 }),
      textDelta(),
    ]
    const groups = groupEventsBySteps(events)
    expect(groups.map((g) => g.modelId)).toEqual([MODEL, 'openai/gpt-5'])
    expect(groups[0].events.map((e) => e.type)).toEqual(['step.started', 'step.completed', 'action.result'])
    // the leading text (no completed step) is not billable
    expect(groups.every((g) => g.events.some((e) => e.type === 'step.completed'))).toBe(true)
  })

  it('bills each step on its own model with eve’s cost rule (Exa-contaminated → priced by the RPC)', () => {
    const steps = workRunStepUsages([
      started('t1', 0),
      completed('t1', 0, { inputTokens: 100, outputTokens: 10, costUsd: 0.004, cacheReadTokens: 40 }, { generationId: 'gen-a' }),
      started('t1', 1, 'openai/gpt-5'),
      completed('t1', 1, { inputTokens: 200, outputTokens: 20, costUsd: 0.009 }),
      exaResult(0.007),
    ])
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ turnId: 't1', stepIndex: 0, modelId: MODEL })
    expect(steps[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.004, cacheReadTokens: 40, generationIds: ['gen-a'] })
    expect(steps[1]).toMatchObject({ stepIndex: 1, modelId: 'openai/gpt-5' })
    expect(steps[1].usage.costUsd).toBeNull()
    expect(steps[1].usage.webSearchCostUsd).toBe(0.007)
  })

  it('a step read without its start takes the read’s first model, else "unknown"; a step that spent nothing is left out', () => {
    const midStep = workRunStepUsages([
      completed('t1', 3, { inputTokens: 50, outputTokens: 5 }),
      started('t1', 4),
      completed('t1', 4, { inputTokens: 0, outputTokens: 0 }),
    ])
    expect(midStep.map((s) => [s.stepIndex, s.modelId])).toEqual([[3, MODEL]])
    const alone = workRunStepUsages([completed('t9', 0, { inputTokens: 5, outputTokens: 1 })])
    expect(alone[0].modelId).toBe('unknown')
  })

  it('keys a step by run, turn and step; a reopened chat’s session by that session too', () => {
    expect(workRunUsageKey('run-1', 't1', 2)).toBe('work-run:run-1:t1:2')
    expect(workRunUsageKey('run-1', 't1', 2, 'sess-new')).toBe('work-run:run-1:sess-new:t1:2')
  })
})

describe('logWorkRunUsage', () => {
  const RUN = { triggered_by: 'user-1', ai_team_member_id: 'tm-1', origin: 'attempt' }

  it('logs one billed row per step to the run’s user, keyed per step, with the run in its metadata', async () => {
    const { client, reads } = fakeSupabase(RUN)
    const n = await logWorkRunUsage(client, {
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      source: 'dispatch',
      events: [
        started('t1', 0, MODEL, '2026-09-29T16:54:11.000Z'),
        completed('t1', 0, { inputTokens: 100, outputTokens: 10, costUsd: 0.004, cacheReadTokens: 40 }, { at: '2026-09-29T16:54:13.500Z' }),
        started('t1', 1),
        completed('t1', 1, { inputTokens: 300, outputTokens: 30 }),
      ],
    })
    expect(n).toBe(2)
    expect(reads).toEqual([{ id: 'run-1', workspace_id: 'ws-1' }])
    expect(h.logUsageMock).toHaveBeenCalledTimes(2)
    const [userId, first] = h.logUsageMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(userId).toBe('user-1')
    expect(first).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      feature: WORK_RUN_USAGE_FEATURE,
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 2500,
      costUsd: 0.004,
      idempotencyKey: 'work-run:run-1:t1:0',
    })
    expect(first.metadata).toMatchObject({
      workspace_id: 'ws-1',
      agent_run_id: 'run-1',
      ai_team_member_id: 'tm-1',
      origin: 'attempt',
      source: 'dispatch',
      turn_id: 't1',
      step_index: 0,
      gateway_model: MODEL,
      cache_read_input_tokens: 40,
      // No stored tier: the default, Think (auto model selection).
      model_route: { tier: 'think', by: 'fixed', signals: ['default'], reasoning: 'high' },
    })
    const second = h.logUsageMock.mock.calls[1][1] as Record<string, unknown>
    expect(second).toMatchObject({ idempotencyKey: 'work-run:run-1:t1:1', costUsd: undefined })
  })

  it('a run refused Strong (the cap or the plan) logs by: cap, as its start stored it', async () => {
    const { client } = fakeSupabase({ ...RUN, model_tier: 'think', model_tier_by: 'cap' })
    await logWorkRunUsage(client, {
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      source: 'dispatch',
      events: [started('t4', 0, 'deepseek/deepseek-v4-flash'), completed('t4', 0, { inputTokens: 9, outputTokens: 3 })],
    })
    expect((h.logUsageMock.mock.calls[0][1] as { metadata: Record<string, unknown> }).metadata.model_route).toEqual({ tier: 'think', by: 'cap', signals: ['run_tier'], reasoning: 'high' })
  })

  it('names the run\'s stored tier in model_route (agent_run.model_tier, migration 345)', async () => {
    const { client } = fakeSupabase({ ...RUN, model_tier: 'strong' })
    await logWorkRunUsage(client, {
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      source: 'dispatch',
      events: [started('t3', 0, 'anthropic/claude-sonnet-5.5'), completed('t3', 0, { inputTokens: 9, outputTokens: 3 })],
    })
    const row = h.logUsageMock.mock.calls[0][1] as { model: string; metadata: Record<string, unknown> }
    expect(row.model).toBe('claude-sonnet-5-5')
    expect(row.metadata.model_route).toEqual({ tier: 'strong', by: 'rule', signals: ['run_tier'], reasoning: 'adaptive' })
  })

  it('bills a non-Anthropic step under its own provider and app id', async () => {
    const { client } = fakeSupabase(RUN)
    await logWorkRunUsage(client, {
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      source: 'chat',
      events: [started('t2', 0, 'deepseek/deepseek-v4-flash'), completed('t2', 0, { inputTokens: 9, outputTokens: 3 })],
    })
    expect(h.logUsageMock.mock.calls[0][1]).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('a reopened chat’s session never collides with the run’s own turns (eve restarts at turn_0 per session)', async () => {
    const { client } = fakeSupabase(RUN)
    const events = [started('turn_0', 0), completed('turn_0', 0, { inputTokens: 100, outputTokens: 10 })]
    await logWorkRunUsage(client, { agentRunId: 'run-1', workspaceId: 'ws-1', source: 'dispatch', events })
    await logWorkRunUsage(client, { agentRunId: 'run-1', workspaceId: 'ws-1', source: 'chat', events, sessionId: 'sess-new' })
    const rows = h.logUsageMock.mock.calls.map((c) => c[1] as { idempotencyKey: string; metadata: Record<string, unknown> })
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['work-run:run-1:turn_0:0', 'work-run:run-1:sess-new:turn_0:0'])
    expect(rows[0].metadata.eve_session_id).toBeUndefined()
    expect(rows[1].metadata.eve_session_id).toBe('sess-new')
  })

  it('a re-read of the same steps reuses their keys, so the RPC bills them once', async () => {
    const { client } = fakeSupabase(RUN)
    const events = [started('t1', 0), completed('t1', 0, { inputTokens: 100, outputTokens: 10 })]
    await logWorkRunUsage(client, { agentRunId: 'run-1', workspaceId: 'ws-1', source: 'dispatch', events })
    await logWorkRunUsage(client, {
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      source: 'dispatch',
      events: [...events, started('t1', 1), completed('t1', 1, { inputTokens: 5, outputTokens: 1 })],
    })
    const keys = h.logUsageMock.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey)
    expect(keys).toEqual(['work-run:run-1:t1:0', 'work-run:run-1:t1:0', 'work-run:run-1:t1:1'])
  })

  it('reads nothing and logs nothing when the read holds no model step', async () => {
    const { client, reads } = fakeSupabase(RUN)
    expect(await logWorkRunUsage(client, { agentRunId: 'run-1', workspaceId: 'ws-1', source: 'chat', events: [textDelta()] })).toBe(0)
    expect(reads).toHaveLength(0)
    expect(h.logUsageMock).not.toHaveBeenCalled()
  })

  it('logs nothing without a payer: no run in this workspace, or no triggered_by', async () => {
    const events = [started('t1', 0), completed('t1', 0, { inputTokens: 1, outputTokens: 1 })]
    for (const run of [null, { triggered_by: null }]) {
      const { client } = fakeSupabase(run)
      expect(await logWorkRunUsage(client, { agentRunId: 'run-1', workspaceId: 'ws-1', source: 'chat', events })).toBe(0)
    }
    expect(h.logUsageMock).not.toHaveBeenCalled()
  })

  it('never throws: a failed read or a throwing logger returns 0 with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = [started('t1', 0), completed('t1', 0, { inputTokens: 1, outputTokens: 1 })]
      const failedRead = fakeSupabase(null, { message: 'boom' })
      await expect(
        logWorkRunUsage(failedRead.client, { agentRunId: 'run-1', workspaceId: 'ws-1', source: 'dispatch', events }),
      ).resolves.toBe(0)
      h.logUsageMock.mockRejectedValueOnce(new Error('rpc down'))
      const ok = fakeSupabase(RUN)
      await expect(
        logWorkRunUsage(ok.client, { agentRunId: 'run-1', workspaceId: 'ws-1', source: 'dispatch', events }),
      ).resolves.toBe(0)
      expect(warn).toHaveBeenCalledWith('[work-run-usage] could not log usage', expect.objectContaining({ agentRunId: 'run-1' }))
    } finally {
      warn.mockRestore()
    }
  })
})
