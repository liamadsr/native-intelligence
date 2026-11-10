import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/billing/checkout/confirm — records the subscription behind a
 * Checkout session the caller just completed. Must refuse sessions that
 * belong to someone else and malformed ids.
 */

const hoisted = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  session: null as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
  planUpserts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: hoisted.user }, error: null }) },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'subscriptions') {
        return { upsert: async (row: Record<string, unknown>) => { hoisted.upserts.push(row); return { error: null } } }
      }
      if (table === 'ai_plan_definitions') {
        return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: 'plan-sub' } }) }) }) }) }
      }
      if (table === 'ai_user_plans') {
        return { upsert: async (row: Record<string, unknown>) => { hoisted.planUpserts.push(row); return { error: null } } }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    checkout: { sessions: { retrieve: async () => hoisted.session } },
    subscriptions: { retrieve: async () => { throw new Error('should be expanded') } },
  }),
}))

const { POST } = await import('@/app/api/billing/checkout/confirm/route')

function req(body: unknown): Request {
  return new Request('https://nativeintelligence.dev/api/billing/checkout/confirm', { method: 'POST', body: JSON.stringify(body) })
}

const trialSub = {
  id: 'sub_1',
  status: 'trialing',
  customer: 'cus_1',
  cancel_at_period_end: false,
  items: { data: [{ current_period_start: 1_756_800_000, current_period_end: 1_757_404_800 }] },
}

beforeEach(() => {
  hoisted.user = { id: 'user-1' }
  hoisted.session = { mode: 'subscription', metadata: { user_id: 'user-1' }, subscription: trialSub }
  hoisted.upserts = []
  hoisted.planUpserts = []
})

describe('POST /api/billing/checkout/confirm', () => {
  it('rejects malformed session ids', async () => {
    expect((await POST(req({ session_id: 'nope' }))).status).toBe(400)
    expect((await POST(req({}))).status).toBe(400)
  })

  it("refuses another user's session", async () => {
    hoisted.session = { ...hoisted.session, metadata: { user_id: 'someone-else' } }
    expect((await POST(req({ session_id: 'cs_test_1' }))).status).toBe(403)
    expect(hoisted.upserts).toHaveLength(0)
  })

  it('records the trialing subscription with item-level period dates and assigns the plan', async () => {
    const res = await POST(req({ session_id: 'cs_test_1' }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('trialing')
    expect(hoisted.upserts[0]).toMatchObject({
      user_id: 'user-1',
      stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1',
      status: 'trialing',
      current_period_end: new Date(1_757_404_800 * 1000).toISOString(),
    })
    expect(hoisted.planUpserts[0]).toMatchObject({ user_id: 'user-1', plan_id: 'plan-sub' })
  })
})
