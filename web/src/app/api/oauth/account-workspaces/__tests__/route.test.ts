/**
 * PUT /api/oauth/account-workspaces: a connected mail or calendar account is
 * never shared into a demo workspace (migration 667). The route refuses before
 * it writes anything, and reads the database's own refusal the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  removed: vi.fn(),
  reconcile: vi.fn(),
  memberOf: ['ws-demo', 'ws-real'] as string[],
}))

vi.mock('@/lib/email/account-scope', () => ({ reconcileThreadCopies: h.reconcile }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (table: string) => {
      if (table === 'connected_account') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: 'acct-1' } }) }
        return q
      }
      if (table === 'member') {
        const q = { select: () => q, eq: () => q, in: async () => ({ data: h.memberOf.map((workspace_id) => ({ workspace_id })) }) }
        return q
      }
      // connected_account_workspace
      const del = { eq: () => del, not: () => del, then: (r: (v: unknown) => unknown) => Promise.resolve(h.removed()).then(r) }
      return { upsert: h.upsert, delete: () => del }
    },
  }),
}))

import { PUT } from '../route'
import { DEMO_OFF, setDemoWorkspaceLookupForTests } from '@/lib/demo/demo-mode'

const put = (workspace_ids: string[]) =>
  PUT(new NextRequest('https://nativeintelligence.dev/api/oauth/account-workspaces', { method: 'PUT', body: JSON.stringify({ account_id: 'acct-1', workspace_ids }) }))

beforeEach(() => {
  h.upsert.mockReset().mockResolvedValue({ error: null })
  h.removed.mockReset().mockReturnValue({ error: null })
  h.reconcile.mockReset()
  setDemoWorkspaceLookupForTests((id) => id === 'ws-demo')
})

describe('PUT /api/oauth/account-workspaces', () => {
  it('shares an account into an ordinary workspace', async () => {
    const res = await put(['ws-real'])
    expect(res.status).toBe(200)
    expect(h.upsert).toHaveBeenCalledOnce()
  })

  it('refuses a demo workspace in the set, and writes nothing: not even the other workspaces', async () => {
    const res = await put(['ws-real', 'ws-demo'])
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: DEMO_OFF.connector, code: 'DEMO_WORKSPACE' })
    expect(h.upsert).not.toHaveBeenCalled()
    expect(h.removed).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('an unreadable flag is an error, never a share', async () => {
    setDemoWorkspaceLookupForTests(() => { throw new Error('down') })
    const res = await put(['ws-real'])
    expect(res.status).toBe(500)
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('the database’s own refusal (the trigger) reads as the same answer', async () => {
    setDemoWorkspaceLookupForTests(() => false)
    h.upsert.mockResolvedValue({ error: { message: 'demo_workspace: connected_account_workspace cannot be connected to or shared into a demo workspace', hint: 'DEMO_WORKSPACE' } })
    const res = await put(['ws-real'])
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('DEMO_WORKSPACE')
    expect(h.removed).not.toHaveBeenCalled()
  })
})
