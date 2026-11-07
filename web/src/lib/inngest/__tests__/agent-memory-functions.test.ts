/**
 * The settle-time memory writer (plan row 15), via the createFunction-capture
 * pattern. Pins: one at a time per teammate; a skipped run makes no model
 * call; a summarised run calls the utility agent once with the built message,
 * bills the run's user once (keyed on the run), and writes the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: StepMock }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
  db: null as unknown,
  runUtilityTask: vi.fn(),
  logUsage: vi.fn(async () => undefined),
  guard: vi.fn(async (): Promise<{ chatgptPlan: boolean }> => ({ chatgptPlan: false })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.config = config
      hoisted.handler = fn
      return { id: config.id }
    },
    send: vi.fn(),
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.runUtilityTask }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: hoisted.logUsage }))
vi.mock('../usage-guard', () => ({ guardBackgroundUsageOnPlan: hoisted.guard }))

import '../agent-memory-functions'
import { AGENT_MEMORY_SUMMARIZE_EVENT } from '@/lib/work/agent-memory'

const WS = 'ws-1'
const MATE = 'mate-1'
const RUN = 'run-1'
const event = { data: { agent_run_id: RUN, workspace_id: WS, ai_team_member_id: MATE } }

function seed(status = 'completed') {
  const db = makeFakeSupabase()
  db.seed('agent_run', [
    {
      id: RUN,
      workspace_id: WS,
      kind: 'workspace',
      status,
      ai_team_member_id: MATE,
      triggered_by: 'user-1',
      task_prompt: 'Draft the Q3 kickoff note.',
      result_summary: 'Drafted it as bullets.',
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 kickoff note' }],
      resources: [],
    },
  ])
  db.seed('ai_team_member', [{ id: MATE, workspace_id: WS, name: 'Quill', role: 'writer' }])
  hoisted.db = db
  return db
}

beforeEach(() => {
  hoisted.runUtilityTask.mockReset()
  hoisted.logUsage.mockClear()
  hoisted.guard.mockClear()
})

describe('agentMemorySummarize', () => {
  it('runs on the summary event, one at a time per teammate', () => {
    expect(hoisted.config.triggers).toEqual([{ event: AGENT_MEMORY_SUMMARIZE_EVENT }])
    expect(hoisted.config.concurrency).toEqual([{ limit: 1, key: 'event.data.ai_team_member_id' }])
  })

  it('makes no model call for a run it skips', async () => {
    seed('failed')
    const out = await hoisted.handler({ event, step: createStepMock() })
    expect(out).toEqual({ skipped: 'not a completed work run' })
    expect(hoisted.runUtilityTask).not.toHaveBeenCalled()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('summarises once, bills the run’s user once, and writes the answer', async () => {
    const db = seed()
    hoisted.runUtilityTask.mockResolvedValue({
      text: '',
      model: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
      object: { entries: [{ kind: 'preference', text: 'Dana wants kickoff notes as three bullets.', replaces: null }] },
    })
    const out = await hoisted.handler({ event, step: createStepMock() })
    expect(out).toEqual({ inserted: 1, superseded: 0, retired: 0 })

    expect(hoisted.guard).toHaveBeenCalledWith('user-1')
    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(1)
    const call = hoisted.runUtilityTask.mock.calls[0][0]
    expect(call).toMatchObject({ kind: 'agent_memory_summary', workspaceId: WS, userId: 'user-1', chatgptPlan: false })
    expect(call.message).toContain('Teammate: Quill (writer)')
    expect(call.message).toContain('- document: Q3 kickoff note')

    expect(hoisted.logUsage).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ feature: 'agent_memory_summary', idempotencyKey: `agent-memory:${RUN}`, inputTokens: 900 }),
    )
    expect(db.rows('agent_memory')).toEqual([
      expect.objectContaining({ agent_run_id: RUN, ai_team_member_id: MATE, text: 'Dana wants kickoff notes as three bullets.' }),
    ])
  })

  it("runs a free user's summary on their own ChatGPT plan and logs the plan's model (billed at no cost)", async () => {
    seed()
    hoisted.guard.mockResolvedValueOnce({ chatgptPlan: true })
    hoisted.runUtilityTask.mockResolvedValue({
      text: '',
      model: 'chatgpt-plan/gpt-6-luna',
      usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
      object: { entries: [] },
    })
    await hoisted.handler({ event, step: createStepMock() })
    expect(hoisted.runUtilityTask.mock.calls[0][0]).toMatchObject({ kind: 'agent_memory_summary', userId: 'user-1', chatgptPlan: true })
    expect(hoisted.logUsage).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6-luna' }),
    )
  })
})
