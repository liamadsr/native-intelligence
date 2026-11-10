import { vi } from 'vitest'

/**
 * Answers a jsdom suite's requests AT ONCE, so none of them outlives its test.
 *
 * Why a suite needs this. `src/lib/workspace-fetch.ts` replaces `window.fetch`
 * when it loads, and almost every page component imports it somewhere below.
 * For an `/api/` URL the replacement first loads the Supabase client and reads
 * the session, and only then sends the request. In a test that request is a
 * relative URL Node's fetch refuses, so it always fails, but tens of
 * milliseconds later, and much later on a loaded runner. By then the test may
 * be over: its failure path runs during the next test (a rollback toast lands
 * on the next test's mock), or after the file's jsdom is gone, where a state
 * update throws "window is not defined" and vitest fails the run although
 * every test passed.
 *
 * `routes` maps a URL to the JSON body answered with status 200. A key ending
 * in `*` matches every URL that starts with the rest of it. Any other URL is
 * refused at once with the TypeError a failed fetch throws: the outcome the
 * real fetch gave a test's relative URL, only without the wait, so the code's
 * failure path runs inside the test. With no routes, every request is refused.
 *
 * Call it in `beforeEach`, and `vi.unstubAllGlobals()` in `afterEach` after the
 * root unmounts. It returns the mock, so a test can check what was sent.
 */
export function stubAppFetch(routes: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    for (const [pattern, body] of Object.entries(routes)) {
      const hit = pattern.endsWith('*') ? url.startsWith(pattern.slice(0, -1)) : url === pattern
      if (hit) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    throw new TypeError('fetch failed', { cause: new Error(`no answer stubbed for ${url} (see src/test/app-fetch-stub.ts)`) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
