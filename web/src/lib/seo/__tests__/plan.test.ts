/**
 * Whether a person's plan pays for search data (../plan.ts): read from the
 * usage check every AI path uses. Not paying: their own ChatGPT plan (the
 * free tier), or no subscription and no running trial. Unreadable: a throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ rpc }) }))

import { onFreePlan } from '../plan'

const USER = '4d2c7b1a-9a53-4e0f-8f3e-2a6f1c9b7d02'
const row = (over: Record<string, unknown>) => ({ data: [{ allowed: true, reason: 'ok', is_paid_plan: true, ...over }], error: null })

beforeEach(() => rpc.mockReset())

describe('onFreePlan', () => {
  it('asks the usage check with the plan opt-in, for that person', async () => {
    rpc.mockResolvedValue(row({}))
    expect(await onFreePlan(USER)).toBe(false)
    expect(rpc).toHaveBeenCalledWith('check_ai_usage_limit', { p_user_id: USER, p_chatgpt_plan: true })
  })

  it('a person on their own ChatGPT plan does not pay for search data, exhausted or not', async () => {
    for (const reason of ['chatgpt_plan', 'chatgpt_plan_exhausted', 'chatgpt_plan_unsupported']) {
      rpc.mockResolvedValue(row({ reason, is_paid_plan: false }))
      expect(await onFreePlan(USER), reason).toBe(true)
    }
  })

  it('a person with no subscription and no running trial does not either (they used to pass)', async () => {
    for (const reason of ['subscription_required', 'no_plan_configured']) {
      rpc.mockResolvedValue(row({ allowed: false, reason, is_paid_plan: false }))
      expect(await onFreePlan(USER), reason).toBe(true)
    }
  })

  it('a paying person who used up the month’s AI allowance still pays: search data has its own budget', async () => {
    rpc.mockResolvedValue(row({ allowed: false, reason: 'cost_limit_exceeded' }))
    expect(await onFreePlan(USER)).toBe(false)
  })

  it('a running trial counts as a plan that pays', async () => {
    rpc.mockResolvedValue(row({ allowed: true, reason: 'ok', is_paid_plan: false }))
    expect(await onFreePlan(USER)).toBe(false)
  })

  it('an unreadable plan throws, after the attempts it was given', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    await expect(onFreePlan(USER)).rejects.toThrow(/plan check failed: timeout/)
    expect(rpc).toHaveBeenCalledTimes(1)
    rpc.mockClear()
    await expect(onFreePlan(USER, { attempts: 2 })).rejects.toThrow(/plan check failed/)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('a second attempt that answers is the answer', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } }).mockResolvedValueOnce(row({ reason: 'chatgpt_plan' }))
    expect(await onFreePlan(USER, { attempts: 2 })).toBe(true)
  })

  it('no row is no answer: it throws rather than guess', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await expect(onFreePlan(USER)).rejects.toThrow(/returned nothing/)
  })
})
