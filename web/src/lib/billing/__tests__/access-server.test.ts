import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/admin/signup-invites', () => ({ findSignupInviteForUser: async () => null }))

import { getBillingAccess } from '../access.server'

/** The user's own client: no subscriptions, and chatgpt_plan_status() answering `rpc`. */
function client(rpc: () => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return {
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    rpc: vi.fn(rpc),
  } as unknown as SupabaseClient
}

const user = { id: 'u1', email: 'ada@gmail.com' }

describe('getBillingAccess — ChatGPT free tier', () => {
  it('lets an active ChatGPT plan through the wall', async () => {
    const supabase = client(async () => ({ data: 'active', error: null }))
    const access = await getBillingAccess(supabase, user)
    expect(access).toMatchObject({ state: 'chatgpt', allowed: true })
    expect(supabase.rpc).toHaveBeenCalledWith('chatgpt_plan_status')
  })

  it('fails closed: an RPC error or a throw means no free pass', async () => {
    expect((await getBillingAccess(client(async () => ({ data: null, error: { message: 'nope' } })), user)).allowed).toBe(false)
    expect((await getBillingAccess(client(async () => { throw new Error('down') }), user)).allowed).toBe(false)
    expect((await getBillingAccess(client(async () => ({ data: 'weird', error: null })), user)).allowed).toBe(false)
  })
})
