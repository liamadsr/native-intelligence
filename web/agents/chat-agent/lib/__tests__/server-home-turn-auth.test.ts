import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The home-turn send door (A4 slice 5): the server principal may SEND into a
 * chat session only with a `server: 'home_turn'` token, only into a home
 * thread (`is_home`), and only a body of exactly
 * `{ message, turnPolicy: 'queue' }` — no clientContext, never a steer, never
 * `inputResponses` (the secret can't answer an approval or a question). A
 * home-turn token may read the stream but never compact; the person's own
 * entry refuses every server token.
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
import {
  assertTurnRunToken,
  isQueuedServerSendBody,
  isSessionLimitContinueBody,
  serverCompactionAuth,
  serverSendSessionId,
  verifyChatRunClaims,
} from '../auth'
import { mintChatRunToken, verifyChatRunToken } from '@/lib/chat/chat-run-token'

const MOUNT = 'https://app/eve/chat-agent/v1'
const entry = serverCompactionAuth()

const tokenFor = (over: Record<string, unknown> = {}) =>
  mintChatRunToken({ conversationId: 'conv-home', userId: 'user-1', workspaceId: 'ws-1', server: 'home_turn', ...over } as never)

const QUEUED = { message: '[BACKGROUND UPDATE · home-turn r1] Not from the person.', turnPolicy: 'queue' }

function send(path: string, body: unknown, over: { token?: string; raw?: string } = {}) {
  return new Request(`${MOUNT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-run-secret': SECRET, 'x-chat-run-token': over.token ?? tokenFor() },
    body: over.raw ?? JSON.stringify(body),
  })
}

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
    sess_HOME: { id: 'conv-home', user_id: 'user-1', workspace_id: 'ws-1', is_home: true },
    sess_SIDE: { id: 'conv-side', user_id: 'user-1', workspace_id: 'ws-1', is_home: null },
  }
})

describe('allowed: a queued background update into the token’s own home thread', () => {
  it('POST /session/:id with exactly { message, turnPolicy: queue } → the server principal', async () => {
    const token = tokenFor()
    expect(await entry(send('/session/sess_HOME', QUEUED, { token }))).toEqual({
      authenticator: 'server',
      principalId: 'user-1',
      principalType: 'service',
      attributes: { workspaceId: 'ws-1', chatRunToken: token, chatRunCtx: '' },
    })
  })

  it('clientContext may not ride along (one-turn text the model would read)', async () => {
    for (const clientContext of [{ a: 1 }, 'ctx', ['x']]) {
      const r = await rejection(entry(send('/session/sess_HOME', { ...QUEUED, clientContext })))
      expect([r.status, r.code]).toEqual([403, 'server_send_body_forbidden'])
    }
  })

  it('leaves the body for eve to read', async () => {
    const request = send('/session/sess_HOME', QUEUED)
    await entry(request)
    expect(await request.json()).toEqual(QUEUED)
  })

  it('a home-turn token may read the stream', async () => {
    const request = new Request(`${MOUNT}/session/sess_HOME/stream?startIndex=12`, {
      method: 'GET',
      headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': tokenFor() },
    })
    expect(await entry(request)).toMatchObject({ authenticator: 'server' })
  })
})

describe('the one create: a parked session for a home thread with none', () => {
  const create = (token: string = tokenFor(), path = '/session') =>
    new Request(`${MOUNT}${path}`, { method: 'POST', headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': token } })

  it('POST /session with no body, a home-turn token for the person’s home thread → the server principal', async () => {
    const token = tokenFor()
    expect(await entry(create(token))).toEqual({
      authenticator: 'server',
      principalId: 'user-1',
      principalType: 'service',
      attributes: { workspaceId: 'ws-1', chatRunToken: token, chatRunCtx: '' },
    })
    expect(await entry(create(token, '/session/'))).toMatchObject({ authenticator: 'server' })
  })

  it('only a home-turn token creates (a plain token, idle compaction’s → 403 server_route_forbidden)', async () => {
    for (const token of [tokenFor({ server: undefined }), tokenFor({ server: 'idle_compaction' })]) {
      const r = await rejection(entry(create(token)))
      expect([r.status, r.code]).toEqual([403, 'server_route_forbidden'])
    }
  })

  it('only for a home thread that is the token’s own person’s, in its workspace (else 403 server_create_not_home)', async () => {
    for (const token of [
      tokenFor({ conversationId: 'conv-side' }),
      tokenFor({ conversationId: 'conv-gone' }),
      tokenFor({ userId: 'user-2' }),
      tokenFor({ workspaceId: 'ws-2' }),
    ]) {
      const r = await rejection(entry(create(token)))
      expect([r.status, r.code]).toEqual([403, 'server_create_not_home'])
    }
  })

  it('a wrong secret is still a 401 before anything else', async () => {
    const request = new Request(`${MOUNT}/session`, { method: 'POST', headers: { 'x-chat-run-secret': 'nope', 'x-chat-run-token': tokenFor() } })
    const r = await rejection(entry(request))
    expect(r.status).toBe(401)
  })
})

describe('refused', () => {
  it('a send without the home_turn claim (a plain token, idle compaction’s) → 403 server_route_forbidden', async () => {
    for (const token of [tokenFor({ server: undefined }), tokenFor({ server: 'idle_compaction' })]) {
      const r = await rejection(entry(send('/session/sess_HOME', QUEUED, { token })))
      expect([r.status, r.code]).toEqual([403, 'server_route_forbidden'])
    }
  })

  it('a home-turn token can’t compact', async () => {
    const r = await rejection(entry(send('/session/sess_HOME/compact', {})))
    expect([r.status, r.code]).toEqual([403, 'server_route_forbidden'])
  })

  it('a home-turn token can’t cancel, clear or reset, nor create with a message', async () => {
    for (const path of ['/session/sess_HOME/cancel', '/session/sess_HOME/clear', '/session/sess_HOME/reset', '/session/sess_HOME/']) {
      const r = await rejection(entry(send(path, QUEUED)))
      expect([path, r.code]).toEqual([path, 'server_route_forbidden'])
    }
    // A create carrying a first turn (or tool stubs) is never the server's.
    for (const body of [QUEUED, { stubs: [] }]) {
      const r = await rejection(entry(send('/session', body)))
      expect([r.status, r.code]).toEqual([403, 'server_create_body_forbidden'])
    }
  })

  it('a session that is not a home thread → 403 server_send_not_home', async () => {
    const r = await rejection(entry(send('/session/sess_SIDE', QUEUED, { token: tokenFor({ conversationId: 'conv-side' }) })))
    expect([r.status, r.code]).toEqual([403, 'server_send_not_home'])
  })

  it('another conversation’s home thread, user or workspace → 403 session_forbidden', async () => {
    for (const over of [{ conversationId: 'conv-side' }, { userId: 'user-2' }, { workspaceId: 'ws-2' }]) {
      const r = await rejection(entry(send('/session/sess_HOME', QUEUED, { token: tokenFor(over) })))
      expect(r.code).toBe('session_forbidden')
    }
    expect((await rejection(entry(send('/session/sess_NOPE', QUEUED)))).code).toBe('session_forbidden')
  })

  it.each([
    ['inputResponses (answering an approval)', { ...QUEUED, inputResponses: [{ requestId: 'r', optionId: 'approve' }] }],
    ['inputResponses alone', { inputResponses: [{ requestId: 'r', optionId: 'approve' }] }],
    ['a steer', { ...QUEUED, turnPolicy: 'steer' }],
    ['no turnPolicy', { message: QUEUED.message }],
    ['an extra key', { ...QUEUED, outputSchema: {} }],
    ['taskDeliveryPolicy', { ...QUEUED, taskDeliveryPolicy: 'x' }],
    ['a structured message', { message: [{ type: 'text', text: 'hi' }], turnPolicy: 'queue' }],
    ['an empty message', { message: '   ', turnPolicy: 'queue' }],
    ['a message too long', { message: 'x'.repeat(32_001), turnPolicy: 'queue' }],
    ['an array body', [QUEUED]],
  ])('a body with %s → 403 server_send_body_forbidden', async (_label, body) => {
    const r = await rejection(entry(send('/session/sess_HOME', body)))
    expect([r.status, r.code]).toEqual([403, 'server_send_body_forbidden'])
  })

  it('a body that is not JSON → 403 server_send_body_forbidden', async () => {
    const r = await rejection(entry(send('/session/sess_HOME', null, { raw: 'not json' })))
    expect(r.code).toBe('server_send_body_forbidden')
  })

  it('a home-turn token carrying a sealed credential, a surface or a relay does not verify', async () => {
    for (const over of [{ cred: 'sealed' }, { surface: 'device_ask' }, { teammateId: 't', relay: 'r' }]) {
      const token = tokenFor(over)
      expect(verifyChatRunClaims(token)).toBeNull()
      expect(verifyChatRunToken(token)).toBeNull()
      const r = await rejection(entry(send('/session/sess_HOME', QUEUED, { token })))
      expect(r.code).toBe('server_run_token_required')
    }
  })

  it('an unknown server principal does not verify in either verifier', async () => {
    const token = tokenFor({ server: 'root' })
    expect(verifyChatRunClaims(token)).toBeNull()
    expect(verifyChatRunToken(token)).toBeNull()
  })

  it('a wrong secret is 401', async () => {
    const request = new Request(`${MOUNT}/session/sess_HOME`, {
      method: 'POST',
      headers: { 'x-chat-run-secret': 'nope', 'x-chat-run-token': tokenFor() },
      body: JSON.stringify(QUEUED),
    })
    expect((await rejection(entry(request))).status).toBe(401)
  })
})

describe('the person’s entry refuses a server token', () => {
  it('assertTurnRunToken: a home-turn (or idle-compaction) token can’t start a turn on a person’s session', async () => {
    const session = { userId: 'user-1', workspaceId: 'ws-1' }
    for (const server of ['home_turn', 'idle_compaction']) {
      const request = new Request(`${MOUNT}/session/sess_HOME`, { method: 'POST' })
      const r = await rejection(assertTurnRunToken(request, session, tokenFor({ server })))
      expect([r.status, r.code]).toEqual([403, 'chat_run_token_required'])
    }
    // An ordinary token for the person still passes.
    await expect(
      assertTurnRunToken(new Request(`${MOUNT}/session/sess_HOME`, { method: 'POST' }), session, tokenFor({ server: undefined })),
    ).resolves.toBeUndefined()
  })
})

describe('both verifiers accept a home-turn token the app minted', () => {
  it('the claim survives both', () => {
    const token = tokenFor()
    expect(verifyChatRunToken(token)?.server).toBe('home_turn')
    expect(verifyChatRunClaims(token)?.server).toBe('home_turn')
  })
})

describe('the one answer a server turn may give: Continue on the input-budget prompt', () => {
  const CONTINUE = { inputResponses: [{ requestId: 'wrun_1:4:limit:input:40044247', optionId: 'continue' }] }

  it('a home-turn or channel-turn token may send exactly one Continue into its own home thread', async () => {
    const token = tokenFor()
    expect(await entry(send('/session/sess_HOME', CONTINUE, { token }))).toMatchObject({ authenticator: 'server', principalType: 'service' })
    const request = send('/session/sess_HOME', CONTINUE)
    await entry(request)
    expect(await request.json()).toEqual(CONTINUE)
  })

  it('never a Stop, an approval, a question, another limit, two answers, or anything riding along', async () => {
    const one = (r: Record<string, unknown>) => ({ inputResponses: [r] })
    for (const body of [
      one({ requestId: 'wrun_1:4:limit:input:40044247', optionId: 'stop' }),
      one({ requestId: 'approval-call_1', optionId: 'continue' }),
      one({ requestId: 'auq-req-1', optionId: 'continue' }),
      one({ requestId: 'wrun_1:4:limit:output:150001', optionId: 'continue' }),
      one({ requestId: 'wrun_1:4:limit:token-cost:5.01', optionId: 'continue' }),
      one({ requestId: 'wrun_1:4:limit:input:40044247', optionId: 'continue', text: 'yes' }),
      { inputResponses: [CONTINUE.inputResponses[0], CONTINUE.inputResponses[0]] },
      { ...CONTINUE, message: 'continue' },
      { ...CONTINUE, clientContext: 'ctx' },
      { ...CONTINUE, turnPolicy: 'queue' },
      { inputResponses: [] },
    ]) {
      const r = await rejection(entry(send('/session/sess_HOME', body)))
      expect([r.status, r.code]).toEqual([403, 'server_send_body_forbidden'])
    }
  })

  it('DRIFT: the body eve’s own ClientSession.respond posts is the one the check admits', async () => {
    const { Client } = await import('eve/client')
    let posted: Request | null = null
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted = new Request(typeof input === 'string' || input instanceof URL ? input : input.url, init)
      return new Response(JSON.stringify({ sessionId: 'sess_HOME' }), { status: 202, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const session = new Client({ host: 'https://eve.test' }).sessions.attach('sess_HOME', { streamIndex: 0 })
      await session.respond([{ requestId: 'wrun_1:4:limit:input:40044247', optionId: 'continue' }]).catch(() => {})
    } finally {
      globalThis.fetch = realFetch
    }
    expect(posted).not.toBeNull()
    expect(await isSessionLimitContinueBody(posted!)).toBe(true)
  })

  it('isSessionLimitContinueBody reads only that exact shape', async () => {
    const r = (body: unknown) => new Request('https://x/', { method: 'POST', body: JSON.stringify(body) })
    expect(await isSessionLimitContinueBody(r(CONTINUE))).toBe(true)
    expect(await isSessionLimitContinueBody(r(QUEUED))).toBe(false)
    expect(await isSessionLimitContinueBody(new Request('https://x/', { method: 'POST', body: 'not json' }))).toBe(false)
  })
})

describe('isQueuedServerSendBody', () => {
  it('accepts exactly the queued shape', async () => {
    const r = (body: unknown) => new Request('https://x/', { method: 'POST', body: JSON.stringify(body) })
    expect(await isQueuedServerSendBody(r(QUEUED))).toBe(true)
    expect(await isQueuedServerSendBody(r({ ...QUEUED, clientContext: 'ctx' }))).toBe(false)
    expect(await isQueuedServerSendBody(r({ ...QUEUED, inputResponses: [] }))).toBe(false)
  })
})

describe('DRIFT — the send door is eve’s message route (POST), and nothing else', () => {
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

  it('only EVE_SESSION_ROUTE_PATTERN with POST resolves to a session id', () => {
    const names = [...new Set([...routesSrc.matchAll(/(EVE_(?:SESSION|SUBAGENT)_[A-Z_]+)=`/g)].map((m) => m[1]))]
    expect(names).toContain('EVE_SESSION_ROUTE_PATTERN')
    for (const name of names) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const id = serverSendSessionId(new Request(underMount(name), { method }))
        const want = name === 'EVE_SESSION_ROUTE_PATTERN' && method === 'POST' ? 'sess_1' : null
        expect([name, method, id]).toEqual([name, method, want])
      }
    }
  })
})
