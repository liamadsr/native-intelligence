/**
 * Preloaded into the eve server (`node --import <this file>`) by the launcher,
 * before Nitro starts. Invariant 4 (docs/plans/local-agents.md §1): no web
 * page and no other app may drive the server, so every HTTP request is checked
 * before eve sees it:
 *   - a request with an `Origin` header is refused (browsers send one on every
 *     cross-origin fetch and form post; eve's client and the Workflow world
 *     never do);
 *   - the Host must be exactly `127.0.0.1:<port>`, which defeats DNS rebinding
 *     (a rebound page's Host is its own name);
 *   - everything outside `/eve/*` (in practice the Workflow world's callbacks
 *     under `/.well-known/workflow/*`) needs a per-launch secret header. The
 *     world's own callbacks get it from a patched global fetch that adds the
 *     header ONLY to requests for this server's base URL. (In eve 0.79.1 most
 *     queue deliveries run in process through registerHandler; the HTTP path is
 *     the fallback, through global fetch unless WORKFLOW_NODE_HTTP is set,
 *     which the launcher never sets.)
 *   - `/eve/*` keeps eve's own bearer check (channels/eve.ts); health stays
 *     open behind the Host and Origin checks.
 * A refusal is a bare 403 with no body.
 *
 * It also makes the server exit when the launcher's stdin pipe closes, so a
 * launcher killed outright leaves no server behind (SIGTERM first, so eve's
 * own shutdown stops the sandbox; a hard exit if that hangs).
 *
 * Installs only when LOCAL_AGENT_SERVER_GUARD=1 (the launcher sets it), so the
 * unit tests can import the pure check.
 */
import { timingSafeEqual } from 'node:crypto'
import { Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export const WORKFLOW_SECRET_HEADER = 'x-local-agent-workflow'

export interface GuardConfig {
  readonly port: number
  readonly workflowSecret: string
}

interface RequestLike {
  readonly url?: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

function secretMatches(presented: string | string[] | undefined, expected: string): boolean {
  if (typeof presented !== 'string' || expected.length === 0) return false
  const a = new Uint8Array(Buffer.from(presented, 'utf8'))
  const b = new Uint8Array(Buffer.from(expected, 'utf8'))
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The request's path with repeated slashes collapsed and dot segments
 * resolved (`%2e` included). Only origin-form targets (`/...`) count; an
 * absolute-form or `*` target is refused. An encoded slash (`%2F`, `%5C`) is
 * no separator here, and none to the eve server's router (h3) either, so
 * `/eve/..%2F.well-known/…` is one segment under /eve for both; the test runs
 * this guard in front of that router to keep them agreeing.
 */
export function normalizedPath(url: string | undefined): string | null {
  if (!url || !url.startsWith('/')) return null
  try {
    return new URL(url.replace(/\/{2,}/g, '/'), 'http://127.0.0.1').pathname
  } catch {
    return null
  }
}

/** Whether a request may reach eve at all. */
export function allowRequest(req: RequestLike, cfg: GuardConfig): boolean {
  const h = req.headers
  if (h.origin !== undefined) return false
  if (h.host !== `127.0.0.1:${cfg.port}`) return false
  const path = normalizedPath(req.url)
  if (path === null) return false
  if (path === '/eve' || path.startsWith('/eve/')) return true // eve's bearer check applies
  return secretMatches(h[WORKFLOW_SECRET_HEADER], cfg.workflowSecret)
}

function refuse(res: ServerResponse): void {
  res.writeHead(403, { 'content-length': '0', connection: 'close' })
  res.end()
}

/** Add the secret header to fetches for this server's own base URL only. */
function patchFetch(cfg: GuardConfig): void {
  const base = `http://127.0.0.1:${cfg.port}/`
  const realFetch = globalThis.fetch
  globalThis.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(base)) return realFetch(input, init)
    if (input instanceof Request) {
      const req = new Request(input, init)
      req.headers.set(WORKFLOW_SECRET_HEADER, cfg.workflowSecret)
      return realFetch(req)
    }
    const headers = new Headers(init?.headers)
    headers.set(WORKFLOW_SECRET_HEADER, cfg.workflowSecret)
    return realFetch(input, { ...init, headers })
  }
}

function patchServer(cfg: GuardConfig, log: (line: string) => void): void {
  const emit = Server.prototype.emit
  Server.prototype.emit = function guardedEmit(this: Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'request') {
      const [req, res] = args as [IncomingMessage, ServerResponse]
      if (!allowRequest(req, cfg)) {
        log(`[local-agent guard] refused ${req.method} ${normalizedPath(req.url) ?? '?'}`)
        refuse(res)
        return true
      }
    } else if (event === 'upgrade') {
      const [req, socket] = args as [IncomingMessage, Duplex]
      if (!allowRequest(req, cfg)) {
        socket.destroy()
        return true
      }
    }
    return (emit as (this: Server, event: string | symbol, ...rest: unknown[]) => boolean).call(this, event, ...args)
  } as typeof Server.prototype.emit
}

function exitWithLauncher(): void {
  process.stdin.on('end', () => {
    process.kill(process.pid, 'SIGTERM')
    setTimeout(() => process.exit(0), 2000).unref()
  })
  process.stdin.resume()
}

export function installServerGuard(env: NodeJS.ProcessEnv = process.env): void {
  if (env.LOCAL_AGENT_SERVER_GUARD !== '1') return
  const port = Number(env.PORT)
  const workflowSecret = env.LOCAL_AGENT_WORKFLOW_SECRET ?? ''
  if (!Number.isInteger(port) || port <= 0 || workflowSecret.length < 32) {
    process.stderr.write('[local-agent guard] missing PORT or workflow secret; refusing to start\n')
    process.exit(1)
  }
  delete env.LOCAL_AGENT_WORKFLOW_SECRET
  const cfg: GuardConfig = { port, workflowSecret }
  patchServer(cfg, (l) => process.stderr.write(`${l}\n`))
  patchFetch(cfg)
  exitWithLauncher()
}

installServerGuard()
