/**
 * Nothing real goes into a demo workspace (migration 669), at the places a
 * person starts it: connecting an account; and what bounds a visitor: whom
 * they may invite, and a background job in another workspace. The database's own refusals are in
 * demo-workspace-migration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ rpcRow: null as Record<string, unknown> | null, calendarLookups: 0 }))
vi.mock('@/lib/integrations/calendar', () => ({
  getCalendarProvider: async () => {
    h.calendarLookups++
    return 'google'
  },
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ rpc: async () => ({ data: h.rpcRow ? [h.rpcRow] : [], error: null }) }),
}))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn() }), headers: async () => new Headers() }))

import { setDemoWorkspaceLookupForTests, DEMO_OFF } from '../demo-mode'
import { completeOAuthConnect } from '@/lib/oauth/complete-connect'
import { mintConnectLink } from '@/lib/links/oauth-link'
import { canCopyJoinLink, decideInvite, invitableRoles } from '@/lib/workspace-join/roles'
import { getCalendarProviderIn } from '@/lib/integrations/calendar-here'
import { sendEmail } from '@/lib/crm/email-client'
import { connectWebsite } from '@/lib/website/start'
import { startNewAccount } from '@/lib/payments/onboarding'
import { guardBackgroundUsage, guardBackgroundUsageOnPlan, isUsageAllowed } from '@/lib/inngest/usage-guard'

const DEMO = 'ws-demo'
/** A client that fails the test if anything is read or written through it. */
const untouched = new Proxy({}, { get: (_t, prop) => { throw new Error(`the client was used (${String(prop)})`) } }) as unknown as SupabaseClient

beforeEach(() => {
  h.rpcRow = null
  h.calendarLookups = 0
  setDemoWorkspaceLookupForTests((id) => id === DEMO)
})

describe('connecting an account', () => {
  it('is refused for a demo workspace before the code is exchanged: no token is ever held', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await completeOAuthConnect({ provider: 'google', code: 'c', userId: 'u1', capability: 'email', stateWorkspaceId: DEMO } as never)
    expect(result).toEqual({ ok: false, error: 'demo_workspace' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('no connect link is made for one either (so none is texted)', async () => {
    const link = await mintConnectLink(untouched, { userId: 'u1', workspaceId: DEMO, provider: 'google', origin: 'https://app.example.test' } as never)
    expect(link).toEqual({ ok: false, error: DEMO_OFF.connector })
  })
})

describe('a person’s own calendar and mailbox, connected in another workspace', () => {
  it('the assistant’s calendar tools have no calendar in a demo workspace, and never look the person’s up', async () => {
    expect(await getCalendarProviderIn('u1', DEMO)).toBeNull()
    expect(h.calendarLookups).toBe(0)
    expect(await getCalendarProviderIn('u1', 'ws-own')).toBe('google')
    expect(h.calendarLookups).toBe(1)
  })

  it('no mailbox answers for a demo workspace: nothing is sent from the person’s real one', async () => {
    await expect(sendEmail('u1', DEMO, { to: ['maya@larkspurcoffee.example'], subject: 'Quote', body: 'Hello' } as never)).rejects.toThrow('No email integration connected')
  })
})

describe('linking something real, at its start', () => {
  it('a website’s repo is not connected to a demo workspace, before the person’s GitHub token is read', async () => {
    const result = await connectWebsite(untouched as never, { userId: 'u1', workspaceId: DEMO } as never, { repo: 'fernhill/site' }, { token: async () => { throw new Error('token read') } } as never)
    expect(result).toMatchObject({ success: false, code: 'DEMO_WORKSPACE', error: DEMO_OFF.connector })
  })

  it('no Stripe account is made for one', async () => {
    const stripe = new Proxy({}, { get: () => { throw new Error('Stripe was called') } })
    const result = await startNewAccount(untouched, stripe as never, { workspaceId: DEMO, userId: 'u1', linkId: 'l1', livemode: false } as never)
    expect(result).toEqual({ ok: false, reason: 'store_failed', error: DEMO_OFF.connector })
  })
})

describe('a visitor who may invite (where the workspace lets members invite)', () => {
  // Nothing here is demo-specific: a visitor is a member or a guest, and these
  // are the rules every workspace has (src/lib/workspace-join/roles.ts). The
  // database holds the rest (306: only an owner or admin changes a role, never
  // their own; only the owner makes an owner).
  it('a member invites as member or guest only: never an admin, and owner is not a role an invite can carry', () => {
    expect(decideInvite('member', true, 'member')).toEqual({ ok: true, role: 'member' })
    expect(decideInvite('member', true, 'guest')).toEqual({ ok: true, role: 'guest' })
    expect(decideInvite('member', true, 'admin')).toMatchObject({ ok: false, status: 403 })
    expect(decideInvite('member', true, 'owner')).toMatchObject({ ok: false, status: 400 })
    expect(invitableRoles('member', true)).toEqual(['member', 'guest'])
  })

  it('not at all while the workspace’s "members can invite" switch is off, and a guest never', () => {
    expect(decideInvite('member', false, 'member')).toMatchObject({ ok: false, status: 403 })
    expect(invitableRoles('member', false)).toEqual([])
    for (const role of ['member', 'guest', 'admin', 'owner']) expect(decideInvite('guest', true, role).ok).toBe(false)
    expect(canCopyJoinLink('guest', true)).toBe(false)
    expect(canCopyJoinLink('member', false)).toBe(false)
    expect(canCopyJoinLink('member', true)).toBe(true)
  })
})

describe('a background job, for a demo workspace’s visitor', () => {
  const visitor = { allowed: true, reason: 'demo_workspace' }

  it('runs in the demo workspace', async () => {
    h.rpcRow = visitor
    await expect(guardBackgroundUsage('u1', DEMO)).resolves.toBeUndefined()
    await expect(guardBackgroundUsageOnPlan('u1', DEMO)).resolves.toEqual({ chatgptPlan: false })
  })

  it('is refused where the job names no workspace: it cannot say where it runs', async () => {
    h.rpcRow = visitor
    await expect(guardBackgroundUsage('u1')).rejects.toThrow('demo_workspace_only')
    await expect(guardBackgroundUsageOnPlan('u1')).rejects.toThrow('demo_workspace_only')
  })

  it('is refused in any other workspace: no seat there', async () => {
    h.rpcRow = visitor
    await expect(guardBackgroundUsage('u1', 'ws-own')).rejects.toThrow('demo_workspace_only')
    await expect(guardBackgroundUsageOnPlan('u1', 'ws-own')).rejects.toThrow('demo_workspace_only')
    const supabase = { rpc: async () => ({ data: [visitor], error: null }) } as unknown as SupabaseClient
    expect(await isUsageAllowed(supabase, 'u1', 'ws-own')).toBe(false)
    expect(await isUsageAllowed(supabase, 'u1', DEMO)).toBe(true)
  })

  it('leaves a seat holder alone, wherever the job runs', async () => {
    h.rpcRow = { allowed: true, reason: 'within_limits' }
    await expect(guardBackgroundUsage('u1', 'ws-own')).resolves.toBeUndefined()
  })
})
