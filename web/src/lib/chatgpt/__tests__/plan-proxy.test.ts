import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The plan proxy core's settle contract (src/lib/chatgpt/plan-proxy.ts): a
 * caller that meters a call or holds a slot for it (the local-agent relay)
 * hears `onSettled` exactly once, however the call ends: the stream's end,
 * OpenAI's side failing mid-stream, the client cancelling, or no answer at all
 * (a connection that couldn't be read). The internal route's own suite covers
 * the plan rules and status codes.
 */

const hoisted = vi.hoisted(() => ({ getPlanAccessToken: vi.fn(), setConnectionStatus: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/chatgpt/connection', () => ({
  getPlanAccessToken: hoisted.getPlanAccessToken,
  setConnectionStatus: hoisted.setConnectionStatus,
}))

const { proxyPlanResponses } = await import('../plan-proxy')

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
const enc = new TextEncoder()
const event = (e: Record<string, unknown>) => enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
const delta = { type: 'response.output_text.delta', delta: 'hi' }
const completed = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } }

function request(body: unknown = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'x' }] }) {
  return new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** An upstream body the test drives chunk by chunk. */
function upstreamStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: () => void (cancelled = true),
  })
  return { stream, push: (b: Uint8Array) => controller.enqueue(b), end: () => controller.close(), fail: (e: Error) => controller.error(e), wasCancelled: () => cancelled }
}

beforeEach(() => {
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

describe('proxyPlanResponses: onSettled, once, however the call ends', () => {
  it('on the stream’s end: the model and the outcome’s usage', async () => {
    const up = upstreamStream()
    fetchMock.mockResolvedValue(new Response(up.stream, { headers: { 'content-type': 'text/event-stream' } }))
    const onSettled = vi.fn()
    const res = await proxyPlanResponses(request(), 'u1', { onSettled })
    up.push(event(delta))
    up.push(event(completed))
    up.end()
    await res.text()
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0][0]).toMatchObject({ model: 'gpt-6.1-sol', outcome: { completed: true } })
  })

  it('when the client cancels mid-stream: settled, and the upstream body cancelled', async () => {
    const up = upstreamStream()
    fetchMock.mockResolvedValue(new Response(up.stream, { headers: { 'content-type': 'text/event-stream' } }))
    const onSettled = vi.fn()
    const res = await proxyPlanResponses(request(), 'u1', { onSettled })
    up.push(event(delta))
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel('stopped')
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0][0]).toMatchObject({ model: 'gpt-6.1-sol', outcome: { completed: false } })
    expect(up.wasCancelled()).toBe(true)
  })

  it('when OpenAI’s side fails mid-stream: settled, and the error reaches the client', async () => {
    const up = upstreamStream()
    fetchMock.mockResolvedValue(new Response(up.stream, { headers: { 'content-type': 'text/event-stream' } }))
    const onSettled = vi.fn()
    const res = await proxyPlanResponses(request(), 'u1', { onSettled })
    up.push(event(delta))
    up.fail(new Error('socket hang up'))
    await expect(res.text()).rejects.toThrow(/socket hang up/)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('a connection that cannot be read: 503 (the SDK retries), settled with no answer, nothing sent', async () => {
    hoisted.getPlanAccessToken.mockRejectedValue(new Error('decrypt failed'))
    const onSettled = vi.fn()
    const res = await proxyPlanResponses(request(), 'u1', { onSettled })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('chatgpt_plan_unreadable')
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ model: 'gpt-6.1-sol', outcome: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes a body its caller already read', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob([event(completed)]).stream(), { headers: { 'content-type': 'text/event-stream' } }))
    const onSettled = vi.fn()
    const unread = new Request('http://localhost/x', { method: 'POST', body: 'ignored' })
    const res = await proxyPlanResponses(unread, 'u1', { onSettled, rawBody: JSON.stringify({ model: 'gpt-6-luna', input: [] }) })
    await res.text()
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ model: 'gpt-6-luna', store: false, stream: true })
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})

describe('proxyPlanResponses: hosted tools (security review 2026-10-31)', () => {
  const withSearch = { model: 'gpt-6-luna', input: [], tools: [{ type: 'function', name: 'bash', parameters: {} }, { type: 'web_search' }] }

  it("by default (the local agent's relay, network off): web search is refused 403 before any call, and settled", async () => {
    const onSettled = vi.fn()
    const res = await proxyPlanResponses(request(withSearch), 'u1', { onSettled })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('hosted_tool')
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ model: null, outcome: null })
    expect(hoisted.getPlanAccessToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('with webSearch (the cloud agents): OpenAI web search goes through, bare', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob([event(completed)]).stream(), { headers: { 'content-type': 'text/event-stream' } }))
    const res = await proxyPlanResponses(request(withSearch), 'u1', { webSearch: true })
    await res.text()
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).tools).toEqual([{ type: 'function', name: 'bash', parameters: {} }, { type: 'web_search' }])
  })
})
