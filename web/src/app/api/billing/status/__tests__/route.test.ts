import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock, type SupabaseMockOptions } from '@/test/supabase-mock'

/**
 * Tests for GET /api/billing/status.
 *
 * Focus: the `usage.resets_at` field added alongside migration 199
 * (subscription-aligned allowance reset). The route must surface
 * `ai_user_plans.usage_reset_date` as an ISO string, and be null-safe when the
 * plan row (or the column) is absent. The billing UI reads this to promise a
 * reset date the backend actually honors.
 */

const hoisted = vi.hoisted(() => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: hoisted.createClient,
}))

const { GET } = await import('@/app/api/billing/status/route')

const USER = {
  id: 'user-1',
  email: 'sub@acme.com', // not @dial8.ai: staff are billing-exempt (lib/billing/access)
  // created ~30 days ago so the trial-window math is stable and irrelevant here
  created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  user_metadata: {},
}

function mountSupabase(opts: SupabaseMockOptions) {
  const mock = createSupabaseMock({ auth: { user: USER as never }, ...opts })
  // The route calls supabase.auth.getUser() and expects { data: { user }, ... }.
  hoisted.createClient.mockResolvedValue(mock)
  return mock
}

beforeEach(() => {
  hoisted.createClient.mockReset()
})

describe('GET /api/billing/status — usage.resets_at', () => {
  it('surfaces ai_user_plans.usage_reset_date as an ISO string', async () => {
    // A subscriber whose allowance is aligned to their Stripe billing period.
    const periodEnd = '2026-08-14T00:00:00.000Z'
    const resetDate = '2026-08-14T00:00:00+00:00' // stored form (timestamptz)

    mountSupabase({
      tables: {
        // The route now fetches ALL subscription rows and picks via
        // pickSubscriptionRow, so the mock returns an array.
        subscriptions: {
          data: [
            {
              status: 'active',
              stripe_subscription_id: 'sub_123',
              stripe_customer_id: 'cus_123',
              current_period_start: '2026-07-14T00:00:00.000Z',
              current_period_end: periodEnd,
              cancel_at_period_end: false,
              created_at: '2026-06-14T00:00:00.000Z',
            },
          ],
          error: null,
        },
        ai_user_plans: {
          data: {
            current_period_cost_usd: 2.5,
            current_period_tokens: 1000,
            current_period_requests: 10,
            usage_reset_date: resetDate,
            // Joined plan def with a non-null limit so the route does NOT fire
            // the conditional subscriber-plan follow-up query.
            ai_plan_definitions: {
              name: 'subscriber',
              display_name: 'Pro',
              monthly_cost_limit_usd: 8,
              description: null,
              feature_highlights: [],
            },
          },
          error: null,
        },
        ai_plan_definitions: { data: [], error: null }, // visible-plans list
        ai_user_credits: {
          data: { balance_usd: 0, lifetime_granted_usd: 0, lifetime_consumed_usd: 0 },
          error: null,
        },
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.usage.resets_at).toBe(new Date(resetDate).toISOString())
    // Sanity: it aligns to the Stripe period end in this scenario.
    expect(body.usage.resets_at).toBe(periodEnd)
  })

  it('is null when no plan row exists', async () => {
    mountSupabase({
      tables: {
        subscriptions: { data: null, error: null },
        ai_user_plans: { data: null, error: null },
        ai_plan_definitions: { data: [], error: null },
        ai_user_credits: { data: null, error: null },
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.usage.resets_at).toBeNull()
  })

  it('is null when the plan row lacks usage_reset_date', async () => {
    mountSupabase({
      tables: {
        subscriptions: { data: null, error: null },
        ai_user_plans: {
          data: {
            current_period_cost_usd: 0.1,
            current_period_tokens: 50,
            current_period_requests: 1,
            usage_reset_date: null,
            ai_plan_definitions: {
              name: 'free',
              display_name: 'Free',
              monthly_cost_limit_usd: 1,
              description: null,
              feature_highlights: [],
            },
          },
          error: null,
        },
        ai_plan_definitions: { data: [], error: null },
        ai_user_credits: { data: null, error: null },
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.usage.resets_at).toBeNull()
  })

  it('401s when unauthenticated', async () => {
    const mock = createSupabaseMock({ auth: { user: null } })
    hoisted.createClient.mockResolvedValue(mock)
    const res = await GET()
    expect(res.status).toBe(401)
  })
})

describe('GET /api/billing/status — subscription row selection', () => {
  // subscriptions has no unique constraint on user_id: canceled history rows
  // and granted + real Stripe rows coexist. The route must mirror the SQL's
  // preference (active/trialing, max future period end), not "newest row".

  const PLAN_ROW = {
    data: {
      current_period_cost_usd: 1,
      current_period_tokens: 10,
      current_period_requests: 2,
      usage_reset_date: '2099-01-01T00:00:00.000Z',
      ai_plan_definitions: {
        name: 'subscriber',
        display_name: 'Pro',
        monthly_cost_limit_usd: 8,
        description: null,
        feature_highlights: [],
      },
    },
    error: null,
  }

  it('prefers an ACTIVE row over a NEWER canceled row', async () => {
    const activeEnd = '2099-06-01T00:00:00.000Z'
    mountSupabase({
      tables: {
        subscriptions: {
          data: [
            {
              // canceled row is NEWER — the old order-by-created_at pick
              // would grab this and report no subscription at all.
              status: 'canceled',
              stripe_subscription_id: 'sub_canceled',
              stripe_customer_id: 'cus_1',
              current_period_start: '2026-06-01T00:00:00.000Z',
              current_period_end: '2026-07-01T00:00:00.000Z',
              cancel_at_period_end: false,
              created_at: '2026-07-10T00:00:00.000Z',
            },
            {
              status: 'active',
              stripe_subscription_id: 'sub_active',
              stripe_customer_id: 'cus_1',
              current_period_start: '2026-07-01T00:00:00.000Z',
              current_period_end: activeEnd,
              cancel_at_period_end: false,
              created_at: '2026-06-01T00:00:00.000Z',
            },
          ],
          error: null,
        },
        ai_user_plans: PLAN_ROW,
        ai_plan_definitions: { data: [], error: null },
        ai_user_credits: { data: null, error: null },
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subscription).not.toBeNull()
    expect(body.subscription.status).toBe('active')
    expect(body.subscription.current_period_end).toBe(activeEnd)
    expect(body.subscription.has_stripe).toBe(true)
    expect(body.plan.name).toBe('subscriber')
  })

  it('prefers a real Stripe row (future end) over a NEWER granted row (NULL end)', async () => {
    const realEnd = '2099-03-01T00:00:00.000Z'
    mountSupabase({
      tables: {
        subscriptions: {
          data: [
            {
              status: 'active',
              stripe_subscription_id: 'granted_admin',
              stripe_customer_id: null,
              current_period_start: null,
              current_period_end: null, // admin-granted: no Stripe period
              cancel_at_period_end: false,
              created_at: '2026-07-10T00:00:00.000Z',
            },
            {
              status: 'active',
              stripe_subscription_id: 'sub_real',
              stripe_customer_id: 'cus_1',
              current_period_start: '2026-07-01T00:00:00.000Z',
              current_period_end: realEnd,
              cancel_at_period_end: false,
              created_at: '2026-06-01T00:00:00.000Z',
            },
          ],
          error: null,
        },
        ai_user_plans: PLAN_ROW,
        ai_plan_definitions: { data: [], error: null },
        ai_user_credits: { data: null, error: null },
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subscription).not.toBeNull()
    expect(body.subscription.has_stripe).toBe(true)
    expect(body.subscription.current_period_end).toBe(realEnd)
  })

  it('reports no subscription when only canceled rows exist', async () => {
    mountSupabase({
      tables: {
        subscriptions: {
          data: [
            {
              status: 'canceled',
              stripe_subscription_id: 'sub_old_1',
              stripe_customer_id: 'cus_1',
              current_period_start: '2026-05-01T00:00:00.000Z',
              current_period_end: '2026-06-01T00:00:00.000Z',
              cancel_at_period_end: false,
              created_at: '2026-05-01T00:00:00.000Z',
            },
            {
              status: 'canceled',
              stripe_subscription_id: 'sub_old_2',
              stripe_customer_id: 'cus_1',
              current_period_start: '2026-06-01T00:00:00.000Z',
              current_period_end: '2026-07-01T00:00:00.000Z',
              cancel_at_period_end: false,
              created_at: '2026-06-01T00:00:00.000Z',
            },
          ],
          error: null,
        },
        ai_user_plans: { data: null, error: null },
        ai_plan_definitions: { data: [], error: null },
        ai_user_credits: { data: null, error: null },
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subscription).toBeNull()
    expect(body.plan.name).toBe('free')
  })
})
