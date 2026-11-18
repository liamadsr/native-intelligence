/**
 * The trial wall for a demo workspace's visitor (migration 667): in without a
 * seat, but only as state 'demo' with the one workspace named, and never
 * ahead of a seat or a ChatGPT plan of their own.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SubscriptionRow } from '@/app/api/billing/status/pick-subscription'

vi.mock('@/lib/admin/signup-invites', () => ({ findSignupInviteForUser: async () => null }))

import { classifyBillingAccess } from '../access'
import { getBillingAccess } from '../access.server'

const DEMO = '11111111-2222-4333-8444-555555555555'
const now = new Date('2026-11-17T12:00:00Z')

const active: SubscriptionRow = {
  status: 'active',
  stripe_subscription_id: 'sub_1',
  stripe_customer_id: 'cus_1',
  current_period_start: '2026-11-01T00:00:00Z',
  current_period_end: '2026-12-01T00:00:00Z',
  cancel_at_period_end: false,
  created_at: '2026-11-01T00:00:00Z',
}

describe('classifyBillingAccess: a demo workspace visitor', () => {
  it('is let in with no subscription, as state demo, naming the workspace', () => {
    const access = classifyBillingAccess([], { invitedByAdmin: false, demoWorkspaceId: DEMO }, now)
    expect(access).toMatchObject({ state: 'demo', allowed: true, demoWorkspaceId: DEMO, hasStripe: false })
  })

  it('stays behind the wall with no demo workspace', () => {
    const access = classifyBillingAccess([], { invitedByAdmin: false, demoWorkspaceId: null }, now)
    expect(access).toMatchObject({ state: 'none', allowed: false, demoWorkspaceId: null })
  })

  it('a seat of their own wins: not confined to the demo workspace', () => {
    const access = classifyBillingAccess([active], { invitedByAdmin: false, demoWorkspaceId: DEMO }, now)
    expect(access).toMatchObject({ state: 'active', allowed: true, demoWorkspaceId: null })
  })

  it('a ChatGPT plan of their own wins too', () => {
    const access = classifyBillingAccess([], { invitedByAdmin: false, chatgptPlan: 'active', demoWorkspaceId: DEMO }, now)
    expect(access).toMatchObject({ state: 'chatgpt', allowed: true, demoWorkspaceId: null })
  })

  it('a lapsed subscription falls back to the demo place, still confined', () => {
    const access = classifyBillingAccess([{ ...active, status: 'past_due' }], { invitedByAdmin: false, demoWorkspaceId: DEMO }, now)
    expect(access).toMatchObject({ state: 'demo', allowed: true, demoWorkspaceId: DEMO })
  })
})

/** The user's own client: no subscriptions, and each rpc answered by name. */
function client(rpcs: Record<string, () => Promise<{ data: unknown; error: unknown }>>): SupabaseClient {
  return {
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    rpc: vi.fn((name: string) => (rpcs[name] ?? (async () => ({ data: null, error: null })))()),
  } as unknown as SupabaseClient
}

const user = { id: 'u1', email: 'visitor@fund.example' }

describe('getBillingAccess: my_demo_seat_workspace()', () => {
  it('reads the caller’s demo workspace with their own client', async () => {
    const supabase = client({ my_demo_seat_workspace: async () => ({ data: DEMO, error: null }) })
    const access = await getBillingAccess(supabase, user)
    expect(access).toMatchObject({ state: 'demo', allowed: true, demoWorkspaceId: DEMO })
    expect(supabase.rpc).toHaveBeenCalledWith('my_demo_seat_workspace')
  })

  it('fails closed: an error, a throw or a value that is not a workspace id is the wall', async () => {
    for (const answer of [
      async () => ({ data: null, error: { message: 'nope' } }),
      async () => { throw new Error('down') },
      async () => ({ data: 'true', error: null }),
      async () => ({ data: true, error: null }),
      async () => ({ data: null, error: null }),
    ]) {
      const access = await getBillingAccess(client({ my_demo_seat_workspace: answer }), user)
      expect(access).toMatchObject({ allowed: false, demoWorkspaceId: null })
    }
  })
})
