import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  db: null as unknown,
  afters: [] as Array<() => unknown>,
  checkUsageLimits: vi.fn(async (): Promise<unknown> => undefined),
  logUsage: vi.fn(async () => 'logged'),
  // The ChatGPT free tier's plan path: the shared proxy core (its own tests
  // cover it); here, what it was handed and how its call settled.
  proxyPlanResponses: vi.fn(),
}))
vi.mock('@/lib/chatgpt/plan-proxy', () => ({ proxyPlanResponses: m.proxyPlanResponses }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => m.db }))
vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: m.checkUsageLimits,
  logUsage: m.logUsage,
  extractGatewayCost: ({ providerMetadata }: { providerMetadata?: Record<string, unknown> }) => {
    const g = providerMetadata?.gateway as { marketCost?: string } | undefined
    return g?.marketCost ? Number(g.marketCost) : undefined
  },
}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    m.afters.push(fn)
  },
}))

import { POST } from '../route'
import { ALLOWED_MODEL_IDS, LOCAL_AGENT_MODEL_SLUG, MAX_BODY_BYTES } from '@/lib/local-agent/relay'
import { signModelToken } from '@/lib/local-agent/tokens'
import { DEVICE, FOLDER, USER, WS, seeded } from '@/lib/local-agent/__tests__/fake-db'

const SID = '77777777-7777-4777-8777-777777777777'
const MODEL = 'anthropic/claude-sonnet-5.5'

function call(opts: { path?: string[]; token?: string | null; model?: string; body?: unknown; streaming?: boolean } = {}) {
  const token = opts.token === undefined ? signModelToken({ sid: SID, uid: USER, wid: WS }).token : opts.token
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'ai-language-model-specification-version': '4',
    'ai-language-model-id': opts.model ?? MODEL,
    'ai-language-model-streaming': String(!!opts.streaming),
    'ai-gateway-auth-method': 'api-key',
    'x-vercel-ai-gateway-team': 'someone-elses-team',
  }
  if (token) headers.authorization = `Bearer ${token}`
  return POST(
    new Request('http://localhost/api/local-agent/model/language-model', {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body ?? { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    }),
    { params: Promise.resolve({ path: opts.path ?? ['language-model'] }) },
  )
}

async function runAfters() {
  for (const fn of m.afters.splice(0)) await fn()
}

const fetchMock = vi.fn()
const env = { ...process.env }

beforeEach(() => {
  process.env.LOCAL_AGENT_TOKEN_SECRET = 'relay-test-secret'
  process.env.AI_GATEWAY_API_KEY = 'server-gateway-key'
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  m.db = seeded({
    local_agent_session: [{ id: SID, user_id: USER, workspace_id: WS, device_id: DEVICE, folder_id: FOLDER, status: 'running' }],
  })
  m.afters = []
  m.checkUsageLimits.mockReset().mockResolvedValue(undefined)
  m.logUsage.mockReset().mockResolvedValue('logged')
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('model relay allowlist', () => {
  it('derives from SURFACE_MODELS.coding_runs: the local agent’s model', () => {
    expect(LOCAL_AGENT_MODEL_SLUG).toBe(MODEL)
    expect([...ALLOWED_MODEL_IDS]).toEqual([MODEL])
  })
})

describe('POST /api/local-agent/model/[...path]', () => {
  it('serves only language-model', async () => {
    for (const path of [['embedding-model'], ['config'], ['v1', 'credits'], ['language-model', 'x'], []]) {
      expect((await call({ path })).status).toBe(404)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a missing, forged or expired token', async () => {
    expect((await call({ token: null })).status).toBe(401)
    expect((await call({ token: 'la1.e30.AAAA' })).status).toBe(401)
    const expired = signModelToken({ sid: SID, uid: USER, wid: WS }, { now: Date.now() - 3 * 3600_000 }).token
    const res = await call({ token: expired })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/expired/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a model outside the allowlist, in the header or as a gateway fallback', async () => {
    expect((await call({ model: 'openai/gpt-6' })).status).toBe(403)
    expect((await call({ body: { prompt: [], providerOptions: { gateway: { models: [MODEL, 'openai/gpt-6'] } } } })).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a session that is not live or not the token’s owner', async () => {
    const db = m.db as { tables: Record<string, Array<Record<string, unknown>>> }
    db.tables.local_agent_session[0].status = 'cancelled'
    expect((await call()).status).toBe(403)
    db.tables.local_agent_session[0].status = 'running'
    db.tables.local_agent_session[0].user_id = 'someone-else'
    expect((await call()).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a session asked to stop at once, before the Mac reports cancelled', async () => {
    const db = m.db as { tables: Record<string, Array<Record<string, unknown>>> }
    db.tables.local_agent_session[0].stop_requested_at = new Date().toISOString()
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/stopped/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the usage limit’s 429 as is, before forwarding', async () => {
    m.checkUsageLimits.mockRejectedValue(new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 }))
    const res = await call()
    expect(res.status).toBe(429)
    expect(m.checkUsageLimits).toHaveBeenCalledWith(USER)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards a generate call with the server credential and meters its usage once per generation', async () => {
    const result = {
      content: [{ type: 'text', text: 'hello' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } },
      providerMetadata: { gateway: { generationId: 'gen_123', marketCost: '0.0042' } },
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=y' } }))
    const res = await call({ body: { prompt: [], providerOptions: { gateway: { byok: { anthropic: [{ apiKey: 'k' }] }, tags: ['mine'] } } } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(res.headers.get('set-cookie')).toBeNull()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://ai-gateway.vercel.sh/v4/ai/language-model')
    const h = init.headers as Headers
    expect(h.get('authorization')).toBe('Bearer server-gateway-key')
    expect(h.get('ai-gateway-auth-method')).toBe('api-key')
    expect(h.get('ai-gateway-protocol-version')).toBe('0.0.1')
    expect(h.get('ai-language-model-id')).toBe(MODEL)
    expect(h.get('ai-language-model-streaming')).toBe('false')
    expect(h.get('x-vercel-ai-gateway-team')).toBeNull()
    const sent = JSON.parse(init.body as string)
    expect(sent.providerOptions.gateway).toEqual({ user: USER, tags: ['local_agent', 'mine'] })

    expect(m.logUsage).not.toHaveBeenCalled()
    await runAfters()
    expect(m.logUsage).toHaveBeenCalledWith(USER, expect.objectContaining({
      feature: 'local_agent',
      model: 'claude-sonnet-5-5',
      inputTokens: 1200,
      outputTokens: 30,
      costUsd: 0.0042,
      idempotencyKey: 'local-agent:gen_123',
      metadata: expect.objectContaining({ local_agent_session_id: SID, generationIds: ['gen_123'], cache_read_input_tokens: 1000 }),
    }))
  })

  it('streams SSE back unchanged and meters the finish part', async () => {
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-delta', id: '1', delta: 'Hel' },
      { type: 'text-delta', id: '1', delta: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 50 }, outputTokens: { total: 7 } }, providerMetadata: { gateway: { generationId: 'gen_s', marketCost: '0.001' } } },
    ]
    const sse = parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')
    const enc = new TextEncoder().encode(sse)
    // Split mid-line to prove the line buffer.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.slice(0, 37))
        c.enqueue(enc.slice(37, enc.length - 20))
        c.enqueue(enc.slice(enc.length - 20))
        c.close()
      },
    })
    fetchMock.mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const res = await call({ streaming: true })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe(sse)
    await runAfters()
    expect(m.logUsage).toHaveBeenCalledTimes(1)
    expect(m.logUsage).toHaveBeenCalledWith(USER, expect.objectContaining({ inputTokens: 50, outputTokens: 7, costUsd: 0.001, idempotencyKey: 'local-agent:gen_s' }))
  })

  it('passes a Gateway error through and meters nothing', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } }))
    const res = await call()
    expect(res.status).toBe(429)
    expect((await res.json()).error.type).toBe('rate_limit_exceeded')
    await runAfters()
    expect(m.logUsage).not.toHaveBeenCalled()
  })

  it('a client cancel mid-stream aborts upstream and still meters an estimate (never free)', async () => {
    const enc = new TextEncoder()
    let push!: (t: string) => void
    let upstreamCancelled = false
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c) { push = (t) => c.enqueue(enc.encode(t)) },
      cancel() { upstreamCancelled = true },
    })
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => { upstreamCancelled = true })
      return new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const body = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }] }
    const res = await call({ streaming: true, body })
    const reader = res.body!.getReader()
    push(`data: ${JSON.stringify({ type: 'text-delta', id: '1', delta: 'y'.repeat(400) })}\n\n`)
    await reader.read()
    await reader.cancel('client went away')
    await runAfters()
    expect(upstreamCancelled).toBe(true)
    expect(m.logUsage).toHaveBeenCalledTimes(1)
    const [, params] = m.logUsage.mock.calls[0] as unknown as [string, { inputTokens: number; outputTokens: number; costUsd?: number; metadata: Record<string, unknown>; idempotencyKey?: string }]
    expect(params.inputTokens).toBeGreaterThanOrEqual(1000)
    expect(params.outputTokens).toBe(100)
    expect(params.costUsd).toBeUndefined()
    expect(params.metadata.estimated).toBe(true)
    expect(params.idempotencyKey).toBeUndefined()
  })

  it('caps a person at 4 calls in flight, and frees the slot when a call settles', async () => {
    const db = m.db as { tables: Record<string, Array<Record<string, unknown>>> }
    db.tables.local_agent_relay_slot = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, user_id: USER, session_id: SID, expires_at: new Date(Date.now() + 60_000).toISOString() }))
    const res = await call()
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('TOO_MANY_CALLS')
    expect(fetchMock).not.toHaveBeenCalled()
    // An expired slot frees itself; a settled call releases its own.
    db.tables.local_agent_relay_slot[0].expires_at = new Date(Date.now() - 1000).toISOString()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    expect((await call()).status).toBe(200)
    expect(db.tables.local_agent_relay_slot).toHaveLength(4)
    await runAfters()
    expect(db.tables.local_agent_relay_slot).toHaveLength(3)
  })

  it('refuses provider-executed tools (network off holds server-side)', async () => {
    const res = await call({ body: { prompt: [], tools: [{ type: 'function', name: 'bash', inputSchema: {} }, { type: 'provider', id: 'gateway.web_search', name: 'web_search', args: {} }] } })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect((await call({ body: { prompt: [], tools: [{ type: 'function', name: 'bash', inputSchema: {} }] } })).status).toBe(200)
  })

  it('refuses a session idle for 24 h', async () => {
    const db = m.db as { tables: Record<string, Array<Record<string, unknown>>> }
    Object.assign(db.tables.local_agent_session[0], { status: 'waiting', updated_at: new Date(Date.now() - 25 * 3600_000).toISOString(), lease_expires_at: null })
    expect((await call()).status).toBe(403)
    db.tables.local_agent_session[0].updated_at = new Date().toISOString()
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect((await call()).status).toBe(200)
  })

  it('503s without a gateway credential', async () => {
    delete process.env.AI_GATEWAY_API_KEY
    delete process.env.VERCEL_OIDC_TOKEN
    vi.doMock('@vercel/oidc', () => ({ getVercelOidcToken: async () => { throw new Error('no oidc') } }))
    const res = await call()
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/local-agent/model/plan/responses (the ChatGPT free tier)', () => {
  function planCall(token = signModelToken({ sid: SID, uid: USER, wid: WS, plan: true }).token, body: unknown = { model: 'gpt-6.1-sol', input: [] }) {
    return POST(
      new Request('http://localhost/api/local-agent/model/plan/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ['plan', 'responses'] }) },
    )
  }
  const slots = () => ((m.db as { tables: Record<string, unknown[]> }).tables.local_agent_relay_slot ?? []).length

  beforeEach(() => {
    m.proxyPlanResponses.mockReset().mockImplementation(async (_req: Request, _uid: string, opts: { onSettled?: (s: unknown) => Promise<void> }) => {
      await opts.onSettled?.({
        model: 'gpt-6.1-sol',
        outcome: { usage: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 1000, reasoningTokens: 12 }, errorCode: null, completed: true },
      })
      return new Response('data: done\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
  })

  it("runs the call on the person's own plan: the usage check opts in, the call is logged at $0, the slot is freed", async () => {
    const res = await planCall()
    expect(res.status).toBe(200)
    expect(m.checkUsageLimits).toHaveBeenCalledWith(USER, undefined, { chatgptPlan: true })
    expect(m.proxyPlanResponses).toHaveBeenCalledWith(expect.any(Request), USER, expect.objectContaining({ rawBody: expect.any(String) }))
    // Metered and freed after the response (after()), never on the stream's path.
    expect(m.logUsage).not.toHaveBeenCalled()
    expect(slots()).toBe(1)
    await runAfters()
    expect(m.logUsage).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        provider: 'chatgpt-plan',
        model: 'chatgpt-plan/gpt-6.1-sol',
        feature: 'local_agent',
        inputTokens: 1200,
        outputTokens: 80,
        metadata: expect.objectContaining({ local_agent_session_id: SID, cost_source: 'chatgpt_plan', cache_read_input_tokens: 1000 }),
      }),
    )
    expect((m.logUsage.mock.calls[0] as unknown[])[1]).not.toHaveProperty('costUsd')
    // Nothing went to the Gateway.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(slots()).toBe(0)
  })

  it('refuses a person the opted-in check refuses, before any call or slot', async () => {
    m.checkUsageLimits.mockRejectedValue(new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 }))
    expect((await planCall()).status).toBe(429)
    expect(m.proxyPlanResponses).not.toHaveBeenCalled()
    expect(slots()).toBe(0)
  })

  it('holds the same token and session checks as the Gateway path', async () => {
    expect((await planCall('la1.e30.AAAA')).status).toBe(401)
    const db = m.db as { tables: Record<string, Array<Record<string, unknown>>> }
    db.tables.local_agent_session[0].status = 'cancelled'
    expect((await planCall()).status).toBe(403)
    expect(m.proxyPlanResponses).not.toHaveBeenCalled()
  })

  it('logs nothing for a call that streamed no answer back, and still frees the slot', async () => {
    m.proxyPlanResponses.mockImplementation(async (_req: Request, _uid: string, opts: { onSettled?: (s: unknown) => Promise<void> }) => {
      await opts.onSettled?.({ model: 'gpt-6.1-sol', outcome: null })
      return new Response(JSON.stringify({ error: { code: 'chatgpt_plan_unreachable' } }), { status: 502 })
    })
    expect((await planCall()).status).toBe(502)
    await runAfters()
    expect(m.logUsage).not.toHaveBeenCalled()
    expect(slots()).toBe(0)
  })

  it('frees the slot even if the core throws', async () => {
    m.proxyPlanResponses.mockRejectedValue(new Error('unexpected'))
    await expect(planCall()).rejects.toThrow('unexpected')
    await runAfters()
    expect(m.logUsage).not.toHaveBeenCalled()
    expect(slots()).toBe(0)
  })

  it('checks the body it reads, not only its content-length (a chunked body has none)', async () => {
    const res = await planCall(undefined, { model: 'gpt-6.1-sol', input: 'x'.repeat(MAX_BODY_BYTES + 1) })
    expect(res.status).toBe(413)
    expect(m.proxyPlanResponses).not.toHaveBeenCalled()
    expect(slots()).toBe(0)
  })

  it('keeps the Gateway path closed to a free user whatever the token says', async () => {
    // The Gateway path's check is the one-argument form, which refuses a free user
    // ('chatgpt_plan_unsupported', migration 409): nothing reaches the Gateway.
    m.checkUsageLimits.mockRejectedValue(new Response(JSON.stringify({ error: 'Usage limit exceeded', reason: 'chatgpt_plan_unsupported' }), { status: 429 }))
    const res = await call({ token: signModelToken({ sid: SID, uid: USER, wid: WS, plan: true }).token })
    expect(res.status).toBe(429)
    expect(m.checkUsageLimits).toHaveBeenCalledWith(USER)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await call({ path: ['plan', 'other'] })).status).toBe(404)
  })
})

