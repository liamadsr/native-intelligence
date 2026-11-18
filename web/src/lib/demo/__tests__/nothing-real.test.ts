/**
 * Nothing real goes into a demo workspace (migration 669), at the places a
 * person starts it: connecting an account; and what bounds a visitor: whom
 * they may invite, a background job in another workspace, and the optional
 * limit on how much of a day's calls is heard. The database's own refusals are in
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
import { canCopyJoinLink, decideInvite, invitableRoles } from '@/lib/workspace-join/roles'
import { guardBackgroundUsage, guardBackgroundUsageOnPlan, isUsageAllowed } from '@/lib/inngest/usage-guard'
import { demoWorkspacesPastTheirDay } from '@/lib/team-calls/recorder'

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
  const TWO_HOURS = 2 * 60 * 60
  function service(opts: { limit: number | null; calls?: Array<{ notes_seconds: number; notes_on_since: string | null }>; flagError?: string; callsError?: string }) {
    const seen: Array<[string, string, unknown]> = []
    const from = (table: string) => {
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (seen.push([table, c, v]), q),
        gte: (c: string, v: unknown) => (seen.push([table, c, v]), q),
        maybeSingle: async () => (opts.flagError ? { data: null, error: { message: opts.flagError } } : { data: { notes_seconds_per_day: opts.limit }, error: null }),
        then: (r: (v: unknown) => unknown) =>
          Promise.resolve(opts.callsError ? { data: null, error: { message: opts.callsError } } : { data: opts.calls ?? [], error: null }).then(r),
      }
      return q
    }
    return { svc: { from } as unknown as SupabaseClient, seen }
  }

  it('no limit by default: every call is heard, however long the day’s calls ran, and they are not even counted', async () => {
    const { svc, seen } = service({ limit: null, calls: [{ notes_seconds: 50 * 3600, notes_on_since: null }] })
    expect(await demoWorkspacesPastTheirDay(svc, [{ workspace_id: DEMO }], now)).toEqual(new Set())
    expect(seen.some(([table]) => table === 'team_call')).toBe(false)
  })

  it('a limit an admin set, under it: heard', async () => {
    const { svc, seen } = service({ limit: TWO_HOURS, calls: [{ notes_seconds: 1800, notes_on_since: null }] })
    expect(await demoWorkspacesPastTheirDay(svc, [{ workspace_id: DEMO }], now)).toEqual(new Set())
    expect(seen).toContainEqual(['team_call', 'workspace_id', DEMO])
    expect(seen).toContainEqual(['team_call', 'started_at', '2026-11-18T00:00:00.000Z'])
  })

  it('at that limit, the running stretch counted: a new call there is not heard', async () => {
    const half = TWO_HOURS / 2
    const { svc } = service({
      limit: TWO_HOURS,
      calls: [
        { notes_seconds: half, notes_on_since: null },
        { notes_seconds: 0, notes_on_since: new Date(now.getTime() - half * 1000).toISOString() },
      ],
    })
    expect(await demoWorkspacesPastTheirDay(svc, [{ workspace_id: DEMO }], now)).toEqual(new Set([DEMO]))
  })

  it('no other workspace is ever counted or held back', async () => {
    expect(await demoWorkspacesPastTheirDay(untouched, [{ workspace_id: 'ws-real' }, { workspace_id: null }], now)).toEqual(new Set())
  })

  it('a failed read, of the limit or of the calls, holds nothing back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await demoWorkspacesPastTheirDay(service({ limit: TWO_HOURS, flagError: 'timeout' }).svc, [{ workspace_id: DEMO }], now)).toEqual(new Set())
    expect(await demoWorkspacesPastTheirDay(service({ limit: TWO_HOURS, callsError: 'timeout' }).svc, [{ workspace_id: DEMO }], now)).toEqual(new Set())
  })
})
