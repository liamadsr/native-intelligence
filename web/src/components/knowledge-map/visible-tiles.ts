/**
 * Viewport → wanted tile set.
 *
 * Pure math over the manifest: no fetching, no state. The tile store calls
 * `computeVisibleTiles` every frame the camera moved, so this must stay cheap
 * — it walks the quadtree top-down and prunes whole subtrees that miss the
 * padded viewport rather than scanning the manifest.
 */

import { tileId, type MapMeta, type TileId } from '@/lib/knowledge/graph-map/types'
import { continuousZoom, fetchDepth } from './lod'
import type { CameraState, Viewport, WorldRect } from './types'

/**
 * Fraction of the viewport kept loaded beyond each edge, so a pan of up to a
 * quarter of a screen shows already-resident tiles instead of holes.
 */
export const VIEWPORT_PAD_FRACTION = 0.25

/**
 * World-space rectangle the camera sees, grown by `padFraction` on every side.
 *
 * `camera.k` is CSS px per world unit and `camera.{x,y}` is the world point at
 * the viewport centre, so half the viewport in world units is
 * `width / 2 / k`.
 *
 * Sign-free by construction: the rect is symmetric about the camera centre on
 * both axes, so it is the same rectangle whichever way world +y points. (It
 * does point DOWN the screen — see camera.ts — but nothing here depends on it.)
 */
export function viewportWorldRect(
  camera: CameraState,
  viewport: Viewport,
  padFraction: number = VIEWPORT_PAD_FRACTION,
): WorldRect {
  // A zero or negative scale would produce an infinite rect that wants every
  // tile in the map; clamp to something tiny but finite instead.
  const k = camera.k > 0 ? camera.k : Number.MIN_VALUE
  const halfW = (viewport.width / 2 / k) * (1 + padFraction)
  const halfH = (viewport.height / 2 / k) * (1 + padFraction)
  return {
    minX: camera.x - halfW,
    minY: camera.y - halfH,
    maxX: camera.x + halfW,
    maxY: camera.y + halfH,
  }
}

export interface TileIndex {
  has(z: number, x: number, y: number): boolean
  readonly maxZ: number
  readonly world: MapMeta['world']
}

/**
 * Membership test over the manifest.
 *
 * The manifest lists only tiles that actually hold nodes — the tiling is
 * additive and sparse, so most (z,x,y) triples in the world square do not
 * exist. Asking for one would 404 / return nothing forever, which is why the
 * wanted set is intersected with this index rather than derived from geometry
 * alone.
 */
export function buildTileIndex(meta: MapMeta): TileIndex {
  const present = new Set<TileId>()
  let deepest = 0
  for (const [z, x, y] of meta.manifest) {
    present.add(tileId(z, x, y))
    if (z > deepest) deepest = z
  }
  // Trust the manifest over meta.maxZ: a maxZ deeper than any listed tile
  // would make the walk descend into levels that can never match.
  const maxZ = Math.min(meta.maxZ, deepest)

  return {
    maxZ,
    world: meta.world,
    has(z, x, y) {
      return present.has(tileId(z, x, y))
    },
  }
}

/**
 * The tiles the store should hold for this camera.
 *
 * Ordering is ascending z — parents first — because the map is additive: tile
 * 0.0.0 holds the 1000 most important nodes of the entire world, so fetching
 * it first paints a usable overview while the detail streams in. A deep tile
 * arriving before its ancestors would show leaves with no context.
 */
export function computeVisibleTiles(
  index: TileIndex,
  camera: CameraState,
  viewport: Viewport,
): { wanted: TileId[]; zc: number } {
  const world = index.world
  const zc = continuousZoom(camera, world.size, index.maxZ)
  const maxDepth = Math.min(index.maxZ, fetchDepth(zc, index.maxZ))
  const rect = viewportWorldRect(camera, viewport)

  const wanted: TileId[] = []

  // Breadth-first by level so the output is already ascending z without a
  // sort, and so a level that matches nothing prunes everything below it.
  let level: Array<[number, number]> = [[0, 0]]
  for (let z = 0; z <= maxDepth; z++) {
    if (level.length === 0) break
    const tileSize = world.size / 2 ** z
    const next: Array<[number, number]> = []

    for (const [x, y] of level) {
      const minX = world.minX + x * tileSize
      const minY = world.minY + y * tileSize
      // Touching edges do not count as intersecting: a tile whose right edge
      // is exactly the viewport's left edge contributes no pixels.
      if (
        minX + tileSize <= rect.minX ||
        minX >= rect.maxX ||
        minY + tileSize <= rect.minY ||
        minY >= rect.maxY
      ) {
        continue
      }

      if (index.has(z, x, y)) wanted.push(tileId(z, x, y))

      // Descend even through a missing tile: the tiling is additive and a
      // sparse level can sit above populated children.
      if (z < maxDepth) {
        const cx = x * 2
        const cy = y * 2
        next.push([cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1])
      }
    }

    level = next
  }

  return { wanted, zc }
}
