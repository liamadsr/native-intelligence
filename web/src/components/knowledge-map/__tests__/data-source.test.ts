import { describe, it, expect, vi } from 'vitest'
import { MAX_TILES_PER_REQUEST, tileId, type MapFilters } from '@/lib/knowledge/graph-map/types'
import { createInMemoryDataSource, createNetworkDataSource } from '../data-source'
import { StaleMapError } from '../types'
import { buildLayeredMap } from './fixtures'

/**
 * `filtersToParams` is owned by the server-core agent and imported by
 * data-source.ts. Mocking it here keeps these tests about the data source's
 * own behaviour (chunking, 409 → StaleMapError, abort) rather than about the
 * exact query-string spelling, which that package's own tests cover.
 */
vi.mock('@/lib/knowledge/graph-map', () => ({
  filtersToParams: (filters: MapFilters) => {
    const p = new URLSearchParams()
    const where = filters.where ?? []
    if (where.length > 0) {
      p.set('f', JSON.stringify(where.map((q) => [q.field, q.op, q.value])))
    }
    return p
  },
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createNetworkDataSource', () => {
  it('builds the map URL from the filters and passes `have`', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return jsonResponse({ unchanged: true, version: 'v1' })
    }) as unknown as typeof fetch

    const source = createNetworkDataSource(
      {
        where: [
          { field: 'confirmation', op: 'is', value: ['confirmed'] },
          { field: 'confidence', op: 'gte', value: 0.5 },
        ],
      },
      { fetchImpl },
    )
    const res = await source.loadMap({ have: 'v1' })

    expect(res).toEqual({ unchanged: true, version: 'v1' })
    expect(calls[0]).toContain('/api/account/knowledge/map?')
    expect(calls[0]).toContain('f=')
    expect(decodeURIComponent(calls[0])).toContain('"confirmation","is"')
    expect(decodeURIComponent(calls[0])).toContain('"confidence","gte",0.5')
    expect(calls[0]).toContain('have=v1')
  })

  it('honours a custom basePath and omits `?` when there is nothing to send', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return jsonResponse({ unchanged: true, version: 'v' })
    }) as unknown as typeof fetch

    await createNetworkDataSource({}, { fetchImpl, basePath: '/custom/map' }).loadMap({})
    expect(calls[0]).toBe('/custom/map')
  })

  it('chunks tile ids into requests of at most MAX_TILES_PER_REQUEST', async () => {
    const ids = Array.from({ length: MAX_TILES_PER_REQUEST + 5 }, (_, i) => tileId(3, i, 0))
    const requested: string[][] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), 'https://dial8.ai')
      requested.push((parsed.searchParams.get('t') ?? '').split(','))
      return jsonResponse({ tiles: [] })
    }) as unknown as typeof fetch

    await createNetworkDataSource({}, { fetchImpl }).loadTiles('v1', ids)

    expect(requested).toHaveLength(2)
    expect(requested[0]).toHaveLength(MAX_TILES_PER_REQUEST)
    expect(requested[1]).toHaveLength(5)
    expect(requested.flat()).toEqual(ids)
  })

  it('flattens tiles from every chunk and carries the version', async () => {
    const map = buildLayeredMap()
    const all = [...map.tiles.values()]
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), 'https://dial8.ai')
      expect(parsed.searchParams.get('v')).toBe('v1')
      const ids = (parsed.searchParams.get('t') ?? '').split(',')
      return jsonResponse({
        tiles: all.filter((t) => ids.includes(tileId(t.z, t.x, t.y))),
      })
    }) as unknown as typeof fetch

    const tiles = await createNetworkDataSource({}, { fetchImpl }).loadTiles('v1', [
      tileId(1, 0, 0),
      tileId(1, 1, 0),
    ])
    expect(tiles.map((t) => tileId(t.z, t.x, t.y)).sort()).toEqual([
      tileId(1, 0, 0),
      tileId(1, 1, 0),
    ])
  })

  it('turns HTTP 409 into StaleMapError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ stale: true }, 409)) as unknown as typeof fetch
    await expect(
      createNetworkDataSource({}, { fetchImpl }).loadTiles('old', [tileId(1, 0, 0)]),
    ).rejects.toBeInstanceOf(StaleMapError)
  })

  it('throws with the status for other failures', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'boom' }, 500),
    ) as unknown as typeof fetch
    await expect(
      createNetworkDataSource({}, { fetchImpl }).loadTiles('v', [tileId(1, 0, 0)]),
    ).rejects.toThrow(/500/)
    await expect(createNetworkDataSource({}, { fetchImpl }).loadMap({})).rejects.toThrow(/500/)
  })

  it('makes no request for an empty id list', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    expect(await createNetworkDataSource({}, { fetchImpl }).loadTiles('v', [])).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('exposes the filters it was built with', () => {
    const filters: MapFilters = {
      where: [{ field: 'type', op: 'is_any_of', value: ['fact'] }],
    }
    expect(createNetworkDataSource(filters).filters).toBe(filters)
  })
})

describe('createInMemoryDataSource', () => {
  it('serves meta plus the inline tiles', async () => {
    const map = buildLayeredMap()
    const res = await createInMemoryDataSource(map).loadMap({})
    expect('unchanged' in res && res.unchanged).toBeFalsy()
    if ('tiles' in res) {
      expect(res.version).toBe('v1')
      expect(res.tiles.map((t) => tileId(t.z, t.x, t.y))).toEqual([tileId(0, 0, 0)])
    }
  })

  it('answers `unchanged` when the caller already holds the version', async () => {
    const map = buildLayeredMap()
    const res = await createInMemoryDataSource(map).loadMap({ have: 'v1' })
    expect(res).toEqual({ unchanged: true, version: 'v1' })
  })

  it('returns requested tiles and silently omits ones it does not hold', async () => {
    const map = buildLayeredMap()
    const tiles = await createInMemoryDataSource(map).loadTiles('v1', [
      tileId(1, 0, 0),
      tileId(9, 9, 9),
    ])
    expect(tiles).toHaveLength(1)
    expect(tileId(tiles[0].z, tiles[0].x, tiles[0].y)).toBe(tileId(1, 0, 0))
  })

  it('rejects with StaleMapError for a mismatched version', async () => {
    const map = buildLayeredMap()
    await expect(
      createInMemoryDataSource(map).loadTiles('other', [tileId(1, 0, 0)]),
    ).rejects.toBeInstanceOf(StaleMapError)
  })

  it('aborts in-flight work when the signal fires', async () => {
    const map = buildLayeredMap()
    const source = createInMemoryDataSource(map, { latencyMs: 50 })
    const controller = new AbortController()
    const promise = source.loadTiles('v1', [tileId(1, 0, 0)], controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately when handed an already-aborted signal', async () => {
    const map = buildLayeredMap()
    const controller = new AbortController()
    controller.abort()
    await expect(
      createInMemoryDataSource(map).loadMap({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
