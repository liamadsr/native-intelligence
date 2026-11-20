/**
 * The demo data layer: lets a public page draw the app's REAL screens with a
 * made-up workspace's data and no server behind them.
 *
 * Every screen in the app gets its data from `/api/account/*`. While a demo
 * is on the page (components/demo/demo-workspace.tsx), those requests are
 * answered from the demo's own snapshot (lib/demo/snapshots/*) and never
 * leave the browser:
 *   - a GET the snapshot knows gets its saved answer;
 *   - a GET it does not know gets `{}` with status 200, and is listed in
 *     `window.__demoMisses` so a missing answer is easy to find;
 *   - a POST the snapshot knows (the app reads some lists with one) gets its
 *     saved answer, under `POST <path>#<body>` or `POST <path>`;
 *   - anything else that would change data is answered `{}` and does
 *     nothing. The demo is also `inert`, so nothing is clicked.
 * Every other request goes through untouched.
 *
 * While a demo is up no socket opens either: the app keeps a live connection
 * to the database for changes, which a picture of it has no use for, and a
 * public page must not open one per visitor. `WebSocket` is replaced by one
 * that never connects, and put back with `fetch`.
 *
 * WHY PATCHING `fetch` IS SAFE HERE. Demos sit on public pages, where a
 * visitor is signed out and no real code calls `/api/account/*` (it would
 * get a 401). Two guards keep it that way: the patch is removed when the
 * last demo leaves the page, and it never answers while the address is
 * inside the app (`/account`, `/admin`), so a visitor who signs in and is
 * taken there by the router gets the real server.
 */

/** A saved answer per request path (with its query string, when it has one). */
export type DemoSnapshot = Record<string, unknown>

declare global {
  interface Window {
    __demoMisses?: string[]
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** The saved answer for `url`, by its exact path and query first, then its path alone. */
export function demoAnswer(snapshots: readonly DemoSnapshot[], url: string, post?: { body: string }): { found: boolean; body: unknown } {
  const { pathname, search } = new URL(url, 'http://demo.invalid')
  const keys = post ? [`POST ${pathname}${search}#${post.body}`, `POST ${pathname}${search}`, `POST ${pathname}`] : [pathname + search, pathname]
  for (const key of keys) {
    for (const snapshot of snapshots) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) return { found: true, body: snapshot[key] }
    }
  }
  return { found: false, body: {} }
}

/**
 * Whether a request from a page at `pagePath` for `url` is the demo's to
 * answer. On a demo page (`/demo/*`): everything it asks of our own server
 * but the sky. Elsewhere: the workspace's own (`/api/account/*`) and the few
 * the app makes beside them at startup.
 */
const APP_PREFIXES = ['/api/account/', '/api/analytics/', '/api/oauth/', '/api/local-agent/']
export function isDemoRequest(pagePath: string, pageOrigin: string, url: string): boolean {
  if (pagePath.startsWith('/account') || pagePath.startsWith('/admin')) return false
  const { pathname, origin } = new URL(url, pageOrigin)
  if (origin !== pageOrigin) return false
  // A demo page (/demo/*) is the app and nothing else, so nothing it asks of
  // our own server goes out: not presence, not a model call, not an upload's
  // sign-off. Only the sky, which is the public page's own.
  if (pagePath.startsWith('/demo/')) return (pathname.startsWith('/api/') || pathname.startsWith('/eve/')) && !pathname.startsWith('/api/sky')
  return APP_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

// The snapshots of the demos on the page now, and the fetch they replaced.
const active: DemoSnapshot[] = []
let real: typeof window.fetch | null = null
let realSocket: typeof WebSocket | null = null

/** A socket that never connects and never says so: whoever opened it simply keeps waiting. */
class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  extensions = ''
  protocol = ''
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  constructor(readonly url: string | URL) {
    super()
  }
  send(): void {}
  close(): void {
    this.readyState = 3
  }
}

/** Answers the workspace's requests from `snapshot` until the returned function is called. */
export function installDemoFetch(snapshot: DemoSnapshot): () => void {
  if (typeof window === 'undefined') return () => {}
  active.push(snapshot)
  if (!real) {
    const original = window.fetch
    real = original
    realSocket = window.WebSocket
    window.WebSocket = DemoSocket as unknown as typeof WebSocket
    window.__demoMisses = []
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!isDemoRequest(window.location.pathname, window.location.origin, url)) return original.call(window, input, init)
      const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
      if (method !== 'GET' && method !== 'POST') return json({})
      const sent = method === 'POST' ? { body: typeof init?.body === 'string' ? init.body : '' } : undefined
      const { found, body } = demoAnswer(active, url, sent)
      if (method === 'POST') return json(body)
      if (!found && (window.__demoMisses?.length ?? 0) < 50) window.__demoMisses?.push(url)
      return json(body)
    }
  }
  return () => {
    const at = active.indexOf(snapshot)
    if (at !== -1) active.splice(at, 1)
    if (active.length === 0 && real) {
      window.fetch = real
      real = null
      if (realSocket) window.WebSocket = realSocket
      realSocket = null
    }
  }
}
