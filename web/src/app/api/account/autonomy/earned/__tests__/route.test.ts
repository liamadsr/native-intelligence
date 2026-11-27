/**
 * GET /api/account/autonomy/earned: off reads nothing; on, the caller's own
 * rows in their workspace (filtered by their id, read with their own client);
 * a failed read is a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), service: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const USER = 'user-1'
const WS = 'ws-1'
let db: FakeSupabase

beforeEach(() => {
  db = makeFakeSupabase({ bulkUpsert: true })
  db.seed('autonomy_outcome', [
    { kind_key: 'offer_times|text|one', outcome: 'approved', edit_ratio: null, created_at: new Date().toISOString(), user_id: USER, workspace_id: WS },
    { kind_key: 'book_quote|customer|one', outcome: 'approved', edit_ratio: null, created_at: new Date().toISOString(), user_id: 'someone-else', workspace_id: WS },
  ])
  hoisted.requireWorkspace.mockResolvedValue({ supabase: db, user: { id: USER }, workspaceId: WS })
  hoisted.service = db
})

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/account/autonomy/earned', () => {
  it('off: enabled false, and nothing is read', async () => {
    vi.stubEnv('EARNED_AUTONOMY', '')
    const res = await GET()
    expect(await res.json()).toEqual({ enabled: false, mode: 'off', kinds: [], actions: [] })
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

  it('record: no actions list (nothing runs on its own)', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'record')
    const body = (await (await GET()).json()) as { mode: string; actions: unknown[] }
    expect(body).toMatchObject({ mode: 'record', actions: [] })
    expect(db.calls.some((c) => c.table === 'autonomy_action')).toBe(false)
  })

  it("graduate: the last day's own actions", async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    db.seed('autonomy_action', [
      { id: 'a1', user_id: USER, workspace_id: WS, status: 'scheduled', title: 'Invite Dana', created_at: new Date().toISOString() },
      { id: 'a2', user_id: 'someone-else', workspace_id: WS, status: 'ran', title: 'Not mine', created_at: new Date().toISOString() },
    ])
    const body = (await (await GET()).json()) as { actions: Array<{ id: string }> }
    expect(body.actions.map((a) => a.id)).toEqual(['a1'])
  })
})

describe('POST /api/account/autonomy/earned (the person\'s own decision)', () => {
  const KEY = 'offer_times|text|one'
  const post = (body: unknown) => POST(new NextRequest('http://localhost/api/account/autonomy/earned', { method: 'POST', body: JSON.stringify(body) }))
  const earn = () =>
    db.seed('autonomy_outcome', Array.from({ length: 10 }, (_, i) => ({ kind_key: KEY, outcome: 'approved', edit_ratio: null, created_at: new Date(Date.now() - (0.1 + i * 0.9) * 86_400_000).toISOString(), user_id: USER, workspace_id: WS })))

  it('hand_over on a kind the server finds earned: tell, fenced on the caller', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    earn()
    const res = await post({ kind_key: KEY, decision: 'hand_over' })
    expect(res.status).toBe(200)
    expect(db.rows('autonomy_kind')).toEqual([expect.objectContaining({ kind_key: KEY, user_id: USER, workspace_id: WS, level: 'tell' })])
  })

  it('hand_over on a kind not yet earned, or under record, is refused and writes nothing', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    expect((await post({ kind_key: KEY, decision: 'hand_over' })).status).toBe(409)
    vi.stubEnv('EARNED_AUTONOMY', 'record')
    earn()
    expect((await post({ kind_key: KEY, decision: 'hand_over' })).status).toBe(409)
    expect(db.rows('autonomy_kind')).toEqual([])
  })

  it('a hard-limited kind is never handed over, whatever the record', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    db.seed('autonomy_outcome', Array.from({ length: 30 }, (_, i) => ({ kind_key: 'send_quote|customer|one', outcome: 'approved', edit_ratio: null, created_at: new Date(Date.now() - i * 86_400_000).toISOString(), user_id: USER, workspace_id: WS })))
    expect((await post({ kind_key: 'send_quote|customer|one', decision: 'hand_over' })).status).toBe(409)
    expect(db.rows('autonomy_kind')).toEqual([])
  })

  it('revoke works at any time', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    db.seed('autonomy_kind', [{ workspace_id: WS, user_id: USER, kind_key: KEY, level: 'tell', pinned_ask: false, granted_at: new Date().toISOString() }])
    expect((await post({ kind_key: KEY, decision: 'revoke' })).status).toBe(200)
    expect(db.rows('autonomy_kind')[0]).toMatchObject({ level: 'ask', granted_at: null })
  })

  it('a bad key or decision is a 400; off is a 400', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    expect((await post({ kind_key: 'nope', decision: 'revoke' })).status).toBe(400)
    expect((await post({ kind_key: KEY, decision: 'promote' })).status).toBe(400)
    vi.stubEnv('EARNED_AUTONOMY', '')
    expect((await post({ kind_key: KEY, decision: 'revoke' })).status).toBe(400)
  })
})
