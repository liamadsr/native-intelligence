/**
 * One Chrome DevTools Protocol connection to the cloud browser's Chrome
 * (docs/plans/cloud-browser.md, C1). Flat sessions: every page and frame target
 * is a `sessionId` on this one socket. Runs in the sandbox (Node 22+, global
 * WebSocket), next to Chrome on 127.0.0.1.
 */

export type CdpParams = Record<string, unknown>
type Listener = (params: CdpParams, sessionId: string | undefined) => void
type Pending = { method: string; resolve: (value: CdpParams) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** The desktop's EVAL_TIMEOUT_MS: no single browser call waits longer. */
export const CDP_CALL_TIMEOUT_MS = 15_000

/** What a page and the browser need of a connection (a fake one in tests). */
export type CdpTransport = Pick<CdpConnection, 'send' | 'on' | 'close'>

export class CdpError extends Error {
  constructor(readonly method: string, message: string, readonly code?: number) {
    super(`${method}: ${message}`)
    this.name = 'CdpError'
  }
}

export class CdpConnection {
  private next = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<Listener>>()
  private closeListeners = new Set<() => void>()
  private isClosed = false

  private constructor(private ws: WebSocket) {
    ws.onmessage = event => this.receive(String(event.data))
    ws.onclose = () => this.shutdown()
    ws.onerror = () => this.shutdown()
  }

  /** Connect to the browser target: a port on 127.0.0.1 or a ws:// URL. */
  static async connect(endpoint: number | string, timeoutMs = 5_000): Promise<CdpConnection> {
    let url = String(endpoint)
    if (typeof endpoint === 'number') {
      const response = await fetch(`http://127.0.0.1:${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
      const version = await response.json() as { webSocketDebuggerUrl?: unknown }
      if (typeof version.webSocketDebuggerUrl !== 'string') throw new Error('Chrome reported no DevTools endpoint')
      url = version.webSocketDebuggerUrl
    }
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connect timed out')) }, timeoutMs)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP connect failed')) }
    })
    return new CdpConnection(ws)
  }

  get closed() { return this.isClosed }

  send<T extends CdpParams = CdpParams>(method: string, params: CdpParams = {}, sessionId?: string,
    timeoutMs = CDP_CALL_TIMEOUT_MS): Promise<T> {
    if (this.isClosed) return Promise.reject(new CdpError(method, 'connection closed'))
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(method, 'timed out'))
      }, timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (value: CdpParams) => void, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /** Listen for an event on any session; the listener gets the event's sessionId. */
  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(listener)
    return () => { set.delete(listener) }
  }

  onClose(listener: () => void): () => void {
    if (this.isClosed) { listener(); return () => {} }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  close() {
    this.ws.close()
    this.shutdown()
  }

  private receive(raw: string) {
    let message: { id?: number; method?: string; params?: CdpParams; result?: CdpParams; sessionId?: string
      error?: { message?: string; code?: number; data?: string } }
    try { message = JSON.parse(raw) } catch { return }
    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) {
        const detail = message.error.data ? `: ${message.error.data}` : ''
        call.reject(new CdpError(call.method, `${message.error.message ?? 'error'}${detail}`, message.error.code))
      } else call.resolve(message.result ?? {})
      return
    }
    if (!message.method) return
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId)
  }

  private shutdown() {
    if (this.isClosed) return
    this.isClosed = true
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new CdpError(call.method, 'connection closed')) }
    this.pending.clear()
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}
