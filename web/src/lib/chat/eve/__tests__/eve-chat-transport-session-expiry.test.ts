import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClientError } from 'eve/client'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'
import { EveChatTransport, isEveSessionAuthError, jwtExpiresSoon } from '../eve-chat-transport'

/**
 * The idle-tab expiry (production, 2026-09-25): a chat tab sat ~47 min, the
 * cached Supabase JWT expired, and the next send failed with "This chat session
 * belongs to another user or workspace." — the eve channel misread the stale
 * Bearer as a workspace mismatch (fixed server-side in agents/*\/lib/auth.ts),
 * and the transport kept sending the bearer baked into its cached eve Client
 * even after refreshing the token for the mint.
 *
 * Pinned here: the eve client's bearer is resolved per request from the live
 * (refreshed) token; a token at/near exp is refreshed BEFORE use; an eve
 * refusal on the caller's credentials refreshes → re-mints → retries ONCE, and
 * a second refusal surfaces the reload copy, never the workspace wording.
 */

const RELOAD_COPY = 'Your session expired — reload the page and try again.'

/** An unsigned JWT-shaped token whose payload carries `exp` (epoch seconds). */
function jwt(expSecondsFromNow: number, sub = 'user-1'): string {
  const b64url = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, exp, nonce: Math.random() })}.sig`
}

/** eve's real ClientError, shaped like the chat-agent channel's auth failures. */
function eveAuthError(status: 401 | 403, code: string, message: string): ClientError {
  return new ClientError(status, JSON.stringify({ ok: false, code, error: message }), {
    'content-type': 'application/json',
  })
}

const evText = (delta: string) =>
  ({ type: 'message.appended', data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId: 'turn_0' } }) as unknown as HandleMessageStreamEvent
const evDone = () => ({ type: 'turn.completed', data: {} }) as unknown as HandleMessageStreamEvent

function okResponse(sessionId = 'wrun_ABC') {
  const events = [evText('hi'), evDone()]
  return {
    sessionId,
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

type Attempt = { kind: 'create' | 'send'; headers: Record<string, string> }

/**
 * A fake eve Client. `fail(attempt, index)` returns an error to throw for that
 * dispatch (or null to succeed). Every create/send is recorded with its headers.
 */
function fakeClient(fail: (a: Attempt, index: number) => Error | null) {
  const attempts: Attempt[] = []
  const run = (a: Attempt) => {
    attempts.push(a)
    const err = fail(a, attempts.length - 1)
    if (err) throw err
    return okResponse()
  }
  const send = vi.fn(async (_message: unknown, options?: { headers?: Record<string, string> }) =>
    run({ kind: 'send', headers: options?.headers ?? {} }),
  )
  const session = { send, respond: vi.fn(), cancel: vi.fn(async () => ({})), state: { sessionId: 'wrun_ABC' } }
  const create = vi.fn(async (input: { headers?: Record<string, string> }) => {
    const response = run({ kind: 'create', headers: input.headers ?? {} })
    return { response, session }
  })
  const client = { sessions: { create, attach: vi.fn(() => session) } }
  return { client, attempts, create, send }
}

function sendOpts(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'chat-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: { conversationId: 'conv-1' },
  } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

type ClientArgs = { accessToken: string | null; getBearer: () => Promise<string | null> }

/**
 * A transport over `fakeClient`, with a host whose refreshAccessToken swaps the
 * cached token (like chat-panel's ref) unless `hostUpdatesRef` is false.
 */
function setup(opts: {
  initialToken: string
  refreshTo: string | null
  fail: (a: Attempt, index: number) => Error | null
  hostUpdatesRef?: boolean
  eveSessionId?: string
}) {
  let current: string | null = opts.initialToken
  const refreshCalls: number[] = []
  const mintTokens: Array<string | null> = []
  const clientArgs: ClientArgs[] = []
  let mintSeq = 0
  const fake = fakeClient(opts.fail)
  const transport = new EveChatTransport({
    getAccessToken: () => current,
    refreshAccessToken: async () => {
      refreshCalls.push(1)
      if (opts.hostUpdatesRef !== false) current = opts.refreshTo
      return opts.refreshTo
    },
    mintRunToken: async (args) => {
      mintTokens.push(args.accessToken)
      return {
        token: `run-tok-${++mintSeq}`,
        conversationId: 'conv-1',
        ...(opts.eveSessionId ? { eveSessionId: opts.eveSessionId } : {}),
      }
    },
    registerEveSession: async () => {},
    persistTurn: async () => {},
    createClient: (args) => {
      clientArgs.push(args)
      return fake.client as never
    },
  })
  return { transport, fake, refreshCalls, mintTokens, clientArgs }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('jwtExpiresSoon', () => {
  const now = Date.now()
  it('a token past its exp → true', () => {
    expect(jwtExpiresSoon(jwt(-600), now)).toBe(true)
  })
  it('a token within the 60s margin → true', () => {
    expect(jwtExpiresSoon(jwt(30), now)).toBe(true)
  })
  it('a token far from exp → false', () => {
    expect(jwtExpiresSoon(jwt(3600), now)).toBe(false)
  })
  it('a malformed token is never reported as expiring (the server 401 path covers it)', () => {
    expect(jwtExpiresSoon('not-a-jwt', now)).toBe(false)
    expect(jwtExpiresSoon('a.b.c', now)).toBe(false)
    expect(jwtExpiresSoon('', now)).toBe(false)
    const noExp = `x.${Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64')}.y`
    expect(jwtExpiresSoon(noExp, now)).toBe(false)
  })
  it('honours a custom margin', () => {
    expect(jwtExpiresSoon(jwt(300), now, 10 * 60 * 1000)).toBe(true)
  })
})

describe('isEveSessionAuthError', () => {
  it('matches a 401 and the credential 403s; nothing else', () => {
    expect(isEveSessionAuthError(eveAuthError(401, 'session_expired', 'x'))).toBe(true)
    expect(isEveSessionAuthError(eveAuthError(401, 'unauthorized', 'x'))).toBe(true)
    expect(isEveSessionAuthError(eveAuthError(403, 'session_forbidden', 'x'))).toBe(true)
    expect(isEveSessionAuthError(eveAuthError(403, 'chat_run_token_required', 'x'))).toBe(true)
    expect(isEveSessionAuthError(eveAuthError(403, 'session_expired', 'x'))).toBe(true)
    expect(isEveSessionAuthError(eveAuthError(403, 'device_run_token_required', 'x'))).toBe(false)
    expect(isEveSessionAuthError(new ClientError(500, 'boom'))).toBe(false)
    expect(isEveSessionAuthError(new Error('network'))).toBe(false)
    expect(isEveSessionAuthError(null)).toBe(false)
  })
})

describe('EveChatTransport — the eve client bearer is resolved per request', () => {
  it('a token near exp is refreshed BEFORE the mint and before the eve request', async () => {
    const near = jwt(20)
    const fresh = jwt(3600)
    const { transport, refreshCalls, mintTokens, clientArgs } = setup({
      initialToken: near,
      refreshTo: fresh,
      fail: () => null,
    })

    await drain(await transport.sendMessages(sendOpts()))

    expect(refreshCalls).toHaveLength(1)
    expect(mintTokens).toEqual([fresh])
    expect(clientArgs[0].accessToken).toBe(fresh)
    expect(await clientArgs[0].getBearer()).toBe(fresh)
  })

  it('a token far from exp is used as-is (no refresh)', async () => {
    const live = jwt(3600)
    const { transport, refreshCalls, mintTokens, clientArgs } = setup({
      initialToken: live,
      refreshTo: jwt(7200),
      fail: () => null,
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(refreshCalls).toHaveLength(0)
    expect(mintTokens).toEqual([live])
    expect(await clientArgs[0].getBearer()).toBe(live)
  })

  it('the cached client picks up a token that expired AFTER it was created (the idle-tab case)', async () => {
    const first = jwt(3600)
    const fresh = jwt(7200)
    let current = first
    let refreshes = 0
    const fake = fakeClient(() => null)
    const clientArgs: ClientArgs[] = []
    const transport = new EveChatTransport({
      getAccessToken: () => current,
      refreshAccessToken: async () => {
        refreshes++
        current = fresh
        return fresh
      },
      mintRunToken: async () => ({ token: 'run-tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: (args) => {
        clientArgs.push(args)
        return fake.client as never
      },
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(await clientArgs[0].getBearer()).toBe(first)

    // ~an hour idle: the cached token is now past its exp.
    current = jwt(-60)
    expect(await clientArgs[0].getBearer()).toBe(fresh)
    expect(refreshes).toBe(1)
    // One client for the life of the chat — the resolver, not a rebuild, carries the new JWT.
    expect(clientArgs).toHaveLength(1)
  })

  it('concurrent requests share ONE refresh', async () => {
    const fresh = jwt(3600)
    let refreshes = 0
    let current = jwt(-60)
    const fake = fakeClient(() => null)
    const clientArgs: ClientArgs[] = []
    const transport = new EveChatTransport({
      getAccessToken: () => current,
      refreshAccessToken: async () => {
        refreshes++
        await new Promise((r) => setTimeout(r, 5))
        current = fresh
        return fresh
      },
      mintRunToken: async () => ({ token: 'run-tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: (args) => {
        clientArgs.push(args)
        return fake.client as never
      },
    })
    await drain(await transport.sendMessages(sendOpts()))
    current = jwt(-60)
    refreshes = 0
    const [a, b] = await Promise.all([clientArgs[0].getBearer(), clientArgs[0].getBearer()])
    expect(a).toBe(fresh)
    expect(b).toBe(fresh)
    expect(refreshes).toBe(1)
  })
})

describe('EveChatTransport — an eve refusal on the caller credentials refreshes, re-mints, retries once', () => {
  it('turn 2 on a live session: 403 session_forbidden (the prod symptom) → refresh → re-mint → retry → success', async () => {
    const stale = jwt(3600) // not near exp locally, but the server refuses it
    const fresh = jwt(7200)
    const { transport, fake, refreshCalls, mintTokens, clientArgs } = setup({
      initialToken: stale,
      refreshTo: fresh,
      // attempt 0 = turn 1's create (ok); attempt 1 = turn 2's send (refused); attempt 2 = the retry.
      fail: (_a, i) =>
        i === 1 ? eveAuthError(403, 'session_forbidden', 'This chat session belongs to another user or workspace.') : null,
    })

    await drain(await transport.sendMessages(sendOpts()))
    expect(await clientArgs[0].getBearer()).toBe(stale)

    const chunks = await drain(await transport.sendMessages(sendOpts()))

    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(refreshCalls).toHaveLength(1)
    // turn 1 mint, turn 2 mint (stale), then the retry's re-mint on the FRESH token.
    expect(mintTokens).toEqual([stale, stale, fresh])
    expect(fake.attempts.map((a) => a.kind)).toEqual(['create', 'send', 'send'])
    // The retry carried the re-minted run token, not the one the refused send had.
    expect(fake.attempts[1].headers['x-chat-run-token']).toBe('run-tok-2')
    expect(fake.attempts[2].headers['x-chat-run-token']).toBe('run-tok-3')
    // The (single, cached) client now authenticates with the refreshed bearer.
    expect(clientArgs).toHaveLength(1)
    expect(await clientArgs[0].getBearer()).toBe(fresh)
  })

  it('a 401 session_expired on the first create → refresh → retry once → success', async () => {
    const stale = jwt(3600)
    const fresh = jwt(7200)
    const { transport, fake, refreshCalls, mintTokens, clientArgs } = setup({
      initialToken: stale,
      refreshTo: fresh,
      fail: (_a, i) => (i === 0 ? eveAuthError(401, 'session_expired', 'Your session expired — refresh and try again.') : null),
    })
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(refreshCalls).toHaveLength(1)
    expect(mintTokens).toEqual([stale, fresh])
    expect(fake.attempts.map((a) => a.kind)).toEqual(['create', 'create'])
    expect(await clientArgs[0].getBearer()).toBe(fresh)
  })

  it('a second refusal surfaces the reload copy — never the workspace wording — and does not loop', async () => {
    const { transport, fake, refreshCalls } = setup({
      initialToken: jwt(3600),
      refreshTo: jwt(7200),
      fail: () => eveAuthError(403, 'session_forbidden', 'This chat session belongs to another user or workspace.'),
    })
    const err = await drain(await transport.sendMessages(sendOpts())).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(RELOAD_COPY)
    expect((err as Error).message).not.toMatch(/workspace/)
    expect(refreshCalls).toHaveLength(1)
    expect(fake.attempts).toHaveLength(2)
  })

  it('no refreshed token → the reload copy, no retry', async () => {
    const { transport, fake } = setup({
      initialToken: jwt(3600),
      refreshTo: null,
      fail: () => eveAuthError(401, 'session_expired', 'x'),
    })
    const err = await drain(await transport.sendMessages(sendOpts())).catch((e: unknown) => e)
    expect((err as Error).message).toBe(RELOAD_COPY)
    expect(fake.attempts).toHaveLength(1)
  })

  it('a non-credential eve error is NOT retried (surfaces as-is)', async () => {
    const { transport, fake, refreshCalls } = setup({
      initialToken: jwt(3600),
      refreshTo: jwt(7200),
      fail: () => new ClientError(500, JSON.stringify({ ok: false, code: 'internal', error: 'boom' })),
    })
    const err = await drain(await transport.sendMessages(sendOpts())).catch((e: unknown) => e)
    expect((err as Error).message).toBe('boom')
    expect(refreshCalls).toHaveLength(0)
    expect(fake.attempts).toHaveLength(1)
  })

  it('a RE-ATTACHED session refused on its credentials is retried in place, not forked into a new session', async () => {
    const fresh = jwt(7200)
    const { transport, fake } = setup({
      initialToken: jwt(3600),
      refreshTo: fresh,
      eveSessionId: 'wrun_REGISTERED',
      fail: (_a, i) => (i === 0 ? eveAuthError(401, 'session_expired', 'x') : null),
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(fake.attempts.map((a) => a.kind)).toEqual(['send', 'send'])
    expect(fake.create).not.toHaveBeenCalled()
  })

  it('a host whose getAccessToken still returns the replaced token gets the refreshed one', async () => {
    const stale = jwt(3600)
    const fresh = jwt(7200)
    const { transport, clientArgs, mintTokens } = setup({
      initialToken: stale,
      refreshTo: fresh,
      hostUpdatesRef: false,
      fail: (_a, i) => (i === 0 ? eveAuthError(401, 'session_expired', 'x') : null),
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(mintTokens).toEqual([stale, fresh])
    expect(await clientArgs[0].getBearer()).toBe(fresh)
  })
})
