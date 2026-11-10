/**
 * Cross-layer contract: the request /api/device/ask's dispatch actually sends is
 * one the chat-agent channel admits — through the session-ownership ACL, as the
 * device's own principal.
 *
 * device-ask-eve.ts builds its eve Client options (mocked Client captures them);
 * those options go through the REAL eve Client (and the REAL createTaskSession
 * for the create) so its bearer → Authorization encoding and the task-mode body
 * are exercised, not assumed; each wire Request is handed to the chat-agent's
 * REAL deviceTokenAuthWithAcl MID-RUN, while the ownership record the ask itself
 * registered is in place — and again after the ask ended. A drift in header names, eve's auth encoding or the registration
 * would fail here instead of 401/403-ing every device ask live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { MessageStreamEvent } from 'eve/client'

const SECRET = 'test-chat-internal-secret-abcdefghij'
const DEVICE_TOKEN = 'nid_the-devices-own-token'

const h = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  /** eve_session_id → owner, as written by the ask's registration (and removed by its delete). */
  registry: {} as Record<string, { id: string; user_id: string; workspace_id: string }>,
  rows: {} as Record<string, { id: string; user_id: string; workspace_id: string }>,
  /** The cookie the Supabase entry's @supabase/ssr client accepts (user-1). */
  validCookie: 'sb-test-auth-token=valid-session',
  createTaskSession: vi.fn(),
}))

vi.mock('eve/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/client')>()),
  Client: class {
    sessions = { attach: () => ({ cancel: async () => ({ status: 'accepted' }) }) }
    constructor(opts: Record<string, unknown>) {
      h.clients.push(opts)
    }
  },
}))
vi.mock('@/lib/eve/task-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/eve/task-session')>()),
  createTaskSession: h.createTaskSession,
}))

// The Next side's service client: the ask's owner row + registration + delete,
// kept in a tiny in-memory table the agent side's ownership lookup reads.
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => ({
      // The ask's membership check: user-1 is a member of ws-1.
      select: () => {
        if (table !== 'member') throw new Error(`unexpected select on ${table}`)
        const eqs: Record<string, string> = {}
        const chain: Record<string, unknown> = {
          eq: (c: string, v: string) => {
            eqs[c] = v
            return chain
          },
          maybeSingle: async () => ({
            data: eqs.user_id === 'user-1' && eqs.workspace_id === 'ws-1' ? { workspace_id: 'ws-1' } : null,
            error: null,
          }),
        }
        return chain
      },
      insert: (v: { user_id: string; workspace_id: string }) => ({
        select: () => ({
          single: async () => {
            h.rows['conv-1'] = { id: 'conv-1', user_id: v.user_id, workspace_id: v.workspace_id }
            return { data: { id: 'conv-1' }, error: null }
          },
        }),
      }),
      update: (v: { eve_session_id: string }) => {
        const chain = {
          eq: () => chain,
          then: (resolve: (x: unknown) => void) => {
            h.registry[v.eve_session_id] = h.rows['conv-1']
            resolve({ error: null, count: 1 })
          },
        }
        return chain
      },
      delete: () => {
        const chain = {
          eq: () => chain,
          then: (resolve: (x: unknown) => void) => {
            for (const k of Object.keys(h.registry)) delete h.registry[k]
            resolve({ error: null })
          },
        }
        return chain
      },
    }),
  }),
}))

// The agent side's service client (device_token + ownership lookups).
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const eqs: Record<string, string> = {}
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: string) => {
          eqs[c] = v
          return chain
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === 'device_token') {
            const ok = eqs.token_hash === createHash('sha256').update(DEVICE_TOKEN).digest('hex')
            return { data: ok ? { user_id: 'user-1', active_workspace_id: 'ws-1', expires_at: null } : null, error: null }
          }
          if (table === 'chat_conversations') return { data: h.registry[eqs.eve_session_id] ?? null, error: null }
          return { data: null, error: null }
        },
      }
      return chain
    },
  }),
}))

// The agent side's Supabase entry (@supabase/ssr): the cookie session resolves
// to user-1 only for the valid cookie; the membership check admits (user-1, ws-1).
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { getAll: () => Array<{ name: string; value: string }> } }) => {
    const cookies = opts.cookies.getAll()
    const [name, value] = h.validCookie.split('=')
    const authed = cookies.some((c) => c.name === name && c.value === value)
    return {
      auth: { getUser: async () => ({ data: { user: authed ? { id: 'user-1' } : null }, error: null }) },
      from: () => {
        const eqs: Record<string, string> = {}
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (c: string, v: string) => {
            eqs[c] = v
            return chain
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({
            data: eqs.user_id === 'user-1' && (eqs.workspace_id ?? 'ws-1') === 'ws-1' ? { workspace_id: 'ws-1' } : null,
            error: null,
          }),
        }
        return chain
      },
    }
  },
}))

import { runDeviceAskViaEve } from '../device-ask-eve'
import { verifyChatRunToken } from '../chat-run-token'
import { openRunCredential } from '../chat-run-credential'
import {
  deviceTokenAuthWithAcl,
  resolveSupabaseSession,
  isSessionOwnedByOther,
} from '../../../../agents/chat-agent/lib/auth'

const ev = (e: unknown) => e as MessageStreamEvent

/** Replays a device-ask call on the REAL eve Client built from the captured options; returns the wire Request. */
async function wireRequest(opts: Record<string, unknown>, run: (c: import('eve/client').Client) => Promise<unknown>) {
  let sent: Request | undefined
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    sent = new Request(input, init)
    return new Response(JSON.stringify({ ok: true, status: 'accepted', sessionId: 'sess-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const { Client: RealClient } = await vi.importActual<typeof import('eve/client')>('eve/client')
  await run(new RealClient(opts as never))
  return sent!
}

/**
 * The STREAM leg as task-session.ts really opens it: the real
 * `sessions.attach(id, { streamIndex: 0 }).stream({ signal })`, iterated. The
 * stubbed fetch records the wire Request and aborts, so eve's reconnect loop
 * returns instead of retrying (followStreamIterable: an aborted signal ends it).
 */
async function wireStreamRequest(opts: Record<string, unknown>) {
  const controller = new AbortController()
  let sent: Request | undefined
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    sent ??= new Request(input, init)
    controller.abort()
    throw new DOMException('aborted', 'AbortError')
  })
  const { Client: RealClient } = await vi.importActual<typeof import('eve/client')>('eve/client')
  const stream = new RealClient(opts as never).sessions.attach('sess-1', { streamIndex: 0 }).stream({ signal: controller.signal })
  try {
    for await (const _event of stream) break
  } catch {
    // an abort surfacing as a throw is fine — only the wire Request matters
  }
  return sent!
}

beforeEach(() => {
  h.clients.length = 0
  for (const k of Object.keys(h.registry)) delete h.registry[k]
  process.env.CHAT_INTERNAL_SECRET = SECRET
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('device ask → chat-agent channel (real eve Client, real channel AuthFn)', () => {
  it('create, stream and cancel are admitted as the DEVICE principal while the ask’s own registration is live — and refused after the ask ends', async () => {
    let streamRequest: Request | undefined
    let cancelRequest: Request | undefined
    let createRequest: Request | undefined
    const midRun: Record<string, unknown> = {}
    h.createTaskSession.mockImplementation(async () => ({
      sessionId: 'sess-1',
      async *[Symbol.asyncIterator]() {
        // Mid-run: the ask has registered sess-1 on its row. Replay the create
        // (through the REAL createTaskSession), the stream and the cancel on the
        // REAL Client, and run the channel's REAL AuthFn on each NOW — against
        // the registration the ask wrote, not one this test restores.
        const opts = h.clients[0]
        const { createTaskSession: realCreate } =
          await vi.importActual<typeof import('@/lib/eve/task-session')>('@/lib/eve/task-session')
        createRequest = await wireRequest(opts, (c) => realCreate(c, { message: 'q' }))
        streamRequest = await wireStreamRequest(opts)
        cancelRequest = await wireRequest(opts, (c) => c.sessions.attach('sess-1').cancel())
        const auth = deviceTokenAuthWithAcl()
        midRun.registry = { ...h.registry }
        midRun.create = await auth(createRequest.clone())
        midRun.stream = await auth(streamRequest.clone())
        midRun.cancel = await auth(cancelRequest.clone())
        yield ev({ type: 'message.completed', data: { finishReason: 'stop', message: 'ok' } })
        yield ev({ type: 'session.completed', data: {} })
      },
    }))

    await runDeviceAskViaEve({
      userId: 'user-1',
      workspaceId: 'ws-1',
      question: 'q',
      model: 'deepseek-v4-flash',
      timeoutMs: 30_000,
      credential: { bearer: DEVICE_TOKEN },
      appBaseUrl: 'https://app.test',
    })

    expect(createRequest!.url).toBe('https://app.test/eve/chat-agent/v1/session')
    expect(createRequest!.headers.get('authorization')).toBe(`Bearer ${DEVICE_TOKEN}`)
    expect(await createRequest!.clone().json()).toEqual({ message: 'q' }) // no `mode`: eve 0.67+ ignores it
    expect(cancelRequest!.url).toBe('https://app.test/eve/chat-agent/v1/session/sess-1/cancel')
    expect(new URL(streamRequest!.url).pathname).toBe('/eve/chat-agent/v1/session/sess-1/stream')

    // What the channel said DURING the run, on the ask's own registration.
    expect(midRun.registry).toEqual({ 'sess-1': { id: 'conv-1', user_id: 'user-1', workspace_id: 'ws-1' } })
    // The ask's run token rides EVERY request (the device principal is bound to it).
    const token = (midRun.create as { attributes: { chatRunToken: string } }).attributes.chatRunToken
    for (const r of [createRequest!, streamRequest!, cancelRequest!]) expect(r.headers.get('x-chat-run-token')).toBe(token)
    expect(midRun.create).toMatchObject({ authenticator: 'device', principalId: 'user-1', attributes: { workspaceId: 'ws-1' } })
    const claims = verifyChatRunToken((midRun.create as { attributes: { chatRunToken: string } }).attributes.chatRunToken)
    expect(claims).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1', surface: 'device_ask', conversationId: 'conv-1' })
    expect(midRun.stream).toMatchObject({ authenticator: 'device', principalId: 'user-1' })
    expect(midRun.cancel).toMatchObject({ authenticator: 'device', principalId: 'user-1' })

    // After the ask ended its row (and so its registration) is gone: refused.
    const auth = deviceTokenAuthWithAcl()
    expect(h.registry).toEqual({})
    await expect(auth(streamRequest!)).rejects.toThrow(/another user or workspace/)
    await expect(auth(cancelRequest!)).rejects.toThrow(/another user or workspace/)
  })

  it('the ask’s own registration is what the ACL reads (registered during the run, removed at the end)', async () => {
    const seen: Array<Record<string, unknown>> = []
    h.createTaskSession.mockImplementation(async () => ({
      sessionId: 'sess-1',
      async *[Symbol.asyncIterator]() {
        seen.push({ ...h.registry })
        yield ev({ type: 'session.completed', data: {} })
      },
    }))
    await runDeviceAskViaEve({
      userId: 'user-1',
      workspaceId: 'ws-1',
      question: 'q',
      model: 'm',
      timeoutMs: 30_000,
      credential: { bearer: DEVICE_TOKEN },
      appBaseUrl: 'https://app.test',
    })
    expect(seen).toEqual([{ 'sess-1': { id: 'conv-1', user_id: 'user-1', workspace_id: 'ws-1' } }])
    expect(h.registry).toEqual({})
  })

  it('a COOKIE caller: the real Client puts the cookie (and no Authorization) on the wire, and the Supabase entry + ACL admit it on the ask’s own registration — refused after the ask ends', async () => {
    let streamRequest: Request | undefined
    let cancelRequest: Request | undefined
    let createRequest: Request | undefined
    const midRun: Record<string, unknown> = {}
    h.createTaskSession.mockImplementation(async () => ({
      sessionId: 'sess-1',
      async *[Symbol.asyncIterator]() {
        const opts = h.clients[0]
        const { createTaskSession: realCreate } =
          await vi.importActual<typeof import('@/lib/eve/task-session')>('@/lib/eve/task-session')
        createRequest = await wireRequest(opts, (c) => realCreate(c, { message: 'q' }))
        streamRequest = await wireStreamRequest(opts)
        cancelRequest = await wireRequest(opts, (c) => c.sessions.attach('sess-1').cancel())
        for (const [k, r] of [
          ['create', createRequest],
          ['stream', streamRequest],
          ['cancel', cancelRequest],
        ] as const) {
          const session = await resolveSupabaseSession(r.clone())
          midRun[k] = session
          midRun[`${k}Foreign`] = session ? await isSessionOwnedByOther(r.clone(), session.userId, session.workspaceId) : null
        }
        yield ev({ type: 'session.completed', data: {} })
      },
    }))

    await runDeviceAskViaEve({
      userId: 'user-1',
      workspaceId: 'ws-1',
      question: 'q',
      model: 'm',
      timeoutMs: 30_000,
      credential: { cookie: h.validCookie },
      appBaseUrl: 'https://app.test',
    })

    for (const r of [createRequest!, streamRequest!, cancelRequest!]) {
      expect(r.headers.get('cookie')).toBe(h.validCookie)
      expect(r.headers.get('authorization')).toBeNull()
      expect(r.headers.get('x-workspace-id')).toBe('ws-1')
    }
    // The cookie principal, in the ask's workspace, owning its own registration.
    for (const k of ['create', 'stream', 'cancel']) {
      expect(midRun[k]).toEqual({ userId: 'user-1', workspaceId: 'ws-1' })
      expect(midRun[`${k}Foreign`]).toBe(false)
    }
    // A cookie never walks into the device entry.
    expect(await deviceTokenAuthWithAcl()(streamRequest!.clone())).toBeNull()

    // After the ask ended: the registration is gone, the ACL refuses the session.
    expect(h.registry).toEqual({})
    expect(await isSessionOwnedByOther(streamRequest!.clone(), 'user-1', 'ws-1')).toBe(true)
    expect(await isSessionOwnedByOther(cancelRequest!.clone(), 'user-1', 'ws-1')).toBe(true)
  })

  it('a JWT caller: the run token carrying the SEALED caller JWT (realistic size) rides create, stream and cancel byte-identical and still opens', async () => {
    // A Supabase access token is ~1 KB (claims + app/user metadata + amr).
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        role: 'authenticated',
        aud: 'authenticated',
        email: 'someone@example.com',
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { full_name: 'Some One', avatar_url: `https://lh3.googleusercontent.com/a/${'x'.repeat(300)}` },
        amr: [{ method: 'oauth', timestamp: 1 }],
        session_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      }),
    ).toString('base64url')
    const jwt = `eyJhbGciOiJIUzI1NiIsImtpZCI6ImFiYyIsInR5cCI6IkpXVCJ9.${payload}.${'s'.repeat(43)}`
    const wire: Request[] = []
    h.createTaskSession.mockImplementation(async () => ({
      sessionId: 'sess-1',
      async *[Symbol.asyncIterator]() {
        const opts = h.clients[0]
        const { createTaskSession: realCreate } =
          await vi.importActual<typeof import('@/lib/eve/task-session')>('@/lib/eve/task-session')
        wire.push(await wireRequest(opts, (c) => realCreate(c, { message: 'q' })))
        wire.push(await wireStreamRequest(opts))
        wire.push(await wireRequest(opts, (c) => c.sessions.attach('sess-1').cancel()))
        yield ev({ type: 'session.completed', data: {} })
      },
    }))

    await runDeviceAskViaEve({
      userId: 'user-1',
      workspaceId: 'ws-1',
      question: 'q',
      model: 'm',
      timeoutMs: 30_000,
      credential: { bearer: jwt },
      appBaseUrl: 'https://app.test',
    })

    expect(wire).toHaveLength(3)
    const token = wire[0].headers.get('x-chat-run-token')!
    expect(token.length).toBeGreaterThan(1500)
    for (const r of wire) {
      expect(r.headers.get('x-chat-run-token')).toBe(token)
      expect(r.headers.get('authorization')).toBe(`Bearer ${jwt}`)
    }
    const claims = verifyChatRunToken(token)
    expect(claims).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1', surface: 'device_ask', conversationId: 'conv-1' })
    expect(typeof claims!.cred).toBe('string')
    expect(openRunCredential(claims!.cred!, claims!)).toBe(jwt)
  })
})
