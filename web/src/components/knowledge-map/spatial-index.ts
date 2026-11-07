/**
 * CPU hit-testing.
 *
 * GPU colour-picking would need a readback per pointer move (a pipeline stall,
 * and on WKWebView an IPC round trip — the very cost this architecture
 * exists to avoid). Instead each tile gets a 16×16 uniform grid in tile-local
 * units, built lazily on the first query that touches the tile and dropped
 * when the tile is evicted, so a hover costs O(cells touched) rather than
 * O(nodes on screen).
 *
 * The hit test itself is in SCREEN space: a 2 px dot at overview zoom must
 * still be clickable, so the effective radius is
 * `max(nodeScreenRadius, hitRadiusPx)`.
 */

import { screenToWorld } from './camera'
import { MAX_NODE_SCREEN_RADIUS_PX, nodeScreenRadiusPx, tileZoomAlpha } from './lod'
import type {
  CameraState,
  PickedNode,
  ResidentTile,
  Viewport,
} from './types'
import type { MapMeta } from '@/lib/knowledge/graph-map/types'

/** Cells per axis in each tile's grid. */
export const GRID_DIM = 16

/** Default pointer slop in CSS px. */
export const DEFAULT_HIT_RADIUS_PX = 8

/** Widest a dot can be painted, CSS px — bounds the cell walk, nothing else. */
const MAX_SCREEN_R = MAX_NODE_SCREEN_RADIUS_PX

/**
 * A tile whose zoom fade is below this is (nearly) invisible, so picking it
 * would select something the user cannot see.
 */
const MIN_PICKABLE_ALPHA = 0.35

interface TileGrid {
  /** Node indices per cell, row-major `y * GRID_DIM + x`. */
  cells: number[][]
  cellSize: number
}

const KIND_NAMES = ['claim', 'entity', 'virtual'] as const

export interface PickOptions {
  hitRadiusPx?: number
  /** Continuous zoom; when given, faded-out tiles are skipped. */
  zc?: number
  /** Supplies `entityTypes` for the picked node's `entityType`. */
  meta?: MapMeta
}

export class SpatialIndex {
  private grids = new WeakMap<ResidentTile, TileGrid>()

  /**
   * Cells visited by the last `pick` — a test hook proving the grid actually
   * prunes (an overview pick must not touch all 256 cells of every tile).
   */
  lastVisitedCells = 0

  remove(tile: ResidentTile): void {
    this.grids.delete(tile)
  }

  clear(): void {
    // A WeakMap has no clear(); replacing it is equivalent and lets the GC
    // reclaim grids for tiles nobody holds any more.
    this.grids = new WeakMap()
  }

  private gridFor(tile: ResidentTile): TileGrid {
    const existing = this.grids.get(tile)
    if (existing) return existing

    const cellSize = tile.size / GRID_DIM
    const cells: number[][] = new Array(GRID_DIM * GRID_DIM)
    for (let i = 0; i < cells.length; i++) cells[i] = []
    for (let i = 0; i < tile.nodeCount; i++) {
      // Nodes sit at tile-local coords but hash jitter can push one a hair
      // outside its own tile — clamp instead of dropping it from the index.
      const cx = clampInt(Math.floor(tile.nodeX[i] / cellSize), 0, GRID_DIM - 1)
      const cy = clampInt(Math.floor(tile.nodeY[i] / cellSize), 0, GRID_DIM - 1)
      cells[cy * GRID_DIM + cx].push(i)
    }
    const grid: TileGrid = { cells, cellSize }
    this.grids.set(tile, grid)
    return grid
  }

  /**
   * Node under (screenX, screenY), or null.
   *
   * Among hits the highest importance wins — that is what the renderer draws
   * on top, so the pick matches what the pointer is actually over. Ties go to
   * the nearer centre.
   */
  pick(
    tiles: ResidentTile[],
    camera: CameraState,
    viewport: Viewport,
    screenX: number,
    screenY: number,
    opts: PickOptions = {},
  ): PickedNode | null {
    this.lastVisitedCells = 0
    const k = camera.k
    if (!(k > 0)) return null

    const hitRadiusPx = opts.hitRadiusPx ?? DEFAULT_HIT_RADIUS_PX
    // CALL the camera rather than re-deriving the transform here. Picking and
    // painting must agree about which way is up (world +y = screen down, set
    // by the renderer's shaders); an inline copy of the projection is exactly
    // how they drifted apart before, leaving the map pickable only at its
    // mirror image about the viewport's horizontal centre line.
    const { x: worldX, y: worldY } = screenToWorld(camera, viewport, screenX, screenY)
    // Widest possible hit in world units, used only to bound the cell walk.
    const maxHitWorld = Math.max(hitRadiusPx, MAX_SCREEN_R) / k

    let best: PickedNode | null = null
    let bestImportance = -Infinity
    let bestDistSq = Infinity

    for (const tile of tiles) {
      if (opts.zc !== undefined && tileZoomAlpha(opts.zc, tile.z) <= MIN_PICKABLE_ALPHA) continue

      // Tile-local query point + radius.
      const lx = worldX - tile.ox
      const ly = worldY - tile.oy
      if (
        lx < -maxHitWorld ||
        ly < -maxHitWorld ||
        lx > tile.size + maxHitWorld ||
        ly > tile.size + maxHitWorld
      ) {
        continue
      }

      const grid = this.gridFor(tile)
      // At overview zoom maxHitWorld can exceed a whole tile; clamping the
      // range to the grid keeps this O(cells that exist) instead of looping
      // over a huge nominal range.
      const x0 = clampInt(Math.floor((lx - maxHitWorld) / grid.cellSize), 0, GRID_DIM - 1)
      const x1 = clampInt(Math.floor((lx + maxHitWorld) / grid.cellSize), 0, GRID_DIM - 1)
      const y0 = clampInt(Math.floor((ly - maxHitWorld) / grid.cellSize), 0, GRID_DIM - 1)
      const y1 = clampInt(Math.floor((ly + maxHitWorld) / grid.cellSize), 0, GRID_DIM - 1)

      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          this.lastVisitedCells++
          const bucket = grid.cells[cy * GRID_DIM + cx]
          for (const i of bucket) {
            const dx = tile.nodeX[i] - lx
            const dy = tile.nodeY[i] - ly
            const distSq = dx * dx + dy * dy

            // Same function the shaders mirror: a hub painted as a 22 px disc
            // must be a 22 px target, and a claim floored to a 2 px dot must
            // not claim more than the pointer slop.
            const screenR = nodeScreenRadiusPx(tile.nodeR[i], k)
            const hitWorld = Math.max(screenR, hitRadiusPx) / k
            if (distSq > hitWorld * hitWorld) continue

            const importance = tile.nodeImportance[i]
            if (importance < bestImportance) continue
            if (importance === bestImportance && distSq >= bestDistSq) continue

            bestImportance = importance
            bestDistSq = distSq
            best = describe(tile, i, opts.meta)
          }
        }
      }
    }

    return best
  }
}

function describe(tile: ResidentTile, index: number, meta?: MapMeta): PickedNode {
  const etype = tile.nodeEtype[index]
  const entityType = etype >= 0 ? meta?.entityTypes[etype] : undefined
  return {
    ref: { tile, index },
    id: tile.nodeId[index],
    key: tile.keys[index],
    kind: KIND_NAMES[tile.nodeKind[index]] ?? 'claim',
    ...(entityType ? { entityType } : {}),
    label: tile.labels[index],
    wx: tile.ox + tile.nodeX[index],
    wy: tile.oy + tile.nodeY[index],
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}
