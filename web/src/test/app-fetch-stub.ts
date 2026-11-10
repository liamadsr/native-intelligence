import { vi } from 'vitest'

/**
 * Answers a jsdom suite's requests AT ONCE, so none of them outlives its test.
 *
 * Why a suite needs this. `src/lib/workspace-fetch.ts` replaces `window.fetch`
 * when it loads, and almost every page component imports it somewhere below.
 * For an `/api/` URL the replacement first reads a token through the Supabase
 * client, and only then sends the request. In a test that request is a
 * relative URL Node's fetch refuses, so it always fails, but late: the first
 * such request in a file waits for the client module to load (tens of
 * milliseconds here, far longer on a loaded runner), and anything sent meanwhile
 * waits with it. By then the test may be over, and its failure path runs
 * outside it: during the next test, or after the file's jsdom is gone, where a
 * state update throws "window is not defined" and vitest fails the run although
 * every test passed.
 *
 * `routes` maps a path to the JSON body answered with status 200. A key ending
 * in `*` matches every path that starts with the rest of it. Keys are
 * same-origin paths (`/api/...`, query included); an absolute URL on the page's
 * own origin, a `URL` or a `Request` is matched by its path the same way. Any
 * other request is refused at once with a `TypeError`, the type the real fetch
 * threw for a test's relative URL (its message names this stub instead), so
 * the code's failure path runs inside the test. With no routes, every request
 * is refused.
 *
 * Call it in `beforeEach`, and `vi.unstubAllGlobals()` in `afterEach` after the
 * root unmounts. It returns the mock, so a test can check what was sent.
 */
export function stubAppFetch(routes: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const path = sameOriginPath(input)
    for (const [pattern, body] of Object.entries(routes)) {
      const hit = pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern
      if (hit) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    throw new TypeError(`fetch refused: no answer stubbed for ${path} (see src/test/app-fetch-stub.ts)`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The request's path and query when it is on the page's own origin, else its full URL. */
function sameOriginPath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (raw.startsWith('/')) return raw
  try {
    const url = new URL(raw)
    if (url.origin === globalThis.location?.origin) return url.pathname + url.search
  } catch { /* not an absolute URL: match it as written */ }
  return raw
}
