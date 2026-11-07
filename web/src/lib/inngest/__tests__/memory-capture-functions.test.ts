/**
 * The capture pass's job (A2c), via the createFunction-capture pattern. Pins:
 * one at a time per person, on `chat/memory.capture`; a skipped operation
 * makes no model call; a queued one is gated on the person's usage, read once
 * on the utility agent (kind memory_capture, its strict schema), billed to the
 * person once (keyed on the operation, decision 8), written, logged as one
 * checkpoint line and marked applied, so a replay writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'
import type { FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { makeFakeMemoryDb } from '@/lib/memory/__tests__/fake-memory-db'

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

import '../memory-capture-functions'
import { MEMORY_CAPTURE_EVENT, MemoryCaptureSchema } from '@/lib/memory/capture-pass'

const event = { data: { operationId: 'op-1', sessionId: 'sess-1', userId: 'u1', workspaceId: 'w1', conversationId: 'c1' } }

function seed(): FakeSupabase {
  const db = makeFakeMemoryDb({ defaults: { profile_fact: { updated_at: '2026-10-14T00:00:00Z', superseded_by: null, retired_at: null } } })
  db.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1', role: 'member' }])
  db.seed('profile_fact', [])
  db.seed('area_memory', [])
  db.seed('chat_memory_op', [
    { operation_id: 'op-1', session_id: 'sess-1', user_id: 'u1', op: 'capture', result: { status: 'queued', slice: [{ role: 'user', text: 'Call me Liam, bullets please.' }] } },
  ])
  hoisted.db = db
  return db
}

beforeEach(() => {
  hoisted.runUtilityTask.mockReset()
  hoisted.logUsage.mockClear()
  hoisted.guard.mockClear()
  hoisted.runUtilityTask.mockResolvedValue({
    object: { stated: [{ text: 'Call me Liam', target: 'profile', area: null, evidence: 'Call me Liam' }], inferred: [], replacements: [], removals: [] },
    model: 'deepseek-v4-flash',
    usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
  })
})

describe('chat-memory-capture', () => {
  it('runs one at a time per person, on chat/memory.capture', () => {
    expect(hoisted.config).toMatchObject({
      id: 'chat-memory-capture',
      concurrency: [{ limit: 1, key: 'event.data.userId' }],
      triggers: [{ event: MEMORY_CAPTURE_EVENT }],
    })
  })

  it('reads once on the utility agent, bills the person once, writes, logs a checkpoint and marks it applied', async () => {
    const db = seed()
    const step = createStepMock()
    const out = await hoisted.handler({ event, step })
    expect(hoisted.guard).toHaveBeenCalledWith('u1')
    // The usage gate runs in its own step, so a replay past it never re-checks.
    expect(step.run.mock.calls.map((c) => c[0])).toEqual(['load', 'guard', 'read', 'write', 'checkpoint'])
    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(1)
    expect(hoisted.runUtilityTask.mock.calls[0][0]).toMatchObject({ kind: 'memory_capture', workspaceId: 'w1', userId: 'u1', chatgptPlan: false, outputSchema: MemoryCaptureSchema })
    expect(hoisted.runUtilityTask.mock.calls[0][0].message).toContain('"role": "person",\n  "text": "Call me Liam, bullets please."')
    expect(hoisted.logUsage).toHaveBeenCalledWith('u1', expect.objectContaining({ feature: 'memory_capture', idempotencyKey: 'memory-capture:op-1' }))
    expect(out).toMatchObject({ saved: 1 })
    expect(db.rows('profile_fact')[0]).toMatchObject({ user_id: 'u1', text: 'Call me Liam', status: 'active', source: 'told' })
    expect(db.rows('agent_log')).toHaveLength(1)
    expect(db.rows('agent_log')[0]).toMatchObject({ kind: 'chat_checkpoint', line: 'Chat checkpoint: 1 fact saved' })
    expect(db.rows('chat_memory_op')[0].result).toMatchObject({ status: 'applied' })

    // A replayed event: no second call, nothing written twice.
    expect(await hoisted.handler({ event, step: createStepMock() })).toEqual({ skipped: 'already_applied' })
    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(1)
  })

  it("runs a free user's read on their own ChatGPT plan and logs the plan's model (billed at no cost)", async () => {
    seed()
    hoisted.guard.mockResolvedValueOnce({ chatgptPlan: true })
    hoisted.runUtilityTask.mockResolvedValueOnce({
      object: { stated: [], inferred: [], replacements: [], removals: [] },
      model: 'chatgpt-plan/gpt-6-luna',
      usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
    })
    await hoisted.handler({ event, step: createStepMock() })
    expect(hoisted.runUtilityTask.mock.calls[0][0]).toMatchObject({ kind: 'memory_capture', userId: 'u1', chatgptPlan: true })
    expect(hoisted.logUsage).toHaveBeenCalledWith('u1', expect.objectContaining({ provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6-luna' }))
  })

  it('skips an unknown operation without a model call', async () => {
    seed()
    expect(await hoisted.handler({ event: { data: { ...event.data, operationId: 'op-x' } }, step: createStepMock() })).toEqual({ skipped: 'unknown_operation' })
    expect(hoisted.runUtilityTask).not.toHaveBeenCalled()
    expect(hoisted.guard).not.toHaveBeenCalled()
  })

  it('refuses an answer that does not match the schema', async () => {
    seed()
    hoisted.runUtilityTask.mockResolvedValueOnce({ object: { stated: 'nope' }, model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 } })
    await expect(hoisted.handler({ event, step: createStepMock() })).rejects.toThrow()
  })
})
