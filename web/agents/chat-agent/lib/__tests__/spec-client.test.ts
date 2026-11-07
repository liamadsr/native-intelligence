import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchChatSkills,
  fetchChatSpec,
  fetchChatSpecResult,
  dispatchChatTool,
  dispatchRetryNote,
  isCheckInRunToken,
  isRetryableSpecFailure,
  isRetryableUsageStatus,
  modelSelectionFromSpec,
  postChatMemory,
  reportTurnUsage,
  USAGE_REPORT_TIMEOUT_MS,
  probeChatRunLive,
  resetSpecMemoForTests,
  runTokenFromAuth,
  surfaceFromRunToken,
  teammateFromRunToken,
  turnCtxFromAuth,
  validGatewayTelemetry,
  validModelPolicy,
  type ChatModelPolicy,
  type ChatSpec,
} from '../spec-client'
import type { SessionAuth } from 'eve/context'
import { CHAT_COMPACTION_WINDOW_TOKENS, chatCompactionWindow } from '../compaction-window'

/**
 * The spec-client is the ONLY thing the chat-agent eve runtime uses to reach the
 * Next app (separate service). These tests pin: the auth-attribute readers, the
 * spec fetch (headers, ctx param, graceful null on failure), and the tool
 * dispatch (structured error passthrough so the model can adapt).
 */

const SECRET = 'chat-internal-secret-abc'

function mockAuth(attrs: Record<string, unknown>): SessionAuth {
  return { current: { attributes: attrs } } as unknown as SessionAuth
}

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  resetSpecMemoForTests()
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
  delete process.env.NEXT_PUBLIC_APP_URL
  vi.restoreAllMocks()
})

describe('runTokenFromAuth / turnCtxFromAuth', () => {
  it('reads the chat-run token + per-turn ctx off the principal attributes', () => {
    const auth = mockAuth({ chatRunToken: 'tok.sig', chatRunCtx: 'Y3R4' })
    expect(runTokenFromAuth(auth)).toBe('tok.sig')
    expect(turnCtxFromAuth(auth)).toBe('Y3R4')
  })
  it('returns empty string when absent or non-string', () => {
    expect(runTokenFromAuth(mockAuth({}))).toBe('')
    expect(turnCtxFromAuth(mockAuth({ chatRunCtx: 123 }))).toBe('')
  })
})

describe('fetchChatSpec', () => {
  const spec: ChatSpec = {
    systemPrompt: 'layered prompt',
    model: 'claude-haiku-4-5',
    ceiling: ['create_action', 'ask_user'],
    ceilingTools: [
      { name: 'create_action', description: 'Create an action.' },
      { name: 'ask_user', description: 'Ask the user.' },
    ],
    coreToolNames: ['create_action'],
  }

  it('returns null immediately for an empty run token (no fetch)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    expect(await fetchChatSpec('', 'ctx')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('GETs the spec route with the secret + token headers and the ctx query param', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(spec), { status: 200 }),
    )
    const got = await fetchChatSpec('tok.sig', 'ENC_CTX')
    expect(got).toEqual(spec)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    // Always the superset variant: the one fetch serves every resolver.
    expect(url).toBe('https://app.test/api/internal/chat/spec?skills=1&schemas=1&turnContext=1&ctx=ENC_CTX')
    const headers = init.headers as Record<string, string>
    expect(headers['x-chat-run-secret']).toBe(SECRET)
    expect(headers['x-chat-run-token']).toBe('tok.sig')
    expect(init.method).toBe('GET')
  })

  it('omits the ctx query param when there is no per-turn ctx', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(spec), { status: 200 }),
    )
    await fetchChatSpec('tok.sig', '')
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe('https://app.test/api/internal/chat/spec?skills=1&schemas=1&turnContext=1')
  })

  it('returns null (degrade, not crash) on a non-OK response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }))
    expect(await fetchChatSpec('tok.sig', 'c')).toBeNull()
  })

  it('returns null on a network throw', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await fetchChatSpec('tok.sig', 'c')).toBeNull()
  })

  // The wrapper contract must stay IDENTICAL after the fetchChatSpecResult
  // refactor: spec on 200, null on every failure — including the new billing
  // statuses. The usage-limit gate reads the richer result; every existing
  // resolver caller still only ever sees spec | null.
  it('returns null on a 429 (usage limit) — wrapper collapses the billing block', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 }),
    )
    expect(await fetchChatSpec('tok.sig', 'c')).toBeNull()
  })

  it('returns null on a 503 BILLING_UNAVAILABLE — wrapper collapses it too', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Usage check unavailable', code: 'BILLING_UNAVAILABLE' }), {
        status: 503,
      }),
    )
    expect(await fetchChatSpec('tok.sig', 'c')).toBeNull()
  })
})

describe('fetchChatSpecResult (discriminated outcome — powers the usage-limit gate)', () => {
  const spec: ChatSpec = {
    systemPrompt: 'layered prompt',
    model: 'claude-haiku-4-5',
    ceiling: null,
    ceilingTools: [],
    coreToolNames: [],
  }

  it('returns { ok:true, spec } on a 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(spec), { status: 200 }),
    )
    const result = await fetchChatSpecResult('tok.sig', 'ENC_CTX')
    expect(result).toEqual({ ok: true, spec })
  })

  it('returns { ok:false, status:429, body:<parsed> } with the usage-limit JSON body', async () => {
    const body = {
      error: 'Usage limit exceeded',
      reason: 'monthly allowance reached',
      plan: 'free',
      isPaidPlan: false,
      usageResetDate: '2026-08-01',
      creditBalanceUsd: 0,
    }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 429 }),
    )
    const result = await fetchChatSpecResult('tok.sig', 'c')
    expect(result).toEqual({ ok: false, status: 429, body })
  })

  it('returns { ok:false, status:503, body:<BILLING_UNAVAILABLE> } parsed', async () => {
    const body = { error: 'Usage check unavailable', code: 'BILLING_UNAVAILABLE' }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 503 }),
    )
    const result = await fetchChatSpecResult('tok.sig', 'c')
    expect(result).toEqual({ ok: false, status: 503, body })
  })

  it('returns body:null when a non-OK response is not JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('plain text', { status: 500 }))
    const result = await fetchChatSpecResult('tok.sig', 'c')
    expect(result).toEqual({ ok: false, status: 500, body: null })
  })

  it("returns { ok:false, status:'network' } when the fetch throws", async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'))
    const result = await fetchChatSpecResult('tok.sig', 'c')
    expect(result).toEqual({ ok: false, status: 'network' })
  })

  it("returns { ok:false, status:'no-token' } for an empty run token (no fetch)", async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await fetchChatSpecResult('', 'c')
    expect(result).toEqual({ ok: false, status: 'no-token' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('one spec fetch per turn (the memo)', () => {
  const spec: ChatSpec = {
    systemPrompt: 'layered prompt',
    model: 'deepseek/deepseek-v4-flash',
    ceiling: null,
    ceilingTools: [{ name: 'find', description: 'Find.', inputSchema: { type: 'object' } }],
    coreToolNames: ['find'],
    skills: [{ name: 'recap', description: 'Weekly recap.', markdown: 'RECAP' }],
  }
  const ok = () => new Response(JSON.stringify(spec), { status: 200 })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('every reader shares one fetch for the same token + ctx, whatever variant it asks for', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => ok())
    const [result, forModel, forPersona, forTools] = await Promise.all([
      fetchChatSpecResult('tok.sig', 'CTX'), // the usage gate
      fetchChatSpec('tok.sig', 'CTX'), // the model resolver
      fetchChatSpec('tok.sig', 'CTX', { skills: true, turnContext: true }), // the persona and the turn context
      fetchChatSpec('tok.sig', 'CTX', { schemas: true }), // the tools resolver
    ])
    // search_tools, and a later step on this instance.
    const later = await fetchChatSpec('tok.sig', 'CTX')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://app.test/api/internal/chat/spec?skills=1&schemas=1&turnContext=1&ctx=CTX')
    expect(result).toEqual({ ok: true, spec })
    for (const got of [forModel, forPersona, forTools, later]) expect(got).toEqual(spec)
  })

  it('load_skill bypasses the memo: a skill created mid-turn loads, and the memo is untouched', async () => {
    const created = { name: 'weekly-report', description: 'Weekly report.', markdown: 'WEEKLY' }
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementationOnce(async () => ok())
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ...spec, skills: [...spec.skills!, created] })))
    // turn.started: the memo holds the turn-start spec.
    expect(await fetchChatSpec('tok.sig', 'CTX')).toEqual(spec)
    // create_skill ran; load_skill fetches its own skills variant, no schemas.
    expect(await fetchChatSkills('tok.sig', 'CTX')).toEqual([...spec.skills!, created])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1][0]).toBe('https://app.test/api/internal/chat/spec?skills=1&ctx=CTX')
    // The per-turn memo still serves the turn-start spec, with no new fetch.
    expect(await fetchChatSpec('tok.sig', 'CTX')).toEqual(spec)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('load_skill with no token never fetches', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    expect(await fetchChatSkills('', 'CTX')).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a different ctx or token is a different fetch', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => ok())
    await fetchChatSpec('tok.sig', 'CTX-1')
    await fetchChatSpec('tok.sig', 'CTX-2')
    await fetchChatSpec('tok2.sig', 'CTX-1')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('never keeps a failure: the next caller fetches again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 }))
      // A network failure is tried once more (fetchChatSpecWithRetry): both tries fail here.
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => ok())
    expect(await fetchChatSpecResult('tok.sig', 'CTX')).toMatchObject({ ok: false, status: 429 })
    expect(await fetchChatSpecResult('tok.sig', 'CTX')).toEqual({ ok: false, status: 'network' })
    expect(await fetchChatSpecResult('tok.sig', 'CTX')).toEqual({ ok: true, spec })
    expect(await fetchChatSpecResult('tok.sig', 'CTX')).toEqual({ ok: true, spec })
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('refetches once the memo is a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-30T12:00:00Z') })
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => ok())
    await fetchChatSpec('tok.sig', 'CTX')
    vi.setSystemTime(new Date('2026-09-30T12:00:59Z'))
    await fetchChatSpec('tok.sig', 'CTX')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-09-30T12:01:00Z'))
    await fetchChatSpec('tok.sig', 'CTX')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps at most 64 turns, dropping the oldest', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => ok())
    for (let i = 0; i <= 64; i++) await fetchChatSpec(`tok-${i}.sig`, 'CTX')
    expect(fetchSpy).toHaveBeenCalledTimes(65)
    await fetchChatSpec('tok-64.sig', 'CTX') // newest: kept
    expect(fetchSpy).toHaveBeenCalledTimes(65)
    await fetchChatSpec('tok-0.sig', 'CTX') // oldest: dropped
    expect(fetchSpy).toHaveBeenCalledTimes(66)
  })

  it('no token never fetches and is never memoized', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    expect(await fetchChatSpecResult('', 'CTX')).toEqual({ ok: false, status: 'no-token' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the ?live=1 probe is never memoized', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ live: true }), { status: 200 }))
    await probeChatRunLive('tok.sig')
    await probeChatRunLive('tok.sig')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

// A turn without its spec runs blind (no prompt, no tools, no turn context):
// 2026-10-16 DEV, one answered "what's this?" about a card it never heard of.
// A failure that may pass is tried once more; an answer never is.
describe('the spec fetch retries once (fetchChatSpecWithRetry)', () => {
  const spec: ChatSpec = { systemPrompt: 'p', model: 'm', ceiling: null, ceilingTools: [], coreToolNames: [] }
  const ok = () => new Response(JSON.stringify(spec), { status: 200 })

  it.each([
    ['a network throw', () => Promise.reject(new Error('offline'))],
    ['a 404 (a dev server still compiling the route)', () => Promise.resolve(new Response('<html>', { status: 404 }))],
    ['a 500 rebuild failure', () => Promise.resolve(new Response(JSON.stringify({ code: 'CHAT_SPEC_REBUILD_FAILED' }), { status: 500 }))],
    ['a platform 503', () => Promise.resolve(new Response('busy', { status: 503 }))],
  ])('%s, then the spec: the turn gets it', async (_name, fail) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementationOnce(fail as () => Promise<Response>).mockImplementation(async () => ok())
    expect(await fetchChatSpecResult('tok.sig', 'CTX')).toEqual({ ok: true, spec })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a 401', 401, { error: 'invalid or expired run token' }],
    ['a 403', 403, { code: 'SURFACE_RUN_ENDED' }],
    ['the usage limit (429)', 429, { error: 'Usage limit exceeded' }],
    ['the billing check (503 BILLING_UNAVAILABLE)', 503, { code: 'BILLING_UNAVAILABLE' }],
  ])('never retries %s: the gate reads it as it is', async (_name, status, body) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))
    expect(await fetchChatSpecResult('tok.sig', 'CTX')).toEqual({ ok: false, status, body })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a second failure is the result: once, never more', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('down', { status: 502 }))
    expect(await fetchChatSpecResult('tok.sig', 'CTX')).toEqual({ ok: false, status: 502, body: null })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('isRetryableSpecFailure', () => {
    expect(isRetryableSpecFailure({ ok: true, spec })).toBe(false)
    expect(isRetryableSpecFailure({ ok: false, status: 'network' })).toBe(true)
    expect(isRetryableSpecFailure({ ok: false, status: 'no-token' })).toBe(false)
    expect(isRetryableSpecFailure({ ok: false, status: 504, body: null })).toBe(true)
    expect(isRetryableSpecFailure({ ok: false, status: 503, body: { code: 'BILLING_UNAVAILABLE' } })).toBe(false)
    expect(isRetryableSpecFailure({ ok: false, status: 400, body: null })).toBe(false)
  })
})

describe('surfaceFromRunToken (unverified routing hint for the per-step liveness gate)', () => {
  const tok = (p: unknown) => `${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}.sig`
  it('reads the surface claim of a device-ask token', () => {
    expect(surfaceFromRunToken(tok({ conversationId: 'c', surface: 'device_ask' }))).toBe('device_ask')
  })
  it('undefined for a browser token, a non-string surface, and anything malformed', () => {
    expect(surfaceFromRunToken(tok({ conversationId: 'c' }))).toBeUndefined()
    expect(surfaceFromRunToken(tok({ surface: 7 }))).toBeUndefined()
    expect(surfaceFromRunToken('tok.sig')).toBeUndefined()
    expect(surfaceFromRunToken('no-dot')).toBeUndefined()
    expect(surfaceFromRunToken('')).toBeUndefined()
  })
})

describe('isCheckInRunToken (unverified routing hint: the check-in’s session has no web)', () => {
  const tok = (p: unknown) => `${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}.sig`
  it('true only for a home turn’s token minted for reason check_in', () => {
    expect(isCheckInRunToken(tok({ conversationId: 'c', server: 'home_turn', homeTurnReason: 'check_in' }))).toBe(true)
    expect(isCheckInRunToken(tok({ conversationId: 'c', server: 'home_turn', homeTurnReason: 'event' }))).toBe(false)
    expect(isCheckInRunToken(tok({ conversationId: 'c', homeTurnReason: 'check_in' }))).toBe(false)
    expect(isCheckInRunToken(tok({ conversationId: 'c', server: 'channel_turn', homeTurnReason: 'check_in' }))).toBe(false)
    expect(isCheckInRunToken('tok.sig')).toBe(false)
    expect(isCheckInRunToken('no-dot')).toBe(false)
    expect(isCheckInRunToken('')).toBe(false)
  })
})

describe('teammateFromRunToken (unverified routing hint: a teammate chat has no picker)', () => {
  const tok = (p: unknown) => `${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}.sig`
  it('reads the teammateId claim of a teammate-chat token', () => {
    expect(teammateFromRunToken(tok({ conversationId: 'c', teammateId: 'tm-1' }))).toBe('tm-1')
  })
  it('undefined for an ordinary token, an empty or non-string id, and anything malformed', () => {
    expect(teammateFromRunToken(tok({ conversationId: 'c' }))).toBeUndefined()
    expect(teammateFromRunToken(tok({ teammateId: '' }))).toBeUndefined()
    expect(teammateFromRunToken(tok({ teammateId: 7 }))).toBeUndefined()
    expect(teammateFromRunToken('tok.sig')).toBeUndefined()
    expect(teammateFromRunToken('no-dot')).toBeUndefined()
    expect(teammateFromRunToken('')).toBeUndefined()
  })
})

describe('probeChatRunLive (GET /spec?live=1 — gates only, no rebuild)', () => {
  it('calls ?live=1 with the secret + token headers and returns ok on a 200', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ live: true }), { status: 200 }))
    expect(await probeChatRunLive('tok.sig')).toEqual({ ok: true })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.test/api/internal/chat/spec?live=1')
    const headers = init.headers as Record<string, string>
    expect(headers['x-chat-run-secret']).toBe(SECRET)
    expect(headers['x-chat-run-token']).toBe('tok.sig')
    expect(init.redirect).toBe('error')
  })
  it('returns the status + parsed body on a 403 SURFACE_RUN_ENDED', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'this run has ended', code: 'SURFACE_RUN_ENDED' }), { status: 403 }),
    )
    expect(await probeChatRunLive('tok.sig')).toEqual({
      ok: false,
      status: 403,
      body: { error: 'this run has ended', code: 'SURFACE_RUN_ENDED' },
    })
  })
  it("'network' when fetch throws, 'no-token' without a token (never fetches)", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await probeChatRunLive('tok.sig')).toEqual({ ok: false, status: 'network' })
    fetchSpy.mockClear()
    expect(await probeChatRunLive('')).toEqual({ ok: false, status: 'no-token' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('dispatchChatTool', () => {
  it('forwards the runtime call, turn and session ids outside the model input for durable admission', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: { status: 'started' } })))
    await dispatchChatTool('start_helper', 'tok.sig', { role: 'writer' }, 'runtime-call', 'runtime-turn', 'runtime-session')
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ toolName: 'start_helper', input: { role: 'writer' }, callId: 'runtime-call', turnId: 'runtime-turn', sessionId: 'runtime-session' })
    await dispatchChatTool('create_action', 'tok.sig', { title: 'x' }, 'runtime-call')
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)).toEqual({ toolName: 'create_action', input: { title: 'x' }, callId: 'runtime-call' })
  })

  it('a search carries its scope in the model\'s own input: nothing rides beside it', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: {} })))
    const input = { query: 'q', all_time: true, include_transcripts: true, types: ['captures', 'attachments'] }
    await dispatchChatTool('deep_search', 'tok.sig', input, 'c')
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ toolName: 'deep_search', input, callId: 'c' })
  })

  it("sends the browser's zone beside the call when it is given", async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: {} })))
    await dispatchChatTool('show', 'tok.sig', {}, 'c', undefined, undefined, { timeZone: 'America/New_York' })
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ toolName: 'show', input: {}, callId: 'c', timeZone: 'America/New_York' })
  })

  it("sends the turn's cards beside read_card's input as a list, and nothing when they do not parse", async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: {} })))
    const cards = [{ n: 1, id: 'call_1', kind: 'list', title: 'Mine', entity: 'action', cur: { filters: [] } }]
    await dispatchChatTool('read_card', 'tok.sig', {}, 'c', undefined, undefined, { cards: JSON.stringify(cards) })
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ toolName: 'read_card', input: {}, callId: 'c', cards })
    await dispatchChatTool('read_card', 'tok.sig', {}, 'c', undefined, undefined, { cards: '[oops' })
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)).toEqual({ toolName: 'read_card', input: {}, callId: 'c' })
  })

  // Failures THROW (not return-an-error-object): eve converts a thrown execute
  // into an isError tool result, which is what flips the UI chip to the red
  // Error state and puts the message in front of the model. The old contract
  // returned { error, code } — every failure rendered as a green "Done".
  it('refuses (no fetch, throws) when the run token is empty', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    await expect(dispatchChatTool('create_action', '', { title: 'x' })).rejects.toThrow(
      /create_action.*no run token.*NO_RUN_TOKEN/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs { toolName, input } with the secret + token and returns output', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: { id: 'ACT-1' } }), { status: 200 }),
    )
    const out = await dispatchChatTool('create_action', 'tok.sig', { title: 'Ship it' })
    expect(out).toEqual({ id: 'ACT-1' })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.test/api/internal/chat/tool')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['x-chat-run-secret']).toBe(SECRET)
    expect(headers['x-chat-run-token']).toBe('tok.sig')
    expect(JSON.parse(init.body as string)).toEqual({
      toolName: 'create_action',
      input: { title: 'Ship it' },
    })
  })

  it('throws the route error + code (e.g. TOOL_OUT_OF_CEILING) so eve marks the result isError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not in ceiling', code: 'TOOL_OUT_OF_CEILING' }), {
        status: 403,
      }),
    )
    await expect(dispatchChatTool('delete_action', 'tok.sig', {})).rejects.toThrow(
      'delete_action: not in ceiling [TOOL_OUT_OF_CEILING]',
    )
  })

  it('carries the Zod details on INPUT_INVALID so the model can self-correct', async () => {
    // The verified prod failure mode: without `details` the model saw a bare
    // INPUT_INVALID and had no way to know which field/shape was wrong.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'input failed tool schema validation',
          code: 'INPUT_INVALID',
          details: 'ZodError: types: Invalid input: expected array, received string',
        }),
        { status: 400 },
      ),
    )
    await expect(dispatchChatTool('find', 'tok.sig', { types: '["capture"]' })).rejects.toThrow(
      'find: input failed tool schema validation [INPUT_INVALID] — ZodError: types: Invalid input: expected array, received string',
    )
  })

  it('throws a model-readable error on a network throw', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'))
    await expect(dispatchChatTool('create_action', 'tok.sig', {})).rejects.toThrow(
      /create_action.*failed to reach the workspace.*offline/,
    )
  })

  it('does not instruct replay of a browser task whose dispatch outcome is unknown', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connection lost'))
    const error = await dispatchChatTool('run_browser_task', 'tok.sig', {}).catch(error => error as Error)
    expect((error as Error).message).toContain('browser task may already be running')
    expect((error as Error).message).toContain('Do not automatically resubmit')
    expect((error as Error).message).not.toContain('You may retry once')
    await expect(dispatchChatTool('find', 'tok.sig', {})).rejects.toThrow('You may retry once')
  })

  it('never invites a resubmit of start_helper or send_bot_message whose dispatch outcome is unknown (bots-v4 A3)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connection lost'))
    const delegated = (await dispatchChatTool('start_helper', 'tok.sig', {}, 'c', 't', 's').catch((e) => e)) as Error
    expect(delegated.message).toContain('Do not call start_helper again')
    expect(delegated.message).not.toContain('You may retry once')
    const relayed = (await dispatchChatTool('send_bot_message', 'tok.sig', {}, 'c', 't', 's').catch((e) => e)) as Error
    expect(relayed.message).toContain('the agent may already have the message. Do not send it again')
    expect(relayed.message).not.toContain('You may retry once')
    // wait_for_bot_reply only reads: retrying it is fine.
    expect(dispatchRetryNote('wait_for_bot_reply')).toBe('You may retry once.')
    expect(dispatchRetryNote('__proto__')).toBe('You may retry once.')
  })

  it('a gateway timeout (no answer from the route) on send_bot_message says delivery is unknown; a route refusal does not', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('upstream timed out', { status: 504 }))
    const timedOut = (await dispatchChatTool('send_bot_message', 'tok.sig', {}, 'c', 't', 's').catch((e) => e)) as Error
    expect(timedOut.message).toBe(
      "send_bot_message: tool dispatch failed (504) Delivery is unknown and the agent may already have the message. Do not send it again: tell the person it may have reached the agent, and offer to check the agent's chat.",
    )
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: 'only the main chat can message an agent', code: 'RELAY_NOT_ALLOWED' }), { status: 403 }))
    const refused = (await dispatchChatTool('send_bot_message', 'tok.sig', {}, 'c', 't', 's').catch((e) => e)) as Error
    expect(refused.message).toBe('send_bot_message: only the main chat can message an agent [RELAY_NOT_ALLOWED]')
  })
})

describe('modelSelectionFromSpec (the per-turn model resolver mapping)', () => {
  function spec(over: Partial<ChatSpec> = {}): ChatSpec {
    return {
      systemPrompt: 'p',
      model: 'anthropic/claude-haiku-4-5-20251001',
      ceiling: null,
      ceilingTools: [],
      coreToolNames: [],
      ...over,
    }
  }

  it('passes a provider-qualified id through verbatim (Kimi reaches moonshotai, not anthropic)', () => {
    expect(modelSelectionFromSpec(spec({ model: 'anthropic/claude-haiku-4.5' }))).toEqual({ model: 'anthropic/claude-haiku-4.5', modelContextWindowTokens: 200_000 })
    expect(modelSelectionFromSpec(spec({ model: 'acme/mystery-1' }))).toBe('acme/mystery-1')
  })

  it('applies the chat compaction window to every known model, even with no policy window: its real window, capped at 250K', () => {
    expect(modelSelectionFromSpec(spec({ model: 'anthropic/claude-sonnet-5.5' }))).toEqual({ model: 'anthropic/claude-sonnet-5.5', modelContextWindowTokens: 250_000 })
    expect(modelSelectionFromSpec(spec({ model: 'anthropic/claude-sonnet-4.5' }))).toEqual({ model: 'anthropic/claude-sonnet-4.5', modelContextWindowTokens: 200_000 })
    expect(modelSelectionFromSpec(spec({ model: 'deepseek/deepseek-v4-flash', modelPolicy: { reasoning: 'none' } }))).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'none',
      modelContextWindowTokens: 250_000,
    })
  })

  it('prefixes anthropic/ to a BARE id (defense-in-depth if an older Next sends one)', () => {
    expect(modelSelectionFromSpec(spec({ model: 'claude-haiku-4-5-20251001' }))).toBe(
      'anthropic/claude-haiku-4-5-20251001',
    )
  })

  it('returns the OBJECT selection form when valid gateway telemetry is present', () => {
    const out = modelSelectionFromSpec(
      spec({
        model: 'acme/mystery-1',
        gatewayTelemetry: { user: 'user-9', tags: ['feature:ai_chat', 'runtime:eve'] },
      }),
    )
    expect(out).toEqual({
      model: 'acme/mystery-1',
      modelOptions: { providerOptions: { gateway: { user: 'user-9', tags: ['feature:ai_chat', 'runtime:eve'] } } },
    })
  })

  it('falls back to the plain string when telemetry is malformed (never crash the resolver)', () => {
    // A malformed telemetry object must degrade to the plain model string, not
    // ride a model selection eve would reject.
    const out = modelSelectionFromSpec(
      spec({ model: 'acme/mystery-1', gatewayTelemetry: { tags: 'not-an-array' } as never }),
    )
    expect(out).toBe('acme/mystery-1')
  })

  it('returns null when the spec is null or carries no model (resolver then throws → fallback)', () => {
    expect(modelSelectionFromSpec(null)).toBeNull()
    expect(modelSelectionFromSpec(spec({ model: '' }))).toBeNull()
  })

  // The shape the Next side sends for DeepSeek (CHAT_MODEL_POLICY in
  // src/lib/ai/models.ts): thinking off in both encodings, routing, window.
  const DEEPSEEK_POLICY: ChatModelPolicy = {
    contextWindowTokens: 1_000_000,
    reasoning: 'none',
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    gateway: { only: ['baseten', 'alibaba'], sort: 'ttft' },
  }

  it('a DeepSeek policy adds reasoning, the window and the provider options, with routing merged under gateway beside the telemetry', () => {
    const out = modelSelectionFromSpec(
      spec({
        model: 'deepseek/deepseek-v4-pro',
        gatewayTelemetry: { user: 'user-9', tags: ['feature:ai_chat', 'runtime:eve'] },
        modelPolicy: DEEPSEEK_POLICY,
      }),
    )
    expect(out).toEqual({
      model: 'deepseek/deepseek-v4-pro',
      reasoning: 'none',
      modelContextWindowTokens: 250_000,
      modelOptions: {
        providerOptions: {
          deepseek: { thinking: { type: 'disabled' } },
          gateway: {
            user: 'user-9',
            tags: ['feature:ai_chat', 'runtime:eve'],
            only: ['baseten', 'alibaba'],
            sort: 'ttft',
          },
        },
      },
    })
  })

  it('a policy without telemetry (tagging off) still routes: gateway carries only the routing', () => {
    expect(modelSelectionFromSpec(spec({ model: 'deepseek/deepseek-v4-pro', modelPolicy: DEEPSEEK_POLICY }))).toEqual({
      model: 'deepseek/deepseek-v4-pro',
      reasoning: 'none',
      modelContextWindowTokens: 250_000,
      modelOptions: {
        providerOptions: {
          deepseek: { thinking: { type: 'disabled' } },
          gateway: { only: ['baseten', 'alibaba'], sort: 'ttft' },
        },
      },
    })
  })

  it('a window-only policy (Claude, Kimi) adds just modelContextWindowTokens; no empty modelOptions', () => {
    expect(
      modelSelectionFromSpec(spec({ model: 'anthropic/claude-haiku-4.5', modelPolicy: { contextWindowTokens: 200_000 } })),
    ).toEqual({ model: 'anthropic/claude-haiku-4.5', modelContextWindowTokens: 200_000 })
    expect(
      modelSelectionFromSpec(
        spec({
          model: 'anthropic/claude-sonnet-5.5',
          gatewayTelemetry: { tags: ['feature:ai_chat'] },
          modelPolicy: { contextWindowTokens: 1_000_000 },
        }),
      ),
    ).toEqual({
      model: 'anthropic/claude-sonnet-5.5',
      modelContextWindowTokens: 250_000,
      modelOptions: { providerOptions: { gateway: { tags: ['feature:ai_chat'] } } },
    })
  })

  it.each([
    ['1M', 1_000_000, 250_000],
    ['600K', 600_000, 250_000],
    ['262K', 262_000, 250_000],
    ['250K', 250_000, 250_000],
    ['200K', 200_000, 200_000],
  ])('caps a %s window at CHAT_COMPACTION_WINDOW_TOKENS for compaction, never raises a smaller one', (_l, window, effective) => {
    expect(CHAT_COMPACTION_WINDOW_TOKENS).toBe(250_000)
    expect(chatCompactionWindow(window)).toBe(effective)
    const out = modelSelectionFromSpec(spec({ model: 'anthropic/claude-sonnet-5.5', modelPolicy: { contextWindowTokens: window } }))
    expect(out).toEqual({ model: 'anthropic/claude-sonnet-5.5', modelContextWindowTokens: effective })
  })

  it('an unknown window stays unknown (eve then uses its own catalog window)', () => {
    expect(chatCompactionWindow(undefined)).toBeUndefined()
    expect(chatCompactionWindow(0)).toBeUndefined()
    expect(modelSelectionFromSpec(spec({ model: 'acme/mystery-1', modelPolicy: { reasoning: 'none' } }))).toEqual({
      model: 'acme/mystery-1',
      reasoning: 'none',
    })
  })

  it('invalid policy fields are dropped one by one, never thrown', () => {
    const out = modelSelectionFromSpec(
      spec({
        model: 'deepseek/deepseek-v4-flash',
        modelPolicy: {
          contextWindowTokens: -1,
          reasoning: 'max',
          providerOptions: { deepseek: { thinking: { type: 'disabled' } }, broken: 'off' },
          gateway: { only: [], sort: 'fastest' },
        } as never,
      }),
    )
    expect(out).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      // The dropped window falls back to the model's known one.
      modelContextWindowTokens: 250_000,
      modelOptions: { providerOptions: { deepseek: { thinking: { type: 'disabled' } } } },
    })
  })

  it('an entirely invalid policy falls back to the selection it had before policies existed', () => {
    for (const bad of [null, 'none', 42, [], {}, { reasoning: 'max', contextWindowTokens: 0 }]) {
      const noTelemetry = spec({ model: 'acme/mystery-1', modelPolicy: bad as never })
      expect(modelSelectionFromSpec(noTelemetry)).toBe('acme/mystery-1')
      const withTelemetry = spec({
        model: 'acme/mystery-1',
        gatewayTelemetry: { user: 'u', tags: ['a'] },
        modelPolicy: bad as never,
      })
      expect(modelSelectionFromSpec(withTelemetry)).toEqual({
        model: 'acme/mystery-1',
        modelOptions: { providerOptions: { gateway: { user: 'u', tags: ['a'] } } },
      })
    }
  })

  it('routing never rides in the telemetry: a telemetry-borne `only` is stripped', () => {
    const out = modelSelectionFromSpec(
      spec({ model: 'acme/mystery-1', gatewayTelemetry: { tags: ['a'], only: ['azure'] } as never }),
    )
    expect(out).toEqual({
      model: 'acme/mystery-1',
      modelOptions: { providerOptions: { gateway: { tags: ['a'] } } },
    })
  })
})

describe('validModelPolicy (shape-guard — keep what validates, drop the rest, never throw)', () => {
  it('keeps a well-formed policy verbatim, including every reasoning effort eve accepts', () => {
    const policy = {
      contextWindowTokens: 262_000,
      reasoning: 'none',
      providerOptions: { deepseek: { thinking: { type: 'disabled' } }, anthropic: { effort: 'low', n: [1, 2] } },
      gateway: { only: ['baseten'], order: ['baseten', 'alibaba'], sort: 'tps' },
    }
    expect(validModelPolicy(policy)).toEqual(policy)
    for (const reasoning of ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(validModelPolicy({ reasoning })).toEqual({ reasoning })
    }
    for (const sort of ['ttft', 'tps', 'cost']) {
      expect(validModelPolicy({ gateway: { sort } })).toEqual({ gateway: { sort } })
    }
  })

  it.each([
    ['reasoning outside eve’s list', { reasoning: 'max' }],
    ['reasoning not a string', { reasoning: 1 }],
    ['a zero window', { contextWindowTokens: 0 }],
    ['a negative window', { contextWindowTokens: -5 }],
    ['a fractional window', { contextWindowTokens: 1.5 }],
    ['a string window', { contextWindowTokens: '1000000' }],
    ['an infinite window', { contextWindowTokens: Infinity }],
    ['providerOptions not an object', { providerOptions: 'deepseek' }],
    ['providerOptions an array', { providerOptions: [{ thinking: false }] }],
    ['a string provider entry', { providerOptions: { deepseek: 'off' } }],
    ['an array provider entry', { providerOptions: { deepseek: [] } }],
    ['a null provider entry', { providerOptions: { deepseek: null } }],
    ['a non-finite number inside an entry', { providerOptions: { deepseek: { budget: NaN } } }],
    ['a class instance inside an entry', { providerOptions: { deepseek: { at: new Date() } } }],
    ['a gateway entry inside providerOptions', { providerOptions: { gateway: { only: ['azure'] } } }],
    ['gateway not an object', { gateway: 'baseten' }],
    ['an empty only (no host could serve)', { gateway: { only: [] } }],
    ['only with an empty host', { gateway: { only: ['baseten', ' '] } }],
    ['only with a non-string host', { gateway: { only: ['baseten', 7] } }],
    ['only as a bare string', { gateway: { only: 'baseten' } }],
    ['an unknown sort', { gateway: { sort: 'fastest' } }],
  ])('drops %s (nothing else left → null)', (_label, policy) => {
    expect(validModelPolicy(policy)).toBeNull()
  })

  it('drops a bad field without touching the valid ones', () => {
    expect(
      validModelPolicy({
        contextWindowTokens: 1_000_000,
        reasoning: 'max',
        providerOptions: { deepseek: { thinking: { type: 'disabled' } }, gateway: { only: ['azure'] }, x: 'y' },
        gateway: { only: ['baseten'], order: [], sort: 'fastest' },
      }),
    ).toEqual({
      contextWindowTokens: 1_000_000,
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
      gateway: { only: ['baseten'] },
    })
  })

  it('drops a provider entry nested past the depth bound instead of recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 20; i++) deep = { next: deep }
    expect(validModelPolicy({ contextWindowTokens: 1, providerOptions: { deepseek: deep } })).toEqual({
      contextWindowTokens: 1,
    })
  })

  for (const bad of [undefined, null, 'none', 42, true, [], [{ reasoning: 'none' }], {}]) {
    it(`returns null for ${JSON.stringify(bad) ?? 'undefined'}`, () => {
      expect(validModelPolicy(bad)).toBeNull()
    })
  }
})

describe('validGatewayTelemetry (Phase A shape-guard — never crash the resolver)', () => {
  it('round-trips a well-formed telemetry object through the wire spec type', () => {
    // The gatewayTelemetry field is part of ChatSpec; a spec carrying it parses
    // and the guard accepts it verbatim.
    const spec: ChatSpec = {
      systemPrompt: 'p',
      model: 'claude-haiku-4-5',
      ceiling: null,
      ceilingTools: [],
      coreToolNames: [],
      gatewayTelemetry: { user: 'user-1', tags: ['feature:ai_chat', 'runtime:eve'] },
    }
    expect(validGatewayTelemetry(spec.gatewayTelemetry)).toEqual({
      user: 'user-1',
      tags: ['feature:ai_chat', 'runtime:eve'],
    })
  })

  it('accepts an absent user (tags-only attribution)', () => {
    expect(validGatewayTelemetry({ tags: ['feature:ai_chat'] })).toEqual({
      tags: ['feature:ai_chat'],
    })
  })

  it('strips extra keys, keeping only user + tags', () => {
    expect(validGatewayTelemetry({ user: 'u', tags: ['a'], evil: 'x' })).toEqual({
      user: 'u',
      tags: ['a'],
    })
  })

  for (const bad of [
    undefined,
    null,
    'string',
    42,
    {},
    { tags: 'not-an-array' },
    { tags: [1, 2, 3] },
    { user: 42, tags: ['a'] },
  ]) {
    it(`returns null for malformed input ${JSON.stringify(bad)} (falls back to plain model)`, () => {
      expect(validGatewayTelemetry(bad)).toBeNull()
    })
  }
})

describe('reportTurnUsage — the usage meter’s only network edge', () => {
  const report = { sessionId: 'sess-1', turnId: 'turn_0', inputTokens: 10 }

  it('POSTs the report to /api/internal/chat/usage with the secret + token, redirect:error, and a timeout signal', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ billed: true }), { status: 200 }),
    )
    const res = await reportTurnUsage('tok.sig', report)
    expect(res).toEqual({ ok: true, body: { billed: true } })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.test/api/internal/chat/usage')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const headers = init.headers as Record<string, string>
    expect(headers['x-chat-run-secret']).toBe(SECRET)
    expect(headers['x-chat-run-token']).toBe('tok.sig')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual(report)
  })

  it('with NO token it still POSTs (secret only, no token header) — the route bills the session owner', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    expect((await reportTurnUsage('', report)).ok).toBe(true)
    const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['x-chat-run-secret']).toBe(SECRET)
    expect(headers).not.toHaveProperty('x-chat-run-token')
  })

  it.each([
    [503, true],
    [500, true],
    [401, true], // the route's only 401 = secret rejected → keep, never silently stop billing
    [409, true], // SESSION_UNREGISTERED → keep
    [429, true],
    [408, true],
    [400, false], // malformed report → final
    [403, false],
    [404, false],
  ])('HTTP %i → retryable %s', async (status, retryable) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status }))
    expect(await reportTurnUsage('tok.sig', report)).toEqual({ ok: false, status, retryable })
    expect(isRetryableUsageStatus(status)).toBe(retryable)
  })

  it('a network throw or an abort (timeout) is a retryable "network" failure — never a throw', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await reportTurnUsage('tok.sig', report)).toEqual({ ok: false, status: 'network', retryable: true })
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
    expect(await reportTurnUsage('tok.sig', report)).toEqual({ ok: false, status: 'network', retryable: true })
  })

  it('the timeout is a few seconds, so a hung app connection cannot hold a turn’s end', () => {
    expect(USAGE_REPORT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(USAGE_REPORT_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })

  it('a POST that never answers is ABORTED by the USAGE_REPORT_TIMEOUT_MS signal and becomes a retryable failure', async () => {
    // Node's AbortSignal.timeout runs on internal timers fake timers cannot
    // advance, so the timeout signal is swapped for one this test fires — the
    // assertion is that fetch receives exactly the signal minted for
    // USAGE_REPORT_TIMEOUT_MS, and that its firing ends the call.
    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    let seen: AbortSignal | undefined
    vi.spyOn(global, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          seen = (init as RequestInit).signal ?? undefined
          seen?.addEventListener('abort', () => reject(new DOMException('The operation timed out.', 'TimeoutError')))
        }),
    )
    const pending = reportTurnUsage('tok.sig', report)
    await Promise.resolve()
    expect(timeoutSpy).toHaveBeenCalledWith(USAGE_REPORT_TIMEOUT_MS)
    expect(seen).toBe(controller.signal)
    controller.abort()
    await expect(pending).resolves.toEqual({ ok: false, status: 'network', retryable: true })
    expect(seen?.aborted).toBe(true)
  })

  it('an unset secret is a retryable failure, not a throw', async () => {
    delete process.env.CHAT_INTERNAL_SECRET
    const fetchSpy = vi.spyOn(global, 'fetch')
    expect(await reportTurnUsage('tok.sig', report)).toEqual({ ok: false, status: 'network', retryable: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('postChatMemory — the profile memory slot’s network edge', () => {
  it('POSTs to /api/internal/chat/memory with the secret + token and a timeout, and returns the result', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: { messages: [] } }), { status: 200 }))
    expect(await postChatMemory('tok.sig', { op: 'recall' })).toEqual({ messages: [] })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.test/api/internal/chat/memory')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const headers = init.headers as Record<string, string>
    expect(headers['x-chat-run-secret']).toBe(SECRET)
    expect(headers['x-chat-run-token']).toBe('tok.sig')
  })

  it('throws on no token, a non-OK answer or no result, so the provider falls back', async () => {
    await expect(postChatMemory('', {})).rejects.toThrow(/no run token/)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 403 }))
    await expect(postChatMemory('tok.sig', {})).rejects.toThrow(/403/)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(postChatMemory('tok.sig', {})).rejects.toThrow(/no result/)
  })
})
