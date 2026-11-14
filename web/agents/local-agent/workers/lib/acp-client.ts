/**
 * The client side of the Agent Client Protocol (https://agentclientprotocol.com):
 * JSON-RPC 2.0, one message per line, over the agent process's stdio. Plain
 * code on purpose (no SDK): the adapter needs requests, notifications, and the
 * agent's own requests answered, nothing more.
 */
import type { Readable, Writable } from 'node:stream'
import { createLineSplitter } from './protocol.js'

/** ACP's "authentication required" error (ErrorCode -32000). */
export const AUTH_REQUIRED = -32000
/** JSON-RPC "method not found": what the client answers to a method it did not advertise. */
export const METHOD_NOT_FOUND = -32601

/** The longest line read from the agent (a whole file's diff can sit in one update). */
export const AGENT_LINE_LIMIT = 64 * 1024 * 1024

export class AcpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

/** The slice of a child process the connection uses (a real one, or a test double). */
export interface AgentStdio {
  readonly stdin: Writable
  readonly stdout: Readable
}

export interface AcpHandlers {
  /** A notification from the agent (`session/update`). */
  notification(method: string, params: unknown): void
  /** A request from the agent: its result, or a thrown AcpError. */
  request(method: string, params: unknown): Promise<unknown> | unknown
  log(line: string): void
}

type Id = number | string

export class AcpConnection {
  private nextId = 1
  private readonly pending = new Map<Id, { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private closed: Error | null = null

  constructor(
    private readonly io: AgentStdio,
    private readonly handlers: AcpHandlers,
  ) {
    io.stdin.on('error', () => {}) // an agent that died: its exit says why
    const lines = createLineSplitter((line) => line.trim() && this.onLine(line), {
      maxBytes: AGENT_LINE_LIMIT,
      onTooLong: () => handlers.log(`[worker] dropped a line from the agent over ${AGENT_LINE_LIMIT} bytes`),
    })
    io.stdout.on('data', (chunk: Buffer) => lines.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    io.stdout.on('end', () => lines.end())
  }

  private send(msg: object) {
    if (this.closed) return
    this.io.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** The agent went away: every request still waiting fails with `reason`. */
  close(reason: Error) {
    if (this.closed) return
    this.closed = reason
    for (const p of this.pending.values()) p.reject(reason)
    this.pending.clear()
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.handlers.log(`[worker] the agent wrote a line that is not JSON: ${line.slice(0, 200)}`)
      return
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return
    const id = msg.id as Id | undefined
    if (typeof msg.method === 'string') {
      if (id === undefined || id === null) {
        this.handlers.notification(msg.method, msg.params)
        return
      }
      void this.answer(id, msg.method, msg.params)
      return
    }
    if (id === undefined || id === null) return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    const error = msg.error as { code?: unknown; message?: unknown; data?: unknown } | undefined
    if (error) p.reject(new AcpError(p.method, typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'error', error.data))
    else p.resolve(msg.result)
  }

  private async answer(id: Id, method: string, params: unknown) {
    try {
      const result = await this.handlers.request(method, params)
      this.send({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      const e = err instanceof AcpError ? err : new AcpError(method, -32603, err instanceof Error ? err.message : String(err))
      this.send({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message } })
    }
  }
}
