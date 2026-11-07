/**
 * Cross-package integration: REAL core (layout + tiling) → in-memory data
 * source → TileStore → SpatialIndex, with the camera math in between.
 *
 * The unit suites on either side use hand-written tile fixtures, so this is
 * the only place that proves the pieces agree on coordinate conventions: a
 * node must be pickable exactly where `worldToScreen` says it is drawn.
 */

import { describe, expect, it } from 'vitest'

import { generateSyntheticRows, layoutMap, tileMap } from '@/lib/knowledge/graph-map'
import { NODE_KIND } from '@/lib/knowledge/graph-map/types'

import { fitWorld, worldToScreen } from '../camera'
import { createInMemoryDataSource } from '../data-source'
import { continuousZoom } from '../lod'
import { SpatialIndex } from '../spatial-index'
import { TileStore } from '../tile-store'
import type { CameraState, ResidentTile, Viewport } from '../types'

const viewport: Viewport = { width: 1440, height: 860, dpr: 2 }

async function loadStore(claims: number) {
  const built = tileMap(layoutMap(generateSyntheticRows({ claims, seed: 7 })), {
    filters: {},
    version: 'it',
    nowMs: Date.UTC(2026, 8, 21),
  })
  const store = new TileStore(createInMemoryDataSource(built), {
    onTileLoaded: () => {},
    onTileEvicted: () => {},
    onReset: () => {},
    onMeta: () => {},
    onError: (e) => {
      throw e
    },
    requestFrame: () => {},
  })
  await store.load()
  return { store, built }
}

/** Drive update() until the wanted set for this camera is resident. */
async function settle(store: TileStore, camera: CameraState): Promise<ResidentTile[]> {
  let tiles: ResidentTile[] = []
  for (let frame = 1; frame <= 40; frame++) {
    tiles = store.update(camera, viewport, frame)
    await new Promise((r) => setTimeout(r, 0))
  }
  return tiles
}

describe('core → tile store → picking', () => {
  it('picks every hub of the overview tile exactly where it is drawn', async () => {
    const { store } = await loadStore(3000)
    const meta = store.meta!
    const camera = fitWorld(meta.world, viewport)
    const tiles = await settle(store, camera)
    const zc = continuousZoom(camera, meta.world.size, meta.maxZ)
    const index = new SpatialIndex()

    const root = tiles.find((t) => t.z === 0)!
    expect(root).toBeDefined()

    let checked = 0
    for (let i = root.nodeCount - 1; i >= 0 && checked < 60; i--) {
      if (root.nodeKind[i] !== NODE_KIND.entity) continue
      const wx = root.ox + root.nodeX[i]
      const wy = root.oy + root.nodeY[i]
      const s = worldToScreen(camera, viewport, wx, wy)
      if (s.x < 0 || s.y < 0 || s.x > viewport.width || s.y > viewport.height) continue
      const picked = index.pick(tiles, camera, viewport, s.x, s.y, { zc, meta })
      expect(picked, `hub ${root.keys[i]} at ${s.x.toFixed(1)},${s.y.toFixed(1)}`).not.toBeNull()
      // Something at least as important may sit on the same pixel at overview
      // zoom, but the pick must land on a node drawn at this spot.
      const ps = worldToScreen(camera, viewport, picked!.wx, picked!.wy)
      expect(Math.hypot(ps.x - s.x, ps.y - s.y)).toBeLessThan(13)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('picks a specific hub and a specific claim when zoomed in on them', async () => {
    const { store } = await loadStore(3000)
    const meta = store.meta!
    const overview = await settle(store, fitWorld(meta.world, viewport))
    const root = overview.find((t) => t.z === 0)!

    // Most important hub = last entry (arrays are importance-ascending).
    let hub = -1
    for (let i = root.nodeCount - 1; i >= 0; i--) {
      if (root.nodeKind[i] === NODE_KIND.entity) {
        hub = i
        break
      }
    }
    expect(hub).toBeGreaterThanOrEqual(0)
    const hx = root.ox + root.nodeX[hub]
    const hy = root.oy + root.nodeY[hub]

    // k = 1 CSS px per world unit: neighbouring claims are ~14 px apart.
    const camera: CameraState = { x: hx + 37, y: hy - 21, k: 1 }
    const tiles = await settle(store, camera)
    const zc = continuousZoom(camera, meta.world.size, meta.maxZ)
    const index = new SpatialIndex()

    const hs = worldToScreen(camera, viewport, hx, hy)
    const pickedHub = index.pick(tiles, camera, viewport, hs.x, hs.y, { zc, meta })
    expect(pickedHub?.key).toBe(root.keys[hub])

    // Any claim on screen must be pickable at its own drawn position.
    let claimsChecked = 0
    for (const tile of tiles) {
      for (let i = 0; i < tile.nodeCount && claimsChecked < 40; i++) {
        if (tile.nodeKind[i] !== NODE_KIND.claim) continue
        const wx = tile.ox + tile.nodeX[i]
        const wy = tile.oy + tile.nodeY[i]
        const s = worldToScreen(camera, viewport, wx, wy)
        if (s.x < 20 || s.y < 20 || s.x > viewport.width - 20 || s.y > viewport.height - 20) continue
        const picked = index.pick(tiles, camera, viewport, s.x, s.y, { zc, meta })
        expect(picked, `claim ${tile.keys[i]} in tile ${tile.id}`).not.toBeNull()
        const ps = worldToScreen(camera, viewport, picked!.wx, picked!.wy)
        expect(Math.hypot(ps.x - s.x, ps.y - s.y)).toBeLessThan(13)
        claimsChecked++
      }
    }
    expect(claimsChecked).toBeGreaterThan(5)
  })
})
