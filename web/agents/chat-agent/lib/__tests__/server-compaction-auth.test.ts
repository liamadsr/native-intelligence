import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The chat-agent channel's one server principal (serverCompactionAuth): the
 * app's idle-time compaction presents the chat family's internal secret plus a
 * chat-run token it minted for the conversation. Pinned:
 *   - allowed ONLY on POST /session/:id/compact and GET /session/:id/stream;
 *     every other route (create, send / respond, cancel, clear, reset, a
 *     subagent stream, the wrong method) is 403;
 *   - a wrong secret is 401 (the RUN_SKILL fallback counts, as everywhere);
 *     no secret header skips, so the person path is unchanged;
 *   - the token must verify (no device-ask surface, no relay);
 *   - ownership: the session must be the one registered on the TOKEN's
 *     conversation, for its user + workspace (fail closed);
 *   - DRIFT: the allow-list is eve's compact + stream route constants.
 */

const SECRET = 'chat-internal-secret-0123456789'

const state = {
  /** eve_session_id → owner (chat_conversations rows). */
  sessions: {} as Record<string, { id: string; user_id: string; workspace_id: string }>,
  lookupError: false,
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
      if (state.lookupError) return { data: null, error: { message: 'boom' } }
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
vi.mock('eve/channels/eve', () => ({ eveChannel: (cfg: unknown) => cfg }))

import { ForbiddenError, UnauthenticatedError, type AuthFn } from 'eve/channels/auth'
import { serverCompactionAuth, serverRouteSessionId } from '../auth'
import channel from '../../channels/eve'
import { mintChatRunToken } from '@/lib/chat/chat-run-token'

const MOUNT = 'https://app/eve/chat-agent/v1'
const entry = serverCompactionAuth()

const tokenFor = (over: Record<string, unknown> = {}) =>
  mintChatRunToken({ conversationId: 'conv-1', userId: 'user-1', workspaceId: 'ws-1', ...over } as never)

function expiredToken(): string {
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000)
  try {
    return tokenFor()
  } finally {
    vi.useRealTimers()
  }
}

const req = (method: string, path: string, headers: Record<string, string> = {}) =>
  new Request(`${MOUNT}${path}`, { method, headers })
/** A server request: the secret + a token for conv-1 unless overridden. */
const serverReq = (method: string, path: string, over: { secret?: string; token?: string } = {}) =>
  req(method, path, { 'x-chat-run-secret': over.secret ?? SECRET, 'x-chat-run-token': over.token ?? tokenFor() })

async function rejection(p: unknown): Promise<{ status: number; code: string; err: unknown }> {
  try {
    await p
  } catch (err) {
    const res = (err as ForbiddenError | UnauthenticatedError).response
    return { status: res.status, code: ((await res.json()) as { code: string }).code, err }
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
    sess_OWN: { id: 'conv-1', user_id: 'user-1', workspace_id: 'ws-1' },
    sess_SIBLING: { id: 'conv-2', user_id: 'user-1', workspace_id: 'ws-1' },
  }
  state.lookupError = false
})

describe('allowed: compact and the stream read on the token’s own session', () => {
  it.each([
    ['POST', '/session/sess_OWN/compact'],
    ['GET', '/session/sess_OWN/stream'],
    ['GET', '/session/sess_OWN/stream?startIndex=-200'],
  ])('%s %s → a server principal acting for the conversation’s person', async (method, path) => {
    const token = tokenFor()
    const principal = await entry(serverReq(method, path, { token }))
    expect(principal).toEqual({
      authenticator: 'server',
      principalId: 'user-1',
      principalType: 'service',
      attributes: { workspaceId: 'ws-1', chatRunToken: token, chatRunCtx: '' },
    })
  })

  it('a bot conversation’s or a focused conversation’s token works the same', async () => {
    for (const token of [
      tokenFor({ teammateId: 'tm-1', teammateIn: 'chat' }),
      tokenFor({ teammateId: 'tm-1' }),
      tokenFor({ focusArea: 'calendar' }),
    ]) {
      expect(await entry(serverReq('POST', '/session/sess_OWN/compact', { token }))).toMatchObject({ authenticator: 'server' })
    }
  })
})

describe('refused on every other route (403 server_route_forbidden)', () => {
  it.each([
    ['POST', '/session'],
    ['POST', '/session/sess_OWN'],
    ['POST', '/session/sess_OWN/cancel'],
    ['POST', '/session/sess_OWN/clear'],
    ['POST', '/session/sess_OWN/reset'],
    ['GET', '/session/sess_OWN/compact'],
    ['POST', '/session/sess_OWN/stream'],
    ['DELETE', '/session/sess_OWN/compact'],
    ['POST', '/session/sess_OWN/compact/'],
    ['POST', '/session/sess_OWN/compact/more'],
    ['GET', '/session/p/subagents/c/sess_OWN/stream'],
    ['GET', '/session/p/subagents/session/sess_OWN/stream'],
    ['GET', '/info'],
  ])('%s %s', async (method, path) => {
    const r = await rejection(entry(serverReq(method, path)))
    expect(r.err).toBeInstanceOf(ForbiddenError)
    expect([r.status, r.code]).toEqual([403, 'server_route_forbidden'])
  })
})

describe('the secret', () => {
  it('no x-chat-run-secret header → skip (null): the person and device entries decide', async () => {
    expect(await entry(req('POST', '/session/sess_OWN/compact', { 'x-chat-run-token': tokenFor() }))).toBeNull()
    expect(await entry(req('POST', '/session/sess_OWN/compact', { 'x-chat-run-secret': '', 'x-chat-run-token': tokenFor() }))).toBeNull()
  })

  it('a wrong secret (or one of another length) → 401, never a fall-through', async () => {
    for (const secret of ['chat-internal-secret-0123456788', 'short', `${SECRET}x`]) {
      const r = await rejection(entry(serverReq('POST', '/session/sess_OWN/compact', { secret })))
      expect(r.err).toBeInstanceOf(UnauthenticatedError)
      expect([r.status, r.code]).toEqual([401, 'server_secret_invalid'])
    }
  })

  it('the secret as a Bearer is not the server header (the person entry handles a Bearer)', async () => {
    expect(await entry(req('POST', '/session/sess_OWN/compact', { authorization: `Bearer ${SECRET}`, 'x-chat-run-token': tokenFor() }))).toBeNull()
  })

  it('falls back to RUN_SKILL_INTERNAL_SECRET like the chat family; with neither set, nothing is admitted', async () => {
    const token = tokenFor() // signed with SECRET (CHAT_INTERNAL_SECRET)
    delete process.env.CHAT_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    expect(await entry(serverReq('POST', '/session/sess_OWN/compact', { token }))).toMatchObject({ authenticator: 'server' })
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect((await rejection(entry(serverReq('POST', '/session/sess_OWN/compact', { token })))).status).toBe(401)
  })
})

describe('the run token (403 server_run_token_required)', () => {
  it.each([
    ['none', ''],
    ['garbage', 'garbage'],
  ])('%s', async (_label, token) => {
    const r = await rejection(entry(serverReq('POST', '/session/sess_OWN/compact', { token })))
    expect([r.status, r.code]).toEqual([403, 'server_run_token_required'])
  })

  it('an expired token, a device-ask token and a relay token are refused', async () => {
    for (const token of [
      expiredToken(),
      tokenFor({ surface: 'device_ask' }),
      tokenFor({ teammateId: 'tm-1', relay: 'relay-1' }),
    ]) {
      const r = await rejection(entry(serverReq('POST', '/session/sess_OWN/compact', { token })))
      expect([r.status, r.code]).toEqual([403, 'server_run_token_required'])
    }
  })
})

describe('ownership: the session must be the token’s conversation (403 session_forbidden)', () => {
  it.each([
    ['another conversation of the same person', { conversationId: 'conv-2' }],
    ['another user', { userId: 'user-2' }],
    ['another workspace', { workspaceId: 'ws-2' }],
  ])('a token for %s', async (_label, over) => {
    for (const [method, path] of [['POST', '/session/sess_OWN/compact'], ['GET', '/session/sess_OWN/stream']]) {
      const r = await rejection(entry(serverReq(method, path, { token: tokenFor(over) })))
      expect([r.status, r.code]).toEqual([403, 'session_forbidden'])
    }
  })

  it('the sibling session is refused to conv-1’s token, and allowed to its own', async () => {
    expect((await rejection(entry(serverReq('POST', '/session/sess_SIBLING/compact')))).code).toBe('session_forbidden')
    expect(await entry(serverReq('POST', '/session/sess_SIBLING/compact', { token: tokenFor({ conversationId: 'conv-2' }) }))).toMatchObject({
      authenticator: 'server',
    })
  })

  it('fails closed on an unregistered id and on a lookup error', async () => {
    expect((await rejection(entry(serverReq('POST', '/session/sess_NOPE/compact')))).code).toBe('session_forbidden')
    state.lookupError = true
    expect((await rejection(entry(serverReq('POST', '/session/sess_OWN/compact')))).code).toBe('session_forbidden')
  })
})

describe('the channel', () => {
  const walk = (channel as unknown as { auth: AuthFn<Request>[] }).auth

  it('runs the server entry right after the eval entry, and a person request skips both', async () => {
    const src = readFileSync(join(__dirname, '../../channels/eve.ts'), 'utf8')
    expect(src).toContain('auth: [evalRunnerAuth(), serverCompactionAuth(), supabaseSessionWithAcl(), deviceTokenAuthWithAcl(), localDevOffVercel()]')
    const person = req('POST', '/session/sess_OWN', { authorization: 'Bearer eyJ.jwt', 'x-chat-run-token': tokenFor() })
    expect(await walk[0](person)).toBeNull()
    expect(await walk[1](person)).toBeNull()
  })

  it('a server request is decided by the server entry, end to end', async () => {
    expect(await walk[0](serverReq('POST', '/session/sess_OWN/compact'))).toBeNull()
    expect(await walk[1](serverReq('POST', '/session/sess_OWN/compact'))).toMatchObject({ authenticator: 'server' })
    await expect(walk[1](serverReq('POST', '/session/sess_OWN'))).rejects.toThrow(ForbiddenError)
  })
})

describe('DRIFT — the allow-list is eve’s compact + stream routes, and nothing else', () => {
  const evePkg = join(__dirname, '../../../../node_modules/eve')
  const routesSrc = readFileSync(join(evePkg, 'dist/src/protocol/routes.js'), 'utf8')
  function resolveRoute(name: string, depth = 0): string {
    if (depth > 5) throw new Error(`route ${name} did not resolve`)
    const m = routesSrc.match(new RegExp(`${name}=\`([^\`]*)\``))
    if (!m) throw new Error(`route constant ${name} not found in eve protocol/routes.js`)
    return m[1].replace(/\$\{([A-Z_]+)\}/g, (_x, inner: string) => resolveRoute(inner, depth + 1))
  }
  const underMount = (name: string) =>
    `https://app${resolveRoute(name).replace('/eve/v1', '/eve/chat-agent/v1')}`
      .replace(':sessionId', 'sess_1')
      .replace(':parentSessionId', 'sess_1')
      .replace(':callId', 'c')
      .replace(':childSessionId', 'child')

  it('compact (POST) and stream (GET) resolve to the session id; every other session route, any method, does not', () => {
    const allowed: Record<string, string> = {
      EVE_SESSION_COMPACT_ROUTE_PATTERN: 'POST',
      EVE_SESSION_STREAM_ROUTE_PATTERN: 'GET',
    }
    const names = [...new Set([...routesSrc.matchAll(/(EVE_(?:SESSION|SUBAGENT)_[A-Z_]+)=`/g)].map((m) => m[1]))]
    expect(names).toEqual(expect.arrayContaining(Object.keys(allowed)))
    for (const name of names) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const id = serverRouteSessionId(new Request(underMount(name), { method }))
        expect([name, method, id]).toEqual([name, method, allowed[name] === method ? 'sess_1' : null])
      }
    }
  })
})
