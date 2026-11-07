import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The channel-turn door (docs/plans/slack-connect.md, decision 14): a Slack DM
 * from the person, written into their home thread by the server, rides the
 * same server entry as a home turn. It may SEND a queued message, only with a
 * `server: 'channel_turn'` token that carries its channel's surface ('slack'),
 * only into the token's own home thread; never compact; and the person's own
 * entry refuses it. The pair is strict on both sides: a channel surface
 * without channel_turn, or channel_turn without one, never verifies.
 */

const SECRET = 'chat-internal-secret-0123456789'
const GUEST = '44444444-4444-4444-8444-444444444444'

const state = {
  without414: false,
  sessions: {} as Record<string, { id: string; user_id: string; workspace_id: string; is_home: boolean | null; outside_channel?: string | null; agent_guest_id?: string | null }>,
}

function query(table: string) {
  const eqs: Array<[string, unknown]> = []
  let columns = ''
  const chain: Record<string, unknown> = {
    select: (c: string) => ((columns = c ?? ''), chain),
    eq: (c: string, v: unknown) => {
      eqs.push([c, v])
      return chain
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      if (table !== 'chat_conversations') throw new Error(`unexpected table ${table}`)
      // A database without migration 414 refuses the column.
      if (state.without414 && columns.includes('outside_channel')) return { data: null, error: { code: '42703', message: 'column does not exist' } }
      // Without 414 a row has no such column to return.
      const shape = (r: (typeof state.sessions)[string] | undefined) => (r && state.without414 ? { ...r, outside_channel: undefined } : r) ?? null
      const byConversation = eqs.find(([c]) => c === 'id')?.[1] as string | undefined
      if (byConversation !== undefined) return { data: shape(Object.values(state.sessions).find((r) => r.id === byConversation)), error: null }
      const id = eqs.find(([c]) => c === 'eve_session_id')?.[1] as string
      return { data: shape(state.sessions[id]), error: null }
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

const tokenFor = (over: Record<string, unknown> = {}) =>
  mintChatRunToken({ conversationId: 'conv-home', userId: 'user-1', workspaceId: 'ws-1', server: 'channel_turn', surface: 'slack', ...over } as never)

const QUEUED = { message: '[SLACK MESSAGE · home-turn r1] The person messaged you from Slack:\nwhat is on my calendar', turnPolicy: 'queue' }

function send(path: string, body: unknown, over: { token?: string } = {}) {
  return new Request(`${MOUNT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-run-secret': SECRET, 'x-chat-run-token': over.token ?? tokenFor() },
    body: JSON.stringify(body),
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
  state.without414 = false
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  process.env.CHAT_INTERNAL_SECRET = SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  state.sessions = {
    sess_HOME: { id: 'conv-home', user_id: 'user-1', workspace_id: 'ws-1', is_home: true },
    sess_SIDE: { id: 'conv-side', user_id: 'user-1', workspace_id: 'ws-1', is_home: null },
    sess_THREAD: { id: 'conv-thread', user_id: 'user-1', workspace_id: 'ws-1', is_home: null, outside_channel: 'slack' },
    sess_GUEST: { id: 'conv-guest', user_id: 'user-1', workspace_id: 'ws-1', is_home: null, outside_channel: 'sms', agent_guest_id: GUEST },
  }
})

describe("a guest's channel turn sends only into that guest's own thread, by text or Slack (migration 434)", () => {
  it('a Slack or SMS guest token sends into their thread, whichever channel the thread was made on', async () => {
    for (const surface of ['slack', 'sms'] as const) {
      const token = tokenFor({ conversationId: 'conv-guest', surface, guestId: GUEST })
      expect(await entry(send('/session/sess_GUEST', QUEUED, { token })), surface).toMatchObject({ authenticator: 'server', principalId: 'user-1' })
    }
  })

  it("never another guest's thread, the home thread, or a guest's thread on a token without its guest", async () => {
    const other = await rejection(entry(send('/session/sess_GUEST', QUEUED, { token: tokenFor({ conversationId: 'conv-guest', guestId: '99999999-9999-4999-8999-999999999999' }) })))
    expect(other.status).toBe(403)
    const home = await rejection(entry(send('/session/sess_HOME', QUEUED, { token: tokenFor({ guestId: GUEST }) })))
    expect(home.status).toBe(403)
    const bare = await rejection(entry(send('/session/sess_GUEST', QUEUED, { token: tokenFor({ conversationId: 'conv-guest', surface: 'sms' }) })))
    expect(bare.status).toBe(403)
  })
})

describe('a channel turn may send into its own home thread', () => {
  it('POST /session/:id with exactly { message, turnPolicy: queue } → the server principal', async () => {
    const token = tokenFor()
    expect(await entry(send('/session/sess_HOME', QUEUED, { token }))).toEqual({
      authenticator: 'server',
      principalId: 'user-1',
      principalType: 'service',
      attributes: { workspaceId: 'ws-1', chatRunToken: token, chatRunCtx: '' },
    })
  })

  it('never into a conversation that is not a home thread', async () => {
    const token = tokenFor({ conversationId: 'conv-side' })
    const r = await rejection(entry(send('/session/sess_SIDE', QUEUED, { token })))
    expect([r.status, r.code]).toEqual([403, 'server_send_not_home'])
  })

  it('never into another conversation’s session', async () => {
    const r = await rejection(entry(send('/session/sess_SIDE', QUEUED)))
    expect([r.status, r.code]).toEqual([403, 'session_forbidden'])
  })

  it('never compacts', async () => {
    const r = await rejection(entry(send('/session/sess_HOME/compact', {})))
    expect([r.status, r.code]).toEqual([403, 'server_route_forbidden'])
  })

  it('may create a parked session for its home thread, with no body', async () => {
    const request = new Request(`${MOUNT}/session`, {
      method: 'POST',
      headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': tokenFor() },
    })
    expect(await entry(request)).toMatchObject({ authenticator: 'server', principalId: 'user-1' })
  })
})

describe('the person’s entry refuses a channel-turn token', () => {
  it('assertTurnRunToken: it can’t start a turn on a person’s session', async () => {
    const session = { userId: 'user-1', workspaceId: 'ws-1' }
    const r = await rejection(assertTurnRunToken(new Request(`${MOUNT}/session/sess_HOME`, { method: 'POST' }), session, tokenFor()))
    expect([r.status, r.code]).toEqual([403, 'chat_run_token_required'])
  })
})

describe('the channel_turn ⇔ channel surface pair, on both sides', () => {
  it('both verifiers accept the pair the app mints', () => {
    const token = tokenFor()
    expect(verifyChatRunToken(token)).toMatchObject({ server: 'channel_turn', surface: 'slack' })
    expect(verifyChatRunClaims(token)).toMatchObject({ server: 'channel_turn', surface: 'slack' })
  })

  it('neither verifies a Slack surface without channel_turn, channel_turn without a channel surface, or one it does not know', () => {
    for (const over of [
      { server: undefined, surface: 'slack' },
      { server: 'home_turn', surface: 'slack' },
      { server: 'channel_turn', surface: undefined },
      { server: 'channel_turn', surface: 'device_ask' },
      { server: 'channel_turn', surface: 'whatsapp' },
      // A channel turn speaks in the person's home thread, never a teammate's or a focused one's.
      { teammateId: 'bot-1' },
      { focusArea: 'sales' },
    ]) {
      const token = tokenFor(over)
      expect(verifyChatRunToken(token), JSON.stringify(over)).toBeNull()
      expect(verifyChatRunClaims(token), JSON.stringify(over)).toBeNull()
    }
  })

  it('the twins agree on every pair', () => {
    const servers = [undefined, 'home_turn', 'idle_compaction', 'channel_turn', 'other']
    const surfaces = [undefined, 'device_ask', 'slack', 'sms']
    for (const server of servers) for (const surface of surfaces) expect(serverSurfacePairValid(server, surface)).toBe(appPairValid(server, surface))
  })
})

describe('a channel turn into the person’s own Slack-thread conversation (migration 414)', () => {
  it('may send there, and create its parked session', async () => {
    const token = tokenFor({ conversationId: 'conv-thread' })
    expect(await entry(send('/session/sess_THREAD', QUEUED, { token }))).toMatchObject({ authenticator: 'server', principalId: 'user-1' })
    const create = new Request(`${MOUNT}/session`, { method: 'POST', headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': token } })
    expect(await entry(create)).toMatchObject({ authenticator: 'server' })
  })

  it('a home-turn token never may (only a channel turn reaches a channel’s conversation)', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-thread', userId: 'user-1', workspaceId: 'ws-1', server: 'home_turn' } as never)
    const r = await rejection(entry(send('/session/sess_THREAD', QUEUED, { token })))
    expect([r.status, r.code]).toEqual([403, 'server_send_not_home'])
  })

  it('a conversation with no channel marker stays closed to a channel turn', async () => {
    const r = await rejection(entry(send('/session/sess_SIDE', QUEUED, { token: tokenFor({ conversationId: 'conv-side' }) })))
    expect([r.status, r.code]).toEqual([403, 'server_send_not_home'])
  })

  it('never someone else’s thread conversation', async () => {
    state.sessions.sess_THREAD = { ...state.sessions.sess_THREAD, user_id: 'user-2' }
    const r = await rejection(entry(send('/session/sess_THREAD', QUEUED, { token: tokenFor({ conversationId: 'conv-thread' }) })))
    expect([r.status, r.code]).toEqual([403, 'session_forbidden'])
  })
})

describe('a database without migration 414 (deployed before the migration)', () => {
  it('still admits a home thread’s sends: the lookup falls back without the column', async () => {
    state.without414 = true
    expect(await entry(send('/session/sess_HOME', QUEUED))).toMatchObject({ authenticator: 'server', principalId: 'user-1' })
    // And nothing is a channel's conversation there.
    const r = await rejection(entry(send('/session/sess_THREAD', QUEUED, { token: tokenFor({ conversationId: 'conv-thread' }) })))
    expect([r.status, r.code]).toEqual([403, 'server_send_not_home'])
  })
})
