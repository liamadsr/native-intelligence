/**
 * A JSON-RPC connection, one message per line, over a child's stdio: what
 * `codex app-server` speaks (codex-app-server.ts). Codex leaves out the
 * `"jsonrpc": "2.0"` member, so lines are read with or without it and sent
 * without it. Requests, notifications, and the agent's own requests answered;
 * nothing more.
 */
import type { Readable, Writable } from 'node:stream'
import { jsonLines } from './agent-link.js'

/** JSON-RPC "method not found": the answer to a request this client does not serve. */
export const METHOD_NOT_FOUND = -32601

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface RpcHandlers {
  notification(method: string, params: unknown): void
  /** A request from the agent: its result, or a thrown RpcError. */
  request(method: string, params: unknown): Promise<unknown> | unknown
  /** A line that is not a JSON object. */
  other(line: string): void
}

type Id = number | string

export class RpcConnection {
  private nextId = 1
  private readonly pending = new Map<Id, { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private closed: Error | null = null

  constructor(
    private readonly io: { readonly stdin: Writable; readonly stdout: Readable },
    private readonly handlers: RpcHandlers,
  ) {
    io.stdin.on('error', () => {}) // an agent that died: its exit says why
    jsonLines(io.stdout, (msg) => this.onMessage(msg), handlers.other)
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
      this.send({ id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params })
  }

  /** The agent went away: every request still waiting fails with `reason`. */
  close(reason: Error) {
    if (this.closed) return
    this.closed = reason
    for (const p of this.pending.values()) p.reject(reason)
    this.pending.clear()
  }

  private onMessage(msg: Record<string, unknown>) {
    const id = msg.id as Id | undefined | null
    if (typeof msg.method === 'string') {
      if (id === undefined || id === null) return this.handlers.notification(msg.method, msg.params)
      return void this.answer(id, msg.method, msg.params)
    }
    if (id === undefined || id === null) return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    const error = msg.error as { code?: unknown; message?: unknown; data?: unknown } | undefined
    if (error) p.reject(new RpcError(p.method, typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'error', error.data))
    else p.resolve(msg.result)
  }

  private async answer(id: Id, method: string, params: unknown) {
    try {
      const result = await this.handlers.request(method, params)
      this.send({ id, result: result ?? null })
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(method, -32603, err instanceof Error ? err.message : String(err))
      this.send({ id, error: { code: e.code, message: e.message } })
    }
  }
}
