import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The check-in's door (docs/plans/now-file.md "The check-in"): a home turn's
 * token minted for reason 'check_in' runs in a FRESH session of its own,
 * registered on its home_turn row (eve_session_id) while that row is claimed
 * or sent, never on a conversation. Pinned: it may create a parked session
 * for its home thread, send its queued update into the session its row
 * registers and read that session's stream; it may never reach the home
 * thread's own session (nor any session a conversation registers), a session
 * another row or conversation registers, or one whose check-in is done; and
 * no other token reaches a check-in's session.
 */

const SECRET = 'chat-internal-secret-0123456789'

type Row = Record<string, unknown>
const state = { conversations: [] as Row[], turns: [] as Row[] }

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      const rows = table === 'chat_conversations' ? state.conversations : table === 'home_turn' ? state.turns : null
      if (!rows) throw new Error(`unexpected table ${table}`)
      return { data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }
    },
  }
  return chain
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ from: query })) }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: async () => ({ data: { user: null } }) }, from: query })),
}))

import { ForbiddenError, UnauthenticatedError } from 'eve/channels/auth'
import { isCheckInClaims, lookupCheckInSession, serverCompactionAuth, verifyChatRunClaims } from '../auth'
import { mintChatRunToken } from '@/lib/chat/chat-run-token'

const MOUNT = 'https://app/eve/chat-agent/v1'
const entry = serverCompactionAuth()
const tokenFor = (over: Record<string, unknown> = {}) =>
  mintChatRunToken({ conversationId: 'conv-home', userId: 'user-1', workspaceId: 'ws-1', server: 'home_turn', homeTurnReason: 'check_in', ...over } as never)
const QUEUED = { message: '[BACKGROUND UPDATE · home-turn r1] Not from the person.', turnPolicy: 'queue' }

function send(path: string, token: string, body: unknown = QUEUED) {
  return new Request(`${MOUNT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-run-secret': SECRET, 'x-chat-run-token': token },
    body: JSON.stringify(body),
  })
}
function stream(path: string, token: string) {
  return new Request(`${MOUNT}${path}`, { method: 'GET', headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': token } })
}
function create(token: string) {
  return new Request(`${MOUNT}/session`, { method: 'POST', headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': token } })
}

async function rejection(p: unknown): Promise<{ status: number; code: string }> {
  try {
    await p
  } catch (err) {
    const res = (err as ForbiddenError | UnauthenticatedError).response
    return { status: res.status, code: ((await res.json()) as { code: string }).code }
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  process.env.CHAT_INTERNAL_SECRET = SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  state.conversations = [
    { id: 'conv-home', user_id: 'user-1', workspace_id: 'ws-1', is_home: true, eve_session_id: 'sess_HOME' },
    { id: 'conv-side', user_id: 'user-1', workspace_id: 'ws-1', is_home: null, eve_session_id: 'sess_SIDE' },
  ]
  state.turns = [
    { id: 'ht-1', conversation_id: 'conv-home', user_id: 'user-1', workspace_id: 'ws-1', reason: 'check_in', status: 'sent', eve_session_id: 'sess_CHECK_IN' },
    { id: 'ht-2', conversation_id: 'conv-home', user_id: 'user-1', workspace_id: 'ws-1', reason: 'check_in', status: 'done', eve_session_id: 'sess_OLD_CHECK_IN' },
    { id: 'ht-3', conversation_id: 'conv-home', user_id: 'user-1', workspace_id: 'ws-1', reason: 'event', status: 'sent', eve_session_id: 'sess_EVENT_ROW' },
  ]
})

describe('a check-in token', () => {
  it('is a home turn’s, with its reason, on both verifiers', () => {
    const claims = verifyChatRunClaims(tokenFor())
    expect(claims).toMatchObject({ server: 'home_turn', homeTurnReason: 'check_in' })
    expect(isCheckInClaims(claims!)).toBe(true)
    expect(isCheckInClaims(verifyChatRunClaims(tokenFor({ homeTurnReason: 'event' }))!)).toBe(false)
  })

  it('may send its queued update into the session its own row registers, and read its stream, while the row is live', async () => {
    const token = tokenFor()
    expect(await entry(send('/session/sess_CHECK_IN', token))).toMatchObject({ authenticator: 'server', principalId: 'user-1', principalType: 'service', attributes: { workspaceId: 'ws-1', chatRunToken: token } })
    expect(await entry(stream('/session/sess_CHECK_IN/stream?startIndex=0', token))).toMatchObject({ authenticator: 'server' })
    state.turns[0].status = 'claimed'
    expect(await entry(send('/session/sess_CHECK_IN', token))).toMatchObject({ authenticator: 'server' })
  })

  it('may create a parked session for its home thread (no body)', async () => {
    expect(await entry(create(tokenFor()))).toMatchObject({ authenticator: 'server', principalType: 'service' })
  })

  it('never reaches the home thread’s own session, or any session a conversation registers', async () => {
    const token = tokenFor()
    for (const id of ['sess_HOME', 'sess_SIDE']) {
      for (const request of [send(`/session/${id}`, token), stream(`/session/${id}/stream`, token)]) {
        expect(await rejection(entry(request))).toEqual({ status: 403, code: 'session_forbidden' })
      }
    }
  })

  it('never a finished check-in’s session, another reason’s row, or a row of another conversation or person', async () => {
    const token = tokenFor()
    for (const id of ['sess_OLD_CHECK_IN', 'sess_EVENT_ROW', 'sess_UNKNOWN']) {
      expect(await rejection(entry(send(`/session/${id}`, token)))).toEqual({ status: 403, code: 'session_forbidden' })
    }
    expect(await rejection(entry(send('/session/sess_CHECK_IN', tokenFor({ conversationId: 'conv-side' }))))).toEqual({ status: 403, code: 'session_forbidden' })
    expect(await rejection(entry(send('/session/sess_CHECK_IN', tokenFor({ userId: 'user-2' }))))).toEqual({ status: 403, code: 'session_forbidden' })
    // A row whose conversation stopped being the home thread.
    state.conversations[0].is_home = null
    expect(await rejection(entry(send('/session/sess_CHECK_IN', token)))).toEqual({ status: 403, code: 'session_forbidden' })
  })

  it('still sends only the queued body and never compacts', async () => {
    const token = tokenFor()
    expect(await rejection(entry(send('/session/sess_CHECK_IN', token, { ...QUEUED, turnPolicy: 'steer' })))).toEqual({ status: 403, code: 'server_send_body_forbidden' })
    expect(await rejection(entry(send('/session/sess_CHECK_IN/compact', token, {})))).toEqual({ status: 403, code: 'server_route_forbidden' })
  })
})

describe('every other token', () => {
  it('never reaches a check-in’s session, and keeps its own thread’s', async () => {
    const event = tokenFor({ homeTurnReason: 'event' })
    expect(await rejection(entry(send('/session/sess_CHECK_IN', event)))).toEqual({ status: 403, code: 'session_forbidden' })
    expect(await entry(send('/session/sess_HOME', event))).toMatchObject({ authenticator: 'server' })
  })

  it('the lookup alone: only a live check-in row of that conversation, whose conversation is the person’s home thread', async () => {
    expect(await lookupCheckInSession('sess_CHECK_IN', 'conv-home')).toEqual({ userId: 'user-1', workspaceId: 'ws-1', conversationId: 'conv-home', isHome: true, outsideChannel: null, agentGuestId: null })
    expect(await lookupCheckInSession('sess_CHECK_IN', 'conv-side')).toBeNull()
    expect(await lookupCheckInSession('sess_HOME', 'conv-home')).toBeNull()
  })

  it('a home-turn reason rides only a home turn’s token', () => {
    expect(verifyChatRunClaims(mintChatRunToken({ conversationId: 'c', userId: 'u', workspaceId: 'w', homeTurnReason: 'check_in' } as never))).toBeNull()
  })
})
