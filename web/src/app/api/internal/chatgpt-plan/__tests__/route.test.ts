import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The ChatGPT plan proxy (POST /api/internal/chatgpt-plan/v1/responses): it
 * authenticates the chat run, calls OpenAI with the person's plan token and
 * the plan route's rules, streams the answer through, and keeps the
 * connection's status from what OpenAI answers. No token, no call.
 */

const hoisted = vi.hoisted(() => ({
  secretOk: true,
  claims: { userId: 'u1', workspaceId: 'w1', conversationId: 'c1', exp: Date.now() + 60_000 } as Record<string, unknown> | null,
  getPlanAccessToken: vi.fn(),
  setConnectionStatus: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
// The caller check is plan-caller's own test; here, its answer.
vi.mock('@/lib/chatgpt/plan-caller', () => ({
  planCallerFrom: () => (hoisted.secretOk && hoisted.claims ? { family: 'chat', userId: hoisted.claims.userId } : null),
}))
vi.mock('@/lib/chatgpt/connection', () => ({
  getPlanAccessToken: hoisted.getPlanAccessToken,
  setConnectionStatus: hoisted.setConnectionStatus,
}))

const { POST } = await import('../v1/responses/route')

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
const sse = (...events: Record<string, unknown>[]) => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const completed = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } }

function request(body: unknown = { model: 'gpt-6.1-sol', input: [{ role: 'system', content: 'x' }], temperature: 0 }) {
  return new Request('http://localhost/api/internal/chatgpt-plan/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  hoisted.secretOk = true
  hoisted.claims = { userId: 'u1', workspaceId: 'w1', conversationId: 'c1', exp: Date.now() + 60_000 }
  hoisted.getPlanAccessToken.mockReset().mockResolvedValue({ ok: true, accessToken: 'plan-at', status: 'active' })
  hoisted.setConnectionStatus.mockReset().mockResolvedValue(undefined)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/internal/chatgpt-plan/v1/responses', () => {
  it('refuses a call no agent run vouches for, before any call', async () => {
    hoisted.secretOk = false
    expect((await POST(request())).status).toBe(401)
    hoisted.secretOk = true
    hoisted.claims = null
    expect((await POST(request())).status).toBe(401)
    expect(hoisted.getPlanAccessToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a body the plan route cannot take', async () => {
    expect((await POST(request('{nope'))).status).toBe(400)
    expect((await POST(request({ model: 'anthropic/claude-sonnet-5.5' }))).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("makes no call without the person's plan token", async () => {
    hoisted.getPlanAccessToken.mockResolvedValue({ ok: false, reason: 'revoked' })
    const res = await POST(request())
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('chatgpt_plan_unavailable')
    hoisted.getPlanAccessToken.mockResolvedValue({ ok: false, reason: 'busy' })
    expect((await POST(request())).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("calls OpenAI with the person's token and the plan rules, and streams the answer through", async () => {
    const text = sse({ type: 'response.output_text.delta', delta: 'hi' }, completed)
    fetchMock.mockResolvedValue(new Response(text, { headers: { 'content-type': 'text/event-stream' } }))
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(text)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer plan-at')
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-6.1-sol',
      input: [{ role: 'developer', content: 'x' }],
      store: false,
      stream: true,
    })
    expect(hoisted.getPlanAccessToken).toHaveBeenCalledWith({ service: true }, 'u1')
    expect(hoisted.setConnectionStatus).not.toHaveBeenCalled()
  })

  it("keeps a cloud agent's OpenAI web search (the local agent's relay refuses it)", async () => {
    fetchMock.mockResolvedValue(new Response(sse(completed), { headers: { 'content-type': 'text/event-stream' } }))
    const tools = [{ type: 'function', name: 'find', parameters: {} }, { type: 'web_search' }]
    expect((await POST(request({ model: 'gpt-6-luna', input: [], tools }))).status).toBe(200)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).tools).toEqual(tools)
  })

  it('marks a spent plan exhausted and answers 402, which the SDK does not retry', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }), { status: 429 }),
    )
    const res = await POST(request())
    expect(res.status).toBe(402)
    expect((await res.json()).error.code).toBe('subscription_sharing_usage_limit_exceeded')
    expect(hoisted.setConnectionStatus).toHaveBeenCalledWith({ service: true }, 'u1', 'exhausted', 'subscription_sharing_usage_limit_exceeded')
  })

  it("passes OpenAI's other errors through as they are", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 }))
    const res = await POST(request())
    expect(res.status).toBe(429)
    expect(hoisted.setConnectionStatus).not.toHaveBeenCalled()
  })

  it('marks it exhausted when the plan runs out mid-stream', async () => {
    const failed = { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }
    fetchMock.mockResolvedValue(new Response(sse(failed), { headers: { 'content-type': 'text/event-stream' } }))
    await (await POST(request())).text()
    expect(hoisted.setConnectionStatus).toHaveBeenCalledWith({ service: true }, 'u1', 'exhausted', 'subscription_sharing_usage_limit_exceeded')
  })

  it('tries an exhausted plan again, and a completed call makes it active', async () => {
    hoisted.getPlanAccessToken.mockResolvedValue({ ok: true, accessToken: 'plan-at', status: 'exhausted' })
    fetchMock.mockResolvedValue(new Response(sse(completed), { headers: { 'content-type': 'text/event-stream' } }))
    await (await POST(request())).text()
    expect(hoisted.setConnectionStatus).toHaveBeenCalledWith({ service: true }, 'u1', 'active', null)
  })

  it('tries once more when the first call made no connection to OpenAI, then streams the answer', async () => {
    const connectTimeout = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
    fetchMock
      .mockRejectedValueOnce(connectTimeout)
      .mockResolvedValueOnce(new Response(sse(completed), { headers: { 'content-type': 'text/event-stream' } }))
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(sse(completed))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The same request both times.
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body)
  })

  it('answers 502 after a second failed connect, and never retries a call that may have reached OpenAI', async () => {
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    fetchMock.mockRejectedValue(refused)
    const res = await POST(request())
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('chatgpt_plan_unreachable')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockReset().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
    expect((await POST(request())).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockReset().mockRejectedValue(new Error('socket hang up'))
    expect((await POST(request())).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

