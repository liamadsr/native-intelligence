/**
 * GET /api/account/agent-links/[id]/exchanges (agent links phase D): the two
 * agents' conversation over one link, for the read-only card. Only the two
 * people on the link read it, each from their own side (me / them, their own
 * half and the other side's workspace); exchanges come newest first, each
 * one's messages oldest first, and page back with ?before=.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const state: { db: FakeSupabase | null; user: string | null } = { db: null, user: 'liam' }
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => (state.user ? { supabase: null, user: { id: state.user } } : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => state.db }))

const { GET, AGENT_LINK_EXCHANGE_PAGE } = await import('../[id]/exchanges/route')

const LINK = '77777777-0000-4000-8000-000000000007'
const LIAM_HALF = '44444444-0000-4000-8000-000000000004'
const DANA_HALF = '55555555-0000-4000-8000-000000000005'
const ex = (n: number, over: Record<string, unknown> = {}) => ({
  id: `ex-${n}`,
  link_id: LINK,
  started_by_user_id: 'liam',
  topic: `topic ${n}`,
  state: 'done',
  message_count: 2,
  created_at: `2026-10-25T${String(n).padStart(2, '0')}:00:00.000Z`,
  closed_at: null,
  ...over,
})
const message = (id: string, exchange: number, from: string, minute: number, over: Record<string, unknown> = {}) => ({
  id,
  exchange_id: `ex-${exchange}`,
  link_id: LINK,
  from_user_id: from,
  kind: from === 'liam' ? 'ask' : 'answer',
  body: `${from} says ${id}`,
  created_at: `2026-10-25T${String(exchange).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`,
  ...over,
})

const call = (id: string, query = '') => GET(new Request(`http://x/api/account/agent-links/${id}/exchanges${query}`) as never, { params: Promise.resolve({ id }) })

/** A fresh database with the link (as given), both halves, both workspaces, and these exchanges and messages (the fake's seed adds rows). */
function seed(link: Record<string, unknown> = {}, exchanges = [ex(1), ex(2, { started_by_user_id: 'dana', state: 'capped' })], messages = [message('m2', 1, 'dana', 2), message('m1', 1, 'liam', 1), message('m3', 2, 'dana', 1), message('m4', 2, 'liam', 2)]) {
  state.db = makeFakeSupabase()
  state.db.seed('agent_link', [
    {
      id: LINK,
      state: 'active',
      requester_user_id: 'liam',
      requester_workspace_id: 'ws-acme',
      requester_guest_id: LIAM_HALF,
      target_user_id: 'dana',
      target_workspace_id: 'ws-northwind',
      target_guest_id: DANA_HALF,
      ...link,
    },
  ])
  state.db.seed('agent_guest', [
    { id: LIAM_HALF, owner_user_id: 'liam', display_name: 'Dana Kim' },
    { id: DANA_HALF, owner_user_id: 'dana', display_name: 'Liam A.' },
  ])
  state.db.seed('workspace', [
    { id: 'ws-acme', name: 'Acme' },
    { id: 'ws-northwind', name: 'Northwind' },
  ])
  state.db.seed('agent_link_exchange', exchanges)
  state.db.seed('agent_link_message', messages)
}

beforeEach(() => {
  state.user = 'liam'
  seed()
})

describe('the two agents’ conversation', () => {
  it('answers the link from my side and its exchanges, newest first, messages oldest first', async () => {
    const res = await call(LINK)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.link).toEqual({ id: LINK, state: 'active', peerName: 'Dana Kim', workspaceName: 'Northwind', myHalfGuestId: LIAM_HALF })
    expect(body.hasMore).toBe(false)
    expect(body.exchanges.map((e: { id: string; startedBy: string; state: string }) => [e.id, e.startedBy, e.state])).toEqual([
      ['ex-2', 'them', 'capped'],
      ['ex-1', 'me', 'done'],
    ])
    expect(body.exchanges[1].messages).toEqual([
      { id: 'm1', from: 'me', kind: 'ask', body: 'liam says m1', at: '2026-10-25T01:01:00.000Z' },
      { id: 'm2', from: 'them', kind: 'answer', body: 'dana says m2', at: '2026-10-25T01:02:00.000Z' },
    ])
  })

  it('the other person reads the same exchanges from their side', async () => {
    state.user = 'dana'
    const body = await (await call(LINK)).json()
    expect(body.link).toEqual({ id: LINK, state: 'active', peerName: 'Liam A.', workspaceName: 'Acme', myHalfGuestId: DANA_HALF })
    expect(body.exchanges[1].messages.map((m: { from: string }) => m.from)).toEqual(['them', 'me'])
    expect(body.exchanges[0].startedBy).toBe('me')
  })

  it('anyone else, a link that never was, and a malformed id are all a 404', async () => {
    state.user = 'marco'
    expect((await call(LINK)).status).toBe(404)
    state.user = 'liam'
    expect((await call('88888888-0000-4000-8000-000000000008')).status).toBe(404)
    expect((await call('nope')).status).toBe(404)
    state.user = null
    expect((await call(LINK)).status).toBe(401)
  })

  it('a request not yet accepted: no workspace on their side, no exchanges', async () => {
    seed({ state: 'requested', target_workspace_id: null, target_guest_id: null }, [], [])
    const body = await (await call(LINK)).json()
    expect(body).toEqual({ link: { id: LINK, state: 'requested', peerName: 'Dana Kim', workspaceName: null, myHalfGuestId: LIAM_HALF }, exchanges: [], hasMore: false })
  })

  it('pages: the newest page, then back with ?before=', async () => {
    seed({}, Array.from({ length: AGENT_LINK_EXCHANGE_PAGE + 2 }, (_, i) => ex(i + 1)), [])
    const first = await (await call(LINK)).json()
    expect(first.hasMore).toBe(true)
    expect(first.exchanges).toHaveLength(AGENT_LINK_EXCHANGE_PAGE)
    expect(first.exchanges[0].id).toBe(`ex-${AGENT_LINK_EXCHANGE_PAGE + 2}`)
    const oldest = first.exchanges[first.exchanges.length - 1]
    const next = await (await call(LINK, `?before=${encodeURIComponent(oldest.createdAt)}`)).json()
    expect(next.exchanges.map((e: { id: string }) => e.id)).toEqual(['ex-2', 'ex-1'])
    expect(next.hasMore).toBe(false)
  })
})
