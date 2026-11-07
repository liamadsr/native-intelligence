// ── Cached JSON fetch ──────────────────────────────────────────
// Tiny stale-while-revalidate layer for workspace-level lookup data that
// detail panels and pickers re-request on every mount (workflow states,
// members, cycles, project/document lists). Without this, opening an action
// detail panel fires ~8 identical lookups each time.
//
// Semantics:
//   - fresh hit (within ttl): resolve from cache, no request
//   - stale hit: resolve from cache immediately AND revalidate in the
//     background so the next open is fresh
//   - miss: fetch (deduped across concurrent callers)
//
// Callers must include anything that scopes the response server-side (e.g.
// the workspace id — the server resolves it from cookies, invisible to the
// URL) in `scope` so entries can't leak across workspaces.
//
// The TTL is a bet that nothing in the same tab CHANGES this data. When
// something does — a settings page mutating exactly what a picker caches — the
// bet is off, and two escape hatches exist for it:
//   - `invalidateCached(prefix)`: the mutation declares its own writes stale.
//   - `{ revalidate: 'always', onRevalidated }`: a reader that would rather
//     correct itself a beat later than show a stale answer until its next open.
// Both are opt-in; a caller that uses neither behaves exactly as before.

interface CacheEntry {
  data: unknown
  at: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()
const MAX_ENTRIES = 100
const DEFAULT_TTL_MS = 60_000

function evictIfNeeded() {
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

/** The url half of a `scope|url` cache key (a url may itself contain '|'). */
function urlOf(key: string): string {
  return key.slice(key.indexOf('|') + 1)
}

function revalidate(key: string, url: string): Promise<unknown> {
  const existing = inflight.get(key)
  if (existing) return existing

  const promise = fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      // Still the current request for this key? An `invalidateCached` between
      // send and arrival dropped us from `inflight`, which means this answer
      // predates a mutation — resolve it to the caller that's already waiting,
      // but never write it to the cache as the current truth.
      if (data !== null && inflight.get(key) === promise) {
        cache.set(key, { data, at: Date.now() })
        evictIfNeeded()
      }
      return data
    })
    .catch(() => null)
    .finally(() => {
      // Same guard: a newer request may already own the slot.
      if (inflight.get(key) === promise) inflight.delete(key)
    })

  inflight.set(key, promise)
  return promise
}

/**
 * Drop every cached (and in-flight) answer whose URL starts with `urlPrefix`,
 * across ALL scopes — call it from whatever just mutated that resource.
 *
 * Prefix rather than exact match so one mutation covers every parameterisation
 * of the resource it changed (`?team_id=…`, `?status=…`). The scope half of the
 * key is deliberately not matched: a workspace-level setting changes for
 * everyone holding a copy of it, and the caller has no way to enumerate scopes.
 *
 * The in-flight sweep is the subtle half. A request that left BEFORE the
 * mutation carries a pre-mutation answer; leaving it in `inflight` would let the
 * next caller adopt it — and cache it as if it were current. Dropping it means
 * its result is discarded on arrival (see `revalidate`) and the next read
 * genuinely re-asks.
 */
export function invalidateCached(urlPrefix: string): void {
  for (const key of [...cache.keys()]) {
    if (urlOf(key).startsWith(urlPrefix)) cache.delete(key)
  }
  for (const key of [...inflight.keys()]) {
    if (urlOf(key).startsWith(urlPrefix)) inflight.delete(key)
  }
}

/**
 * The cached answer for `url` in `scope` — fresh or stale — without fetching,
 * or undefined when there is none. For a reader that must decide synchronously
 * whether it has anything to show yet (a popover choosing between its list and
 * its loading state); `cachedJson` is still what reads and revalidates.
 */
export function peekCached<T>(url: string, options?: { scope?: string | null }): T | undefined {
  return cache.get(`${options?.scope ?? ''}|${url}`)?.data as T | undefined
}

/**
 * GET `url` as JSON with stale-while-revalidate caching.
 * Resolves null on network/HTTP failure (when there's no cached fallback).
 *
 * `revalidate: 'always'` forces the background refetch even on a FRESH hit, so
 * the answer is still instant but can never be older than one render. The fresh
 * value arrives via `onRevalidated` — and only when it came from behind a cache
 * hit: on a miss the returned value already IS the fresh one, and calling back
 * with it would make every caller apply the same data twice.
 */
export async function cachedJson<T>(
  url: string,
  options?: {
    scope?: string | null
    ttlMs?: number
    revalidate?: 'always'
    onRevalidated?: (data: T | null) => void
  }
): Promise<T | null> {
  const key = `${options?.scope ?? ''}|${url}`
  const ttl = options?.ttlMs ?? DEFAULT_TTL_MS
  const entry = cache.get(key)

  if (entry) {
    const stale = Date.now() - entry.at > ttl
    if (stale || options?.revalidate === 'always') {
      const pending = revalidate(key, url)
      if (options?.onRevalidated) {
        void pending.then((data) => options.onRevalidated!(data as T | null))
      }
    }
    return entry.data as T
  }

  return (await revalidate(key, url)) as T | null
}
