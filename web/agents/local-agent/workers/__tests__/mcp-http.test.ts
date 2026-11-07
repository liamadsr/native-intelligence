/**
 * The fence's MCP server: the JSON-RPC subset on its own, then the real HTTP
 * server on 127.0.0.1 with its guard (bearer, Host, Origin, path, method).
 */
import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FENCE_TOOLS } from '../lib/fence-tools'
import { MAX_BATCH, MCP_PATH, SUPPORTED_PROTOCOL_VERSIONS, handleRpcMessage, startFenceMcp, type FenceMcpServer, type RpcContext, type ToolCall } from '../lib/mcp-http'

const ctx = (call: ToolCall = async (name) => ({ text: `called ${name}`, isError: false })): RpcContext => ({ call, inflight: new Map() })

describe('handleRpcMessage', () => {
  it('initializes on the client version when known, else the newest', async () => {
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx())).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dial8-workspace' } },
    })
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, ctx())).toMatchObject({
      result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] },
    })
  })

  it('lists the fence tools and calls one', async () => {
    const list = (await handleRpcMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, ctx())) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(FENCE_TOOLS.map((t) => t.name))
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' } } }, ctx())).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'called bash' }], isError: false },
    })
  })

  it('refuses unknown tools and methods, and answers nothing to notifications', async () => {
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'Bash' } }, ctx())).toMatchObject({ error: { code: -32602 } })
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, ctx())).toMatchObject({ error: { code: -32601 } })
    expect(await handleRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx())).toBeNull()
    expect(await handleRpcMessage({ jsonrpc: '2.0', id: 7, result: {} }, ctx())).toBeNull()
    expect(await handleRpcMessage({ nope: true }, ctx())).toMatchObject({ error: { code: -32600 } })
  })

  it('aborts a call on notifications/cancelled', async () => {
    const c = ctx((_name, _args, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: 'stopped', isError: true }))))
    const pending = handleRpcMessage({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'bash', arguments: {} } }, c)
    await new Promise((r) => setTimeout(r, 5))
    expect(c.inflight.has('call-1')).toBe(true)
    await handleRpcMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } }, c)
    expect(await pending).toMatchObject({ result: { isError: true, content: [{ text: 'stopped' }] } })
    expect(c.inflight.size).toBe(0)
  })
})

describe('the HTTP server', () => {
  let server: FenceMcpServer
  const calls: string[] = []

  beforeAll(async () => {
    server = await startFenceMcp(async (name, args) => {
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
    const call = await send({ body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a' } } } })
    expect(JSON.parse(call.body).result.content[0].text).toBe('{"path":"a"}')
    const batch = await send({ body: [{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }] })
    expect(JSON.parse(batch.body)).toEqual([{ jsonrpc: '2.0', id: 3, result: {} }])
  })

  it('refuses a missing or wrong bearer, a browser, a rebound Host, other paths and methods', async () => {
    const before = calls.length
    const body = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'bash', arguments: {} } }
    expect((await send({ body, headers: { authorization: '' } })).status).toBe(401)
    expect((await send({ body, headers: { authorization: `Bearer ${server.token.slice(1)}x` } })).status).toBe(401)
    expect((await send({ body, headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await send({ body, headers: { host: `localhost:${server.port}` } })).status).toBe(403)
    expect((await send({ body, path: '/other' })).status).toBe(404)
    expect((await send({ method: 'GET' })).status).toBe(405)
    expect((await send({ body: 'not json' })).status).toBe(400)
    expect(calls.length).toBe(before)
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
    const slow = await startFenceMcp(async (name) => {
      running += 1
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 20))
      running -= 1
      return { text: name, isError: false }
    })
    try {
      const body = Array.from({ length: 4 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a' } } }))
      const res = await fetch(slow.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${slow.token}` }, body: JSON.stringify(body) })
      expect((await res.json()).map((m: { id: number }) => m.id)).toEqual([0, 1, 2, 3])
      expect(most).toBe(1)
    } finally {
      await slow.close()
    }
  })
})
