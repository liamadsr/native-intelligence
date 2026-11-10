/**
 * Undo of an applied create (POST …/proposed-changes/[changeId]/undo): in the
 * active workspace, or the change's own when the body names it (P13: the home
 * thread's Undo on what a call added, viewed from another workspace), and then
 * only for a workspace the caller is a member of.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  members: [] as Array<{ workspace_id: string; user_id: string }>,
  active: 'ws-active' as string | null,
  undo: vi.fn(async (_s: unknown, _a: { workspaceId: string; changeId: string; captureId?: string }) => ({ ok: true as const, change: { id: 'ch' } })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    from: () => {
      const filters: Record<string, unknown> = {}
      const chain = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          filters[col] = v
          return chain
        },
        maybeSingle: async () => ({ data: h.members.find((m) => m.workspace_id === filters.workspace_id && m.user_id === filters.user_id) ?? null, error: null }),
      }
      return chain
    },
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => h.active }))
vi.mock('@/lib/proposed-changes/undo-applied', () => ({ undoAppliedProposal: h.undo }))

import { POST } from '../route'

const WS_OTHER = '11111111-0000-4000-8000-000000000001'
const params = { params: Promise.resolve({ id: 'cap-1', changeId: 'ch-1' }) }
const post = (body?: unknown) =>
  POST(new Request('https://nativeintelligence.dev/x', { method: 'POST', ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }) as never, params)

beforeEach(() => {
  h.user = { id: 'user-1' }
  h.members = [{ workspace_id: WS_OTHER, user_id: 'user-1' }]
  h.active = 'ws-active'
  h.undo.mockClear()
})

describe('POST undo', () => {
  it('no workspace named: the active one, as before', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(h.undo).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-active', changeId: 'ch-1', captureId: 'cap-1' })
  })

  it('the change’s own workspace when named, whatever is active, once membership is checked', async () => {
    const res = await post({ workspace_id: WS_OTHER })
    expect(res.status).toBe(200)
    expect(h.undo).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS_OTHER, changeId: 'ch-1', captureId: 'cap-1' })
  })

  it('a workspace the caller is not in: 403, nothing undone', async () => {
    h.members = []
    const res = await post({ workspace_id: WS_OTHER })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'NOT_MEMBER' })
    expect(h.undo).not.toHaveBeenCalled()
  })

  it('signed out: 401', async () => {
    h.user = null
    expect((await post({ workspace_id: WS_OTHER })).status).toBe(401)
  })
})
