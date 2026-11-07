/**
 * One in-flight GET per URL (inflight-get.ts): callers within the join window
 * share one request; a later caller (a refresh after a change) asks again; a
 * finished request is never reused; a not-ok answer is null for everyone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getJsonOnce, JOIN_WINDOW_MS, resetInflightGets } from '../inflight-get'

beforeEach(() => resetInflightGets())

function deferredFetch() {
  const resolvers: Array<(r: Response) => void> = []
  const fetch = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)))
  const answer = (i: number, body: unknown, ok = true) => resolvers[i]({ ok, json: async () => body } as unknown as Response)
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, answer }
}

describe('getJsonOnce', () => {
  it('callers at the same moment share one request and one answer', async () => {
    const f = deferredFetch()
    const a = getJsonOnce('/api/x', { fetch: f.fetch, now: () => 1000 })
    const b = getJsonOnce('/api/x', { fetch: f.fetch, now: () => 1010 })
    expect(f.calls).toHaveBeenCalledTimes(1)
    f.answer(0, { n: 1 })
    expect(await a).toEqual({ n: 1 })
    expect(await b).toEqual({ n: 1 })
  })

  it('a different URL is its own request', () => {
    const f = deferredFetch()
    void getJsonOnce('/api/x?a=1', { fetch: f.fetch, now: () => 1000 })
    void getJsonOnce('/api/x?a=2', { fetch: f.fetch, now: () => 1000 })
    expect(f.calls).toHaveBeenCalledTimes(2)
  })

  it('a caller past the join window asks again, even while the first is open', () => {
    const f = deferredFetch()
    void getJsonOnce('/api/x', { fetch: f.fetch, now: () => 1000 })
    void getJsonOnce('/api/x', { fetch: f.fetch, now: () => 1000 + JOIN_WINDOW_MS + 1 })
    expect(f.calls).toHaveBeenCalledTimes(2)
  })

  it('a finished request is not reused, and a not-ok answer is null', async () => {
    const f = deferredFetch()
    const a = getJsonOnce('/api/x', { fetch: f.fetch, now: () => 1000 })
    f.answer(0, {}, false)
    expect(await a).toBeNull()
    void getJsonOnce('/api/x', { fetch: f.fetch, now: () => 1001 })
    expect(f.calls).toHaveBeenCalledTimes(2)
  })
})
