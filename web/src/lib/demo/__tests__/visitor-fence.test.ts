/**
 * Who is a demo workspace's visitor, and what keeps them inside it for the
 * things that are not AI calls (migration 669): the tools' workspace routing,
 * paid search data, and connecting anything, anywhere. The request helpers'
 * half is in src/lib/__tests__/api-auth.test.ts and workspace.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  demoRows: [] as Array<{ workspace_id: string }>,
  demoError: null as { message: string; code?: string } | null,
  seat: null as string | null,
  reason: 'demo_workspace' as string,
  rpcs: [] as string[],
  tableReads: 0,
  role: 'member' as string | null,
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: () => {
      h.tableReads++
      const q = { select: () => q, limit: async () => ({ data: h.demoError ? null : h.demoRows, error: h.demoError }) }
      return q
    },
    rpc: async (name: string) => {
      h.rpcs.push(name)
      if (name === 'demo_seat_workspace') return { data: h.seat, error: null }
      if (name === 'check_ai_usage_limit') return { data: [{ allowed: true, reason: h.reason }], error: null }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
  }),
}))
vi.mock('@/lib/seo/dataforseo', () => ({ isDataforseoConfigured: () => true }))
vi.mock('@/lib/seo/membership', () => ({ memberRole: async () => 'member', isFullMemberRole: (r: string | null) => r === 'member' || r === 'owner' || r === 'admin' }))
vi.mock('@/lib/seo/plan', () => ({ onFreePlan: async () => false }))

import { clearDemoWorkspaceCache, demoVisitorWorkspace, setDemoVisitorLookupForTests } from '../demo-mode'
import { getUserWorkspaces, resolveCreateWorkspace, resolveEntityWorkspace } from '@/lib/ai/tools/_shared'
import { completeOAuthConnect } from '@/lib/oauth/complete-connect'

const DEMO = 'ws-demo'
const OWN = 'ws-own'

beforeEach(() => {
  h.demoRows = [{ workspace_id: DEMO }]
  h.demoError = null
  h.seat = DEMO
  h.reason = 'demo_workspace'
  h.rpcs = []
  h.tableReads = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('demoVisitorWorkspace (the real read)', () => {
  beforeEach(() => {
    setDemoVisitorLookupForTests(null)
    clearDemoWorkspaceCache()
  })

  it('a member or guest of a demo workspace whom the gate lets in as a visitor', async () => {
    expect(await demoVisitorWorkspace('u1')).toBe(DEMO)
    expect(h.rpcs).toEqual(['demo_seat_workspace', 'check_ai_usage_limit'])
    // Remembered for a while: asked once.
    expect(await demoVisitorWorkspace('u1')).toBe(DEMO)
    expect(h.rpcs.length).toBe(2)
  })

  it('still a visitor once an admin’s cap is reached', async () => {
    h.reason = 'demo_cost_limit_exceeded'
    expect(await demoVisitorWorkspace('u1')).toBe(DEMO)
  })

  it('not a visitor with anything of their own: a seat, a plan, credits (the gate’s other answers)', async () => {
    for (const reason of ['within_limits', 'using_credits', 'chatgpt_plan']) {
      clearDemoWorkspaceCache()
      h.reason = reason
      expect(await demoVisitorWorkspace('u1'), reason).toBeNull()
    }
  })

  it('not a visitor when in no demo workspace (an owner or admin of one included)', async () => {
    h.seat = null
    expect(await demoVisitorWorkspace('u1')).toBeNull()
    expect(h.rpcs).toEqual(['demo_seat_workspace'])
  })

  it('with no demo workspace at all nobody is asked about, and the table is read once for everyone', async () => {
    h.demoRows = []
    expect(await demoVisitorWorkspace('u1')).toBeNull()
    expect(await demoVisitorWorkspace('u2')).toBeNull()
    expect(h.rpcs).toEqual([])
    expect(h.tableReads).toBe(1)
  })

  it('before migration 669 (no table) and on a failed read: nobody is a visitor', async () => {
    h.demoError = { message: 'relation "demo_workspace" does not exist', code: '42P01' }
    expect(await demoVisitorWorkspace('u1')).toBeNull()
    clearDemoWorkspaceCache()
    h.demoError = { message: 'timeout' }
    expect(await demoVisitorWorkspace('u1')).toBeNull()
  })
})

/** A member table holding these workspaces for the person, and rows that live in `rowWorkspace`. */
function db(workspaces: string[], rowWorkspace: string | null = null) {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => ((filters[c] = v), q),
      maybeSingle: async () => {
        if (table === 'member') return { data: workspaces.includes(filters.workspace_id as string) ? { id: 'm', workspace: { name: 'W' } } : null, error: null }
        if (filters.workspace_id !== undefined) return { data: filters.workspace_id === rowWorkspace ? { id: 'row' } : null, error: null }
        return { data: rowWorkspace ? { workspace_id: rowWorkspace } : null, error: null }
      },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: workspaces.map((id) => ({ workspace: { id, name: id } })), error: null }).then(r),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

describe('the tools’ workspace routing, for a visitor', () => {
  beforeEach(() => setDemoVisitorLookupForTests((id) => (id === 'visitor' ? DEMO : null)))

  it('a visitor has one workspace as far as any tool is concerned', async () => {
    expect((await getUserWorkspaces(db([OWN, DEMO]), 'visitor')).map((w) => w.id)).toEqual([DEMO])
    expect((await getUserWorkspaces(db([OWN, DEMO]), 'member-with-a-seat')).map((w) => w.id)).toEqual([OWN, DEMO])
  })

  it('a row in another workspace of theirs is not found, as a nonexistent id is', async () => {
    expect(await resolveEntityWorkspace(db([OWN, DEMO], OWN), 'visitor', DEMO, 'actions', 'row-1')).toBeNull()
    expect(await resolveEntityWorkspace(db([OWN, DEMO], OWN), 'member-with-a-seat', DEMO, 'actions', 'row-1')).toEqual({ workspaceId: OWN, crossWorkspace: true })
  })

  it('nothing is created outside the demo by naming another workspace', async () => {
    expect((await resolveCreateWorkspace(db([OWN, DEMO]), 'visitor', DEMO, OWN, 'explicit')).ok).toBe(false)
    expect((await resolveCreateWorkspace(db([OWN, DEMO]), 'member-with-a-seat', DEMO, OWN, 'explicit')).ok).toBe(true)
  })
})

describe('paid search data', () => {
  beforeEach(() => setDemoVisitorLookupForTests((id) => (id === 'visitor' ? DEMO : null)))

  it('a visitor gets it in the demo workspace only: a workspace of their own has no plan behind it', async () => {
    const { checkSeoDataAccess } = await import('@/lib/seo/access')
    expect(await checkSeoDataAccess({ userId: 'visitor', workspaceId: DEMO })).toEqual({ ok: true })
    expect(await checkSeoDataAccess({ userId: 'visitor', workspaceId: OWN })).toMatchObject({ ok: false, code: 'FREE_PLAN' })
    expect(await checkSeoDataAccess({ userId: 'visitor', workspaceId: null })).toMatchObject({ ok: false, code: 'FREE_PLAN' })
    // Anyone else: as before, in any workspace of theirs.
    expect(await checkSeoDataAccess({ userId: 'member-with-a-seat', workspaceId: OWN })).toEqual({ ok: true })
  })
})

describe('a visitor connects nothing, anywhere', () => {
  it('a connect through a workspace of their own is refused before the code is exchanged', async () => {
    setDemoVisitorLookupForTests((id) => (id === 'visitor' ? DEMO : null))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await completeOAuthConnect({ provider: 'github', code: 'c', userId: 'visitor', capability: 'github', stateWorkspaceId: OWN } as never)
    expect(result).toEqual({ ok: false, error: 'demo_workspace' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
