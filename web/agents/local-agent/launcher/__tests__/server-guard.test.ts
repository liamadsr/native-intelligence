/**
 * The eve server's request guard (invariant 4): the pure check, then the real
 * preload in a child Node process in front of a plain HTTP server, probed
 * with raw requests so Host and Origin are exactly what a page or app would
 * send. The live eve server is covered by the launcher's startup self-check
 * and the smoke.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKFLOW_SECRET_HEADER, allowRequest, normalizedPath } from '../server-guard'

const SECRET = 'w'.repeat(43)
const cfg = { port: 4321, workflowSecret: SECRET }
const host = '127.0.0.1:4321'

describe('allowRequest', () => {
  it.each([
    ['health, no auth', { url: '/eve/v1/health', headers: { host } }, true],
    ['an eve route (eve checks the bearer)', { url: '/eve/v1/session', headers: { host } }, true],
    ['a workflow callback with the secret', { url: '/.well-known/workflow/v1/flow', headers: { host, [WORKFLOW_SECRET_HEADER]: SECRET } }, true],
    ['any Origin header', { url: '/eve/v1/health', headers: { host, origin: 'null' } }, false],
    ['a same-host Origin', { url: '/eve/v1/session', headers: { host, origin: `http://${host}` } }, false],
    ['a rebound Host', { url: '/eve/v1/health', headers: { host: 'evil.test:4321' } }, false],
    ['localhost as Host', { url: '/eve/v1/health', headers: { host: 'localhost:4321' } }, false],
    ['another port', { url: '/eve/v1/health', headers: { host: '127.0.0.1:80' } }, false],
    ['no Host', { url: '/eve/v1/health', headers: {} }, false],
    ['a workflow POST without the secret', { url: '/.well-known/workflow/v1/flow', headers: { host } }, false],
    ['a workflow POST with a wrong secret', { url: '/.well-known/workflow/v1/step', headers: { host, [WORKFLOW_SECRET_HEADER]: 'x'.repeat(43) } }, false],
    ['a double-slash workflow path', { url: '//.well-known/workflow/v1/flow', headers: { host } }, false],
    ['a dot-segment escape from /eve', { url: '/eve/../.well-known/workflow/v1/flow', headers: { host } }, false],
    ['an encoded dot-segment escape', { url: '/eve/%2e%2e/.well-known/workflow/v1/flow', headers: { host } }, false],
    ['a backslash escape (URL parsing reads it as a slash)', { url: '/eve/..\\.well-known/workflow/v1/flow', headers: { host } }, false],
    ['an encoded-dot first segment', { url: '/%2Ewell-known/workflow/v1/flow', headers: { host } }, false],
    // An encoded slash is no separator, here or in the router: `..%2F.well-known`
    // is one segment under /eve, so eve's bearer check still applies (pinned
    // against the real router below).
    ['an encoded slash after .. (still /eve/*)', { url: '/eve/..%2F.well-known/workflow/v1/flow', headers: { host } }, true],
    ['encoded slashes out of a workflow path', { url: '/.well-known/workflow/v1/step/..%2F..%2F..%2F..%2F..%2Feve/v1/health', headers: { host } }, false],
    ['any other path without the secret', { url: '/', headers: { host } }, false],
    ['an absolute-form target', { url: 'http://127.0.0.1:4321/eve/v1/session', headers: { host } }, false],
  ])('%s', (_label, req, allowed) => {
    expect(allowRequest(req, cfg)).toBe(allowed)
  })

  it('normalizes paths the way a router would', () => {
    expect(normalizedPath('/eve/v1/../v1/health?x=1')).toBe('/eve/v1/health')
    expect(normalizedPath('//a///b')).toBe('/a/b')
    expect(normalizedPath('http://127.0.0.1:4321/eve/v1/health')).toBeNull()
    expect(normalizedPath('*')).toBeNull()
  })
})

// ── The preload, live ─────────────────────────────────────────────────────────

const GUARD = fileURLToPath(new URL('../server-guard.ts', import.meta.url))

/** A plain server behind the preload; /self-fetch makes it fetch its own workflow route. */
const CHILD = `
import { createServer } from 'node:http'
const port = Number(process.env.PORT)
createServer(async (req, res) => {
  if (req.url === '/eve/self-fetch') {
    const r = await fetch('http://127.0.0.1:' + port + '/.well-known/workflow/v1/flow', { method: 'POST', body: '{}' })
    res.end('self:' + r.status)
    return
  }
  res.end('ok:' + req.url)
}).listen(port, '127.0.0.1', () => console.log('listening'))
`

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

function raw(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? '{}' : undefined)
  })
}

describe('the preload in front of a real server', () => {
  let child: ChildProcess
  let port: number
  let h: string

  beforeAll(async () => {
    port = await freePort()
    h = `127.0.0.1:${port}`
    child = spawn(process.execPath, ['--import', GUARD, '--input-type=module', '-e', CHILD], {
      // Cast: Next's global types make ProcessEnv require NODE_ENV, which the server here never gets.
      env: { PATH: process.env.PATH ?? '', PORT: String(port), LOCAL_AGENT_SERVER_GUARD: '1', LOCAL_AGENT_WORKFLOW_SECRET: SECRET } as Record<string, string> as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d) => String(d).includes('listening') && resolve())
      child.once('exit', (code) => reject(new Error(`child exited ${code}`)))
    })
  })

  afterAll(() => {
    child?.kill('SIGKILL')
  })

  it('lets a plain local request through', async () => {
    expect(await raw(port, '/eve/v1/health', { host: h })).toEqual({ status: 200, body: 'ok:/eve/v1/health' })
  })

  it('refuses an unauthenticated workflow POST with a bare 403', async () => {
    expect(await raw(port, '/.well-known/workflow/v1/flow', { host: h, 'content-type': 'application/json' }, 'POST')).toEqual({ status: 403, body: '' })
  })

  it('refuses any request with an Origin header', async () => {
    expect(await raw(port, '/eve/v1/health', { host: h, origin: 'https://example.com' })).toEqual({ status: 403, body: '' })
  })

  it('refuses a wrong Host (DNS rebinding)', async () => {
    expect(await raw(port, '/eve/v1/health', { host: `attacker.example:${port}` })).toEqual({ status: 403, body: '' })
    expect(await raw(port, '/eve/v1/health', { host: `localhost:${port}` })).toEqual({ status: 403, body: '' })
  })

  it("adds the secret to the server's own fetches, so its workflow callbacks pass", async () => {
    expect(await raw(port, '/eve/self-fetch', { host: h })).toEqual({ status: 200, body: 'self:200' })
  })

  it('exits when its stdin closes (the launcher went away)', async () => {
    const exited = new Promise((r) => child.once('exit', r))
    child.stdin!.end()
    await expect(exited).resolves.toBeDefined()
  })
})

// ── The guard against the eve server's own router ─────────────────────────────
// The guard and the router must agree on what a path is: a target the guard
// counts as /eve/* (no workflow secret needed) must never route anywhere else.
// The child serves h3, the router the eve server's Nitro build bundles
// (resolved from nitro's own dependencies, so an upgrade re-runs this against
// the new one), with the eve server's two route shapes: /eve/** and the
// Workflow world's callbacks, exact and wildcard.

const H3_ENTRY = createRequire(createRequire(import.meta.url).resolve('nitro/package.json')).resolve('h3')

const ROUTER_CHILD = `
import { pathToFileURL } from 'node:url'
const { H3, serve } = await import(pathToFileURL(process.env.H3_ENTRY).href)
const app = new H3()
app.all('/eve/**', (event) => 'eve:' + event.url.pathname)
app.post('/.well-known/workflow/v1/flow', () => 'workflow')
app.all('/.well-known/workflow/v1/step/**', () => 'workflow')
app.all('/**', () => 'other')
const server = serve(app, { port: Number(process.env.PORT), hostname: '127.0.0.1', silent: true })
await server.ready()
console.log('listening')
`

describe('the preload in front of the eve server’s router (h3)', () => {
  let child: ChildProcess
  let port: number
  let h: string

  beforeAll(async () => {
    port = await freePort()
    h = `127.0.0.1:${port}`
    child = spawn(process.execPath, ['--import', GUARD, '--input-type=module', '-e', ROUTER_CHILD], {
      env: { PATH: process.env.PATH ?? '', PORT: String(port), LOCAL_AGENT_SERVER_GUARD: '1', LOCAL_AGENT_WORKFLOW_SECRET: SECRET, H3_ENTRY } as Record<string, string> as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d) => String(d).includes('listening') && resolve())
      child.once('exit', (code) => reject(new Error(`child exited ${code}`)))
    })
  })

  afterAll(() => {
    child?.kill('SIGKILL')
  })

  it.each([
    // The guard admits these as /eve/*, and the router agrees: each stays one segment under /eve.
    ['/eve/..%2F.well-known/workflow/v1/flow', 'eve:/eve/..%2F.well-known/workflow/v1/flow'],
    ['/eve/..%2f.well-known%2fworkflow%2fv1%2fflow', 'eve:/eve/..%2f.well-known%2fworkflow%2fv1%2fflow'],
    ['/eve/%2e%2e%2F.well-known/workflow/v1/flow', 'eve:/eve/..%2F.well-known/workflow/v1/flow'],
    ['/eve/..%5C.well-known/workflow/v1/flow', 'eve:/eve/..%5C.well-known/workflow/v1/flow'],
    ['/eve/v1/..%252F..%252F.well-known/workflow/v1/flow', 'eve:/eve/v1/..%252F..%252F.well-known/workflow/v1/flow'],
    // Dot segments resolve the same way on both sides.
    ['/.well-known/workflow/v1/step/../../../../eve/v1/health', 'eve:/eve/v1/health'],
  ])('%s reaches only /eve/*', async (path, body) => {
    expect(await raw(port, path, { host: h }, 'POST')).toEqual({ status: 200, body })
  })

  it.each([
    // The router WOULD serve these as workflow callbacks; the guard refuses them without the secret.
    '/eve/../.well-known/workflow/v1/flow',
    '/eve/%2e%2e/.well-known/workflow/v1/flow',
    '/eve/..\\.well-known/workflow/v1/flow',
    '/%2Ewell-known/workflow/v1/flow',
    '/.well-known/workflow/v1/step/..%2F..%2F..%2F..%2F..%2Feve/v1/health',
  ])('%s is refused without the workflow secret', async (path) => {
    expect(await raw(port, path, { host: h }, 'POST')).toEqual({ status: 403, body: '' })
  })

  it('serves the workflow callback to the holder of the secret (the routes are live)', async () => {
    expect(await raw(port, '/.well-known/workflow/v1/flow', { host: h, [WORKFLOW_SECRET_HEADER]: SECRET }, 'POST')).toEqual({ status: 200, body: 'workflow' })
  })
})
