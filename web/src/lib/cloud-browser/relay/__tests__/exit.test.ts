/**
 * The Mac exit, the hub's side (src/lib/cloud-browser/relay/exit.ts), with real
 * sockets: a stand-in Mac on the tunnel, a SOCKS5 client as Chrome. In `mac`
 * mode every connection goes over the tunnel, and with no tunnel the hub
 * refuses at once (never direct); `cloud` goes direct; a switch ends what was
 * open; only 80/443, never the relay's host; the tunnel's token, version,
 * credit window and silence.
 */
import { generateKeyPairSync } from 'node:crypto'
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { decodeFrame, encodeFrame, WINDOW, type Frame } from '../../exit/mux'
import { sandboxVerifyKey, signSandboxToken } from '../../viewer-token'
import { startExit, type ExitHub } from '../exit'

const { privateKey } = generateKeyPairSync('ed25519')
const exitToken = (sandbox = 'browser-a', aud: 'browser-exit' | 'browser-viewer' = 'browser-exit') =>
  signSandboxToken({ aud, userId: 'u1', workspaceId: 'w1', sandbox, deviceId: 'mac-1' }, 60_000, privateKey)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(done: () => boolean, ms = 3000) { for (let t = 0; t < ms && !done(); t += 20) await sleep(20) }

let exit: ExitHub
let http: HttpServer
let tunnelUrl = ''
let socksPort = 0
let site: Server
let sitePort = 0
const events: string[] = []

beforeEach(async () => {
  events.length = 0
  // A site: echoes what it gets, upper-cased.
  site = createServer(socket => socket.on('data', chunk => socket.write(chunk.toString().toUpperCase())))
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
  sitePort = (site.address() as AddressInfo).port
  exit = startExit({ sandbox: 'browser-a', verifyKey: sandboxVerifyKey(privateKey), socksPort: 0, refusedHosts: ['browser-relay.dial8.ai'],
    allowAddress: () => true, ports: [80, 443, sitePort], mode: 'cloud', pingMs: 100, silenceMs: 400, openTimeoutMs: 1000, log: event => events.push(event) })
  await until(() => exit.socks.listening)
  socksPort = (exit.socks.address() as AddressInfo).port
  const wss = new WebSocketServer({ noServer: true })
  http = createHttpServer()
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => exit.attach(ws, req)))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  tunnelUrl = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/exit`
})
afterEach(() => { exit.close(); http.close(); site.close() })

/** A stand-in Mac: says hello, then opens each stream to the local site (the Mac's own policy is its own test). */
function mac(options: { token?: string; v?: number; credit?: boolean; silent?: boolean } = {}) {
  const ws = new WebSocket(tunnelUrl)
  const frames: Frame[] = []
  const state = { hello: null as Record<string, unknown> | null, closed: null as number | null, received: 0 }
  const sockets = new Map<number, Socket>()
  const send = (frame: Frame) => ws.send(encodeFrame(frame))
  ws.on('open', () => ws.send(JSON.stringify({ v: options.v ?? 1, token: options.token ?? exitToken() })))
  ws.on('close', code => { state.closed = code })
  ws.on('message', (data, isBinary) => {
    if (!isBinary) { state.hello = JSON.parse(data.toString()); return }
    const frame = decodeFrame(new Uint8Array(data as Buffer))!
    frames.push(frame)
    if (options.silent) return
    if (frame.type === 'ping') send({ type: 'pong', nonce: frame.nonce })
    if (frame.type === 'open') {
      const socket = connect(sitePort, '127.0.0.1', () => send({ type: 'opened', stream: frame.stream }))
      sockets.set(frame.stream, socket)
      socket.on('data', chunk => send({ type: 'data', stream: frame.stream, bytes: new Uint8Array(chunk) }))
    }
    if (frame.type === 'data') {
      state.received += frame.bytes.length
      sockets.get(frame.stream)?.write(frame.bytes)
      if (options.credit !== false) send({ type: 'credit', stream: frame.stream, bytes: frame.bytes.length })
    }
    if (frame.type === 'reset') sockets.get(frame.stream)?.destroy()
  })
  return { ws, frames, state, send }
}

/** Chrome's side: SOCKS5 CONNECT to host:port; resolves with the reply code and the socket. */
function socksConnect(host: string, port: number): Promise<{ code: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socksPort, '127.0.0.1')
    let stage = 0
    socket.on('error', reject)
    socket.on('connect', () => socket.write(new Uint8Array([5, 1, 0])))
    socket.on('data', function onData(chunk) {
      if (stage === 0) {
        stage = 1
        const name = new TextEncoder().encode(host)
        socket.write(new Uint8Array([5, 1, 0, 3, name.length, ...name, port >> 8, port & 255]))
        return
      }
      socket.off('data', onData)
      resolve({ code: chunk[1], socket })
    })
    socket.on('close', () => resolve({ code: -1, socket }))
  })
}

const read = (socket: Socket) => new Promise<string>(resolve => socket.once('data', chunk => resolve(chunk.toString())))

describe('the tunnel', () => {
  it('takes a Mac with a valid exit token, and tells it the IP it came from', async () => {
    const m = mac()
    await until(() => m.state.hello !== null)
    expect(m.state.hello).toEqual({ ok: true, v: 1, ip: '127.0.0.1' })
    expect(exit.tunnelUp()).toBe(true)
    expect(exit.tunnelDevice()).toBe('mac-1')
    m.ws.close()
  })

  it('refuses another sandbox’s token, a viewer token, and another version', async () => {
    for (const [options, code] of [[{ token: exitToken('browser-b') }, 4401], [{ token: exitToken('browser-a', 'browser-viewer') }, 4401], [{ v: 2 }, 4400]] as const) {
      const m = mac(options)
      await until(() => m.state.closed !== null)
      expect(m.state.closed).toBe(code)
    }
    expect(exit.tunnelUp()).toBe(false)
  })

  it('lets a newer tunnel take over at once, closing the older one, never a moment without a Mac', async () => {
    const seen: boolean[] = []
    exit.onTunnel(up => seen.push(up))
    const first = mac()
    await until(() => first.state.hello !== null)
    const second = mac()
    await until(() => second.state.hello !== null && first.state.closed !== null)
    expect(first.state.closed).toBe(4409)
    expect(exit.tunnelUp()).toBe(true)
    expect(seen).toEqual([true])
    second.ws.close()
  })

  it('starts refusing everything unless told otherwise (nothing leaves before the relay decides)', async () => {
    const boot = startExit({ sandbox: 'browser-a', verifyKey: sandboxVerifyKey(privateKey), socksPort: 0, refusedHosts: [], ports: [sitePort] })
    await until(() => boot.socks.listening)
    expect(boot.mode()).toBe('mac')
    const port = socksPort
    socksPort = (boot.socks.address() as AddressInfo).port
    expect((await socksConnect('127.0.0.1', sitePort)).code).toBe(3)
    socksPort = port
    boot.close()
  })

  it('gives a silent Mac up, and refuses at once from then on', async () => {
    exit.setMode('mac')
    const m = mac({ silent: true })
    await until(() => m.state.hello !== null)
    await until(() => !exit.tunnelUp(), 2000)
    expect(exit.tunnelUp()).toBe(false)
    expect((await socksConnect('example.com', 443)).code).toBe(3)
  })
})

describe('Chrome’s proxy', () => {
  it('in mac mode, carries a connection over the tunnel both ways', async () => {
    exit.setMode('mac')
    const m = mac()
    await until(() => exit.tunnelUp())
    const { code, socket } = await socksConnect('shop.example', 443)
    expect(code).toBe(0)
    const open = m.frames.find(frame => frame.type === 'open')
    expect(open).toMatchObject({ host: 'shop.example', port: 443 })
    socket.write('hello')
    expect(await read(socket)).toBe('HELLO')
    socket.destroy()
    m.ws.close()
  })

  it('in mac mode with no tunnel, refuses at once and never goes direct', async () => {
    exit.setMode('mac')
    let direct = 0
    site.on('connection', () => direct++)
    const { code } = await socksConnect('127.0.0.1', 443)
    expect(code).toBe(3)
    expect(direct).toBe(0)
  })

  it('never sends a stream more than its window before the Mac credits it', async () => {
    exit.setMode('mac')
    const m = mac({ credit: false })
    await until(() => exit.tunnelUp())
    const { socket } = await socksConnect('big.example', 443)
    socket.write(new Uint8Array(WINDOW * 2).fill(1))
    await until(() => m.state.received >= WINDOW)
    await sleep(200)
    expect(m.state.received).toBe(WINDOW)
    const stream = (m.frames.find(frame => frame.type === 'open') as { stream: number }).stream
    m.send({ type: 'credit', stream, bytes: 1000 })
    await until(() => m.state.received > WINDOW)
    expect(m.state.received).toBe(WINDOW + 1000)
    socket.destroy()
    m.ws.close()
  })

  it('in cloud mode, goes direct, and never over a tunnel that is up', async () => {
    const m = mac()
    await until(() => exit.tunnelUp())
    const { code, socket } = await socksConnect('127.0.0.1', sitePort)
    expect(code).toBe(0)
    socket.write('direct')
    expect(await read(socket)).toBe('DIRECT')
    expect(m.frames.some(frame => frame.type === 'open')).toBe(false)
    socket.destroy()
    m.ws.close()
  })

  it('in cloud mode, refuses an address that isn’t public', async () => {
    const strict = startExit({ sandbox: 'browser-a', verifyKey: sandboxVerifyKey(privateKey), socksPort: 0, refusedHosts: [], ports: [sitePort], mode: 'cloud' })
    await until(() => strict.socks.listening)
    const port = socksPort
    socksPort = (strict.socks.address() as AddressInfo).port
    expect((await socksConnect('127.0.0.1', sitePort)).code).toBe(2)
    socksPort = port
    strict.close()
  })

  it('only ever opens ports 80 and 443, and never the relay’s host', async () => {
    exit.setMode('mac')
    const m = mac()
    await until(() => exit.tunnelUp())
    for (const [host, port] of [['example.com', 22], ['example.com', 8443], ['browser-relay.dial8.ai', 443], ['x.browser-relay.dial8.ai', 443], ['localhost', 443], ['a.localhost', 80]] as const)
      expect((await socksConnect(host, port)).code, `${host}:${port}`).toBe(2)
    expect(m.frames.some(frame => frame.type === 'open')).toBe(false)
    m.ws.close()
  })

  it('ends every open connection when the mode changes', async () => {
    exit.setMode('mac')
    const m = mac()
    await until(() => exit.tunnelUp())
    const { code, socket } = await socksConnect('shop.example', 443)
    expect(code).toBe(0)
    let closed = false
    socket.on('close', () => { closed = true })
    exit.setMode('cloud')
    await until(() => closed)
    expect(closed).toBe(true)
    expect(m.frames.some(frame => frame.type === 'reset')).toBe(true)
    m.ws.close()
  })
})
