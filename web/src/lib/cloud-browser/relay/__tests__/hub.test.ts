/**
 * The sandbox's hub (src/lib/cloud-browser/relay/hub.ts) with real sockets: a
 * viewer gets VNC bytes only after its token checks out and it says `go`; the
 * token picks the view-only or the input server; a control session ends with
 * its token; the thumbnail needs the token too.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { sandboxVerifyKey, signSandboxToken } from '../../viewer-token'
import { startHub } from '../hub'

const { privateKey } = generateKeyPairSync('ed25519')
const token = (fields: Record<string, unknown> = {}, ttl = 60_000) =>
  signSandboxToken({ aud: 'browser-viewer', userId: 'u1', workspaceId: 'w1', sandbox: 'browser-a', ...fields }, ttl, privateKey)

/** A stand-in VNC server on a unix socket, as x11vnc runs: announces itself and keeps what it gets. */
function vncServer(name: string): Promise<{ server: Server; path: string; received: Buffer[] }> {
  const received: Buffer[] = []
  const path = join(mkdtempSync(join(tmpdir(), 'hub-vnc-')), `${name}.sock`)
  const server = createServer((socket: Socket) => {
    socket.write(`RFB 003.008 ${name}\n`)
    socket.on('data', chunk => received.push(chunk))
  })
  return new Promise(resolve => server.listen(path, () => resolve({ server, path, received })))
}

let hub: ReturnType<typeof startHub>
let hubPort = 0
let view: Awaited<ReturnType<typeof vncServer>>
let control: Awaited<ReturnType<typeof vncServer>>

beforeEach(async () => {
  view = await vncServer('view')
  control = await vncServer('control')
  hub = startHub({ port: 0, sandbox: 'browser-a', verifyKey: sandboxVerifyKey(privateKey), vncSockets: { view: view.path, control: control.path },
    thumbnail: async () => Buffer.from('jpeg-bytes') })
  await new Promise(resolve => hub.server.once('listening', resolve))
  hubPort = (hub.server.address() as { port: number }).port
})
afterEach(() => { hub.close(); view.server.close(); control.server.close() })

function viewer() {
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/viewer`)
  const messages: (string | Buffer)[] = []
  let closed: { code: number; reason: string } | null = null
  ws.on('message', (data, isBinary) => messages.push(isBinary ? data as Buffer : data.toString()))
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() } })
  const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 20)) }
  return { ws, messages, closed: () => closed, until, open: new Promise(resolve => ws.once('open', resolve)) }
}

describe('the viewer gate', () => {
  it('pipes the view-only server once the token checks out and the client says go', async () => {
    const v = viewer()
    await v.open
    v.ws.send(token())
    await v.until(() => v.messages.length > 0)
    expect(JSON.parse(String(v.messages[0]))).toEqual({ ok: true, control: false })
    await new Promise(r => setTimeout(r, 50))
    expect(v.messages).toHaveLength(1) // nothing from VNC before `go`
    v.ws.send('go')
    await v.until(() => v.messages.length > 1)
    expect(String(v.messages[1])).toBe('RFB 003.008 view\n')
    v.ws.send(Buffer.from('client-bytes'))
    await v.until(() => view.received.length > 0)
    expect(view.received.map(chunk => chunk.toString()).join('')).toBe('client-bytes')
    expect(control.received).toEqual([])
    v.ws.close()
  })

  it('opens the input server only for a control token, and ends input with the token', async () => {
    const v = viewer()
    await v.open
    v.ws.send(token({ control: true }, 400))
    await v.until(() => v.messages.length > 0)
    expect(JSON.parse(String(v.messages[0]))).toEqual({ ok: true, control: true })
    v.ws.send('go')
    await v.until(() => v.messages.length > 1)
    expect(String(v.messages[1])).toBe('RFB 003.008 control\n')
    await v.until(() => v.closed() !== null)
    expect(v.closed()).toMatchObject({ code: 4408 })
  })

  it('refuses a bad token, another sandbox’s, or none in time', async () => {
    for (const bad of ['nonsense', signSandboxToken({ aud: 'browser-viewer', userId: 'u1', workspaceId: 'w1', sandbox: 'browser-b' }, 60_000, privateKey),
      signSandboxToken({ aud: 'browser-exit', userId: 'u1', workspaceId: 'w1', sandbox: 'browser-a' }, 60_000, privateKey)]) {
      const v = viewer()
      await v.open
      v.ws.send(bad)
      await v.until(() => v.closed() !== null)
      expect(v.closed()).toMatchObject({ code: 4401 })
    }
    expect(view.received).toEqual([])
  })
})

describe('the hub’s limits', () => {
  it('keeps the viewers’ places for viewers: sockets owing a token don’t count', async () => {
    const strangers = Array.from({ length: 5 }, () => viewer())
    await Promise.all(strangers.map(s => s.open))
    const v = viewer()
    await v.open
    v.ws.send(token())
    await v.until(() => v.messages.length > 0)
    expect(JSON.parse(String(v.messages[0]))).toEqual({ ok: true, control: false })
    for (const s of strangers) s.ws.close()
    v.ws.close()
  })

  it('waits for a port an old relay still holds, then listens', async () => {
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '0.0.0.0', resolve))
    const port = (blocker.address() as { port: number }).port
    const fatal: Error[] = []
    const late = startHub({ port, sandbox: 'browser-a', verifyKey: sandboxVerifyKey(privateKey), vncSockets: { view: view.path, control: control.path },
      thumbnail: async () => null, onFatal: error => fatal.push(error) })
    await new Promise(r => setTimeout(r, 200))
    blocker.close()
    for (let i = 0; i < 40 && !late.server.listening; i++) await new Promise(r => setTimeout(r, 100))
    expect(late.server.listening).toBe(true)
    expect(fatal).toEqual([])
    late.close()
  })
})

describe('the thumbnail', () => {
  it('needs a token, and allows the app to fetch it cross-origin', async () => {
    const url = `http://127.0.0.1:${hubPort}/thumbnail`
    expect((await fetch(url)).status).toBe(401)
    const preflight = await fetch(url, { method: 'OPTIONS' })
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization')
    const ok = await fetch(url, { headers: { authorization: `Bearer ${token()}` } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/jpeg')
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    expect(await ok.text()).toBe('jpeg-bytes')
  })
})
