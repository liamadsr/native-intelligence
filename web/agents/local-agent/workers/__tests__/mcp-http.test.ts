/**
 * The manager tools' MCP server: the JSON-RPC subset on its own, then the real HTTP
 * server on 127.0.0.1 with its guard (bearer, Host, Origin, path, method).
 */
import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MANAGER_TOOLS, createManagerTools } from '../lib/manager-tools'
import { MAX_BATCH, MCP_PATH, SUPPORTED_PROTOCOL_VERSIONS, handleRpcMessage, startManagerMcp, type ManagerMcpServer, type RpcContext, type ToolCall } from '../lib/mcp-http'
import type { NormalizedEvent } from '../lib/protocol'

const ctx = (call: ToolCall = async (name) => ({ text: `called ${name}`, isError: false })): RpcContext => ({ call, inflight: new Map() })

describe('handleRpcMessage', () => {
  it('initializes on the client version when known, else the newest', async () => {
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx())).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'native-intelligence' } },
    })
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, ctx())).toMatchObject({
      result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] },
    })
  })

  it('lists the manager tools, and only those, and calls one', async () => {
    const list = (await handleRpcMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, ctx())) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['report', 'ask_manager', 'finish'])
    expect(MANAGER_TOOLS).toHaveLength(3)
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report', arguments: { text: 'hi' } } }, ctx())).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'called report' }], isError: false },
    })
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bash', arguments: {} } }, ctx())).toMatchObject({ error: { code: -32602 } })
  })

  it('refuses unknown tools and methods, and answers nothing to notifications', async () => {
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'Finish' } }, ctx())).toMatchObject({ error: { code: -32602 } })
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, ctx())).toMatchObject({ error: { code: -32601 } })
    expect(await handleRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx())).toBeNull()
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 7, result: {} }, ctx())).toBeNull()
    expect(await handleRpcMessage({ nope: true }, ctx())).toMatchObject({ error: { code: -32600 } })
  })

  it('aborts a call on notifications/cancelled', async () => {
    const c = ctx((_name, _args, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: 'stopped', isError: true }))))
    const pending = handleRpcMessage({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'report', arguments: {} } }, c)
    await new Promise((r) => setTimeout(r, 5))
    expect(c.inflight.has('call-1')).toBe(true)
    await handleRpcMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } }, c)
    expect(await pending).toMatchObject({ result: { isError: true, content: [{ text: 'stopped' }] } })
    expect(c.inflight.size).toBe(0)
  })
})

describe('the HTTP server', () => {
  let server: ManagerMcpServer
  const calls: string[] = []

  beforeAll(async () => {
    server = await startManagerMcp(async (name, args) => {
      calls.push(name)
      return { text: JSON.stringify(args), isError: false }
    })
  })
  afterAll(() => server.close())

  /** A raw request (node:http, so Host and Origin are exactly as given). */
  const send = (opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, method: opts.method ?? 'POST', path: opts.path ?? MCP_PATH, headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', authorization: `Bearer ${server.token}`, ...opts.headers } }, (res) => {
        let body = ''
        res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
      req.end()
    })

  it('listens on 127.0.0.1 with a fresh bearer', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`)
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('answers initialize, tools/list and tools/call as JSON', async () => {
    const init = await send({ body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'test' } } } })
    expect(init.status).toBe(200)
    expect(JSON.parse(init.body).result.protocolVersion).toBe('2025-11-25')
    expect((await send({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status).toBe(202)
    const call = await send({ body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'finish', arguments: { summary: 'a' } } } })
    expect(JSON.parse(call.body).result.content[0].text).toBe('{"summary":"a"}')
    const batch = await send({ body: [{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }] })
    expect(JSON.parse(batch.body)).toEqual([{ jsonrpc: '2.0', id: 3, result: {} }])
  })

  it('refuses a missing or wrong bearer, a browser, a rebound Host, other paths and methods', async () => {
    const before = calls.length
    const body = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'report', arguments: { text: 'x' } } }
    expect((await send({ body, headers: { authorization: '' } })).status).toBe(401)
    expect((await send({ body, headers: { authorization: `Bearer ${server.token.slice(1)}x` } })).status).toBe(401)
    expect((await send({ body, headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await send({ body, headers: { host: `localhost:${server.port}` } })).status).toBe(403)
    expect((await send({ body, path: '/other' })).status).toBe(404)
    expect((await send({ method: 'GET' })).status).toBe(405)
    expect((await send({ body: 'not json' })).status).toBe(400)
    expect(calls.length).toBe(before)
  })

  it("refuses another job's bearer: every job's port is reachable on loopback now, so the bearer is the guard", async () => {
    const otherJob = await startManagerMcp(async () => ({ text: 'other', isError: false }))
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'finish', arguments: { summary: 'x' } } })
      const post = (url: string, token?: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body })
      expect((await post(otherJob.url, server.token)).status).toBe(401)
      expect((await post(server.url, otherJob.token)).status).toBe(401)
      expect((await post(otherJob.url)).status).toBe(401)
      expect((await post(otherJob.url, otherJob.token)).status).toBe(200)
      expect(otherJob.token).not.toBe(server.token)
    } finally {
      await otherJob.close()
    }
  })

  it('takes a batch of 1 to MAX_BATCH messages, and runs its calls one at a time', async () => {
    const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' })
    for (const body of [[], Array.from({ length: MAX_BATCH + 1 }, (_, i) => ping(i))]) {
      const r = await send({ body })
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body).error.code).toBe(-32600)
    }
    let running = 0
    let most = 0
    const slow = await startManagerMcp(async (name) => {
      running += 1
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 20))
      running -= 1
      return { text: name, isError: false }
    })
    try {
      const body = Array.from({ length: 4 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'report', arguments: { text: 'a' } } }))
      const res = await fetch(slow.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${slow.token}` }, body: JSON.stringify(body) })
      expect((await res.json()).map((m: { id: number }) => m.id)).toEqual([0, 1, 2, 3])
      expect(most).toBe(1)
    } finally {
      await slow.close()
    }
  })
})

describe("finish's pull_request", () => {
  it('takes the same shape and limits as our own agent: a title of 1–256 characters, a body of at most 60,000', async () => {
    const calls: [NormalizedEvent, unknown][] = []
    const edit = createManagerTools((e, pr) => calls.push([e, pr]), 'edit')
    const signal = new AbortController().signal
    const finish = (pull_request: unknown) => edit.call('finish', { summary: 'Done.', pull_request }, signal)
    expect((await finish({ title: 'Fix it', body: 'Why.' })).isError).toBe(false)
    expect((await finish({ title: '\u0007 Fix\u0001 it ' })).isError).toBe(false) // control characters go, as the prompt strips them
    expect(calls.map(([, pr]) => pr)).toEqual([{ title: 'Fix it', body: 'Why.' }, { title: 'Fix it' }])
    for (const bad of [{}, { title: '' }, { title: 'x'.repeat(257) }, { title: 'ok', body: 'b'.repeat(60_001) }, { title: 'ok', body: 7 }, 'title', [1]]) {
      expect((await finish(bad)).isError, JSON.stringify(bad).slice(0, 40)).toBe(true)
    }
    expect(calls).toHaveLength(2) // a refused call emits nothing
    const read: [NormalizedEvent, unknown][] = []
    const r = await createManagerTools((e, pr) => read.push([e, pr]), 'read').call('finish', { summary: 'Done.', pull_request: { title: 'Fix it' } }, signal)
    expect(r.text).toMatch(/read-only: nothing was changed/)
    expect(read).toEqual([[{ kind: 'finish', summary: 'Done.' }, undefined]])
  })
})

describe('the manager tools', () => {
  it('emits report, ask and finish when the call arrives, cut to their limits, and nothing for a bad call', async () => {
    const events: NormalizedEvent[] = []
    const tools = createManagerTools((e) => events.push(e))
    const signal = new AbortController().signal
    expect(await tools.call('report', { text: 'Looking.' }, signal)).toEqual({ text: 'Reported.', isError: false })
    expect((await tools.call('ask_manager', { question: 'Which?' }, signal)).isError).toBe(false)
    expect((await tools.call('finish', { summary: 'Done.' }, signal)).isError).toBe(false)
    expect(await tools.call('finish', { summary: ' ' }, signal)).toEqual({ text: 'summary is required', isError: true })
    expect(await tools.call('report', { text: 'r'.repeat(4001) }, signal)).toEqual({ text: 'text is longer than 4000 characters', isError: true })
    expect((await tools.call('bash', { command: 'ls' }, signal)).isError).toBe(true)
    expect(events).toEqual([
      { kind: 'report', text: 'Looking.' },
      { kind: 'ask', question: 'Which?' },
      { kind: 'finish', summary: 'Done.' },
    ])
  })
})
