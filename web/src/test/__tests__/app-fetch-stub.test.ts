// @vitest-environment jsdom
/**
 * The fetch stub in src/test/app-fetch-stub.ts. Its one promise is that a suite
 * using it has no request in flight when a test ends: every answer, and every
 * refusal, is settled before the next timer tick.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubAppFetch } from '../app-fetch-stub'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Resolves on the next timer tick: anything the stub left pending is still pending then. */
const nextTask = () => new Promise<'timer'>(r => setTimeout(() => r('timer'), 0))

describe('stubAppFetch', () => {
  it('answers a listed URL with its body, status 200', async () => {
    stubAppFetch({ '/api/account/projects': { projects: [{ id: 'p1' }] } })
    const res = await fetch('/api/account/projects')
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [{ id: 'p1' }] })
  })

  it('matches a key ending in * as a prefix, and only as a prefix', async () => {
    stubAppFetch({ '/api/account/prospecting/entries/*': { ok: 1 } })
    expect((await fetch('/api/account/prospecting/entries/e1', { method: 'PATCH' })).ok).toBe(true)
    await expect(fetch('/api/account/prospecting/lists')).rejects.toThrow('fetch failed')
  })

  it('refuses any other URL with the TypeError a failed fetch throws', async () => {
    stubAppFetch({ '/api/account/projects': {} })
    const refused = fetch('/api/account/workspace')
    await expect(refused).rejects.toBeInstanceOf(TypeError)
    await expect(refused).rejects.toThrow('fetch failed')
  })

  it('refuses everything when given no routes', async () => {
    stubAppFetch()
    await expect(fetch('/api/account/workspace')).rejects.toThrow('fetch failed')
  })

  it('settles both answers and refusals before the next timer tick, body included', async () => {
    stubAppFetch({ '/api/account/projects': { projects: [] } })
    const answered = fetch('/api/account/projects').then(r => r.json()).then(() => 'answered')
    const refused = fetch('/api/account/workspace').catch(() => 'refused')
    expect(await Promise.race([answered, nextTask()])).toBe('answered')
    expect(await Promise.race([refused, nextTask()])).toBe('refused')
  })

  it('replaces the global fetch and records every call for the test to check', async () => {
    const fetchMock = stubAppFetch({ '/api/x': {} })
    expect(globalThis.fetch).toBe(fetchMock)
    await fetch('/api/x', { method: 'PATCH', body: '{"a":1}' })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { method: 'PATCH', body: '{"a":1}' })
  })
})
