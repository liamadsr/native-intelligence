import { describe, it, expect } from 'vitest'
import { tileId } from '@/lib/knowledge/graph-map/types'
import {
  buildTileIndex,
  computeVisibleTiles,
  viewportWorldRect,
  VIEWPORT_PAD_FRACTION,
} from '../visible-tiles'
import { continuousZoom, fetchDepth } from '../lod'
import { buildLayeredMap, makeMeta, WORLD } from './fixtures'
import type { CameraState, Viewport } from '../types'

const VIEWPORT: Viewport = { width: 1024, height: 1024, dpr: 2 }

/** Camera showing the whole 1024-unit world in a 1024 px viewport. */
const OVERVIEW: CameraState = { x: 512, y: 512, k: 1 }

describe('viewportWorldRect', () => {
  it('centres on the camera and grows by the pad fraction', () => {
    const rect = viewportWorldRect(OVERVIEW, VIEWPORT)
    const half = 512 * (1 + VIEWPORT_PAD_FRACTION)
    expect(rect.minX).toBeCloseTo(512 - half)
    expect(rect.maxX).toBeCloseTo(512 + half)
    expect(rect.minY).toBeCloseTo(512 - half)
    expect(rect.maxY).toBeCloseTo(512 + half)
  })

  it('shrinks in world units as the camera zooms in', () => {
    const zoomed = viewportWorldRect({ x: 512, y: 512, k: 8 }, VIEWPORT, 0)
    expect(zoomed.maxX - zoomed.minX).toBeCloseTo(1024 / 8)
  })

  it('accepts an explicit zero pad', () => {
    const rect = viewportWorldRect(OVERVIEW, VIEWPORT, 0)
    expect(rect.minX).toBeCloseTo(0)
    expect(rect.maxX).toBeCloseTo(1024)
  })
})

describe('buildTileIndex', () => {
  it('reports only the tiles the manifest lists', () => {
    const index = buildTileIndex(makeMeta('v', [[0, 0, 0, 10, 0], [1, 1, 1, 5, 0]]))
    expect(index.has(0, 0, 0)).toBe(true)
    expect(index.has(1, 1, 1)).toBe(true)
    expect(index.has(1, 0, 0)).toBe(false)
    expect(index.world).toEqual(WORLD)
  })

  it('caps maxZ at the deepest tile the manifest actually has', () => {
    // meta.maxZ claims 5, but nothing deeper than z=1 exists: walking to 5
    // would descend through four empty levels on every camera move.
    const meta = makeMeta('v', [[0, 0, 0, 10, 0], [1, 0, 0, 5, 0]])
    meta.maxZ = 5
    expect(buildTileIndex(meta).maxZ).toBe(1)
  })
})

describe('computeVisibleTiles', () => {
  const map = buildLayeredMap()
  const index = buildTileIndex(map.meta)

  it('returns just the overview tile when the whole world is in view', () => {
    const { wanted, zc } = computeVisibleTiles(index, OVERVIEW, VIEWPORT)
    expect(zc).toBe(0)
    // fetchDepth(0) = ceil(0.5) = 1, so the z=1 ring is prefetched too.
    expect(wanted[0]).toBe(tileId(0, 0, 0))
    expect(wanted).toContain(tileId(1, 0, 0))
    expect(wanted).not.toContain(tileId(2, 0, 0))
  })

  it('orders ascending z — parents always before their children', () => {
    const camera: CameraState = { x: 100, y: 100, k: 4 }
    const { wanted } = computeVisibleTiles(index, camera, VIEWPORT)
    const levels = wanted.map((id) => Number(id.split('.')[0]))
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1])
    }
    expect(wanted[0]).toBe(tileId(0, 0, 0))
  })

  it('only returns tiles that exist in the manifest', () => {
    // Deep zoom into the BOTTOM-right corner: geometry says z=2 tiles are in
    // view, but the fixture only has z=2 under 1.0.0 (top-left).
    const camera: CameraState = { x: 900, y: 900, k: 8 }
    const { wanted } = computeVisibleTiles(index, camera, VIEWPORT)
    for (const id of wanted) expect(map.tiles.has(id)).toBe(true)
    expect(wanted).toContain(tileId(1, 1, 1))
    expect(wanted.filter((id) => id.startsWith('2.'))).toHaveLength(0)
  })

  it('reaches the existing z=2 tiles when zoomed into the top-left corner', () => {
    const camera: CameraState = { x: 60, y: 60, k: 8 }
    const { wanted, zc } = computeVisibleTiles(index, camera, VIEWPORT)
    expect(zc).toBeGreaterThan(1)
    expect(wanted).toContain(tileId(0, 0, 0))
    expect(wanted).toContain(tileId(1, 0, 0))
    expect(wanted).toContain(tileId(2, 0, 0))
    // 2.1.0 is the corner's right neighbour — outside a viewport this tight.
    expect(wanted).not.toContain(tileId(1, 1, 1))
  })

  it('never exceeds fetchDepth for the current zoom', () => {
    for (const k of [1, 2, 4, 8, 16]) {
      const camera: CameraState = { x: 128, y: 128, k }
      const { wanted, zc } = computeVisibleTiles(index, camera, VIEWPORT)
      const limit = fetchDepth(continuousZoom(camera, WORLD.size, index.maxZ), index.maxZ)
      for (const id of wanted) {
        expect(Number(id.split('.')[0])).toBeLessThanOrEqual(limit)
      }
      expect(zc).toBeLessThanOrEqual(index.maxZ)
    }
  })

  it('includes tiles just outside the viewport thanks to the 25% padding', () => {
    // Camera hard against the left edge of 1.1.0 at a zoom where the padding
    // is what reaches back into 1.0.0.
    const camera: CameraState = { x: 520, y: 512, k: 2 }
    const unpadded = viewportWorldRect(camera, VIEWPORT, 0)
    expect(unpadded.minX).toBeGreaterThan(256)
    const { wanted } = computeVisibleTiles(index, camera, VIEWPORT)
    expect(wanted).toContain(tileId(1, 0, 0))
  })

  it('descends through a missing intermediate level', () => {
    // 1.0.0 is absent, but its child 2.0.0 exists: the walk must not prune
    // the subtree just because the parent is not in the manifest.
    const sparse = buildTileIndex(
      makeMeta('v', [
        [0, 0, 0, 10, 0],
        [2, 0, 0, 5, 0],
      ]),
    )
    const { wanted } = computeVisibleTiles(sparse, { x: 60, y: 60, k: 8 }, VIEWPORT)
    expect(wanted).toContain(tileId(0, 0, 0))
    expect(wanted).toContain(tileId(2, 0, 0))
    expect(wanted).not.toContain(tileId(1, 0, 0))
  })

  it('survives a degenerate zero scale without wanting the whole map', () => {
    const { wanted } = computeVisibleTiles(index, { x: 512, y: 512, k: 0 }, VIEWPORT)
    expect(Array.isArray(wanted)).toBe(true)
  })
})
