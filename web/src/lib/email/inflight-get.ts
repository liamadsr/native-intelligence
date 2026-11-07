/**
 * One in-flight GET per URL for Mail's list and counts. Opening Mail mounted
 * the same requests more than once at the same moment (the list's search
 * effect firing beside its load, a second Mail view, React's dev double
 * mount): each caller here joins a request for the same URL that started
 * within JOIN_WINDOW_MS instead of sending its own. A request older than that
 * is not joined, so a refresh after a change (a realtime insert) always asks
 * again rather than taking an answer that may predate it.
 *
 * Resolves to the parsed JSON, or null when the response was not ok. A
 * network error rejects, for every joined caller alike.
 */
export const JOIN_WINDOW_MS = 250

interface Inflight {
  startedAt: number
  promise: Promise<unknown>
}

const inflight = new Map<string, Inflight>()

export function getJsonOnce<T = unknown>(
  url: string,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<T | null> {
  const now = (deps.now ?? Date.now)()
  const open = inflight.get(url)
  if (open && now - open.startedAt <= JOIN_WINDOW_MS) return open.promise as Promise<T | null>
  const doFetch = deps.fetch ?? fetch
  const entry: Inflight = { startedAt: now, promise: Promise.resolve() }
  entry.promise = doFetch(url)
    .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
    .finally(() => {
      if (inflight.get(url) === entry) inflight.delete(url)
    })
  inflight.set(url, entry)
  return entry.promise as Promise<T | null>
}

/** Tests only. */
export function resetInflightGets(): void {
  inflight.clear()
}
