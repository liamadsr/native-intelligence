/**
 * A failed read must never degrade into "no rows".
 *
 * Found against a real database, not by a unit test: the first map request hit
 * a transient failure, every reader discarded `error` and kept `data ?? []`,
 * the service cached the resulting EMPTY map for its 10-minute TTL, and a
 * workspace with 251 claims rendered "No claims yet". Every fake in the other
 * suites returns `error: null`, so nothing could see it.
 *
 * Contract locked in here: a query error REJECTS (→ the route answers 500 and
 * the client shows Retry; nothing is cached). The single exception is an
 * explicit permission denial while resolving hub labels, which genuinely means
 * "this viewer cannot read those rows".
 */

import { describe, expect, it } from 'vitest'

import {
  fetchSourceRows,
  probeVersion,
  resolveEntityLabels,
  type MapSourceClient,
} from '@/lib/knowledge/graph-map/source'
import { fetchSourceDelta, probeParts, snapshotOf } from '@/lib/knowledge/graph-map/source-delta'

interface Failure {
  message: string
  code?: string
}

/**
 * A chainable that accepts any PostgREST builder call and resolves to either a
 * healthy empty result or the given failure, decided per table.
 */
function clientFailing(failFor: (table: string) => Failure | null): MapSourceClient {
  const table = (name: string) => {
    const result = () => {
      const error = failFor(name)
      return error ? { data: null, count: null, error } : { data: [], count: 0, error: null }
    }
    const api: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
              Promise.resolve(result()).then(ok, err)
          }
          return () => api
        },
      },
    )
    return api
  }
  return { from: table } as unknown as MapSourceClient
}

const boom: Failure = { message: 'upstream timeout', code: '57014' }

describe('source reads fail loudly', () => {
  it('fetchSourceRows rejects when the claim read fails', async () => {
    const client = clientFailing((t) => (t === 'claim' ? boom : null))
    await expect(fetchSourceRows(client, 'ws')).rejects.toThrow(/upstream timeout/)
  })

  it('fetchSourceRows rejects when the link read fails', async () => {
    const client = clientFailing((t) => (t === 'entity_link' ? boom : null))
    await expect(fetchSourceRows(client, 'ws')).rejects.toThrow(/upstream timeout/)
  })

  it('probeVersion rejects instead of hashing an "empty workspace" token', async () => {
    const client = clientFailing((t) => (t === 'entity_link' ? boom : null))
    await expect(probeVersion(client, 'ws')).rejects.toThrow(/version probe failed/)
  })

  it('probeParts rejects the same way', async () => {
    const client = clientFailing((t) => (t === 'claim' ? boom : null))
    await expect(probeParts(client, 'ws')).rejects.toThrow(/version probe failed/)
  })

  it('fetchSourceDelta rejects, so the service falls back to a full fetch', async () => {
    const snapshot = snapshotOf(
      { claims: [], links: [], hubs: [] },
      {
        version: 'v0',
        claimCount: 0,
        claimMaxUpdatedAt: '2026-01-01T00:00:00Z',
        linkCount: 0,
        linkMaxCreatedAt: '2026-01-01T00:00:00Z',
      },
      0,
    )
    const client = clientFailing((t) => (t === 'claim' ? boom : null))
    await expect(fetchSourceDelta(client, 'ws', snapshot)).rejects.toThrow(/upstream timeout/)
  })
})

describe('hub label resolution', () => {
  const wanted = new Map([['capture', new Set(['11111111-1111-4111-8111-111111111111'])]])

  it('rejects on a real error — a hub must not silently become "unreadable"', async () => {
    const client = clientFailing(() => boom)
    await expect(resolveEntityLabels(client, 'ws', wanted)).rejects.toThrow(/label read failed/)
  })

  it('treats an explicit permission denial as "not readable", not as an error', async () => {
    const client = clientFailing(() => ({ message: 'permission denied', code: '42501' }))
    const labels = await resolveEntityLabels(client, 'ws', wanted)
    expect(labels.size).toBe(0)
  })
})
