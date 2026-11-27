/**
 * GET /api/account/autonomy/earned: off reads nothing; on, the caller's own
 * rows in their workspace (filtered by their id, read with their own client);
 * a failed read is a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

import { GET } from '../route'

const USER = 'user-1'
const WS = 'ws-1'
let db: FakeSupabase

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('autonomy_outcome', [
    { kind_key: 'offer_times|text|one', outcome: 'approved', edit_ratio: null, created_at: new Date().toISOString(), user_id: USER, workspace_id: WS },
    { kind_key: 'book_quote|customer|one', outcome: 'approved', edit_ratio: null, created_at: new Date().toISOString(), user_id: 'someone-else', workspace_id: WS },
  ])
  hoisted.requireWorkspace.mockResolvedValue({ supabase: db, user: { id: USER }, workspaceId: WS })
})

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/account/autonomy/earned', () => {
  it('off: enabled false, and nothing is read', async () => {
    vi.stubEnv('EARNED_AUTONOMY', '')
    const res = await GET()
    expect(await res.json()).toEqual({ enabled: false, mode: 'off', kinds: [] })
    expect(db.calls).toHaveLength(0)
  })

  it('record: the caller\'s own kinds only', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'record')
    const res = await GET()
    const body = (await res.json()) as { enabled: boolean; kinds: Array<{ key: string }> }
    expect(body.enabled).toBe(true)
    expect(body.kinds.map((k) => k.key)).toEqual(['offer_times|text|one'])
    expect(db.calls.filter((c) => c.table === 'autonomy_outcome')[0].filters).toEqual(expect.arrayContaining([['user_id', USER], ['workspace_id', WS]]))
  })

  it('a failed read is a 500', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'record')
    hoisted.requireWorkspace.mockResolvedValue({
      supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }), then: undefined }) }) }) }) },
      user: { id: USER },
      workspaceId: WS,
    })
    const res = await GET()
    expect(res.status).toBe(500)
  })

  it('an unauthenticated caller gets the auth response', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('no', { status: 401 }))
    expect((await GET()).status).toBe(401)
  })
})
