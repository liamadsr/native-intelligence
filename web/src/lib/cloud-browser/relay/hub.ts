import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { verifySandboxToken } from '../viewer-token'
import type { ExitHub } from './exit'

/**
 * The hub (docs/plans/cloud-browser.md, C3): the sandbox's one published port.
 * It holds only the public key, so every request proves itself with a token
 * the server signed for this sandbox; the platform's proxy passes client
 * addresses through unchanged, so the token is the only lock.
 *
 * - `/viewer` (WebSocket): the live view. The client's first message is its
 *   token, never the URL. The hub then opens the VNC server it may use (the
 *   view-only one, or the one with input while the person has taken over),
 *   says `ok`, and pipes bytes once the client says `go` (by then noVNC is
 *   listening). A control session ends when its token does; the client asks
 *   for a fresh one, so handing the browser back takes effect.
 *   The VNC servers listen on unix sockets in a 0700 directory, never TCP: a
 *   page in the sandbox's Chrome could reach a loopback port, and with it the
 *   browser, around the token and the driver lock.
 * - `/thumbnail` (GET, Bearer token): a small JPEG of the agent's tab, for the
 *   computer card. Never wakes anything: the browser is already running.
 * - `/exit` (WebSocket, C4): the person's Mac's tunnel (exit.ts), with its own token.
 */

export interface HubOptions {
  port: number
  sandbox: string
  /** The server's public key (base64 SPKI DER). */
  verifyKey: string
  /** x11vnc's unix sockets: one view-only, one that takes input. */
  vncSockets: { view: string; control: string }
  thumbnail(): Promise<Buffer | null>
  log?: (event: string, fields?: Record<string, unknown>) => void
  /** The port stayed taken: the process should exit, so the next start runs a hub again. */
  onFatal?: (error: Error) => void
  /** The Mac exit (C4): `/exit` hands its WebSockets here. */
  exit?: ExitHub
}

/** At most this many viewers at once (a phone, a desktop, a laptop and one spare). */
const MAX_VIEWERS = 4
/** Sockets still owing their token: a few, so strangers can't hold the viewers' places. */
const MAX_PENDING = 8
/** How long a viewer has to send its token, and then `go`. */
const HANDSHAKE_MS = 5000
/** A viewer that reads slower than the screen changes: VNC waits above this much unsent. */
const BUFFER_HIGH = 4 * 1024 * 1024
/** A listen that finds the port taken (an old relay still exiting) tries again, this often, this many times. */
const LISTEN_RETRY_MS = 500
const LISTEN_RETRIES = 20

export function startHub(options: HubOptions) {
  const log = options.log ?? (() => {})
  const viewers = new Set<WebSocket>()
  const pending = new Set<WebSocket>()
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization', 'access-control-allow-methods': 'GET' }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/health') { res.writeHead(200).end('ok'); return }
    if (path === '/thumbnail' && req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return }
    if (path === '/thumbnail' && req.method === 'GET') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      if (!verifySandboxToken(token, 'browser-viewer', options.sandbox, options.verifyKey)) { res.writeHead(401, cors).end(); return }
      options.thumbnail().then(image => {
        if (!image) { res.writeHead(204, cors).end(); return }
        res.writeHead(200, { ...cors, 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).end(image)
      }, error => {
        log('hub.thumbnail_failed', { message: error instanceof Error ? error.message : String(error) })
        res.writeHead(503, cors).end()
      })
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  wss.on('error', error => log('hub.error', { message: error.message }))
  // A frame is at most 64 KiB of data plus its header.
  const exitWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
  exitWss.on('error', error => log('hub.error', { message: error.message }))
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/viewer') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    else if (path === '/exit' && options.exit) exitWss.handleUpgrade(req, socket, head, ws => options.exit!.attach(ws, req))
    else socket.destroy()
  })
  wss.on('connection', (ws: WebSocket) => {
    if (pending.size >= MAX_PENDING) { ws.close(4429, 'too many viewers'); return }
    pending.add(ws)
    let vnc: Socket | null = null
    let piping = false
    const held: Buffer[] = []
    let expiry: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(() => ws.close(4408, 'handshake timed out'), HANDSHAKE_MS)
    const end = () => {
      clearTimeout(deadline)
      clearTimeout(expiry)
      pending.delete(ws)
      viewers.delete(ws)
      vnc?.destroy()
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close()
    }
    ws.on('close', end)
    ws.on('error', end)
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (piping) {
        if (!isBinary) return
        const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
        vnc?.write(Array.isArray(data) ? u8(Buffer.concat(data.map(u8))) : Buffer.isBuffer(data) ? u8(data) : new Uint8Array(data))
        return
      }
      const text = isBinary ? '' : data.toString()
      if (!vnc) {
        const claims = verifySandboxToken(text, 'browser-viewer', options.sandbox, options.verifyKey)
        if (!claims) { ws.close(4401, 'unauthorized'); return }
        pending.delete(ws)
        if (viewers.size >= MAX_VIEWERS) { ws.close(4429, 'too many viewers'); return }
        viewers.add(ws)
        const control = claims.control === true
        const socket = connect({ path: control ? options.vncSockets.control : options.vncSockets.view })
        vnc = socket
        socket.on('connect', () => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ok: true, control })) })
        socket.on('data', chunk => {
          if (!piping) { held.push(chunk); return }
          ws.send(chunk, { binary: true })
          if (ws.bufferedAmount > BUFFER_HIGH) {
            socket.pause()
            const drained = setInterval(() => {
              if (ws.readyState !== ws.OPEN || ws.bufferedAmount < BUFFER_HIGH / 4) { clearInterval(drained); socket.resume() }
            }, 50)
          }
        })
        socket.on('close', end)
        socket.on('error', end)
        // Input stops with the token: the client must ask again, and gets control only while the person still drives.
        if (control) expiry = setTimeout(() => ws.close(4408, 'token expired'), Math.max(0, claims.exp - Date.now()))
        log('hub.viewer', { control })
        return
      }
      if (text === 'go') {
        clearTimeout(deadline)
        piping = true
        for (const chunk of held.splice(0)) ws.send(chunk, { binary: true })
      }
    })
  })

  let retries = 0
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && retries++ < LISTEN_RETRIES) {
      setTimeout(() => server.listen(options.port, '0.0.0.0'), LISTEN_RETRY_MS)
      return
    }
    log('hub.failed', { message: error.message })
    options.onFatal?.(error)
  })
  server.listen(options.port, '0.0.0.0')
  return {
    server,
    viewers: () => viewers.size,
    close() {
      for (const ws of [...viewers, ...pending]) ws.close(1001, 'hub stopping')
      wss.close()
      exitWss.close()
      server.close()
    },
  }
}
