import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

/**
 * Tests for the durable usage-log retry handler (billing-functions.ts).
 *
 * The retry re-runs the log_ai_usage RPC after an inline failure. It must honor
 * the ORIGINAL call's billing intent: a skipBilling run (an eval turn the
 * user is never charged for) must pass p_cost_usd: 0,
 * NOT null. A null makes the RPC compute a real cost and CHARGE for a run that
 * should be $0 — the bug this guards.
 *
 * inngest.createFunction is stubbed to capture the handler so it can be driven
 * directly with a fake { event, step }.
 */

const hoisted = vi.hoisted(() => ({
  rpc: vi.fn(),
  handler: null as null | ((args: unknown) => unknown),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_config: unknown, handler: (args: unknown) => unknown) => {
      hoisted.handler = handler
      return {}
    },
  },
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ rpc: hoisted.rpc }),
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

// Importing registers the function → populates hoisted.handler.
await import('../billing-functions')

// Shared Inngest step mock: run() invokes the fn inline (no durability in the
// test) and every step method throws if called from inside a step.run callback
// — that nesting deadlocks in production. See src/test/inngest-step-mock.ts.
const step = createStepMock()

async function runRetry(userId: string, params: Record<string, unknown>) {
  hoisted.rpc.mockResolvedValueOnce({ error: null })
  await hoisted.handler!({ event: { data: { userId, params } }, step })
  return hoisted.rpc.mock.calls[0][1] as Record<string, unknown>
}

beforeEach(() => hoisted.rpc.mockReset())

describe('usageLogRetry — cost mapping', () => {
  it('forces p_cost_usd:0 for a skipBilling run (never charge for a $0 run)', async () => {
    const args = await runRetry('u1', {
      provider: 'claude',
      model: 'claude-opus',
      feature: 'live_agent',
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 1000,
      // An eval run carries its real cost for VISIBILITY only.
      costUsd: 0.42,
      skipBilling: true,
    })
    expect(args.p_cost_usd).toBe(0)
  })

  it('passes the authoritative costUsd for a normal (billed) run', async () => {
    const args = await runRetry('u1', {
      provider: 'claude',
      model: 'claude-opus',
      feature: 'flow_run_skill',
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 1000,
      costUsd: 0.42,
    })
    expect(args.p_cost_usd).toBe(0.42)
  })

  it('passes null when a billed run has no costUsd (RPC computes it)', async () => {
    const args = await runRetry('u1', {
      provider: 'deepgram',
      model: 'nova',
      feature: 'transcription',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 500,
    })
    expect(args.p_cost_usd).toBeNull()
  })
})

describe('usageLogRetry — an idempotency-keyed payload (eve chat turns)', () => {
  it('re-runs through log_ai_usage_once with the SAME key, so a failure that committed is not billed twice', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: [{ duplicate: true }], error: null })
    await hoisted.handler!({
      event: {
        data: {
          userId: 'u1',
          params: { provider: 'deepseek', model: 'deepseek-v4-flash', feature: 'ai_chat', inputTokens: 10, outputTokens: 2, durationMs: 5, idempotencyKey: 'ai_chat:sess-1:turn_0' },
        },
      },
      step,
    })
    expect(hoisted.rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = hoisted.rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(fn).toBe('log_ai_usage_once')
    expect(args).toMatchObject({ p_idempotency_key: 'ai_chat:sess-1:turn_0', p_user_id: 'u1', p_feature: 'ai_chat', p_edge_function: 'inngest-retry' })
  })

  it.each(['PGRST202', '42883'])(
    'the keyed RPC missing (%s) on the retry falls back to plain log_ai_usage, still tagged inngest-retry',
    async (code) => {
      hoisted.rpc
        .mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function', code } })
        .mockResolvedValueOnce({ data: [{ log_id: 'l1' }], error: null })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await hoisted.handler!({
        event: {
          data: {
            userId: 'u1',
            params: { provider: 'deepseek', model: 'deepseek-v4-flash', feature: 'ai_chat', inputTokens: 10, outputTokens: 2, durationMs: 5, idempotencyKey: 'ai_chat:sess-1:turn_0' },
          },
        },
        step,
      })
      spy.mockRestore()
      expect(hoisted.rpc.mock.calls.map(([fn]) => fn)).toEqual(['log_ai_usage_once', 'log_ai_usage'])
      const fallback = hoisted.rpc.mock.calls[1][1] as Record<string, unknown>
      expect(fallback).not.toHaveProperty('p_idempotency_key')
      expect(fallback).toMatchObject({ p_user_id: 'u1', p_feature: 'ai_chat', p_edge_function: 'inngest-retry' })
    },
  )

  it('an unkeyed payload keeps calling plain log_ai_usage', async () => {
    await runRetry('u1', { provider: 'claude', model: 'm', feature: 'ai_summarize', inputTokens: 1, outputTokens: 1, durationMs: 1 })
    expect(hoisted.rpc.mock.calls[0][0]).toBe('log_ai_usage')
  })
})
