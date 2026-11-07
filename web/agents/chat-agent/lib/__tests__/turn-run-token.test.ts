import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The browser entry's RUN-TOKEN GATE on the chat-agent channel.
 *
 * A request that STARTS model work (POST create / send / respond / compact) must
 * carry a verified, unexpired chat-run token minted for the same user +
 * workspace the Supabase session resolved — else 403. (A device-ask token
 * qualifies: /api/device/ask relays a JWT/cookie device's credential through
 * this entry with the token it minted for that ask.) Before this gate the
 * channel stamped whatever `x-chat-run-token` the browser sent (or ''), and the
 * usage-limit gate, the model resolver and the usage meter all failed SOFT on a
 * missing / bad token, so a client that stripped the header ran turns with no
 * usage-limit gate. Pinned:
 *   - which routes are turn-starting (eve 0.66.3's POST /session, /session/:id,
 *     /session/:id/compact) and which are not (stream, cancel, clear, reset,
 *     subagent streams, any GET);
 *   - the verifier twin accepts Next-minted tokens (in-app and device-ask) and
 *     refuses a tampered / expired / foreign-signed one;
 *   - the channel's Supabase entry, driven end to end: no token / garbage /
 *     expired / another user's / another workspace's token → 403 on a
 *     turn-starting request; a valid one (in-app or the ask's device token)
 *     passes and is stamped; a stream read or a cancel still passes without one
 *     (the ownership ACL gates those);
 *   - a device-ask token is bound to ITS ask's conversation on a targeted
 *     turn-starting request (it cannot drive the user's in-app sessions);
 *   - DRIFT: the classifier covers exactly the POST routes eve's channel
 *     registers (node_modules/eve/dist/src/eve-channel/index.js) — an eve bump
 *     that adds or renames one fails here until it is classified.
 */

const SECRET = 'chat-internal-secret-0123456789'

const state = {
  user: 'user-1' as string | null,
  membership: 'ws-1' as string | null,
  /** Workspaces the user is ALSO a member of (a header/cookie candidate is checked against these). */
  otherMemberships: [] as string[],
  /** eve_session_id → owner (chat_conversations rows). */
  sessions: {} as Record<string, { id: string; user_id: string; workspace_id: string }>,
}

function query(table: string) {
  const eqs: Array<[string, unknown]> = []
  const val = (col: string) => eqs.find(([c]) => c === col)?.[1] as string
  const resolve = async () => {
    if (table === 'member') {
      // A candidate check names the workspace; the first-membership read does not.
      const candidate = val('workspace_id')
      if (candidate !== undefined) {
        const member = candidate === state.membership || state.otherMemberships.includes(candidate)
        return { data: member ? { workspace_id: candidate } : null, error: null }
      }
      return { data: state.membership ? { workspace_id: state.membership } : null, error: null }
    }
    if (table === 'chat_conversations') return { data: state.sessions[val('eve_session_id')] ?? null, error: null }
    throw new Error(`unexpected table ${table}`)
  }
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (c: string, v: unknown) => {
      eqs.push([c, v])
      return chain
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: resolve,
  }
  return chain
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ from: query })) }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null } }) },
    from: query,
  })),
}))
// Capture the channel's config instead of building a real eve channel.
vi.mock('eve/channels/eve', () => ({ eveChannel: (cfg: unknown) => cfg }))

import { ForbiddenError, UnauthenticatedError, type AuthFn } from 'eve/channels/auth'
import { assertTurnRunToken, isTurnStartingRequest, verifyChatRunClaims, verifyDeviceAskRunToken } from '../auth'
import channel from '../../channels/eve'
import { mintChatRunToken } from '@/lib/chat/chat-run-token'

// [0] is the eval runner (eval-auth.test.ts), [1] the server principal (server-compaction-auth.test.ts); [2] the person's entry.
const supabaseEntry = (channel as unknown as { auth: AuthFn<Request>[] }).auth[2]

const MOUNT = 'https://app/eve/chat-agent/v1'
const browserToken = (over: Partial<{ userId: string; workspaceId: string; conversationId: string }> = {}) =>
  mintChatRunToken({ conversationId: 'conv-1', userId: 'user-1', workspaceId: 'ws-1', ...over })
const deviceToken = () =>
  mintChatRunToken({ conversationId: 'conv-d', userId: 'user-1', workspaceId: 'ws-1', surface: 'device_ask' })
/** A structurally valid token whose exp has passed (signed with the real secret). */
function expiredToken(): string {
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000)
  try {
    return browserToken()
  } finally {
    vi.useRealTimers()
  }
}

const req = (method: string, path: string, token?: string, extra: Record<string, string> = {}) =>
  new Request(`${MOUNT}${path}`, {
    method,
    headers: { authorization: 'Bearer eyJ.jwt', ...(token !== undefined ? { 'x-chat-run-token': token } : {}), ...extra },
  })
/** A bots v2 teammate-chat token, minted for the TEAMMATE's workspace. */
const teammateToken = (workspaceId = 'ws-2') =>
  mintChatRunToken({ conversationId: 'conv-tm', userId: 'user-1', workspaceId, teammateId: 'tm-1' })

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  process.env.CHAT_INTERNAL_SECRET = SECRET
  state.user = 'user-1'
  state.membership = 'ws-1'
  state.sessions = { sess_OWN: { id: 'conv-1', user_id: 'user-1', workspace_id: 'ws-1' } }
  state.otherMemberships = []
})

describe('isTurnStartingRequest — eve 0.66.3’s model-work routes', () => {
  it.each([
    ['POST', '/session'],
    ['POST', '/session/'],
    ['POST', '/session/sess_1'],
    ['POST', '/session/sess_1/compact'],
    ['post', '/session/sess_1'],
  ])('%s %s starts model work', (method, path) => {
    expect(isTurnStartingRequest(new Request(`${MOUNT}${path}`, { method: method.toUpperCase() }))).toBe(true)
  })

  it.each([
    ['GET', '/session/sess_1/stream'],
    ['POST', '/session/sess_1/cancel'],
    ['POST', '/session/sess_1/clear'],
    ['POST', '/session/sess_1/reset'],
    ['GET', '/session/p/subagents/c/child/stream'],
    ['GET', '/session'],
    ['GET', '/info'],
    ['POST', '/info'],
  ])('%s %s does not', (method, path) => {
    expect(isTurnStartingRequest(new Request(`${MOUNT}${path}`, { method }))).toBe(false)
  })
})

describe('verifyChatRunClaims — twin of the Next verifier', () => {
  it('accepts Next-minted tokens (in-app and device-ask) and returns their tenancy', () => {
    expect(verifyChatRunClaims(browserToken())).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1', conversationId: 'conv-1' })
    expect(verifyChatRunClaims(browserToken())).not.toHaveProperty('surface')
    expect(verifyChatRunClaims(deviceToken())).toMatchObject({ surface: 'device_ask' })
    // The device entry's stricter check still refuses an in-app token.
    expect(verifyDeviceAskRunToken(browserToken())).toBeNull()
    expect(verifyDeviceAskRunToken(deviceToken())).toMatchObject({ surface: 'device_ask' })
  })

  it('refuses a tampered / foreign-signed / expired / empty token, and any token with no secret', () => {
    const t = browserToken()
    const [payload, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ conversationId: 'c', userId: 'attacker', workspaceId: 'ws-1', exp: Date.now() + 1e6 })).toString('base64url')
    expect(verifyChatRunClaims(`${forged}.${sig}`)).toBeNull()
    // Flip the first char to one it is NOT: a constant 'x' equals the real signature's first char 1 run in 64.
    const tamper = (s: string) => (s[0] === 'x' ? 'y' : 'x') + s.slice(1)
    expect(tamper(sig)).not.toBe(sig)
    expect(tamper(`x${sig.slice(1)}`)).not.toBe(`x${sig.slice(1)}`)
    expect(verifyChatRunClaims(`${payload}.${tamper(sig)}`)).toBeNull()
    expect(verifyChatRunClaims(expiredToken())).toBeNull()
    expect(verifyChatRunClaims('')).toBeNull()
    delete process.env.CHAT_INTERNAL_SECRET
    expect(verifyChatRunClaims(t)).toBeNull()
  })
})

describe('assertTurnRunToken', () => {
  const session = { userId: 'user-1', workspaceId: 'ws-1' }
  it('passes a matching in-app or device-ask token on a turn-starting request; ignores non-turn requests entirely', async () => {
    await expect(assertTurnRunToken(req('POST', '/session'), session, browserToken())).resolves.toBeUndefined()
    await expect(assertTurnRunToken(req('POST', '/session'), session, deviceToken())).resolves.toBeUndefined()
    await expect(assertTurnRunToken(req('GET', '/session/s/stream'), session, '')).resolves.toBeUndefined()
    await expect(assertTurnRunToken(req('POST', '/session/s/cancel'), session, 'garbage')).resolves.toBeUndefined()
  })
  it('403s a turn-starting request without a matching, verified token', async () => {
    for (const token of [
      '',
      'garbage',
      expiredToken(),
      browserToken({ userId: 'user-2' }),
      browserToken({ workspaceId: 'ws-2' }),
    ]) {
      await expect(assertTurnRunToken(req('POST', '/session/s'), session, token)).rejects.toThrow(ForbiddenError)
    }
  })

  describe('a device-ask token is bound to its own ask', () => {
    it('drives the session registered on the conversation it was minted for', async () => {
      state.sessions.sess_ASK = { id: 'conv-d', user_id: 'user-1', workspace_id: 'ws-1' }
      await expect(assertTurnRunToken(req('POST', '/session/sess_ASK'), session, deviceToken())).resolves.toBeUndefined()
      await expect(assertTurnRunToken(req('POST', '/session/sess_ASK/compact'), session, deviceToken())).resolves.toBeUndefined()
    })
    it('403s on the user’s in-app session (owned by the same user + workspace, but another conversation)', async () => {
      await expect(assertTurnRunToken(req('POST', '/session/sess_OWN'), session, deviceToken())).rejects.toThrow(/its own ask/)
      await expect(assertTurnRunToken(req('POST', '/session/sess_OWN/compact'), session, deviceToken())).rejects.toThrow(/its own ask/)
    })
    it('fails closed on an unregistered session id', async () => {
      await expect(assertTurnRunToken(req('POST', '/session/sess_NOPE'), session, deviceToken())).rejects.toThrow(ForbiddenError)
    })
    it('an in-app token is not bound this way (the ownership ACL gates its sessions)', async () => {
      state.sessions.sess_ASK = { id: 'conv-d', user_id: 'user-1', workspace_id: 'ws-1' }
      await expect(assertTurnRunToken(req('POST', '/session/sess_ASK'), session, browserToken())).resolves.toBeUndefined()
    })
  })
})

describe('verifyChatRunClaims — allowExpired (attribution only)', () => {
  it('accepts an expired but validly signed token only when asked, and never a forged one', () => {
    const expired = expiredToken()
    expect(verifyChatRunClaims(expired)).toBeNull()
    expect(verifyChatRunClaims(expired, { allowExpired: true })).toMatchObject({ userId: 'user-1' })
    const [, sig] = expired.split('.')
    const forged = Buffer.from(JSON.stringify({ conversationId: 'c', userId: 'u', workspaceId: 'w', surface: 'device_ask', exp: 1 })).toString('base64url')
    expect(verifyChatRunClaims(`${forged}.${sig}`, { allowExpired: true })).toBeNull()
  })
})

describe('DRIFT — the classifier vs eve’s registered POST routes', () => {
  // Every POST the eve channel registers, and whether it starts model work
  // (isTurnStartingRequest must say so). Session routes go through routeAuth
  // (the channel's auth walk); the token routes (callback / connection
  // callbacks / workflow webhook) authenticate by the
  // unguessable token in their path, not by this channel's principal.
  const CLASSIFIED: Record<string, boolean> = {
    EVE_SESSION_ROUTE_PATH: true, // create + first turn
    EVE_SESSION_ROUTE_PATTERN: true, // send / steer / HITL respond
    EVE_SESSION_COMPACT_ROUTE_PATTERN: true, // a summarization model call
    EVE_SESSION_CANCEL_ROUTE_PATTERN: false,
    EVE_SESSION_CLEAR_ROUTE_PATTERN: false,
    EVE_SESSION_RESET_ROUTE_PATTERN: false,
    // eve 0.69+ dropped the activity and task-input routes.
    EVE_CALLBACK_ROUTE_PATTERN: false,
    EVE_CONNECTION_CALLBACK_ROUTE_PATTERN: false,
    WORKFLOW_WEBHOOK_ROUTE_PATTERN: false,
    '`${EVE_ROUTE_PREFIX}/connections/:name/callback/:token`': false,
  }
  const evePkg = join(__dirname, '../../../../node_modules/eve')
  const channelSrc = readFileSync(join(evePkg, 'dist/src/eve-channel/index.js'), 'utf8')
  const routesSrc = readFileSync(join(evePkg, 'dist/src/protocol/routes.js'), 'utf8')

  /** Resolve an EVE_* route constant from routes.js (template-literal chains). */
  function resolveRoute(name: string, depth = 0): string {
    if (depth > 5) throw new Error(`route ${name} did not resolve`)
    const m = routesSrc.match(new RegExp(`${name}=\`([^\`]*)\``))
    if (!m) throw new Error(`route constant ${name} not found in eve protocol/routes.js`)
    return m[1].replace(/\$\{([A-Z_]+)\}/g, (_x, inner: string) => resolveRoute(inner, depth + 1))
  }

  it('eve 0.79.1 registers exactly the classified POST routes (a new or renamed one fails here)', () => {
    const registered = [...channelSrc.matchAll(/POST\((`[^`]*`|[A-Z_]+)/g)].map((m) => m[1]).sort()
    expect(registered).toEqual(Object.keys(CLASSIFIED).sort())
  })

  it('every classified SESSION route is classified the same by isTurnStartingRequest (under the chat-agent mount)', () => {
    for (const [name, starts] of Object.entries(CLASSIFIED)) {
      if (!name.startsWith('EVE_SESSION_')) continue
      const path = resolveRoute(name).replace('/eve/v1', '/eve/chat-agent/v1').replace(':sessionId', 'sess_1')
      expect([name, isTurnStartingRequest(new Request(`https://app${path}`, { method: 'POST' }))]).toEqual([name, starts])
    }
  })
})

describe('the channel’s Supabase entry — driven end to end', () => {
  const run = (r: Request) => supabaseEntry(r)

  it('create / send / respond with a valid in-app token pass, and the token is stamped for the resolvers', async () => {
    const token = browserToken()
    for (const r of [req('POST', '/session', token), req('POST', '/session/sess_OWN', token)]) {
      const principal = await run(r)
      expect(principal).toMatchObject({ principalId: 'user-1', attributes: { workspaceId: 'ws-1', chatRunToken: token } })
    }
  })

  it('a JWT/cookie-authenticated device ask (relayed through this entry with its device-ask token) still starts', async () => {
    const token = deviceToken()
    expect(await run(req('POST', '/session', token))).toMatchObject({ principalId: 'user-1', attributes: { chatRunToken: token } })
  })

  it.each([
    ['no token', undefined],
    ['an empty token', ''],
    ['garbage', 'garbage'],
  ])('a turn with %s is refused 403 — create and send', async (_label, token) => {
    await expect(run(req('POST', '/session', token))).rejects.toThrow(/current chat-run token/)
    await expect(run(req('POST', '/session/sess_OWN', token))).rejects.toThrow(/current chat-run token/)
  })

  it('an expired, another user’s or another workspace’s token is refused on a turn', async () => {
    for (const token of [expiredToken(), browserToken({ userId: 'user-2' }), browserToken({ workspaceId: 'ws-2' })]) {
      await expect(run(req('POST', '/session/sess_OWN', token))).rejects.toThrow(/current chat-run token/)
    }
  })

  it('a stream read or a cancel on the caller’s OWN session still passes without a token (no model work)', async () => {
    expect(await run(req('GET', '/session/sess_OWN/stream'))).toMatchObject({ principalId: 'user-1' })
    expect(await run(req('POST', '/session/sess_OWN/cancel'))).toMatchObject({ principalId: 'user-1' })
  })

  it('the ownership ACL still runs first: another user’s session is 403 even with a valid token', async () => {
    state.sessions.sess_OTHER = { id: 'conv-9', user_id: 'user-2', workspace_id: 'ws-1' }
    await expect(run(req('POST', '/session/sess_OTHER', browserToken()))).rejects.toThrow(/belongs to another user/)
  })

  it('no Supabase session → skip (null), so the walk falls through (localDev is loopback-only)', async () => {
    state.user = null
    const bare = new Request(`${MOUNT}/session`, { method: 'POST' })
    expect(await run(bare)).toBeNull()
  })

  it('a Bearer that fails verification with no cookie session → 401 session_expired (not a skip, not a 403)', async () => {
    state.user = null
    let err: unknown
    try {
      await run(req('POST', '/session/sess_OWN', browserToken()))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnauthenticatedError)
    const res = (err as UnauthenticatedError).response
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('session_expired')
  })

  it('the gate is wired into the channel after the ACL, on the token the principal is stamped with', () => {
    const src = readFileSync(join(__dirname, '../../channels/eve.ts'), 'utf8')
    const acl = src.indexOf('isSessionOwnedByOther(')
    const gate = src.indexOf('await assertTurnRunToken(request, session, chatRunToken)')
    const stamp = src.indexOf('chatRunToken,\n        chatRunCtx,')
    expect(acl).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(acl)
    expect(stamp).toBeGreaterThan(gate)
  })
})

// ── A teammate chat (bots v2) in a workspace other than the current one ──────
// The token is minted for the TEAMMATE's workspace; the transport sends that
// workspace as `x-workspace-id`, so the session resolves to it and the gate's
// workspace match holds. Without the header the session falls back to the
// cookie / first membership and the turn is refused — the reason the
// transport's `workspaceId` option exists.
describe('a teammate-chat token on the Supabase entry', () => {
  const run = (r: Request) => supabaseEntry(r)

  it('the twin verifier accepts it and carries teammateId', () => {
    expect(verifyChatRunClaims(teammateToken())).toMatchObject({ teammateId: 'tm-1', workspaceId: 'ws-2' })
  })

  it("passes with the teammate's workspace as x-workspace-id (the user is a member there)", async () => {
    state.otherMemberships = ['ws-2']
    const token = teammateToken()
    const principal = await run(req('POST', '/session', token, { 'x-workspace-id': 'ws-2' }))
    expect(principal).toMatchObject({ principalId: 'user-1', attributes: { workspaceId: 'ws-2', chatRunToken: token } })
  })

  it('is refused without the header (the session resolves the first membership, ws-1)', async () => {
    state.otherMemberships = ['ws-2']
    await expect(run(req('POST', '/session', teammateToken()))).rejects.toThrow(/current chat-run token/)
  })

  it('is refused when the caller is not a member of the named workspace (falls back, then mismatches)', async () => {
    await expect(run(req('POST', '/session', teammateToken(), { 'x-workspace-id': 'ws-2' }))).rejects.toThrow(
      /current chat-run token/,
    )
  })
})

// ── A bot conversation (bots v4 Phase C) in the main chat ────────────────────
// The token names the bot with `teammateIn: 'chat'` and is minted for the
// main chat's own workspace, so the browser sends no workspace header of its
// own: the window's current workspace (the cookie) is the token's.
describe('a bot-conversation token on the Supabase entry', () => {
  const botToken = (over: Record<string, unknown> = {}) =>
    mintChatRunToken({ conversationId: 'conv-bot', userId: 'user-1', workspaceId: 'ws-1', teammateId: 'tm-1', teammateIn: 'chat', ...over } as never)

  it('the twin verifier accepts it and carries teammateId and teammateIn, as an ordinary in-app chat (no surface)', () => {
    const claims = verifyChatRunClaims(botToken())
    expect(claims).toMatchObject({ teammateId: 'tm-1', teammateIn: 'chat', workspaceId: 'ws-1' })
    expect(claims).not.toHaveProperty('surface')
    expect(verifyDeviceAskRunToken(botToken())).toBeNull()
  })

  it('the twin refuses what the Next verifier refuses: teammateIn without a teammate, another place, or with an item', () => {
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', process.env.CHAT_INTERNAL_SECRET).update(payload).digest('base64url')}`
    }
    const base = { conversationId: 'c', userId: 'user-1', workspaceId: 'ws-1' }
    expect(verifyChatRunClaims(signed({ ...base, teammateIn: 'chat' }))).toBeNull()
    expect(verifyChatRunClaims(signed({ ...base, teammateId: 'tm-1', teammateIn: 'thread' }))).toBeNull()
    expect(verifyChatRunClaims(signed({ ...base, teammateId: 'tm-1', teammateIn: 'chat', aboutCardId: 'card-1' }))).toBeNull()
    expect(verifyChatRunClaims(signed({ ...base, teammateId: 'tm-1', teammateIn: 'chat' }))).toMatchObject({ teammateIn: 'chat' })
  })

  it('passes the turn gate in the main chat’s workspace with no workspace header', async () => {
    const token = botToken()
    const principal = await supabaseEntry(req('POST', '/session', token))
    expect(principal).toMatchObject({ principalId: 'user-1', attributes: { workspaceId: 'ws-1', chatRunToken: token } })
  })
})

// ── A relayed turn in a bot's own thread (bots v4 Phase A4) ──────────────────
// The relay mints a teammate-thread token with a `relay` claim and sends the
// person's own credential, so the channel sees an ordinary in-app turn.
describe('a relayed thread-turn token on the Supabase entry', () => {
  const relayToken = (over: Record<string, unknown> = {}) =>
    mintChatRunToken({ conversationId: 'thread-1', userId: 'user-1', workspaceId: 'ws-1', teammateId: 'tm-1', relay: 'relay-1', ...over } as never)

  it('the twin verifier accepts it and carries the relay, as an ordinary in-app chat (no surface)', () => {
    const claims = verifyChatRunClaims(relayToken())
    expect(claims).toMatchObject({ teammateId: 'tm-1', relay: 'relay-1', workspaceId: 'ws-1' })
    expect(claims).not.toHaveProperty('surface')
    expect(verifyDeviceAskRunToken(relayToken())).toBeNull()
  })

  it('the twin refuses what the Next verifier refuses: a relay off a bot’s thread, or not a string', () => {
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', process.env.CHAT_INTERNAL_SECRET).update(payload).digest('base64url')}`
    }
    const base = { conversationId: 'c', userId: 'user-1', workspaceId: 'ws-1' }
    expect(verifyChatRunClaims(signed({ ...base, relay: 'relay-1' }))).toBeNull()
    expect(verifyChatRunClaims(signed({ ...base, teammateId: 'tm-1', teammateIn: 'chat', relay: 'relay-1' }))).toBeNull()
    expect(verifyChatRunClaims(signed({ ...base, teammateId: 'tm-1', surface: 'device_ask', relay: 'relay-1' }))).toBeNull()
    expect(verifyChatRunClaims(signed({ ...base, teammateId: 'tm-1', relay: '' }))).toBeNull()
    expect(verifyChatRunClaims(signed({ ...base, teammateId: 'tm-1', relay: 'relay-1' }))).toMatchObject({ relay: 'relay-1' })
  })

  it('passes the turn gate in the bot’s workspace, as the person', async () => {
    const token = relayToken()
    // Making the thread's session again (a create targets no session id yet).
    const principal = await supabaseEntry(req('POST', '/session', token))
    expect(principal).toMatchObject({ principalId: 'user-1', attributes: { workspaceId: 'ws-1', chatRunToken: token } })
  })
})

