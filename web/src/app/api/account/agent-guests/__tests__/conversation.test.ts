/**
 * GET /api/account/agent-guests/[id]/conversation (guest access PR4): one
 * guest's thread, for the read-only conversation card. Only the guest's owner
 * reads it; a guest who hasn't texted has no thread; messages come oldest
 * first with their times, the newest page when the thread is long.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { messageTime } from '@/lib/chat/message-time'

const state: { db: FakeSupabase | null; user: string | null } = { db: null, user: 'owner-1' }
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () =>
    state.user ? { supabase: state.db, user: { id: state.user } } : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}))

const { GET, GUEST_CONVERSATION_PAGE } = await import('../[id]/conversation/route')

const GUEST = '44444444-0000-4000-8000-000000000004'
const OTHER = '66666666-0000-4000-8000-000000000006'
const CONV = '55555555-0000-4000-8000-000000000005'

const guestRow = (over: Record<string, unknown> = {}) => ({
  id: GUEST,
  owner_user_id: 'owner-1',
  workspace_id: 'ws-1',
  display_name: 'Sam',
  phone_e164: '+15551234567',
  preset: 'household',
  tools: [],
  ask_before: ['payments', 'deletes'],
  notes: null,
  state: 'active',
  invite_expires_at: null,
  requested_at: null,
  activated_at: '2026-10-24T10:00:00Z',
  removed_at: null,
  opted_out_at: null,
  last_inbound_at: null,
  created_at: '2026-10-24T09:00:00Z',
  ...over,
})
const at = (minute: number) => `2026-10-24T13:${String(minute).padStart(2, '0')}:00.000Z`
const msg = (n: number, role: 'user' | 'assistant', over: Record<string, unknown> = {}) => ({
  id: `row-${n}`,
  conversation_id: CONV,
  user_id: 'owner-1',
  workspace_id: 'ws-1',
  created_at: at(n % 60),
  ui_message: { id: role === 'user' ? `sms-in:SM${n}` : `home-turn:${n}`, role, parts: [{ type: 'text', text: `message ${n}` }] },
  ...over,
})

const call = (id: string, query = '') => GET(new Request(`http://x/api/account/agent-guests/${id}/conversation${query}`) as never, { params: Promise.resolve({ id }) })

beforeEach(() => {
  state.user = 'owner-1'
  state.db = makeFakeSupabase()
  state.db.seed('agent_guest', [guestRow()])
  state.db.seed('chat_conversations', [{ id: CONV, user_id: 'owner-1', workspace_id: 'ws-1', agent_guest_id: GUEST }])
  state.db.seed('chat_messages', [msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user'), msg(4, 'assistant')])
})

describe('a guest’s conversation', () => {
  it('answers the guest and their thread, oldest first, each message with its time', async () => {
    const res = await call(GUEST)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.guest).toEqual({ id: GUEST, displayName: 'Sam', preset: 'household', state: 'active', channel: 'sms' })
    expect(body.conversationId).toBe(CONV)
    expect(body.hasMore).toBe(false)
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['sms-in:SM1', 'home-turn:2', 'sms-in:SM3', 'home-turn:4'])
    expect(messageTime(body.messages[0])).toBe(Date.parse(at(1)))
  })

  it('a guest who hasn’t texted: no thread, no messages', async () => {
    state.db!.seed('agent_guest', [guestRow({ id: OTHER, display_name: 'Priya', state: 'invited' })])
    const body = await (await call(OTHER)).json()
    expect(body).toMatchObject({ conversationId: null, messages: [], hasMore: false, guest: { id: OTHER, state: 'invited' } })
  })

  it('only the owner: another person’s guest, or none, is a 404; signed out is a 401', async () => {
    state.db!.seed('agent_guest', [guestRow({ id: OTHER, owner_user_id: 'owner-2' })])
    expect((await call(OTHER)).status).toBe(404)
    expect((await call('not-a-uuid')).status).toBe(404)
    expect((await call('77777777-0000-4000-8000-000000000007')).status).toBe(404)
    state.user = null
    expect((await call(GUEST)).status).toBe(401)
  })

  it('never another thread’s messages: the owner’s own chat in the same workspace stays out', async () => {
    state.db!.seed('chat_messages', [msg(9, 'user', { conversation_id: 'home-conv' })])
    const body = await (await call(GUEST)).json()
    expect(body.messages.map((m: { id: string }) => m.id)).not.toContain('sms-in:SM9')
  })

  it('a long thread: the newest page, saying there is more', async () => {
    state.db!.seed('chat_messages', Array.from({ length: GUEST_CONVERSATION_PAGE + 5 }, (_, i) => msg(100 + i, i % 2 ? 'assistant' : 'user', { created_at: new Date(Date.parse(at(30)) + i * 1000).toISOString() })))
    const body = await (await call(GUEST)).json()
    expect(body.hasMore).toBe(true)
    expect(body.messages).toHaveLength(GUEST_CONVERSATION_PAGE)
    expect(body.messages.at(-1).id).toBe(`sms-in:SM${100 + GUEST_CONVERSATION_PAGE + 4}`)
  })
})
