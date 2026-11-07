import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/billing/invite-access — "continue without adding a card". Only a
 * user whose signup consumed an admin invite may self-grant a complimentary
 * seat, and only once.
 */

const hoisted = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  invite: { id: 'inv-1', email: 'jane@gmail.com', used_by: 'user-1' } as
    | { id: string; email: string; used_by: string | null }
    | null,
  subRows: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  planUpserts: [] as Array<Record<string, unknown>>,
  stamped: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: hoisted.user }, error: null }) },
  }),
}))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'signup_invite') {
        // Chainable stand-in: both lookups (by used_by, and pending-by-email)
        // resolve to the same fixture row; `update` records the stamp.
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is', 'gt', 'limit']) chain[m] = () => chain
        chain.maybeSingle = async () => ({ data: hoisted.invite })
        return {
          ...chain,
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              hoisted.stamped.push(row)
              return { error: null }
            },
          }),
        }
      }
      if (table === 'subscriptions') {
        return {
          select: () => ({ eq: async () => ({ data: hoisted.subRows }) }),
          insert: async (row: Record<string, unknown>) => {
            hoisted.inserted.push(row)
            return { error: null }
          },
        }
      }
      if (table === 'ai_plan_definitions') {
        return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: 'plan-sub' } }) }) }) }) }
      }
      if (table === 'ai_user_plans') {
        return { upsert: async (row: Record<string, unknown>) => { hoisted.planUpserts.push(row); return { error: null } } }
      }
      if (table === 'analytics_events') {
        return { insert: async () => ({ error: null }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

const { POST } = await import('@/app/api/billing/invite-access/route')

beforeEach(() => {
  hoisted.user = { id: 'user-1' }
  hoisted.invite = { id: 'inv-1', email: 'jane@gmail.com', used_by: 'user-1' }
  hoisted.subRows = []
  hoisted.inserted = []
  hoisted.planUpserts = []
  hoisted.stamped = []
})

describe('POST /api/billing/invite-access', () => {
  it('401s without a user', async () => {
    hoisted.user = null
    expect((await POST()).status).toBe(401)
  })

  it('403s when the account was not admin-invited', async () => {
    hoisted.invite = null
    expect((await POST()).status).toBe(403)
    expect(hoisted.inserted).toHaveLength(0)
  })

  it('grants a complimentary seat and the subscriber plan', async () => {
    const res = await POST()
    expect(res.status).toBe(200)
    expect(hoisted.inserted).toHaveLength(1)
    expect(String(hoisted.inserted[0].stripe_subscription_id)).toMatch(/^granted_invite_/)
    expect(hoisted.inserted[0].status).toBe('active')
    expect(hoisted.inserted[0].current_period_end).toBeNull()
    expect(hoisted.planUpserts[0]).toMatchObject({ user_id: 'user-1', plan_id: 'plan-sub', is_active: true })
  })

  it('stamps a pending invite when an account that predates it uses it', async () => {
    hoisted.invite = { id: 'inv-1', email: 'jane@gmail.com', used_by: null }
    const res = await POST()
    expect(res.status).toBe(200)
    expect(hoisted.inserted).toHaveLength(1)
    expect(hoisted.stamped[0]).toMatchObject({ used_by: 'user-1' })
    expect(hoisted.stamped[0].used_at).toBeTruthy()
  })

  it('does not re-stamp an invite already stamped at signup', async () => {
    await POST()
    expect(hoisted.stamped).toHaveLength(0)
  })

  it('403s when the invite requires a card (skip_payment=false)', async () => {
    hoisted.invite = { id: 'inv-1', email: 'jane@gmail.com', used_by: 'user-1', skip_payment: false } as typeof hoisted.invite
    expect((await POST()).status).toBe(403)
    expect(hoisted.inserted).toHaveLength(0)
  })

  it('is a no-op when access already exists', async () => {
    hoisted.subRows = [
      { status: 'active', stripe_subscription_id: 'granted_invite_1', stripe_customer_id: null, current_period_end: null, created_at: '2026-09-01T00:00:00Z' },
    ]
    const body = await (await POST()).json()
    expect(body.already).toBe(true)
    expect(hoisted.inserted).toHaveLength(0)
  })
})
