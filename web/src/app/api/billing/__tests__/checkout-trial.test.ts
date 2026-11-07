import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/billing/checkout — the card-backed trial. First-time users get a
 * 7-day trial with the card collected up front; anyone who has held a real
 * Stripe subscription before is charged immediately; an already-active seat
 * is refused.
 */

const hoisted = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'jane@acme.com' } as { id: string; email: string } | null,
  subRows: [] as Array<Record<string, unknown>>,
  sessionsCreate: vi.fn(),
  customersCreate: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: hoisted.user }, error: null }) },
    from: (table: string) => {
      if (table === 'subscriptions') {
        return { select: () => ({ eq: async () => ({ data: hoisted.subRows }) }) }
      }
      if (table === 'ai_plan_definitions') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: { stripe_price_id: 'price_99' } }) }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    checkout: { sessions: { create: hoisted.sessionsCreate } },
    customers: { create: hoisted.customersCreate },
  }),
  safeCheckoutOrigin: () => 'https://dial8.ai',
}))

const { POST } = await import('@/app/api/billing/checkout/route')

function req(body?: unknown): Request {
  return new Request('https://dial8.ai/api/billing/checkout', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  hoisted.user = { id: 'user-1', email: 'jane@acme.com' }
  hoisted.subRows = []
  hoisted.sessionsCreate.mockReset().mockResolvedValue({ url: 'https://checkout.stripe.com/x' })
  hoisted.customersCreate.mockReset().mockResolvedValue({ id: 'cus_new' })
})

describe('POST /api/billing/checkout', () => {
  it('401s without a user', async () => {
    hoisted.user = null
    expect((await POST(req())).status).toBe(401)
  })

  it('starts a 7-day trial with the card collected up front for a first-time user', async () => {
    const res = await POST(req({ return: 'start-trial' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trial).toBe(true)
    const args = hoisted.sessionsCreate.mock.calls[0][0]
    expect(args.mode).toBe('subscription')
    expect(args.payment_method_collection).toBe('always')
    expect(args.subscription_data.trial_period_days).toBe(7)
    expect(args.subscription_data.trial_settings.end_behavior.missing_payment_method).toBe('cancel')
    expect(args.subscription_data.metadata.user_id).toBe('user-1')
    expect(args.success_url).toContain('/account/start-trial?session_id={CHECKOUT_SESSION_ID}')
    expect(args.cancel_url).toBe('https://dial8.ai/account/start-trial')
    expect(args.line_items).toEqual([{ price: 'price_99', quantity: 1 }])
    expect(hoisted.customersCreate).toHaveBeenCalled()
  })

  it('charges immediately (no trial) when a Stripe subscription existed before', async () => {
    hoisted.subRows = [
      { status: 'canceled', stripe_subscription_id: 'sub_old', stripe_customer_id: 'cus_old', current_period_end: '2026-01-01T00:00:00Z', created_at: '2025-12-01T00:00:00Z' },
    ]
    const res = await POST(req({ return: 'billing' }))
    const body = await res.json()
    expect(body.trial).toBe(false)
    const args = hoisted.sessionsCreate.mock.calls[0][0]
    expect(args.subscription_data.trial_period_days).toBeUndefined()
    expect(args.customer).toBe('cus_old')
    expect(hoisted.customersCreate).not.toHaveBeenCalled()
    expect(args.success_url).toContain('/account/settings/billing?upgraded=1')
  })

  it('still offers a trial after a complimentary (granted) row only', async () => {
    hoisted.subRows = [
      { status: 'canceled', stripe_subscription_id: 'granted_1', stripe_customer_id: null, current_period_end: null, created_at: '2025-12-01T00:00:00Z' },
    ]
    const body = await (await POST(req())).json()
    expect(body.trial).toBe(true)
  })

  it('refuses when a trialing or active seat already exists', async () => {
    hoisted.subRows = [
      { status: 'trialing', stripe_subscription_id: 'sub_live', stripe_customer_id: 'cus_1', current_period_end: '2099-01-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z' },
    ]
    const res = await POST(req())
    expect(res.status).toBe(400)
    expect(hoisted.sessionsCreate).not.toHaveBeenCalled()
  })
})
