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
 *   - anything that would change data (POST, PATCH, PUT, DELETE) is answered
 *     `{}` and does nothing. The demo is also `inert`, so nothing is clicked.
 * Every other request goes through untouched.
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
export function demoAnswer(snapshots: readonly DemoSnapshot[], url: string): { found: boolean; body: unknown } {
  const { pathname, search } = new URL(url, 'http://demo.invalid')
  for (const key of [pathname + search, pathname]) {
    for (const snapshot of snapshots) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) return { found: true, body: snapshot[key] }
    }
  }
  return { found: false, body: {} }
}

/**
 * Whether a request from a page at `pagePath` for `url` is the demo's to
 * answer: the workspace's own (`/api/account/*`), and the few the whole app
 * makes beside them at startup (its sign-in ping, its connected accounts,
 * the Mac's folders). The public page's own requests (the sky) are not.
 */
const APP_PREFIXES = ['/api/account/', '/api/analytics/', '/api/oauth/', '/api/local-agent/']
export function isDemoRequest(pagePath: string, pageOrigin: string, url: string): boolean {
  if (pagePath.startsWith('/account') || pagePath.startsWith('/admin')) return false
  const { pathname, origin } = new URL(url, pageOrigin)
  return origin === pageOrigin && APP_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

// The snapshots of the demos on the page now, and the fetch they replaced.
const active: DemoSnapshot[] = []
let real: typeof window.fetch | null = null

/** Answers the workspace's requests from `snapshot` until the returned function is called. */
export function installDemoFetch(snapshot: DemoSnapshot): () => void {
  if (typeof window === 'undefined') return () => {}
  active.push(snapshot)
  if (!real) {
    const original = window.fetch
    real = original
    window.__demoMisses = []
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!isDemoRequest(window.location.pathname, window.location.origin, url)) return original.call(window, input, init)
      const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
      if (method !== 'GET') return json({})
      const { found, body } = demoAnswer(active, url)
      if (!found) window.__demoMisses?.push(url)
      return json(body)
    }
  }
  return () => {
    const at = active.indexOf(snapshot)
    if (at !== -1) active.splice(at, 1)
    if (active.length === 0 && real) {
      window.fetch = real
      real = null
    }
  }
}
