/**
 * The manager tools (manager-tools.ts) as an MCP server on 127.0.0.1, over
 * Streamable HTTP (MCP 2025-03-26 and later), for the worker agent to call.
 *
 * It lives in the adapter, outside the agent's Seatbelt profile
 * (agent-profile.ts). The profile lets the agent reach every port on this
 * Mac, so every job's server is reachable from every job: the per-launch
 * bearer is what keeps one job from calling another's tools. The
 * agent gets it as an HTTP MCP server with the bearer in an Authorization
 * header when it advertises `mcpCapabilities.http`; otherwise through the
 * stdio proxy (mcp-proxy.ts), a child of the agent inside the fence that
 * forwards each message here with the same bearer.
 *
 * The guard, like launcher/server-guard.ts: a random port on 127.0.0.1 only,
 * a random 32-byte bearer per launch checked in constant time, a bare 403 to
 * any request with an `Origin` header or a Host other than
 * `127.0.0.1:<port>` (DNS rebinding), and only `POST /mcp`.
 *
 * The protocol subset: `initialize`, `ping`, `tools/list`, `tools/call`, and
 * the `notifications/initialized` and `notifications/cancelled` notifications.
 * Each request is answered with one `application/json` body (no SSE: the
 * server never starts a message of its own); a GET for the optional server
 * stream gets 405, as the spec allows.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { MANAGER_TOOLS, type ManagerToolResult } from './manager-tools.js'

/** Newest first; an unknown version from the client is answered with the newest. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
export const MCP_PATH = '/mcp'
/** The largest request body read: a workspace tool's input may be up to 1 MB (workspace-tools.ts), plus its envelope. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024
/** The most messages one batch may hold; they run one after another. */
export const MAX_BATCH = 32

export const SERVER_INSTRUCTIONS =
  'Native Intelligence, who gave you this job: use report for progress, ask_manager when you are blocked, and finish when the request is done.'

type JsonRpcId = string | number
interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: JsonRpcId | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

export type ToolCall = (name: string, args: unknown, signal: AbortSignal) => Promise<ManagerToolResult>

/** A tool as listed: the manager's three, then the job's workspace tools. */
export interface ListedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: Record<string, unknown>
}

export interface RpcContext {
  readonly call: ToolCall
  /** The tools listed and callable (default: the manager's). */
  readonly tools?: readonly ListedTool[]
  /** The server's instructions (default: SERVER_INSTRUCTIONS). */
  readonly instructions?: string
  /** Calls in flight, by request id, so `notifications/cancelled` can abort one. */
  readonly inflight: Map<JsonRpcId, AbortController>
  readonly log?: (line: string) => void
}

const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } })
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result })

function isRequest(v: unknown): v is JsonRpcRequest {
  return !!v && typeof v === 'object' && (v as { jsonrpc?: unknown }).jsonrpc === '2.0' && typeof (v as { method?: unknown }).method === 'string'
}

function hasId(m: JsonRpcRequest): m is JsonRpcRequest & { id: JsonRpcId } {
  return typeof m.id === 'string' || typeof m.id === 'number'
}

/**
 * One JSON-RPC message: the response for a request, null for a notification
 * (or a response from the client, which this server never asks for).
 * `signal` aborts a tool call when the HTTP client goes away.
 */
export async function handleRpcMessage(msg: unknown, ctx: RpcContext, signal?: AbortSignal): Promise<object | null> {
  if (!isRequest(msg)) {
    const id = msg && typeof msg === 'object' ? (msg as { id?: unknown }).id : undefined
    const isClientResponse = !!msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)
    if (isClientResponse) return null
    return rpcError(typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid Request')
  }
  if (!hasId(msg)) {
    if (msg.method === 'notifications/cancelled') {
      const requestId = msg.params?.requestId
      if (typeof requestId === 'string' || typeof requestId === 'number') ctx.inflight.get(requestId)?.abort()
    }
    return null // notifications/initialized and any other notification
  }
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : SUPPORTED_PROTOCOL_VERSIONS[0]
      const client = msg.params?.clientInfo as { name?: unknown; version?: unknown } | undefined
      ctx.log?.(`[worker] MCP initialize from ${String(client?.name ?? '?')} ${String(client?.version ?? '')} (protocol ${String(asked)} → ${protocolVersion})`)
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'native-intelligence', version: '1.0.0' },
        instructions: ctx.instructions ?? SERVER_INSTRUCTIONS,
      })
    }
    case 'ping':
      return rpcResult(msg.id, {})
    case 'tools/list':
      return rpcResult(msg.id, { tools: (ctx.tools ?? MANAGER_TOOLS).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) })
    case 'tools/call': {
      const name = msg.params?.name
      if (typeof name !== 'string') return rpcError(msg.id, -32602, 'tools/call needs a tool name')
      if (!(ctx.tools ?? MANAGER_TOOLS).some((t) => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`)
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) controller.abort()
      ctx.inflight.set(msg.id, controller)
      try {
        const res = await ctx.call(name, msg.params?.arguments ?? {}, controller.signal)
        return rpcResult(msg.id, { content: [{ type: 'text', text: res.text }], isError: res.isError })
      } finally {
        ctx.inflight.delete(msg.id)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
  }
}

export interface ManagerMcpServer {
  readonly port: number
  readonly url: string
  /** The bearer the agent sends; never logged. */
  readonly token: string
  close(): Promise<void>
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = new TextEncoder().encode(`Bearer ${token}`)
  const got = new TextEncoder().encode(header ?? '')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  if (body === undefined) {
    res.writeHead(status, headers).end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers }).end(text)
}

/** The body as UTF-8 text, or null past MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) return null
    text += decoder.decode(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), { stream: true })
  }
  return text + decoder.decode()
}

/** Start the server on a random 127.0.0.1 port. */
export async function startManagerMcp(
  call: ToolCall,
  opts: { log?: (line: string) => void; workspaceTools?: readonly ListedTool[]; workspaceInstructions?: string } = {},
): Promise<ManagerMcpServer> {
  const token = randomBytes(32).toString('base64url')
  // Workspace tools join the manager's on ONE server (one list); their section follows our instructions.
  const ctx: RpcContext = {
    call,
    inflight: new Map(),
    log: opts.log,
    ...(opts.workspaceTools ? { tools: [...MANAGER_TOOLS, ...opts.workspaceTools] } : {}),
    ...(opts.workspaceInstructions ? { instructions: `${SERVER_INSTRUCTIONS}\n\n${opts.workspaceInstructions}` } : {}),
  }
  let port = 0

  const server: Server = createServer(async (req, res) => {
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) return send(res, 403)
    const path = (req.url ?? '').split('?')[0]
    if (path !== MCP_PATH) return send(res, 404)
    if (!bearerMatches(req.headers.authorization, token)) return send(res, 401, undefined, { 'www-authenticate': 'Bearer' })
    if (req.method !== 'POST') return send(res, 405, undefined, { allow: 'POST' })

    // A client that hangs up mid-call aborts the call.
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) gone.abort()
    })

    const body = await readBody(req)
    if (body === null) return send(res, 413)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return send(res, 400, rpcError(null, -32700, 'Parse error'))
    }
    try {
      if (Array.isArray(parsed)) {
        if (parsed.length === 0 || parsed.length > MAX_BATCH) return send(res, 400, rpcError(null, -32600, `A batch holds 1 to ${MAX_BATCH} messages`))
        // One call at a time: a batch can't start more commands at once than a client sending them one by one.
        const out: object[] = []
        for (const m of parsed) {
          const r = await handleRpcMessage(m, ctx, gone.signal)
          if (r !== null) out.push(r)
        }
        return out.length ? send(res, 200, out) : send(res, 202)
      }
      const out = await handleRpcMessage(parsed, ctx, gone.signal)
      return out ? send(res, 200, out) : send(res, 202)
    } catch (err) {
      opts.log?.(`[worker] MCP request failed: ${err instanceof Error ? err.message : String(err)}`)
      return send(res, 500, rpcError(null, -32603, 'Internal error'))
    }
  })
  server.requestTimeout = 0
  server.timeout = 0
  server.headersTimeout = 60_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port

  return {
    port,
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of ctx.inflight.values()) c.abort()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
