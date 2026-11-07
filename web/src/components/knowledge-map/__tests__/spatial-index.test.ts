import { describe, it, expect } from 'vitest'
import { tileId } from '@/lib/knowledge/graph-map/types'
import { SpatialIndex, GRID_DIM, DEFAULT_HIT_RADIUS_PX } from '../spatial-index'
import { TileStore } from '../tile-store'
import { createInMemoryDataSource } from '../data-source'
import { buildMap, makeMeta, makeTile, WORLD, type NodeSpec } from './fixtures'
import type { CameraState, ResidentTile, Viewport } from '../types'

const VIEWPORT: Viewport = { width: 1024, height: 1024, dpr: 2 }

/** Make a resident tile directly, without a store — picking needs no streaming. */
async function residentTile(nodes: NodeSpec[], z = 0, x = 0, y = 0): Promise<ResidentTile> {
  const tile = makeTile(z, x, y, nodes)
  const map = buildMap('v1', [tile], [tileId(z, x, y)])
  const store = new TileStore(createInMemoryDataSource(map), {
    onTileLoaded: () => {},
    onTileEvicted: () => {},
    onReset: () => {},
    onMeta: () => {},
    onError: () => {},
    requestFrame: () => {},
  })
  await store.load()
  return store.residentTiles()[0]
}

/** Screen position of a world point under `camera`. */
function toScreen(camera: CameraState, viewport: Viewport, wx: number, wy: number) {
  return {
    sx: (wx - camera.x) * camera.k + viewport.width / 2,
    sy: (wy - camera.y) * camera.k + viewport.height / 2,
  }
}

describe('SpatialIndex.pick', () => {
  it('finds the node under the pointer at three zoom levels', async () => {
    const tile = await residentTile([
      { id: 1, x: 100, y: 100, r: 6, importance: 10, key: 'claim:a' },
      { id: 2, x: 700, y: 400, r: 6, importance: 20, key: 'claim:b' },
    ])
    const index = new SpatialIndex()

    for (const k of [0.5, 1, 4]) {
      const camera: CameraState = { x: 700, y: 400, k }
      const { sx, sy } = toScreen(camera, VIEWPORT, 700, 400)
      const hit = index.pick([tile], camera, VIEWPORT, sx, sy)
      expect(hit?.key).toBe('claim:b')
      expect(hit?.id).toBe(2)
      expect(hit?.wx).toBeCloseTo(700)
      expect(hit?.wy).toBeCloseTo(400)
    }
  })

  it('returns the highest-importance node when several overlap', async () => {
    // Three nodes within a couple of world units — at k=1 all are inside the
    // 8 px hit radius, so the tie-break is what decides.
    const tile = await residentTile([
      { id: 1, x: 500, y: 500, r: 4, importance: 5, key: 'claim:low' },
      { id: 2, x: 501, y: 500, r: 4, importance: 50, key: 'claim:high' },
      { id: 3, x: 502, y: 500, r: 4, importance: 9, key: 'claim:mid' },
    ])
    const index = new SpatialIndex()
    const camera: CameraState = { x: 500, y: 500, k: 1 }
    const { sx, sy } = toScreen(camera, VIEWPORT, 500, 500)

    const hit = index.pick([tile], camera, VIEWPORT, sx, sy)
    // The pointer is nearest `low`, but `high` is drawn on top — so it wins.
    expect(hit?.key).toBe('claim:high')
  })

  it('breaks importance ties by distance', async () => {
    const tile = await residentTile([
      { id: 1, x: 500, y: 500, r: 4, importance: 7, key: 'claim:near' },
      { id: 2, x: 503, y: 500, r: 4, importance: 7, key: 'claim:far' },
    ])
    const index = new SpatialIndex()
    const camera: CameraState = { x: 500, y: 500, k: 1 }
    const { sx, sy } = toScreen(camera, VIEWPORT, 500, 500)
    expect(index.pick([tile], camera, VIEWPORT, sx, sy)?.key).toBe('claim:near')
  })

  it('returns null for a far miss', async () => {
    const tile = await residentTile([{ id: 1, x: 100, y: 100, r: 4, key: 'claim:a' }])
    const index = new SpatialIndex()
    const camera: CameraState = { x: 100, y: 100, k: 4 }
    // 200 px away on screen — well outside any hit radius.
    const { sx, sy } = toScreen(camera, VIEWPORT, 100, 100)
    expect(index.pick([tile], camera, VIEWPORT, sx + 200, sy)).toBeNull()
  })

  it('honours the hitRadiusPx slop for a small dot', async () => {
    const tile = await residentTile([{ id: 1, x: 500, y: 500, r: 0.5, key: 'claim:tiny' }])
    const index = new SpatialIndex()
    const camera: CameraState = { x: 500, y: 500, k: 1 }
    const { sx, sy } = toScreen(camera, VIEWPORT, 500, 500)

    // 5 px off: inside the default 8 px slop even though the dot is sub-pixel.
    expect(index.pick([tile], camera, VIEWPORT, sx + 5, sy)?.key).toBe('claim:tiny')
    // With a 2 px radius the same pointer misses.
    expect(index.pick([tile], camera, VIEWPORT, sx + 5, sy, { hitRadiusPx: 2 })).toBeNull()
    expect(DEFAULT_HIT_RADIUS_PX).toBe(8)
  })

  it('skips tiles whose zoom alpha has faded out', async () => {
    const deep = await residentTile([{ id: 5, x: 10, y: 10, r: 6, key: 'claim:deep' }], 2, 0, 0)
    const index = new SpatialIndex()
    const world = deep.ox + 10
    const camera: CameraState = { x: world, y: deep.oy + 10, k: 4 }
    const { sx, sy } = toScreen(camera, VIEWPORT, world, deep.oy + 10)

    // zc = 2 → a z=2 tile is fully faded in and pickable.
    expect(index.pick([deep], camera, VIEWPORT, sx, sy, { zc: 2 })?.key).toBe('claim:deep')
    // zc = 0.5 → tileZoomAlpha(0.5, 2) = 0: invisible, so not pickable.
    expect(index.pick([deep], camera, VIEWPORT, sx, sy, { zc: 0.5 })).toBeNull()
  })

  it('resolves entityType through the meta lookup table', async () => {
    const tile = await residentTile([
      { id: 1, x: 500, y: 500, r: 6, kind: 1, etype: 2, key: 'contact:u1', label: 'Ada' },
    ])
    const index = new SpatialIndex()
    const camera: CameraState = { x: 500, y: 500, k: 1 }
    const { sx, sy } = toScreen(camera, VIEWPORT, 500, 500)
    const meta = makeMeta('v1', [[0, 0, 0, 1, 0]])

    const hit = index.pick([tile], camera, VIEWPORT, sx, sy, { meta })
    expect(hit?.kind).toBe('entity')
    expect(hit?.entityType).toBe('contact')
    expect(hit?.label).toBe('Ada')

    // Without meta the type is simply absent rather than wrong.
    expect(index.pick([tile], camera, VIEWPORT, sx, sy)?.entityType).toBeUndefined()
  })

  it('visits only a few cells at overview zoom, never the whole tile', async () => {
    // 1000 nodes spread over the tile: a naive implementation would test all
    // of them on every pointer move.
    const nodes: NodeSpec[] = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      x: (i % 40) * 25 + 5,
      y: Math.floor(i / 40) * 40 + 5,
      r: 3,
      importance: i,
    }))
    const tile = await residentTile(nodes)
    const index = new SpatialIndex()

    const camera: CameraState = { x: 512, y: 512, k: 1 }
    const { sx, sy } = toScreen(camera, VIEWPORT, 512, 512)
    index.pick([tile], camera, VIEWPORT, sx, sy)

    // The grid is 16×16 = 256 cells; a centre pick must touch a small
    // neighbourhood, not the lot.
    expect(index.lastVisitedCells).toBeGreaterThan(0)
    expect(index.lastVisitedCells).toBeLessThan(GRID_DIM * GRID_DIM)
    expect(index.lastVisitedCells).toBeLessThanOrEqual(16)
  })

  it('clamps the cell range when the hit radius exceeds a whole tile', async () => {
    // k tiny ⇒ the 8 px slop is a huge world distance. The walk must clamp to
    // the tile's 256 cells rather than looping over a vast nominal range.
    const tile = await residentTile([{ id: 1, x: 512, y: 512, r: 4, key: 'claim:a' }])
    const index = new SpatialIndex()
    const camera: CameraState = { x: 512, y: 512, k: 0.002 }
    const { sx, sy } = toScreen(camera, VIEWPORT, 512, 512)

    const hit = index.pick([tile], camera, VIEWPORT, sx, sy)
    expect(hit?.key).toBe('claim:a')
    expect(index.lastVisitedCells).toBeLessThanOrEqual(GRID_DIM * GRID_DIM)
  })

  it('searches across several tiles', async () => {
    const a = await residentTile([{ id: 1, x: 100, y: 100, r: 6, importance: 5, key: 'claim:a' }], 1, 0, 0)
    const b = await residentTile([{ id: 2, x: 100, y: 100, r: 6, importance: 9, key: 'claim:b' }], 1, 1, 1)
    const index = new SpatialIndex()

    const bx = b.ox + 100
    const by = b.oy + 100
    const camera: CameraState = { x: bx, y: by, k: 2 }
    const { sx, sy } = toScreen(camera, VIEWPORT, bx, by)
    expect(index.pick([a, b], camera, VIEWPORT, sx, sy)?.key).toBe('claim:b')
  })

  it('returns null for a degenerate camera scale', async () => {
    const tile = await residentTile([{ id: 1, x: 100, y: 100, key: 'claim:a' }])
    const index = new SpatialIndex()
    expect(index.pick([tile], { x: 0, y: 0, k: 0 }, VIEWPORT, 10, 10)).toBeNull()
  })

  it('drops a tile grid on remove and rebuilds it on the next query', async () => {
    const tile = await residentTile([{ id: 1, x: 500, y: 500, r: 6, key: 'claim:a' }])
    const index = new SpatialIndex()
    const camera: CameraState = { x: 500, y: 500, k: 1 }
    const { sx, sy } = toScreen(camera, VIEWPORT, 500, 500)

    expect(index.pick([tile], camera, VIEWPORT, sx, sy)?.key).toBe('claim:a')
    index.remove(tile)
    // Still correct after the grid was dropped — it is a cache, not state.
    expect(index.pick([tile], camera, VIEWPORT, sx, sy)?.key).toBe('claim:a')
    index.clear()
    expect(index.pick([tile], camera, VIEWPORT, sx, sy)?.key).toBe('claim:a')
  })

  it('keeps the world square the fixtures assume', () => {
    expect(WORLD.size).toBe(1024)
  })
})
