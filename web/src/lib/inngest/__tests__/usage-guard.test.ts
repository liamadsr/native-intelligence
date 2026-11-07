import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for guardBackgroundUsage (P1-4) — the non-throwing-Response usage gate
 * for Inngest jobs. Blocked users must raise a NonRetriableError so the run
 * fails immediately instead of burning retries; infra errors fail OPEN.
 */

const hoisted = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ rpc: hoisted.rpc }),
}))

const { guardBackgroundUsage, isUsageAllowed } = await import('@/lib/inngest/usage-guard')
const { NonRetriableError } = await import('inngest')

beforeEach(() => hoisted.rpc.mockReset())

describe('guardBackgroundUsage', () => {
  it('is a no-op for an unattributed (null) user', async () => {
    await expect(guardBackgroundUsage(null)).resolves.toBeUndefined()
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('passes when the user is within limits', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: [{ allowed: true }], error: null })
    await expect(guardBackgroundUsage('u1')).resolves.toBeUndefined()
  })

  it('throws NonRetriableError when the user is over limit', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: [{ allowed: false, reason: 'cost_limit_exceeded' }], error: null })
    await expect(guardBackgroundUsage('u1')).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('fails OPEN (no throw) on an RPC/infra error', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(guardBackgroundUsage('u1')).resolves.toBeUndefined()
    spy.mockRestore()
  })
})

describe('isUsageAllowed', () => {
  const client = () => ({ rpc: hoisted.rpc }) as never

  it('opts in to the ChatGPT plan: a person on their own plan may have their loops enqueued', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: [{ allowed: true, reason: 'chatgpt_plan' }], error: null })
    expect(await isUsageAllowed(client(), 'u1')).toBe(true)
    expect(hoisted.rpc).toHaveBeenCalledWith('check_ai_usage_limit', { p_user_id: 'u1', p_chatgpt_plan: true })
  })

  it('is false only on an explicit refusal, and fails open on an RPC error', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: [{ allowed: false, reason: 'subscription_required' }], error: null })
    expect(await isUsageAllowed(client(), 'u1')).toBe(false)
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await isUsageAllowed(client(), 'u1')).toBe(true)
    spy.mockRestore()
  })
})
