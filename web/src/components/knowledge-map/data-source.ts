/**
 * Where the viewer's tiles come from.
 *
 * Two implementations behind the one `MapDataSource` seam:
 *   - `createNetworkDataSource` talks to `/api/account/knowledge/map*`.
 *   - `createInMemoryDataSource` serves a pre-built map, which is what the
 *     synthetic benchmark page and every tile-store test drive — the tile
 *     store can then be exercised at 1M nodes with no server at all.
 *
 * Both are plain closures over `MapFilters`: a data source is immutable, and
 * changing filters means creating a new one (`TileStore.setSource`). That is
 * what makes `dataSource` identity a safe React dependency.
 */

import {
  MAX_TILES_PER_REQUEST,
  type MapFilters,
  type MapMeta,
  type MapResponse,
  type MapTile,
  type TileId,
  type TilesResponse,
} from '@/lib/knowledge/graph-map/types'
import { filtersToParams } from '@/lib/knowledge/graph-map'
import { StaleMapError, type MapDataSource } from './types'

const DEFAULT_BASE_PATH = '/api/account/knowledge/map'

export interface NetworkDataSourceOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  basePath?: string
}

/** Chunk `ids` into runs the tiles route will accept in one request. */
function chunkTileIds(ids: TileId[]): TileId[][] {
  const chunks: TileId[][] = []
  for (let i = 0; i < ids.length; i += MAX_TILES_PER_REQUEST) {
    chunks.push(ids.slice(i, i + MAX_TILES_PER_REQUEST))
  }
  return chunks
}

async function failure(res: Response, what: string): Promise<never> {
  // Read the body best-effort: the route returns `{ error, code }`, but an
  // edge/proxy error (502 from Vercel) is HTML, so never assume JSON.
  let detail = ''
  try {
    const text = await res.text()
    if (text) detail = `: ${text.slice(0, 200)}`
  } catch {
    // Body already consumed or the connection died — the status is enough.
  }
  throw new Error(`knowledge map ${what} failed (${res.status})${detail}`)
}

export function createNetworkDataSource(
  filters: MapFilters,
  opts: NetworkDataSourceOptions = {},
): MapDataSource {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH

  return {
    filters,

    async loadMap({ have, signal }: { have?: string; signal?: AbortSignal } = {}) {
      const params = filtersToParams(filters)
      if (have) params.set('have', have)
      const qs = params.toString()
      const res = await doFetch(`${basePath}${qs ? `?${qs}` : ''}`, {
        signal,
        // Tile content is per user and per workspace (§4.4) — never let a
        // shared HTTP cache or the bfcache hand it to a different viewer.
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) await failure(res, 'load')
      return (await res.json()) as MapResponse
    },

    async loadTiles(version: string, ids: TileId[], signal?: AbortSignal) {
      if (ids.length === 0) return []

      const chunks = chunkTileIds(ids)
      const responses = await Promise.all(
        chunks.map(async (chunk) => {
          const params = filtersToParams(filters)
          params.set('v', version)
          params.set('t', chunk.join(','))
          const res = await doFetch(`${basePath}/tiles?${params.toString()}`, {
            signal,
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          // 409 is the server saying the map moved under us. The tile store
          // turns this into a revalidate rather than an error toast.
          if (res.status === 409) throw new StaleMapError()
          if (!res.ok) await failure(res, 'tile load')
          const body = (await res.json()) as TilesResponse
          return body.tiles ?? []
        }),
      )

      return responses.flat()
    },
  }
}

export interface InMemoryMap {
  meta: MapMeta
  /** Every tile of the map, keyed by `z.x.y`. */
  tiles: Map<TileId, MapTile>
  /** The subset `loadMap` returns inline (ascending z), as the route would. */
  inline: MapTile[]
}

export interface InMemoryDataSourceOptions {
  /** Artificial per-request latency, so tests can observe in-flight state. */
  latencyMs?: number
}

/** Rejects with the same `AbortError` shape `fetch` produces. */
function abortError(): DOMException | Error {
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

/**
 * Resolves after `ms`, or rejects as soon as `signal` aborts. With `ms = 0` it
 * still yields a microtask-and-a-tick so callers can never observe a data
 * source that resolves synchronously — the network one never does either.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createInMemoryDataSource(
  built: InMemoryMap,
  opts: InMemoryDataSourceOptions = {},
): MapDataSource {
  const latency = opts.latencyMs ?? 0

  return {
    // A synthetic map has no server-side filtering; the filters are carried
    // only so this source satisfies the same identity contract as the network
    // one (the benchmark page swaps sources to change map size).
    filters: {},

    async loadMap({ have, signal }: { have?: string; signal?: AbortSignal } = {}) {
      await delay(latency, signal)
      if (have && have === built.meta.version) {
        return { unchanged: true, version: built.meta.version }
      }
      return { ...built.meta, tiles: built.inline }
    },

    async loadTiles(version: string, ids: TileId[], signal?: AbortSignal) {
      await delay(latency, signal)
      if (version !== built.meta.version) throw new StaleMapError()
      const out: MapTile[] = []
      for (const id of ids) {
        const tile = built.tiles.get(id)
        // A manifest-only id that the map does not actually hold is simply
        // absent from the response; the store treats it as "never arrives".
        if (tile) out.push(tile)
      }
      return out
    },
  }
}
