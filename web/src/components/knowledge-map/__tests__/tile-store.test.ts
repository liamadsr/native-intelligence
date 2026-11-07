import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tileId, type MapMeta, type MapTile, type TileId } from '@/lib/knowledge/graph-map/types'
import { TileStore, type TileStoreCallbacks } from '../tile-store'
import { createInMemoryDataSource, type InMemoryMap } from '../data-source'
import { StaleMapError, type CameraState, type MapDataSource, type ResidentTile, type Viewport } from '../types'
import { buildLayeredMap, buildMap, makeTile, WORLD } from './fixtures'

const VIEWPORT: Viewport = { width: 1024, height: 1024, dpr: 2 }
const OVERVIEW: CameraState = { x: 512, y: 512, k: 1 }

function makeCallbacks() {
  const loaded: ResidentTile[] = []
  const evicted: ResidentTile[] = []
  const metas: MapMeta[] = []
  const errors: unknown[] = []
  let resets = 0
  let frames = 0
  const callbacks: TileStoreCallbacks = {
    onTileLoaded: (t) => loaded.push(t),
    onTileEvicted: (t) => evicted.push(t),
    onReset: () => {
      resets++
    },
    onMeta: (m) => metas.push(m),
    onError: (e) => errors.push(e),
    requestFrame: () => {
      frames++
    },
  }
  return {
    callbacks,
    loaded,
    evicted,
    metas,
    errors,
    get resets() {
      return resets
    },
    get frames() {
      return frames
    },
  }
}

/** Let queued promise jobs (and any zero-delay timers) drain. */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Drive the store the way the shell does: a downloaded tile is ADMITTED by a
 * frame, not by the fetch completing (that is the point of the admit budget —
 * see `drainAdmissions`). The real shell gets there via `requestFrame` →
 * rAF → `update()`; here we just interleave the two by hand.
 *
 * Tests about admission PACING drive `update()` themselves and count; tests
 * about what gets fetched or evicted use this and stop caring which frame a
 * tile landed on.
 */
async function settleFrames(
  store: TileStore,
  camera: CameraState,
  frames = 8,
  startFrame = 1,
) {
  let tiles: ResidentTile[] = []
  for (let i = 0; i < frames; i++) {
    tiles = store.update(camera, VIEWPORT, startFrame + i)
    await settle(2)
  }
  return tiles
}

/** Wrap a source so tests can observe and gate each loadTiles call. */
function instrument(source: MapDataSource) {
  const requests: Array<{ ids: TileId[]; signal?: AbortSignal; aborted: () => boolean }> = []
  const gates: Array<() => void> = []
  let gated = false

  const wrapped: MapDataSource = {
    filters: source.filters,
    loadMap: (opts) => source.loadMap(opts),
    loadTiles: (version, ids, signal) => {
      const record = { ids, signal, aborted: () => signal?.aborted ?? false }
      requests.push(record)
      if (!gated) return source.loadTiles(version, ids, signal)
      return new Promise((resolve, reject) => {
        gates.push(() => {
          source.loadTiles(version, ids, signal).then(resolve, reject)
        })
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    },
  }

  return {
    source: wrapped,
    requests,
    setGated(on: boolean) {
      gated = on
    },
    releaseAll() {
      const pending = gates.splice(0)
      for (const gate of pending) gate()
    },
    get inFlightCount() {
      return requests.filter((r) => !r.aborted()).length
    },
  }
}

describe('TileStore — loading', () => {
  it('makes the inline tiles resident and reports meta', async () => {
    const map = buildLayeredMap()
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(map), h.callbacks)

    await store.load()

    expect(store.meta?.version).toBe('v1')
    expect(h.metas).toHaveLength(1)
    expect(h.loaded.map((t) => t.id)).toEqual([tileId(0, 0, 0)])
    expect(store.residentTiles()).toHaveLength(1)
    // Wire columns became typed arrays with a truthful node count.
    const overview = store.residentTiles()[0]
    expect(overview.nodeCount).toBe(2)
    expect(overview.nodeX).toBeInstanceOf(Float32Array)
    expect(overview.nodeId).toBeInstanceOf(Uint32Array)
    expect(overview.edgeSource).toBeInstanceOf(Uint16Array)
  })

  it('surfaces a load failure through onError instead of throwing', async () => {
    const h = makeCallbacks()
    const failing: MapDataSource = {
      filters: {},
      loadMap: async () => {
        throw new Error('network down')
      },
      loadTiles: async () => [],
    }
    const store = new TileStore(failing, h.callbacks)
    await expect(store.load()).resolves.toBeUndefined()
    expect(h.errors).toHaveLength(1)
    expect((h.errors[0] as Error).message).toBe('network down')
  })
})

describe('TileStore — streaming', () => {
  let map: InMemoryMap
  beforeEach(() => {
    map = buildLayeredMap()
  })

  it('fetches children when the camera zooms in', async () => {
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(map), h.callbacks)
    await store.load()

    // Frames, not just microtasks: a downloaded tile is admitted BY a frame.
    await settleFrames(store, { x: 60, y: 60, k: 8 })

    const ids = store.residentTiles().map((t) => t.id).sort()
    expect(ids).toContain(tileId(1, 0, 0))
    expect(ids).toContain(tileId(2, 0, 0))
    expect(ids).toContain(tileId(0, 0, 0))
  })

  it('never exceeds the concurrency cap', async () => {
    const wide = buildMap(
      'v1',
      [
        makeTile(0, 0, 0, [{ id: 1, x: 10, y: 10 }]),
        ...Array.from({ length: 4 }, (_, i) =>
          makeTile(1, i % 2, Math.floor(i / 2), [{ id: 10 + i, x: 10, y: 10 }]),
        ),
      ],
      [tileId(0, 0, 0)],
    )
    const inst = instrument(createInMemoryDataSource(wide))
    inst.setGated(true)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks, { concurrency: 2 })
    await store.load()

    store.update(OVERVIEW, VIEWPORT, 1)
    await settle()

    // Four z=1 tiles are wanted, but only two requests may be open.
    expect(inst.requests).toHaveLength(2)
    inst.releaseAll()
    await settle()
    expect(inst.requests.length).toBeGreaterThan(2)
    expect(inst.requests.length).toBeLessThanOrEqual(4)
  })

  it('aborts requests for tiles the camera has panned away from', async () => {
    const inst = instrument(createInMemoryDataSource(map))
    inst.setGated(true)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks, { concurrency: 4 })
    await store.load()

    // Zoom into the top-left corner: wants 1.0.0 / 2.0.0.
    store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 1)
    await settle()
    const cornerRequests = inst.requests.filter((r) => r.ids.includes(tileId(2, 0, 0)))
    expect(cornerRequests.length).toBeGreaterThan(0)
    expect(cornerRequests[0].aborted()).toBe(false)

    // Fly to the far corner — 2.0.0 is no longer wanted anywhere.
    store.update({ x: 960, y: 960, k: 8 }, VIEWPORT, 2)
    await settle()
    expect(cornerRequests[0].aborted()).toBe(true)
  })

  it('does not re-request a tile the source never returns', async () => {
    // 1.1.0 is in the manifest but absent from the tile map: a single attempt,
    // then the store must stop asking or it spins every frame.
    const ghost = buildMap('v1', [makeTile(0, 0, 0, [{ id: 1, x: 10, y: 10 }])], [tileId(0, 0, 0)])
    ghost.meta.manifest.push([1, 0, 0, 3, 0])
    ghost.meta.maxZ = 1

    const inst = instrument(createInMemoryDataSource(ghost))
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks)
    await store.load()

    for (let frame = 1; frame <= 4; frame++) {
      store.update(OVERVIEW, VIEWPORT, frame)
      await settle()
    }
    const attempts = inst.requests.filter((r) => r.ids.includes(tileId(1, 0, 0)))
    expect(attempts).toHaveLength(1)
  })

  it('skips the quadtree walk for camera moves below the hysteresis threshold', async () => {
    const inst = instrument(createInMemoryDataSource(map))
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks)
    await store.load()

    store.update(OVERVIEW, VIEWPORT, 1)
    await settle()
    const after = inst.requests.length

    // A one-world-unit nudge at k=1 is one screen px — far below 8%.
    store.update({ x: 513, y: 512, k: 1 }, VIEWPORT, 2)
    await settle()
    expect(inst.requests).toHaveLength(after)
  })
})

describe('TileStore — eviction', () => {
  /** A wide map: one overview + a full z=1 ring + several z=2 corner tiles. */
  function buildEvictionMap(): InMemoryMap {
    const tiles: MapTile[] = [makeTile(0, 0, 0, [{ id: 1, x: 512, y: 512, importance: 999 }])]
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        tiles.push(makeTile(1, x, y, [{ id: 100 + x * 2 + y, x: 256, y: 256 }]))
      }
    }
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        tiles.push(makeTile(2, x, y, [{ id: 200 + x * 4 + y, x: 128, y: 128 }]))
      }
    }
    return buildMap('v1', tiles, [tileId(0, 0, 0)])
  }

  it('never evicts 0.0.0 nor an ancestor of a wanted tile, and never moves a slab', async () => {
    const evMap = buildEvictionMap()
    const h = makeCallbacks()
    // Tight budget forces eviction almost immediately.
    const store = new TileStore(createInMemoryDataSource(evMap), h.callbacks, {
      maxResidentTiles: 5,
      concurrency: 8,
    })
    await store.load()

    const overview = store.residentTiles().find((t) => t.id === tileId(0, 0, 0))
    expect(overview).toBeDefined()
    const overviewSlab = overview!.slab

    // Sweep the map at deep zoom so far more tiles are wanted than fit.
    const corners: CameraState[] = [
      { x: 128, y: 128, k: 8 },
      { x: 896, y: 128, k: 8 },
      { x: 896, y: 896, k: 8 },
      { x: 128, y: 896, k: 8 },
    ]
    const slabsSeen = new Map<TileId, number>()
    let frame = 1
    for (const camera of corners) {
      for (let i = 0; i < 3; i++) {
        store.update(camera, VIEWPORT, frame++)
        await settle()
      }
      for (const tile of store.residentTiles()) {
        const previous = slabsSeen.get(tile.id)
        // A tile's slab is fixed for its whole residency. (It may differ after
        // an evict/reload cycle, which is why this only checks live tiles.)
        if (previous !== undefined && store.residentTiles().includes(tile)) {
          expect(tile.slab).toBe(previous)
        }
        slabsSeen.set(tile.id, tile.slab)
      }
    }

    // 0.0.0 stayed resident on the same slab through all of it.
    const stillThere = store.residentTiles().find((t) => t.id === tileId(0, 0, 0))
    expect(stillThere).toBeDefined()
    expect(stillThere!.slab).toBe(overviewSlab)
    expect(h.evicted.some((t) => t.id === tileId(0, 0, 0))).toBe(false)

    // Nothing resident exceeds the slab budget.
    expect(store.residentTiles().length).toBeLessThanOrEqual(5)
  })

  it('protects a resident ancestor that is NOT itself in the wanted set', async () => {
    // The tiling is sparse: 1.0.0 exists, 2.0.0 does NOT, 3.0.0 does. Zoomed
    // deep, the wanted set is {0.0.0, 1.0.0, 3.0.0} — so the only thing
    // keeping an already-resident 2.x.y from being the eviction victim is the
    // ancestor rule. (With a dense manifest every ancestor is also wanted, so
    // this is the case that actually exercises `protectedTiles`.)
    const sparseTiles: MapTile[] = [
      makeTile(0, 0, 0, [{ id: 1, x: 512, y: 512, importance: 999 }]),
      makeTile(1, 0, 0, [{ id: 10, x: 40, y: 40 }]),
      makeTile(3, 0, 0, [{ id: 30, x: 20, y: 20 }]),
      // Far-away filler so the budget is genuinely contended.
      makeTile(1, 1, 1, [{ id: 11, x: 256, y: 256 }]),
    ]
    const sparse = buildMap('v1', sparseTiles, [tileId(0, 0, 0)])
    // 2.0.0 is resident (loaded earlier) but absent from the manifest, so the
    // walk never wants it again.
    const orphanAncestor = makeTile(2, 0, 0, [{ id: 20, x: 60, y: 60 }])
    sparse.tiles.set(tileId(2, 0, 0), orphanAncestor)
    sparse.inline = [...sparse.inline, orphanAncestor]

    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(sparse), h.callbacks, {
      maxResidentTiles: 3,
      concurrency: 8,
    })
    await store.load()
    expect(store.residentTiles().map((t) => t.id)).toContain(tileId(2, 0, 0))

    // Zoom deep into the top-left corner and keep frames coming, so eviction
    // must choose victims under a 3-slab budget.
    for (let frame = 1; frame <= 4; frame++) {
      store.update({ x: 20, y: 20, k: 64 }, VIEWPORT, frame)
      await settle()
    }

    // 2.0.0 is an ancestor of the wanted 3.0.0 — it must never be the victim.
    expect(h.evicted.map((t) => t.id)).not.toContain(tileId(2, 0, 0))
    expect(h.evicted.map((t) => t.id)).not.toContain(tileId(0, 0, 0))
    expect(store.residentTiles().map((t) => t.id)).toContain(tileId(2, 0, 0))
  })

  it('evicts the least-recently-visible unprotected tile', async () => {
    const evMap = buildEvictionMap()
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(evMap), h.callbacks, {
      maxResidentTiles: 4,
      concurrency: 8,
    })
    await store.load()

    store.update({ x: 128, y: 128, k: 8 }, VIEWPORT, 1)
    await settle()
    store.update({ x: 896, y: 896, k: 8 }, VIEWPORT, 2)
    await settle()
    store.update({ x: 896, y: 896, k: 8 }, VIEWPORT, 3)
    await settle()

    // Whatever went, it was not an ancestor of what is now wanted.
    for (const gone of h.evicted) {
      expect(gone.id).not.toBe(tileId(0, 0, 0))
    }
    expect(store.residentTiles().length).toBeLessThanOrEqual(4)
  })
})

describe('TileStore — lookups', () => {
  it('findById / findByKey survive unrelated evictions and go null after eviction', async () => {
    const tiles: MapTile[] = [
      makeTile(0, 0, 0, [{ id: 1, x: 512, y: 512, key: 'claim:root', importance: 999 }]),
    ]
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        const id = 100 + x * 2 + y
        tiles.push(makeTile(1, x, y, [{ id, x: 256, y: 256, key: `claim:c${id}` }]))
      }
    }
    const lookupMap = buildMap('v1', tiles, [tileId(0, 0, 0)])

    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(lookupMap), h.callbacks, {
      maxResidentTiles: 3,
      concurrency: 8,
    })
    await store.load()

    expect(store.findById(1)?.tile.id).toBe(tileId(0, 0, 0))
    expect(store.findByKey('claim:root')?.index).toBe(0)
    expect(store.findById(999999)).toBeNull()
    expect(store.findByKey('claim:nope')).toBeNull()

    store.update(OVERVIEW, VIEWPORT, 1)
    await settle()
    // The root is unaffected by children loading and evicting around it.
    expect(store.findById(1)?.tile.id).toBe(tileId(0, 0, 0))
    expect(store.findByKey('claim:root')).not.toBeNull()

    // Anything that was evicted must no longer resolve.
    for (const gone of h.evicted) {
      for (let i = 0; i < gone.nodeCount; i++) {
        const ref = store.findById(gone.nodeId[i])
        expect(ref?.tile).not.toBe(gone)
      }
    }
  })
})

describe('TileStore — version changes', () => {
  it('revalidate returns unchanged when the version matches', async () => {
    const map = buildLayeredMap()
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(map), h.callbacks)
    await store.load()
    const resetsBefore = h.resets

    expect(await store.revalidate()).toBe('unchanged')
    expect(h.resets).toBe(resetsBefore)
    expect(store.residentTiles()).toHaveLength(1)
  })

  it('an unchanged revalidate keeps in-flight tile requests alive', async () => {
    // Before: the probe bumped the tile generation, so requests already in
    // flight were dropped without leaving `inFlight` and held every slot.
    const wide = buildMap(
      'v1',
      [
        makeTile(0, 0, 0, [{ id: 1, x: 10, y: 10 }]),
        ...Array.from({ length: 4 }, (_, i) =>
          makeTile(1, i % 2, Math.floor(i / 2), [{ id: 10 + i, x: 10, y: 10 }]),
        ),
      ],
      [tileId(0, 0, 0)],
    )
    const inst = instrument(createInMemoryDataSource(wide))
    inst.setGated(true)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks, { concurrency: 2 })
    await store.load()

    store.update(OVERVIEW, VIEWPORT, 1)
    await settle()
    expect(inst.requests).toHaveLength(2)

    expect(await store.revalidate()).toBe('unchanged')
    inst.setGated(false)
    inst.releaseAll()
    await settleFrames(store, OVERVIEW, 8, 2)

    // The two that were in flight landed, and the other two were asked for.
    const ids = new Set(inst.requests.flatMap((r) => r.ids))
    expect(ids.size).toBe(4)
    expect(store.residentTiles().filter((t) => t.id !== tileId(0, 0, 0))).toHaveLength(4)
  })

  it('revalidate swaps the map when the version moved', async () => {
    const first = buildLayeredMap('v1')
    let current = first
    const h = makeCallbacks()
    const switching: MapDataSource = {
      filters: {},
      loadMap: async ({ have }) => {
        if (have && have === current.meta.version) {
          return { unchanged: true, version: current.meta.version }
        }
        return { ...current.meta, tiles: current.inline }
      },
      loadTiles: async (version, ids) => {
        if (version !== current.meta.version) throw new StaleMapError()
        return ids.map((id) => current.tiles.get(id)).filter((t): t is MapTile => Boolean(t))
      },
    }

    const store = new TileStore(switching, h.callbacks)
    await store.load()
    expect(store.meta?.version).toBe('v1')

    current = buildLayeredMap('v2')
    expect(await store.revalidate()).toBe('updated')
    expect(store.meta?.version).toBe('v2')
    expect(h.metas.map((m) => m.version)).toEqual(['v1', 'v2'])
    // The swap is a full reset: old slabs and node ids cannot leak forward.
    expect(h.resets).toBeGreaterThanOrEqual(2)
    expect(store.residentTiles().map((t) => t.id)).toEqual([tileId(0, 0, 0)])
  })

  it('a StaleMapError from loadTiles triggers a revalidate', async () => {
    const stale = buildLayeredMap('v1')
    const fresh = buildLayeredMap('v2')
    let served = stale
    const h = makeCallbacks()
    const revalidated = vi.fn()

    const source: MapDataSource = {
      filters: {},
      loadMap: async ({ have }) => {
        revalidated()
        if (have && have === served.meta.version) {
          return { unchanged: true, version: served.meta.version }
        }
        return { ...served.meta, tiles: served.inline }
      },
      loadTiles: async (version) => {
        // The map moved between the manifest and this tile request.
        if (version !== served.meta.version) throw new StaleMapError()
        served = fresh
        throw new StaleMapError()
      },
    }

    const store = new TileStore(source, h.callbacks)
    await store.load()
    store.update(OVERVIEW, VIEWPORT, 1)
    await settle(10)

    expect(store.meta?.version).toBe('v2')
    expect(revalidated.mock.calls.length).toBeGreaterThanOrEqual(2)
    // A stale version is not an application error the UI should show.
    expect(h.errors).toHaveLength(0)
  })

  it('setSource resets and loads the new filter set', async () => {
    const a = buildLayeredMap('v1')
    const b = buildLayeredMap('v2')
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(a), h.callbacks)
    await store.load()
    await settleFrames(store, { x: 60, y: 60, k: 8 })
    expect(store.residentTiles().length).toBeGreaterThan(1)

    await store.setSource(createInMemoryDataSource(b))

    expect(store.meta?.version).toBe('v2')
    expect(store.residentTiles().map((t) => t.id)).toEqual([tileId(0, 0, 0)])
    expect(h.metas.map((m) => m.version)).toEqual(['v1', 'v2'])
  })
})

describe('TileStore — pause / resume', () => {
  it('pause aborts in-flight work and resume re-requests what is still wanted', async () => {
    const map = buildLayeredMap()
    const inst = instrument(createInMemoryDataSource(map))
    inst.setGated(true)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks, { concurrency: 4 })
    await store.load()

    store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 1)
    await settle()
    const opened = inst.requests.length
    expect(opened).toBeGreaterThan(0)

    store.pause()
    expect(inst.requests.every((r) => r.aborted())).toBe(true)

    // No new network while paused, even as frames keep coming.
    store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 2)
    await settle()
    expect(inst.requests).toHaveLength(opened)

    inst.setGated(false)
    store.resume()
    await settle()
    expect(inst.requests.length).toBeGreaterThan(opened)
    // The refetched tiles still need frames to be admitted.
    await settleFrames(store, { x: 60, y: 60, k: 8 }, 8, 3)
    expect(store.residentTiles().length).toBeGreaterThan(1)
  })

  it('dispose stops everything and aborts outstanding requests', async () => {
    const map = buildLayeredMap()
    const inst = instrument(createInMemoryDataSource(map))
    inst.setGated(true)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks)
    await store.load()
    store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 1)
    await settle()

    store.dispose()
    expect(inst.requests.every((r) => r.aborted())).toBe(true)
    expect(store.residentTiles()).toHaveLength(0)
    expect(store.findById(1)).toBeNull()

    // A late release after dispose must not resurrect anything.
    inst.releaseAll()
    await settle()
    expect(store.residentTiles()).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('TileStore — draw list', () => {
  it('returns resident tiles intersecting the viewport, ascending z', async () => {
    const map = buildLayeredMap()
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(map), h.callbacks)
    await store.load()

    store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 1)
    await settle()
    const draw = store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 2)

    expect(draw.length).toBeGreaterThan(1)
    for (let i = 1; i < draw.length; i++) {
      expect(draw[i].z).toBeGreaterThanOrEqual(draw[i - 1].z)
    }
    // Everything drawn really does intersect the viewport.
    const half = VIEWPORT.width / 2 / 8
    for (const tile of draw) {
      expect(tile.ox).toBeLessThan(60 + half)
      expect(tile.ox + tile.size).toBeGreaterThan(60 - half)
    }
    // And they were stamped with this frame.
    for (const tile of draw) expect(tile.lastVisibleFrame).toBe(2)
  })

  it('returns nothing before a map is loaded', () => {
    const map = buildLayeredMap()
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(map), h.callbacks)
    expect(store.update(OVERVIEW, VIEWPORT, 1)).toEqual([])
  })

  it('excludes a resident tile that is off screen', async () => {
    const wide = buildMap(
      'v1',
      [
        makeTile(0, 0, 0, [{ id: 1, x: 512, y: 512 }]),
        makeTile(1, 0, 0, [{ id: 10, x: 256, y: 256 }]),
        makeTile(1, 1, 1, [{ id: 11, x: 256, y: 256 }]),
      ],
      [tileId(0, 0, 0), tileId(1, 0, 0), tileId(1, 1, 1)],
    )
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(wide), h.callbacks)
    await store.load()
    expect(store.residentTiles()).toHaveLength(3)

    // Tight camera on the top-left quadrant: 1.1.1 (bottom-right) is off screen.
    const draw = store.update({ x: 100, y: 100, k: 8 }, VIEWPORT, 1)
    expect(draw.map((t) => t.id)).not.toContain(tileId(1, 1, 1))
    expect(draw.map((t) => t.id)).toContain(tileId(1, 0, 0))
    // Off-screen ≠ evicted.
    expect(store.residentTiles()).toHaveLength(3)
  })
})

describe('TileStore — admission budget', () => {
  /**
   * Admitting a tile is not free — wire columns become typed arrays here, and
   * the shell's onTileLoaded then does two bufferSubData, the neighbour-index
   * update and a label invalidation. Every tile that resolved since the last
   * frame used to be admitted in ONE frame: measured on the 1M-node tour as 5
   * of 358 frames over 16.7 ms, the worst at 84 ms against a 1.6 ms median.
   *
   * These tests drive a FAKE CLOCK that charges a fixed cost per admission, so
   * the pacing is deterministic rather than a race against the real one.
   */

  /**
   * A clock that advances by `costMs` on every read.
   *
   * `drainAdmissions` reads it once to take the start time and once per loop
   * iteration, so a budget of `costMs` admits one tile per frame, `2 × costMs`
   * admits two, and so on. Deterministic, unlike racing the real clock.
   */
  function fakeClock(costMs: number) {
    let t = 0
    return {
      now: () => {
        const value = t
        t += costMs
        return value
      },
      get t() {
        return t
      },
    }
  }

  /** A map with one overview tile and `n` children, all wanted at once. */
  function burstMap(n: number): InMemoryMap {
    const children = Array.from({ length: n }, (_, i) =>
      makeTile(1, i % 2, Math.floor(i / 2) % 2, [{ id: 100 + i, x: 100, y: 100 }]),
    )
    return buildMap(
      'v1',
      [makeTile(0, 0, 0, [{ id: 1, x: 512, y: 512 }]), ...children],
      [tileId(0, 0, 0)],
    )
  }

  it('spreads a burst of resolved tiles across several frames', async () => {
    // Four children resolve together; each admission costs 3 ms against a
    // 4 ms budget, so no frame may admit more than two.
    const clock = fakeClock(3)
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(burstMap(4)), h.callbacks, {
      concurrency: 4,
      admitBudgetMs: 4,
      now: clock.now,
    })
    await store.load()

    const camera: CameraState = { x: 512, y: 512, k: 2 }
    store.update(camera, VIEWPORT, 1)
    await settle()

    const admittedPerFrame: number[] = []
    for (let frame = 2; frame <= 8; frame++) {
      const before = store.residentTiles().length
      store.update(camera, VIEWPORT, frame)
      admittedPerFrame.push(store.residentTiles().length - before)
      await settle(1)
    }

    // No single frame swallowed the whole burst...
    expect(Math.max(...admittedPerFrame)).toBeLessThan(4)
    // ...and it still all arrived.
    expect(store.residentTiles().length).toBe(5)
    // Which means it genuinely took more than one frame.
    expect(admittedPerFrame.filter((n) => n > 0).length).toBeGreaterThan(1)
  })

  it('always admits at least one tile per frame, however small the budget', async () => {
    // A zero budget must not stall the map forever: progress is guaranteed.
    const clock = fakeClock(50)
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(burstMap(4)), h.callbacks, {
      concurrency: 4,
      admitBudgetMs: 0,
      now: clock.now,
    })
    await store.load()

    const camera: CameraState = { x: 512, y: 512, k: 2 }
    store.update(camera, VIEWPORT, 1)
    await settle()

    const before = store.residentTiles().length
    store.update(camera, VIEWPORT, 2)
    expect(store.residentTiles().length).toBe(before + 1)

    // And it keeps going, one per frame, until the queue is empty.
    for (let frame = 3; frame <= 10; frame++) store.update(camera, VIEWPORT, frame)
    expect(store.residentTiles().length).toBe(5)
  })

  it('admits parents before children', async () => {
    // Two levels resolve together; the shallow tile is the backdrop for more
    // of the view, so it must land first however the responses interleaved.
    const layered = buildMap(
      'v1',
      [
        makeTile(0, 0, 0, [{ id: 1, x: 512, y: 512 }]),
        makeTile(1, 0, 0, [{ id: 10, x: 100, y: 100 }]),
        makeTile(2, 0, 0, [{ id: 20, x: 50, y: 50 }]),
        makeTile(3, 0, 0, [{ id: 30, x: 25, y: 25 }]),
      ],
      [tileId(0, 0, 0)],
    )
    const clock = fakeClock(10)
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(layered), h.callbacks, {
      concurrency: 4,
      admitBudgetMs: 1,
      now: clock.now,
    })
    await store.load()

    const camera: CameraState = { x: 60, y: 60, k: 32 }
    store.update(camera, VIEWPORT, 1)
    await settle()

    // One per frame at this budget, so the load order is the admission order.
    for (let frame = 2; frame <= 8; frame++) {
      store.update(camera, VIEWPORT, frame)
      await settle(1)
    }

    const order = h.loaded.map((t) => t.z)
    expect(order[0]).toBe(0) // the inline overview
    const streamed = order.slice(1)
    expect(streamed).toEqual([...streamed].sort((a, b) => a - b))
    expect(streamed).toContain(1)
  })

  it('asks for another frame while the admission queue is non-empty', async () => {
    const clock = fakeClock(10)
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(burstMap(4)), h.callbacks, {
      concurrency: 4,
      admitBudgetMs: 1,
      now: clock.now,
    })
    await store.load()

    const camera: CameraState = { x: 512, y: 512, k: 2 }
    store.update(camera, VIEWPORT, 1)
    await settle()

    // A frame that leaves work behind must re-arm the scheduler, or a map
    // that finished downloading sits half-admitted until the camera moves.
    const before = h.frames
    store.update(camera, VIEWPORT, 2)
    expect(h.frames).toBeGreaterThan(before)

    // Drain it, then a frame with an empty queue asks for nothing.
    for (let frame = 3; frame <= 10; frame++) store.update(camera, VIEWPORT, frame)
    const settled = h.frames
    store.update(camera, VIEWPORT, 11)
    expect(h.frames).toBe(settled)
  })

  it('drops queued tiles belonging to a superseded version', async () => {
    // Node ids are per-version: a tile admitted after a swap would address
    // the wrong nodes, so the queue must be emptied by the reset.
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(burstMap(4)), h.callbacks, {
      concurrency: 4,
      admitBudgetMs: 0,
      now: fakeClock(50).now,
    })
    await store.load()

    const camera: CameraState = { x: 512, y: 512, k: 2 }
    store.update(camera, VIEWPORT, 1)
    await settle()
    // One tile in, three still queued.
    store.update(camera, VIEWPORT, 2)
    const afterOne = store.residentTiles().length
    expect(afterOne).toBeGreaterThan(1)
    expect(afterOne).toBeLessThan(5)

    await store.setSource(createInMemoryDataSource(buildLayeredMap('v2')))
    expect(store.meta?.version).toBe('v2')

    // Frames after the swap must not resurrect anything from the old version.
    const justInline = store.residentTiles().map((t) => t.id)
    expect(justInline).toEqual([tileId(0, 0, 0)])
    for (let frame = 3; frame <= 8; frame++) store.update(camera, VIEWPORT, frame)
    expect(store.residentTiles().every((t) => t.nodeId[0] < 100 || t.z === 0)).toBe(true)
  })

  it('drops a queued tile the camera no longer wants', async () => {
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(buildLayeredMap()), h.callbacks, {
      concurrency: 4,
      admitBudgetMs: 0,
      now: fakeClock(50).now,
    })
    await store.load()

    // Zoom into the top-left corner, let 1.0.0 / 2.0.0 resolve into the queue.
    store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 1)
    await settle()

    // Fly to the far corner BEFORE those are admitted: they are dropped rather
    // than burning a slab the new wanted set needs.
    for (let frame = 2; frame <= 10; frame++) store.update({ x: 960, y: 960, k: 8 }, VIEWPORT, frame)
    expect(store.residentTiles().map((t) => t.id)).not.toContain(tileId(2, 0, 0))
  })
})

describe('TileStore — world geometry', () => {
  it('keeps float64 tile origins so deep zoom stays precise', async () => {
    const far = buildMap(
      'v1',
      [makeTile(0, 0, 0, [{ id: 1, x: 1.5, y: 2.5 }])],
      [tileId(0, 0, 0)],
    )
    far.meta.world = { ...WORLD }
    const h = makeCallbacks()
    const store = new TileStore(createInMemoryDataSource(far), h.callbacks)
    await store.load()
    const tile = store.residentTiles()[0]
    // Origin arrives as a plain JSON number and is stored unrounded.
    expect(tile.ox).toBe(0)
    expect(tile.size).toBe(1024)
    expect(tile.nodeX[0]).toBeCloseTo(1.5)
  })
})

describe('TileStore — empty answers are a retry cache, not a verdict', () => {
  /** A layered map whose z=1 tile can be made to come back empty on demand. */
  function ghostSource() {
    const ghost = buildMap('v1', [makeTile(0, 0, 0, [{ id: 1, x: 10, y: 10 }])], [tileId(0, 0, 0)])
    ghost.meta.manifest.push([1, 0, 0, 3, 0])
    ghost.meta.maxZ = 1
    ghost.tiles.set(tileId(1, 0, 0), makeTile(1, 0, 0, [{ id: 7, x: 5, y: 5 }]))

    let empty = true
    const inner = createInMemoryDataSource(ghost)
    const source: MapDataSource = {
      filters: inner.filters,
      loadMap: (opts) => inner.loadMap(opts),
      loadTiles: async (version, ids, signal) => {
        // The server-side case this models: a `sinceDays` tiling rebuilt in a
        // later hour bucket no longer holds a sparse edge tile, so the route
        // answers 200 with an empty list — indistinguishable on the wire from
        // "this tile has no nodes", and with the version unchanged throughout.
        if (empty) return []
        return inner.loadTiles(version, ids, signal)
      },
    }
    return {
      source,
      honest() {
        empty = false
      },
    }
  }

  const DEEP: CameraState = { x: 60, y: 60, k: 8 }

  it('does not spin: one empty answer suppresses further requests for a while', async () => {
    const g = ghostSource()
    const inst = instrument(g.source)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks)
    await store.load()

    await settleFrames(store, DEEP, 6)
    const attempts = inst.requests.filter((r) => r.ids.includes(tileId(1, 0, 0)))
    expect(attempts).toHaveLength(1)
  })

  it('retries after the window, so a transient empty answer is not permanent', async () => {
    const g = ghostSource()
    const inst = instrument(g.source)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks)
    await store.load()

    await settleFrames(store, DEEP, 4, 1)
    expect(inst.requests.filter((r) => r.ids.includes(tileId(1, 0, 0)))).toHaveLength(1)
    expect(store.residentTiles().map((t) => t.id)).not.toContain(tileId(1, 0, 0))

    // The server is healthy again — but nothing about the map version moved,
    // so before this fix the id stayed filtered out of every queue for the
    // life of the store and those nodes were invisible at every zoom level.
    g.honest()
    await settleFrames(store, DEEP, 4, 1000)

    expect(inst.requests.filter((r) => r.ids.includes(tileId(1, 0, 0))).length).toBeGreaterThan(1)
    expect(store.residentTiles().map((t) => t.id)).toContain(tileId(1, 0, 0))
  })

  it('resume() retires the retry cache — coming back is the user asking again', async () => {
    const g = ghostSource()
    const inst = instrument(g.source)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks)
    await store.load()

    await settleFrames(store, DEEP, 4)
    expect(store.residentTiles().map((t) => t.id)).not.toContain(tileId(1, 0, 0))

    g.honest()
    store.pause()
    store.resume()
    await settle()
    // Immediately, not after MISSING_RETRY_FRAMES: the tab was not fetching
    // while paused, so at most one round trip per still-wanted tile is spent.
    await settleFrames(store, DEEP, 4, 100)
    expect(store.residentTiles().map((t) => t.id)).toContain(tileId(1, 0, 0))
  })

  it('an ABORTED request is never recorded as empty', async () => {
    // Panning away cancels the fetch. That must not look like "the server has
    // nothing here", or a fast pan would poison every tile it flew over.
    const map = buildLayeredMap()
    const inst = instrument(createInMemoryDataSource(map))
    inst.setGated(true)
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks, { concurrency: 4 })
    await store.load()

    store.update(DEEP, VIEWPORT, 1)
    await settle()
    const first = inst.requests.length
    expect(first).toBeGreaterThan(0)

    // Fly away: the in-flight tiles are aborted.
    store.update({ x: 960, y: 960, k: 8 }, VIEWPORT, 2)
    await settle()
    expect(inst.requests.some((r) => r.aborted())).toBe(true)

    // Fly back and let it through: the same ids must be asked for again.
    inst.setGated(false)
    await settleFrames(store, DEEP, 6, 3)
    const again = inst.requests.length
    expect(again).toBeGreaterThan(first)
    expect(store.residentTiles().length).toBeGreaterThan(1)
  })
})

describe('TileStore — pause does not discard downloaded bytes', () => {
  it('resume() admits tiles parked in the admit queue instead of refetching them', async () => {
    // The window this covers: fetches RESOLVE, park in admitQueue waiting for
    // a frame with budget, and then the tab goes inactive — which pauses the
    // scheduler, so no frame ever drains them. resume() used to rebuild the
    // queue from `wanted` minus resident/inFlight/missing, and a parked id is
    // in none of those three, so every one was downloaded a second time and
    // the first copy thrown away by enqueueAdmission.
    const map = buildLayeredMap()
    const inst = instrument(createInMemoryDataSource(map))
    const h = makeCallbacks()
    const store = new TileStore(inst.source, h.callbacks, { concurrency: 4 })
    await store.load()

    // One frame to want + request; let the fetches resolve, but run NO further
    // frame, so they sit in admitQueue exactly as they do behind a paused
    // scheduler.
    store.update({ x: 60, y: 60, k: 8 }, VIEWPORT, 1)
    await settle()
    const fetchedBefore = inst.requests.flatMap((r) => r.ids)
    expect(fetchedBefore.length).toBeGreaterThan(0)

    store.pause()
    store.resume()
    await settle()

    const fetchedAfter = inst.requests.flatMap((r) => r.ids)
    const counts = new Map<TileId, number>()
    for (const id of fetchedAfter) counts.set(id, (counts.get(id) ?? 0) + 1)
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
    expect(duplicated).toEqual([])

    // And the parked bytes still become resident on the next frames.
    await settleFrames(store, { x: 60, y: 60, k: 8 }, 8, 2)
    expect(store.residentTiles().length).toBeGreaterThan(1)
  })
})
