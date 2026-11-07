/**
 * cachedJson — the module-level stale-while-revalidate layer, and the two escape
 * hatches that keep it from outliving the truth it caches.
 *
 * The cache exists because a detail panel re-asks for the same workspace lookups
 * on every open. That's harmless for data that changes quarterly — until a
 * SETTINGS page in the same tab changes exactly that data. Then a 60s TTL is a
 * 60s lie, and the SWR read makes it worse: the first caller after expiry still
 * gets the stale answer and only revalidates behind it, so seeing the truth
 * takes TWO opens. Hence:
 *   - `invalidateCached(prefix)` — a mutation says "what I just changed is no
 *     longer what you have", by URL prefix so query-string variants go too.
 *   - `{ revalidate: 'always' }` + `onRevalidated` — a reader that would rather
 *     correct itself a beat later than render a stale answer until the next open.
 *
 * The module-level maps are the point of the file, so each test uses its own URL
 * rather than trying to reset them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cachedJson, invalidateCached } from '../cached-fetch'

let responses: Map<string, unknown>
let fetchCalls: string[]

/** Resolve-on-demand fetch: every URL answers with `responses.get(url)`. */
function installFetch() {
  responses = new Map()
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      fetchCalls.push(url)
      const body = responses.get(url)
      return { ok: true, status: 200, json: async () => body ?? null }
    }),
  )
}

/**
 * Let the background revalidation's promise chain settle. It is several
 * `.then`s deep (fetch → json → cache-write → onRevalidated), so this drains
 * the microtask queue via a macrotask rather than counting ticks.
 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  installFetch()
})

describe('cachedJson', () => {
  it('serves a fresh hit from cache without a second request', async () => {
    const url = '/api/fresh-hit'
    responses.set(url, { v: 1 })
    expect(await cachedJson(url)).toEqual({ v: 1 })
    responses.set(url, { v: 2 })
    expect(await cachedJson(url)).toEqual({ v: 1 })
    expect(fetchCalls.filter((u) => u === url)).toHaveLength(1)
  })

  it('scopes entries so one workspace never reads another’s answer', async () => {
    // The server resolves the workspace from cookies — it is invisible in the
    // URL, so without `scope` the two workspaces share one cache key.
    const url = '/api/scoped'
    responses.set(url, { ws: 'a' })
    expect(await cachedJson(url, { scope: 'ws-a' })).toEqual({ ws: 'a' })
    responses.set(url, { ws: 'b' })
    expect(await cachedJson(url, { scope: 'ws-b' })).toEqual({ ws: 'b' })
  })
})

describe('invalidateCached', () => {
  it('drops the entry so the next read hits the network', async () => {
    const url = '/api/invalidate-basic'
    responses.set(url, { v: 1 })
    await cachedJson(url)
    responses.set(url, { v: 2 })

    invalidateCached(url)

    expect(await cachedJson(url)).toEqual({ v: 2 })
    expect(fetchCalls.filter((u) => u === url)).toHaveLength(2)
  })

  it('matches by URL PREFIX, so query-string variants go too', async () => {
    // One mutation changes the resource; every parameterisation of it is stale.
    const base = '/api/prefix-target'
    responses.set(`${base}?a=1`, { v: 1 })
    responses.set(`${base}?a=2`, { v: 1 })
    await cachedJson(`${base}?a=1`)
    await cachedJson(`${base}?a=2`)
    responses.set(`${base}?a=1`, { v: 2 })
    responses.set(`${base}?a=2`, { v: 2 })

    invalidateCached(base)

    expect(await cachedJson(`${base}?a=1`)).toEqual({ v: 2 })
    expect(await cachedJson(`${base}?a=2`)).toEqual({ v: 2 })
  })

  it('ignores the scope half of the key — every workspace’s copy is dropped', async () => {
    // Keys are `scope|url`; a naive `key.startsWith(prefix)` would match none of
    // them, which is the whole bug this function exists to prevent.
    const url = '/api/scoped-invalidate'
    responses.set(url, { v: 1 })
    await cachedJson(url, { scope: 'ws-a' })
    await cachedJson(url, { scope: 'ws-b' })
    responses.set(url, { v: 2 })

    invalidateCached(url)

    expect(await cachedJson(url, { scope: 'ws-a' })).toEqual({ v: 2 })
    expect(await cachedJson(url, { scope: 'ws-b' })).toEqual({ v: 2 })
  })

  it('leaves entries outside the prefix alone', async () => {
    const keep = '/api/unrelated-lookup'
    const drop = '/api/dropped-lookup'
    responses.set(keep, { v: 1 })
    responses.set(drop, { v: 1 })
    await cachedJson(keep)
    await cachedJson(drop)
    responses.set(keep, { v: 2 })

    invalidateCached(drop)

    // The untouched entry still answers from cache — invalidation is surgical,
    // not a cache flush. Workflow states/members/cycles must not pay for a
    // task-destinations mutation.
    expect(await cachedJson(keep)).toEqual({ v: 1 })
  })

  it('drops the INFLIGHT request too, so a fetch begun pre-mutation cannot land', async () => {
    // A request that left before the PATCH carries a pre-mutation answer. If it
    // stays in `inflight`, the next caller adopts it — and caches it as current.
    const url = '/api/inflight-invalidate'
    let release: (value: unknown) => void = () => {}
    const gate = new Promise((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const u = String(input)
        fetchCalls.push(u)
        if (fetchCalls.filter((x) => x === u).length === 1) {
          await gate
          return { ok: true, status: 200, json: async () => ({ v: 'stale' }) }
        }
        return { ok: true, status: 200, json: async () => ({ v: 'fresh' }) }
      }),
    )

    const first = cachedJson(url)
    invalidateCached(url)
    release(null)
    await first

    // The in-flight answer resolved AFTER the invalidation, so it must not have
    // been cached — the next read goes back to the network.
    expect(await cachedJson(url)).toEqual({ v: 'fresh' })
  })
})

describe('cachedJson — revalidate: always', () => {
  it('returns the cached answer immediately AND refetches behind it', async () => {
    const url = '/api/revalidate-always'
    responses.set(url, { v: 1 })
    await cachedJson(url)
    responses.set(url, { v: 2 })

    // Still the cached answer — the caller gets an instant render.
    expect(await cachedJson(url, { revalidate: 'always' })).toEqual({ v: 1 })
    await flush()
    // ...and the fresh one landed in the cache behind it.
    expect(fetchCalls.filter((u) => u === url)).toHaveLength(2)
    expect(await cachedJson(url)).toEqual({ v: 2 })
  })

  it('reports the fresh answer through onRevalidated', async () => {
    const url = '/api/revalidate-callback'
    responses.set(url, { v: 1 })
    await cachedJson(url)
    responses.set(url, { v: 2 })

    const onRevalidated = vi.fn()
    await cachedJson(url, { revalidate: 'always', onRevalidated })
    await flush()

    expect(onRevalidated).toHaveBeenCalledWith({ v: 2 })
  })

  it('does not fire onRevalidated when the cache MISSED — that answer is already fresh', async () => {
    // A miss resolves from the network, so the returned value IS the fresh one.
    // Calling back with it would make every caller apply the same data twice.
    const url = '/api/revalidate-miss'
    responses.set(url, { v: 1 })
    const onRevalidated = vi.fn()
    expect(await cachedJson(url, { revalidate: 'always', onRevalidated })).toEqual({ v: 1 })
    await flush()
    expect(onRevalidated).not.toHaveBeenCalled()
  })
})
