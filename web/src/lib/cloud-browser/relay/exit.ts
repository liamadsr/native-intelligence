import { lookup } from 'node:dns/promises'
import type { IncomingMessage } from 'node:http'
import { connect, createServer, isIP, type Server, type Socket } from 'node:net'
import type { RawData, WebSocket } from 'ws'
import { EXIT_PORTS, isPublicAddress } from '../exit/address'
import { decodeFrame, encodeFrame, MAX_DATA, MAX_STREAMS, MUX_VERSION, WINDOW, type Frame, type Refusal } from '../exit/mux'
import { verifySandboxToken } from '../viewer-token'

/**
 * The Mac exit, the hub's side (docs/plans/cloud-browser.md, C4). Chrome's
 * only way out is the hub's SOCKS5 on 127.0.0.1 (`--proxy-server`), and the
 * hub sends each connection one of two ways, for the whole browser at once:
 *
 * - `mac`: over the person's Mac's tunnel (`/exit`, a WebSocket the Mac opens
 *   to the hub; its token is the first message). No tunnel, no connection:
 *   the hub refuses at once and never goes direct, so a sleeping Mac never
 *   turns into the cloud's own address. The session's network policy then
 *   allows only the relay's host, so nothing else could leave anyway.
 * - `cloud`: straight out from the sandbox, public addresses only.
 *
 * The relay picks the mode between tasks (runner.ts); a switch ends every open
 * connection, so none outlives it on the other address. Either way only ports
 * 80 and 443 go out, and never to the relay's own host (its requests carry the
 * relay's authority).
 *
 * The tunnel speaks mux v1 (exit/mux.ts): many streams on one WebSocket, each
 * with its own 512 KiB credit window. The hub pings every 5 s and gives the
 * tunnel up after 15 s of silence.
 */

export type ExitMode = 'mac' | 'cloud'

export interface ExitOptions {
  sandbox: string
  /** The server's public key (base64 SPKI DER). */
  verifyKey: string
  /** Chrome's proxy: SOCKS5 on 127.0.0.1. */
  socksPort: number
  /** Hosts never reached through the hub, whatever the mode (and their subdomains). */
  refusedHosts: string[]
  /** The mode it starts in (default `mac`: nothing leaves until the relay says the cloud may). */
  mode?: ExitMode
  log?: (event: string, fields?: Record<string, unknown>) => void
  /** For tests: which addresses a `cloud` connection may reach (default: public ones), and on which ports (default 80, 443). */
  allowAddress?: (address: string) => boolean
  ports?: number[]
  pingMs?: number
  silenceMs?: number
  openTimeoutMs?: number
}

/** SOCKS5 replies. */
const SOCKS = { ok: 0, general: 1, notAllowed: 2, networkUnreachable: 3, hostUnreachable: 4, refused: 5, command: 7, address: 8 } as const
const REFUSAL_REPLY: Record<Refusal, number> = { blocked: SOCKS.notAllowed, port: SOCKS.notAllowed, dns: SOCKS.hostUnreachable, connect: SOCKS.refused, busy: SOCKS.general }
const HELLO_MS = 5000

/** A Buffer as the plain Uint8Array the typings want. */
const u8 = (b: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
const bytes = (...values: number[]) => new Uint8Array(values)
const reply = (code: number) => bytes(5, code, 0, 1, 0, 0, 0, 0, 0, 0)
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

interface Stream {
  id: number
  socket: Socket
  opened: boolean
  /** Bytes the Mac still lets the hub send. */
  window: number
  /** Bytes read from Chrome, waiting for window. */
  pending: Uint8Array[]
  /** Chrome finished sending; FIN once pending is out. */
  finPending: boolean
  /** DATA from the Mac not yet credited back (never past WINDOW). */
  unacked: number
  timer?: ReturnType<typeof setTimeout>
  replied: (code: number) => void
}

interface Tunnel {
  ws: WebSocket
  device: string | null
  since: number
  lastSeen: number
  streams: Map<number, Stream>
  ping: ReturnType<typeof setInterval>
}

export function startExit(options: ExitOptions) {
  const log = options.log ?? (() => {})
  const allow = options.allowAddress ?? isPublicAddress
  const ports = options.ports ?? EXIT_PORTS
  const refused = new Set(options.refusedHosts.map(host => host.toLowerCase()))
  const pingMs = options.pingMs ?? 5000
  const silenceMs = options.silenceMs ?? 15_000
  const openTimeoutMs = options.openTimeoutMs ?? 15_000
  let mode: ExitMode = options.mode ?? 'mac'
  let tunnel: Tunnel | null = null
  let nextId = 1
  let nonce = BigInt(0)
  const clients = new Set<Socket>()
  const listeners = new Set<(up: boolean) => void>()
  const emit = (up: boolean) => { for (const listener of listeners) listener(up) }

  const send = (t: Tunnel, frame: Frame) => { if (t.ws.readyState === t.ws.OPEN) t.ws.send(encodeFrame(frame)) }

  // ── The tunnel ───────────────────────────────────────────────────────────
  /** End a tunnel's streams and its socket. */
  function drop(t: Tunnel) {
    clearInterval(t.ping)
    for (const stream of t.streams.values()) { clearTimeout(stream.timer); stream.replied(SOCKS.networkUnreachable); stream.socket.destroy() }
    t.streams.clear()
    if (t.ws.readyState === t.ws.OPEN || t.ws.readyState === t.ws.CONNECTING) t.ws.terminate()
  }

  function tunnelDown(t: Tunnel, reason: string) {
    if (tunnel !== t) return
    tunnel = null
    drop(t)
    log('exit.down', { reason })
    emit(false)
  }

  function onFrame(t: Tunnel, data: RawData, isBinary: boolean) {
    t.lastSeen = Date.now()
    if (!isBinary) return
    const raw = Array.isArray(data) ? data.map(chunk => u8(chunk)).reduce(concat, new Uint8Array(0)) : data instanceof ArrayBuffer ? new Uint8Array(data) : u8(data)
    const frame = decodeFrame(raw)
    if (!frame) { tunnelDown(t, 'malformed frame'); return }
    if (frame.type === 'ping') { send(t, { type: 'pong', nonce: frame.nonce }); return }
    if (frame.type === 'pong' || frame.type === 'open') return
    const stream = t.streams.get(frame.stream)
    if (!stream) return
    switch (frame.type) {
      case 'opened':
        if (stream.opened) return
        clearTimeout(stream.timer)
        stream.opened = true
        stream.replied(SOCKS.ok)
        stream.socket.resume()
        return
      case 'refused':
        clearTimeout(stream.timer)
        t.streams.delete(stream.id)
        stream.replied(REFUSAL_REPLY[frame.reason])
        stream.socket.destroy()
        return
      case 'data': {
        if (stream.unacked + frame.bytes.length > WINDOW) { reset(t, stream); return }
        stream.unacked += frame.bytes.length
        const n = frame.bytes.length
        stream.socket.write(frame.bytes, () => {
          stream.unacked -= n
          if (t.streams.get(stream.id) === stream) send(t, { type: 'credit', stream: stream.id, bytes: n })
        })
        return
      }
      case 'credit':
        stream.window = Math.min(stream.window + frame.bytes, WINDOW)
        flush(t, stream)
        return
      case 'fin':
        stream.socket.end()
        return
      case 'reset':
        t.streams.delete(stream.id)
        stream.socket.destroy()
        return
    }
  }

  function reset(t: Tunnel, stream: Stream) {
    t.streams.delete(stream.id)
    send(t, { type: 'reset', stream: stream.id })
    stream.socket.destroy()
  }

  /** Send what the window allows; Chrome waits (paused) for the rest. */
  function flush(t: Tunnel, stream: Stream) {
    while (stream.pending.length && stream.window > 0) {
      const head = stream.pending[0]
      const n = Math.min(head.length, stream.window, MAX_DATA)
      send(t, { type: 'data', stream: stream.id, bytes: head.subarray(0, n) })
      stream.window -= n
      if (n === head.length) stream.pending.shift()
      else stream.pending[0] = head.subarray(n)
    }
    if (stream.pending.length) { stream.socket.pause(); return }
    if (stream.finPending) { stream.finPending = false; send(t, { type: 'fin', stream: stream.id }) }
    else if (stream.opened) stream.socket.resume()
  }

  function attach(ws: WebSocket, req: IncomingMessage) {
    const timer = setTimeout(() => ws.close(4408, 'no hello'), HELLO_MS)
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer)
      let hello: { v?: unknown; token?: unknown } = {}
      try { hello = isBinary ? {} : JSON.parse(data.toString()) } catch { /* refused below */ }
      if (hello.v !== MUX_VERSION) { ws.close(4400, 'version'); return }
      const claims = verifySandboxToken(hello.token, 'browser-exit', options.sandbox, options.verifyKey)
      if (!claims) { ws.close(4401, 'unauthorized'); return }
      // One tunnel at a time: the newest wins (a Mac back from sleep, or another Mac of the person's).
      // It takes over at once: no moment without a tunnel, so nothing reads it as the Mac going away.
      const old = tunnel
      if (old) { tunnel = null; old.ws.close(4409, 'replaced'); drop(old) }
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
      const ip = forwarded || req.socket.remoteAddress || null
      const t: Tunnel = { ws, device: claims.deviceId ?? null, since: Date.now(), lastSeen: Date.now(), streams: new Map(),
        ping: setInterval(() => {
          if (Date.now() - t.lastSeen > silenceMs) { tunnelDown(t, 'silent'); return }
          nonce += BigInt(1)
          send(t, { type: 'ping', nonce })
        }, pingMs) }
      tunnel = t
      ws.on('message', (frame: RawData, binary: boolean) => onFrame(t, frame, binary))
      ws.on('close', () => tunnelDown(t, 'closed'))
      ws.on('error', () => tunnelDown(t, 'error'))
      ws.send(JSON.stringify({ ok: true, v: MUX_VERSION, ip }))
      log('exit.up', { device: t.device, replaced: !!old })
      if (!old) emit(true)
    })
    ws.on('close', () => clearTimeout(timer))
  }

  // ── Chrome's proxy ──────────────────────────────────────────────────────
  function viaTunnel(t: Tunnel, socket: Socket, host: string, port: number, rest: Uint8Array, replied: (code: number) => void) {
    if (t.streams.size >= MAX_STREAMS) { replied(SOCKS.general); socket.destroy(); return }
    while (t.streams.has(nextId)) nextId = nextId >= 0x7fffffff ? 1 : nextId + 1
    const id = nextId
    nextId = nextId >= 0x7fffffff ? 1 : nextId + 1
    const stream: Stream = { id, socket, opened: false, window: WINDOW, pending: rest.length ? [rest] : [], finPending: false, unacked: 0, replied }
    stream.timer = setTimeout(() => {
      if (stream.opened) return
      t.streams.delete(id)
      send(t, { type: 'reset', stream: id })
      replied(SOCKS.hostUnreachable)
      socket.destroy()
    }, openTimeoutMs)
    t.streams.set(id, stream)
    socket.on('data', (chunk: Buffer) => { stream.pending.push(u8(chunk)); if (stream.opened) flush(t, stream) })
    socket.on('end', () => { stream.finPending = true; if (stream.opened) flush(t, stream) })
    socket.on('close', () => {
      clearTimeout(stream.timer)
      if (t.streams.get(id) === stream) { t.streams.delete(id); send(t, { type: 'reset', stream: id }) }
    })
    send(t, { type: 'open', stream: id, host, port })
  }

  async function direct(socket: Socket, host: string, port: number, rest: Uint8Array, replied: (code: number) => void) {
    let addresses: string[]
    try { addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(entry => entry.address) } catch { addresses = [] }
    // The mode may have changed while the name resolved: never go direct in `mac` mode.
    if (mode !== 'cloud' || socket.destroyed) { replied(SOCKS.networkUnreachable); socket.destroy(); return }
    if (!addresses.length) { replied(SOCKS.hostUnreachable); socket.destroy(); return }
    if (addresses.some(address => !allow(address))) { replied(SOCKS.notAllowed); socket.destroy(); return }
    const upstream = connect({ host: addresses[0], port })
    const drop = () => { upstream.destroy(); socket.destroy() }
    upstream.once('connect', () => {
      replied(SOCKS.ok)
      if (rest.length) upstream.write(rest)
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.resume()
    })
    upstream.on('error', () => { replied(SOCKS.refused); drop() })
    socket.on('error', drop)
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  }

  function route(socket: Socket, host: string, port: number, rest: Uint8Array) {
    let answered = false
    const replied = (code: number) => {
      if (answered || socket.destroyed) return
      answered = true
      socket.write(reply(code))
    }
    const name = host.toLowerCase().replace(/\.$/, '')
    const refusedName = [...refused].some(h => name === h || name.endsWith(`.${h}`))
    if (!ports.includes(port) || refusedName || name === 'localhost' || name.endsWith('.localhost')) {
      replied(SOCKS.notAllowed); socket.end(); return
    }
    if (mode === 'mac') {
      if (!tunnel) { replied(SOCKS.networkUnreachable); socket.end(); return }
      viaTunnel(tunnel, socket, host, port, rest, replied)
      return
    }
    void direct(socket, host, port, rest, replied)
  }

  const socks: Server = createServer(socket => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => socket.destroy())
    let buf: Uint8Array = new Uint8Array(0)
    let greeted = false
    const onData = (chunk: Buffer) => {
      buf = concat(buf, u8(chunk))
      if (!greeted) {
        if (buf.length < 2) return
        if (buf[0] !== 5) { socket.destroy(); return }
        if (buf.length < 2 + buf[1]) return
        const methods = buf.subarray(2, 2 + buf[1])
        buf = buf.subarray(2 + buf[1])
        greeted = true
        if (!methods.includes(0)) { socket.end(bytes(5, 0xff)); return }
        socket.write(bytes(5, 0))
      }
      if (buf.length < 5) return
      if (buf[0] !== 5) { socket.destroy(); return }
      const [, command, , type] = buf
      let host: string
      let at: number
      if (type === 1) {
        if (buf.length < 10) return
        host = Array.from(buf.subarray(4, 8)).join('.'); at = 8
      } else if (type === 3) {
        const length = buf[4]
        if (buf.length < 5 + length + 2) return
        host = new TextDecoder().decode(buf.subarray(5, 5 + length)); at = 5 + length
      } else if (type === 4) {
        if (buf.length < 22) return
        const words: string[] = []
        for (let i = 0; i < 8; i++) words.push(((buf[4 + i * 2] << 8) | buf[5 + i * 2]).toString(16))
        // Canonical (compressed) form, so an IPv4 inside it is recognised (::ffff:a00:1).
        host = new URL(`http://[${words.join(':')}]/`).hostname.slice(1, -1); at = 20
      } else {
        socket.end(reply(SOCKS.address)); return
      }
      const port = (buf[at] << 8) | buf[at + 1]
      const rest = buf.slice(at + 2)
      socket.off('data', onData)
      socket.pause()
      if (command !== 1) { socket.end(reply(SOCKS.command)); return }
      route(socket, host, port, rest)
    }
    socket.on('data', onData)
  })
  socks.on('error', error => log('exit.socks_error', { message: error.message }))
  socks.listen(options.socksPort, '127.0.0.1')

  return {
    socks,
    attach,
    tunnelUp: () => tunnel !== null,
    tunnelDevice: () => tunnel?.device ?? null,
    mode: () => mode,
    /** Route every connection from now on this way; any open one ends now. */
    setMode(next: ExitMode) {
      if (next === mode) return
      mode = next
      if (tunnel) {
        for (const stream of tunnel.streams.values()) { clearTimeout(stream.timer); send(tunnel, { type: 'reset', stream: stream.id }) }
        tunnel.streams.clear()
      }
      for (const socket of clients) socket.destroy()
      log('exit.mode', { mode })
    },
    onTunnel(listener: (up: boolean) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close() {
      if (tunnel) tunnelDown(tunnel, 'closing')
      for (const socket of clients) socket.destroy()
      socks.close()
    },
  }
}

export type ExitHub = ReturnType<typeof startExit>
