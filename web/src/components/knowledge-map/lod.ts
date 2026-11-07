/**
 * Level-of-detail rules shared by the tile store (what to fetch) and the
 * renderer (how opaque a tile is). Pure functions — keep them that way.
 */

import type { CameraState } from './types'

/** A tile is "at home" when it spans roughly this many CSS px on screen. */
export const TILE_SCREEN_PX = 1024

/**
 * Continuous zoom level: the (fractional) quadtree depth whose tiles span
 * TILE_SCREEN_PX on screen at the current scale. 0 at/below the overview.
 */
export function continuousZoom(camera: CameraState, worldSize: number, maxZ: number): number {
  const zc = Math.log2((worldSize * camera.k) / TILE_SCREEN_PX)
  if (!Number.isFinite(zc)) return 0
  return Math.min(Math.max(zc, 0), maxZ)
}

/** Deepest level to FETCH: one level ahead of what is fully visible, so tiles arrive before they fade in. */
export function fetchDepth(zc: number, maxZ: number): number {
  return Math.min(maxZ, Math.ceil(zc + 0.5))
}

/**
 * Opacity of a tile from zoom alone: level 0 is always opaque; level z fades
 * in as the continuous zoom goes from z-1 to z, and fades back out the same
 * way on zoom-out — so lingering deep tiles never clutter the overview.
 */
export function tileZoomAlpha(zc: number, tileZ: number): number {
  if (tileZ <= 0) return 1
  const t = zc - (tileZ - 1)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

/** Opacity ramp after a tile becomes resident (ms). */
export const TILE_FADE_MS = 220

export function tileLoadAlpha(now: number, loadedAt: number): number {
  const t = (now - loadedAt) / TILE_FADE_MS
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t
}

/**
 * On-screen dot radius clamp, CSS px — ONE definition for the three places that
 * must agree: the renderer (what is painted), the spatial index (what is
 * pickable) and the label builder (where a label hangs below its dot).
 *
 * The floor is deliberately visible: at the opening zoom of a small workspace
 * a claim's true radius is ~1 px, so without it the overview reads as a cloud
 * of labels rather than a graph.
 *
 * The ceiling is what lets a hub become a DISC rather than a dot once you are
 * close enough to read its claims. 22 is the largest a hub can get before it
 * starts swallowing the first ring of its own spiral (HUB_R0 = 18 world units
 * against a 14-unit slot spacing).
 */
export const MIN_NODE_SCREEN_RADIUS_PX = 2
export const MAX_NODE_SCREEN_RADIUS_PX = 22

/**
 * The smallest radius the server layout can emit: a degree-0 claim, from
 * `claimRadius()` in `graph-map/layout.ts` (`min(1.6 + 0.75·log2(d + 2), 8)`).
 * Hubs run `min(4 + 1.5·log2(d + 2), 17)`, so the whole map lives in
 * [2.35, 17] — a ~7× spread that IS the degree signal.
 *
 * This number is not decorative: it divides MIN_NODE_SCREEN_RADIUS_PX to give
 * the floor scale below, so the smallest node in the world lands EXACTLY on
 * the screen floor and every other node keeps its true ratio to it. Get it
 * wrong high and the smallest dot is drawn above MIN with nothing below it to
 * justify the floor; wrong low and the bottom of the range is clamped flat
 * again. Pinned by a test against a real laid-out map for that reason.
 */
export const BASE_NODE_WORLD_RADIUS = 2.35

/**
 * The zoom at which dots STOP SHRINKING, in CSS px per world unit.
 *
 * A plain `clamp(r·k, MIN, MAX)` throws the degree signal away exactly where it
 * matters most: at the opening view of a real workspace k ≈ 0.1, so every node
 * — a leaf claim at 3.6 world units and a 1,614-claim project hub at 14 —
 * lands under the floor and is painted at MIN. The overview was therefore a
 * field of identical dots, which is why it read as "text with some specks"
 * rather than as a graph.
 *
 * Flooring the SCALE instead of the radius keeps the ratios: below this k every
 * node is drawn as though the camera were here, so the hub is still ~4× the
 * leaf. Above it nothing changes at all — this is a floor, not a scale factor,
 * and zooming in still grows the dots normally until MAX.
 */
export const NODE_RADIUS_FLOOR_K = MIN_NODE_SCREEN_RADIUS_PX / BASE_NODE_WORLD_RADIUS

/**
 * World radius → on-screen radius in CSS px.
 *
 * MIRRORED IN GLSL by NODE_VS/RING_VS (`max(uK, uFloorK)`), which is what
 * actually paints. This is the CPU copy the spatial index (what is pickable)
 * and the label builder (where a label hangs) call, so all three agree by
 * construction; the renderer uploads `NODE_RADIUS_FLOOR_K` as a uniform rather
 * than calling this, because a per-node JS call per frame is the one thing this
 * renderer may not do.
 */
export function nodeScreenRadiusPx(worldRadius: number, k: number): number {
  const r = worldRadius * Math.max(k, NODE_RADIUS_FLOOR_K)
  return r < MIN_NODE_SCREEN_RADIUS_PX
    ? MIN_NODE_SCREEN_RADIUS_PX
    : r > MAX_NODE_SCREEN_RADIUS_PX
      ? MAX_NODE_SCREEN_RADIUS_PX
      : r
}
