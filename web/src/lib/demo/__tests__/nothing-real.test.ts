/**
 * Nothing real goes into, or out of, a demo workspace (migration 669), at the
 * places a person starts it: connecting an account, joining by a link,
 * sending mail, a background job in another workspace, and how much of a
 * day's calls are heard. The database's own refusals are in
 * demo-workspace-migration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ rpcRow: null as Record<string, unknown> | null }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ rpc: async () => ({ data: h.rpcRow ? [h.rpcRow] : [], error: null }) }),
}))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn() }), headers: async () => new Headers() }))

import { setDemoWorkspaceLookupForTests, DEMO_OFF } from '../demo-mode'
import { completeOAuthConnect } from '@/lib/oauth/complete-connect'
import { mintConnectLink } from '@/lib/links/oauth-link'
import { joinWorkspace } from '@/lib/workspace-join/add-member'
import { joinSettingsView } from '@/lib/workspace-join/view'
import { sendEmail } from '@/lib/crm/email-client'
import { requestLinkByEmail } from '@/lib/agent-links/outside'
import { guardBackgroundUsage, guardBackgroundUsageOnPlan, isUsageAllowed } from '@/lib/inngest/usage-guard'
import { DEMO_NOTES_SECONDS_PER_DAY, demoWorkspacesPastTheirDay } from '@/lib/team-calls/recorder'

const DEMO = 'ws-demo'
/** A client that fails the test if anything is read or written through it. */
const untouched = new Proxy({}, { get: (_t, prop) => { throw new Error(`the client was used (${String(prop)})`) } }) as unknown as SupabaseClient

beforeEach(() => {
  h.rpcRow = null
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

describe('joining', () => {
  const user = { id: 'u1', email: 'visitor@fund.example' }

  it('a demo workspace is not joined by its link or by an email domain', async () => {
    for (const via of ['link', 'domain'] as const) {
      const result = await joinWorkspace({ service: untouched, user, workspaceId: DEMO, role: 'member', via, activate: 'always' })
      expect(result).toEqual({ ok: false, error: 'This workspace is joined by invitation only' })
    }
  })

  it('an emailed invite still joins it (it goes on to the member row)', async () => {
    await expect(joinWorkspace({ service: untouched, user, workspaceId: DEMO, role: 'member', via: 'invite', activate: 'always' })).rejects.toThrow('the client was used')
  })

  it('nobody is shown a join link there, and a member is offered no one to invite', () => {
    const stored = { membersCanInvite: true, domains: [], link: { token: 'tok', enabled: true } }
    const viewer = { id: 'u1', email: 'visitor@fund.example' } as never
    expect(joinSettingsView(stored, 'member', viewer).link.url).toContain('tok')
    const member = joinSettingsView(stored, 'member', viewer, true)
    expect(member.link).toEqual({ enabled: false, url: null })
    expect(member.membersCanInvite).toBe(false)
    expect(member.invitableRoles).toEqual([])
    expect(joinSettingsView(stored, 'owner', viewer, true).link.url).toBeNull()
  })
})

describe('mail', () => {
  it('none is sent for a demo workspace from a person’s own mailbox, and the mailbox is never looked up', async () => {
    await expect(sendEmail('u1', DEMO, { to: ['maya@larkspurcoffee.example'], subject: 'Quote', body: 'Hello' } as never)).rejects.toThrow(DEMO_OFF.outbound_email)
  })

  it('no link request is emailed to an address a visitor types', async () => {
    const result = await requestLinkByEmail(untouched, { requesterUserId: 'u1', workspaceId: DEMO, email: 'someone@elsewhere.example' } as never)
    // Refused before anything is read or sent (with no signing key set, earlier still).
    expect(result.ok).toBe(false)
  })
})

describe('a background job, for a demo workspace’s visitor', () => {
  const visitor = { allowed: true, reason: 'demo_workspace' }

  it('runs in the demo workspace, and where no workspace is named', async () => {
    h.rpcRow = visitor
    await expect(guardBackgroundUsage('u1', DEMO)).resolves.toBeUndefined()
    await expect(guardBackgroundUsage('u1')).resolves.toBeUndefined()
    await expect(guardBackgroundUsageOnPlan('u1', DEMO)).resolves.toEqual({ chatgptPlan: false })
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

describe('how much of a demo workspace’s day of calls is heard', () => {
  const now = new Date('2026-11-18T15:00:00Z')
  function calls(rows: Array<{ notes_seconds: number; notes_on_since: string | null }>, error: { message: string } | null = null) {
    const seen: Array<[string, unknown]> = []
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (seen.push([c, v]), q),
      gte: (c: string, v: unknown) => (seen.push([c, v]), q),
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: error ? null : rows, error }).then(r),
    }
    return { svc: { from: () => q } as unknown as SupabaseClient, seen }
  }

  it('under the limit: every call is heard', async () => {
    const { svc, seen } = calls([{ notes_seconds: 1800, notes_on_since: null }])
    expect(await demoWorkspacesPastTheirDay(svc, [{ workspace_id: DEMO }], now)).toEqual(new Set())
    expect(seen).toContainEqual(['workspace_id', DEMO])
    expect(seen).toContainEqual(['started_at', '2026-11-18T00:00:00.000Z'])
  })

  it('at the limit, the running stretch counted: a new call there is not heard', async () => {
    const half = DEMO_NOTES_SECONDS_PER_DAY / 2
    const { svc } = calls([
      { notes_seconds: half, notes_on_since: null },
      { notes_seconds: 0, notes_on_since: new Date(now.getTime() - half * 1000).toISOString() },
    ])
    expect(await demoWorkspacesPastTheirDay(svc, [{ workspace_id: DEMO }], now)).toEqual(new Set([DEMO]))
  })

  it('no other workspace is ever counted or held back', async () => {
    expect(await demoWorkspacesPastTheirDay(untouched, [{ workspace_id: 'ws-real' }, { workspace_id: null }], now)).toEqual(new Set())
  })

  it('a failed read holds nothing back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { svc } = calls([], { message: 'timeout' })
    expect(await demoWorkspacesPastTheirDay(svc, [{ workspace_id: DEMO }], now)).toEqual(new Set())
  })
})
