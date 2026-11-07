import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The text-turn door (docs/plans/text-and-calling.md, Phase 1): a text the
 * person sent the Dial8 number rides the server entry with a `server:
 * 'channel_turn'` token with `surface: 'sms'` (a channel turn, shared with
 * Slack; a channel surface always means a channel turn, and no other server
 * token carries a surface). It may send a
 * queued `{ message, turnPolicy: 'queue' }` ONLY into the token's own home
 * thread, read that session's stream, and create a parked session for it;
 * never compact, never answer a question or an approval, never another
 * thread. The person's own entry refuses it like every server token.
 */

const SECRET = 'chat-internal-secret-0123456789'

const state = {
  sessions: {} as Record<string, { id: string; user_id: string; workspace_id: string; is_home: boolean | null }>,
}

function query(table: string) {
  const eqs: Array<[string, unknown]> = []
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (c: string, v: unknown) => {
      eqs.push([c, v])
      return chain
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      if (table !== 'chat_conversations') throw new Error(`unexpected table ${table}`)
      const byConversation = eqs.find(([c]) => c === 'id')?.[1] as string | undefined
      if (byConversation !== undefined) return { data: Object.values(state.sessions).find((r) => r.id === byConversation) ?? null, error: null }
      const id = eqs.find(([c]) => c === 'eve_session_id')?.[1] as string
      return { data: state.sessions[id] ?? null, error: null }
    },
  }
  return chain
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ from: query })) }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: async () => ({ data: { user: null } }) }, from: query })),
}))

import { ForbiddenError, UnauthenticatedError } from 'eve/channels/auth'
import { assertTurnRunToken, serverCompactionAuth, serverSurfacePairValid, verifyChatRunClaims } from '../auth'
import { mintChatRunToken, serverSurfacePairValid as appPairValid, verifyChatRunToken } from '@/lib/chat/chat-run-token'

const MOUNT = 'https://app/eve/chat-agent/v1'
const entry = serverCompactionAuth()

const textToken = (over: Record<string, unknown> = {}) =>
  mintChatRunToken({ conversationId: 'conv-home', userId: 'user-1', workspaceId: 'ws-1', server: 'channel_turn', surface: 'sms', ...over } as never)

const QUEUED = { message: '[TEXT MESSAGE · home-turn r1] The person texted you from their phone:\nMove my 3pm', turnPolicy: 'queue' }

function post(path: string, body: unknown, token: string = textToken()) {
  return new Request(`${MOUNT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-run-secret': SECRET, 'x-chat-run-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
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
  state.sessions = {
    sess_HOME: { id: 'conv-home', user_id: 'user-1', workspace_id: 'ws-1', is_home: true },
    sess_SIDE: { id: 'conv-side', user_id: 'user-1', workspace_id: 'ws-1', is_home: null },
    sess_OTHER_HOME: { id: 'conv-home-2', user_id: 'user-2', workspace_id: 'ws-1', is_home: true },
  }
})

describe('the surface rule: channel_turn ⇔ a channel surface (sms here), no other server token carries a surface', () => {
  it.each([
    ['channel_turn + sms', { server: 'channel_turn', surface: 'sms' }, true],
    ['the retired text_turn + sms', { server: 'text_turn', surface: 'sms' }, false],
    ['no server, no surface', {}, true],
    ['device_ask alone', { surface: 'device_ask' }, true],
    ['home_turn alone', { server: 'home_turn' }, true],
    ['channel_turn without a surface', { server: 'channel_turn' }, false],
    ['sms without channel_turn', { surface: 'sms' }, false],
    ['home_turn + sms', { server: 'home_turn', surface: 'sms' }, false],
    ['idle_compaction + sms', { server: 'idle_compaction', surface: 'sms' }, false],
    ['channel_turn + device_ask', { server: 'channel_turn', surface: 'device_ask' }, false],
    ['home_turn + device_ask', { server: 'home_turn', surface: 'device_ask' }, false],
  ])('%s → %s in both verifiers', (_label, claims, valid) => {
    const token = mintChatRunToken({ conversationId: 'conv-home', userId: 'user-1', workspaceId: 'ws-1', ...claims } as never)
    expect(verifyChatRunClaims(token) !== null).toBe(valid)
    expect(verifyChatRunToken(token) !== null).toBe(valid)
    const c = claims as { server?: string; surface?: string }
    expect(serverSurfacePairValid(c.server, c.surface)).toBe(valid)
    expect(appPairValid(c.server, c.surface)).toBe(valid)
  })

  it('a text-turn token with a sealed credential or a relay does not verify', () => {
    for (const over of [{ cred: 'sealed' }, { teammateId: 't', relay: 'r' }]) {
      const token = textToken(over)
      expect(verifyChatRunClaims(token)).toBeNull()
      expect(verifyChatRunToken(token)).toBeNull()
    }
  })

  it('a text-turn send token may live as long as a home turn’s (past the 60-minute default)', () => {
    const token = mintChatRunToken({ conversationId: 'c', userId: 'u', workspaceId: 'w', server: 'channel_turn', surface: 'sms' }, { ttlMs: 84 * 60_000 })
    expect(verifyChatRunToken(token)!.exp - Date.now()).toBeGreaterThan(80 * 60_000)
    const plain = mintChatRunToken({ conversationId: 'c', userId: 'u', workspaceId: 'w' }, { ttlMs: 84 * 60_000 })
    expect(verifyChatRunToken(plain)!.exp - Date.now()).toBeLessThanOrEqual(60 * 60_000)
  })
})

describe('allowed: only into the token’s own home thread', () => {
  it('a queued send into its own home session → the server principal', async () => {
    const token = textToken()
    expect(await entry(post('/session/sess_HOME', QUEUED, token))).toEqual({
      authenticator: 'server',
      principalId: 'user-1',
      principalType: 'service',
      attributes: { workspaceId: 'ws-1', chatRunToken: token, chatRunCtx: '' },
    })
  })

  it('reads its own session’s stream, and creates a parked session for its own home thread', async () => {
    const stream = new Request(`${MOUNT}/session/sess_HOME/stream?startIndex=-1000&includeTailIndex=1`, {
      method: 'GET',
      headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': textToken() },
    })
    expect(await entry(stream)).toMatchObject({ authenticator: 'server' })
    expect(await entry(post('/session', undefined))).toMatchObject({ authenticator: 'server' })
  })
})

describe('refused', () => {
  it('a side chat → server_send_not_home; another person’s home thread or another conversation → session_forbidden', async () => {
    expect(await rejection(entry(post('/session/sess_SIDE', QUEUED, textToken({ conversationId: 'conv-side' }))))).toEqual({ status: 403, code: 'server_send_not_home' })
    expect((await rejection(entry(post('/session/sess_OTHER_HOME', QUEUED)))).code).toBe('session_forbidden')
    expect((await rejection(entry(post('/session/sess_SIDE', QUEUED)))).code).toBe('session_forbidden')
  })

  it('a create for anything but its own home thread → server_create_not_home', async () => {
    for (const over of [{ conversationId: 'conv-side' }, { userId: 'user-2' }]) {
      expect((await rejection(entry(post('/session', undefined, textToken(over))))).code).toBe('server_create_not_home')
    }
  })

  it('never compacts, answers a question or an approval, steers, or cancels', async () => {
    expect((await rejection(entry(post('/session/sess_HOME/compact', {})))).code).toBe('server_route_forbidden')
    expect((await rejection(entry(post('/session/sess_HOME/cancel', {})))).code).toBe('server_route_forbidden')
    for (const body of [
      { ...QUEUED, inputResponses: [{ requestId: 'r', optionId: 'approve' }] },
      { inputResponses: [{ requestId: 'r', optionId: 'approve' }] },
      { ...QUEUED, turnPolicy: 'steer' },
      { ...QUEUED, clientContext: 'answer' },
    ]) {
      expect((await rejection(entry(post('/session/sess_HOME', body)))).code).toBe('server_send_body_forbidden')
    }
  })

  it('a device-ask token never rides the server entry', async () => {
    const device = mintChatRunToken({ conversationId: 'conv-home', userId: 'user-1', workspaceId: 'ws-1', surface: 'device_ask' })
    expect((await rejection(entry(post('/session/sess_HOME', QUEUED, device)))).code).toBe('server_run_token_required')
  })

  it('the person’s own entry refuses a text-turn token', async () => {
    const request = new Request(`${MOUNT}/session/sess_HOME`, { method: 'POST' })
    const r = await rejection(assertTurnRunToken(request, { userId: 'user-1', workspaceId: 'ws-1' }, textToken()))
    expect([r.status, r.code]).toEqual([403, 'chat_run_token_required'])
  })
})
