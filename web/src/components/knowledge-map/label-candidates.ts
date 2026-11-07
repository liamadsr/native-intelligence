/**
 * Which nodes are even ALLOWED to carry a label this frame.
 *
 * `selectLabels` (labels.ts) does the screen-space collision packing; it needs
 * a list that is already importance-DESC, already inside the viewport, and
 * already small. Building that list is where the whole cost of labelling
 * lives: the resident set can be 96 tiles × 4000 nodes = 384k nodes, and
 * walking all of them would be the per-node JS work this architecture exists
 * to delete (§2 principle 4).
 *
 * Three cuts keep it bounded, in this order:
 *   1. Tiles whose zoom fade is below LABEL_MIN_TILE_ALPHA are skipped whole —
 *      a tile the user cannot see cannot contribute a label.
 *   2. Within a tile we walk BACKWARDS. The wire contract orders a tile's node
 *      arrays importance-ASCENDING (types.ts, MapTile.nodes), so walking from
 *      the end visits the most important nodes first; combined with tiles in
 *      ascending z (parents = the overview's top nodes first) the overall walk
 *      is approximately importance-DESC without sorting 384k entries.
 *   3. The walk stops after EXAMINE_BUDGET nodes have been *looked at*, not
 *      after that many were kept. That is the hard ceiling: label work is
 *      O(budget) no matter how deep the map is.
 *
 * Claims only become candidates once neighbouring claims are far enough apart
 * to read (CLAIM_LABEL_MIN_K); entities and virtual hubs are candidates at any
 * zoom, because they are the map's signposts. Forced nodes (hover / selection
 * neighbourhood) bypass every rule — the user is pointing at them.
 */

import { screenToWorld } from './camera'
import { nodeScreenRadiusPx, tileZoomAlpha } from './lod'
import type { LabelCandidate } from './labels'
import type { CameraState, ResidentTile, Viewport } from './types'

/** A tile fainter than this contributes no labels — it is barely on screen. */
export const LABEL_MIN_TILE_ALPHA = 0.5

/**
 * CSS px per world unit at which claim labels switch on. With SPACING = 14
 * world units between neighbouring phyllotaxis slots, k = 1.1 puts them
 * ~15 CSS px apart — the point where two adjacent claim labels stop being a
 * single grey smear. Below it only entities and hubs are labelled.
 */
export const CLAIM_LABEL_MIN_K = 1.1

/** Hard ceiling on nodes INSPECTED per rebuild (not on labels produced). */
export const EXAMINE_BUDGET = 2500

/** Candidates kept before collision packing; selectLabels caps output again. */
export const MAX_CANDIDATES = 400

/** Node kind codes, mirroring NODE_KIND in the wire contract. */
const KIND_CLAIM = 0

/** A node this far outside the viewport can still place a legible label. */
const VIEWPORT_MARGIN_PX = 64

export interface BuildLabelCandidatesOpts {
  /** Continuous zoom (lod.continuousZoom) — drives the per-tile fade cut. */
  zc: number
  /** Node ids that must be labelled: hover/selection focus + neighbours. */
  forcedIds?: ReadonlySet<number>
  /** The hovered / selected node itself — its label is pinned (never rejected). */
  focusId?: number | null
  examineBudget?: number
  maxCandidates?: number
}

/**
 * Build the label candidate list for one frame's drawn tiles.
 *
 * `tiles` is expected ascending-z (what `TileStore.update` returns). The
 * result is importance-DESC with forced nodes first, which is exactly what
 * `selectLabels` wants.
 */
export function buildLabelCandidates(
  tiles: readonly ResidentTile[],
  camera: CameraState,
  viewport: Viewport,
  opts: BuildLabelCandidatesOpts,
): LabelCandidate[] {
  const budget = opts.examineBudget ?? EXAMINE_BUDGET
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES
  const forced = opts.forcedIds
  const k = camera.k
  if (!(k > 0) || budget <= 0 || maxCandidates <= 0) return []

  const claimsReadable = k >= CLAIM_LABEL_MIN_K

  // Viewport in world units, padded so a label anchored just off-screen (whose
  // text still reaches into view) is not dropped. Derived by projecting the
  // padded screen corners through camera.ts rather than by assuming a sign:
  // world +y is screen down (the renderer decides — see camera.ts), so the
  // top-left screen corner is the MINIMUM world corner on both axes.
  const topLeft = screenToWorld(camera, viewport, -VIEWPORT_MARGIN_PX, -VIEWPORT_MARGIN_PX)
  const bottomRight = screenToWorld(
    camera,
    viewport,
    viewport.width + VIEWPORT_MARGIN_PX,
    viewport.height + VIEWPORT_MARGIN_PX,
  )
  const minX = Math.min(topLeft.x, bottomRight.x)
  const maxX = Math.max(topLeft.x, bottomRight.x)
  const minY = Math.min(topLeft.y, bottomRight.y)
  const maxY = Math.max(topLeft.y, bottomRight.y)

  const out: LabelCandidate[] = []
  const forcedOut: LabelCandidate[] = []
  let examined = 0

  for (const tile of tiles) {
    if (examined >= budget) break
    // A forced node inside a faded tile must still be labelled, so the tile is
    // only skipped wholesale when it can contribute nothing at all.
    const alpha = tileZoomAlpha(opts.zc, tile.z)
    const faded = alpha <= LABEL_MIN_TILE_ALPHA
    if (faded && !forced?.size) continue

    // Importance-ASCENDING arrays ⇒ walk backwards for most-important-first.
    for (let i = tile.nodeCount - 1; i >= 0; i--) {
      if (examined >= budget) break
      examined++

      const text = tile.labels[i]
      if (!text) continue

      const id = tile.nodeId[i]
      const isForced = forced?.has(id) ?? false
      if (faded && !isForced) continue

      const kind = tile.nodeKind[i]
      if (!isForced && kind === KIND_CLAIM && !claimsReadable) continue

      const wx = tile.ox + tile.nodeX[i]
      const wy = tile.oy + tile.nodeY[i]
      if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue

      const candidate: LabelCandidate = {
        id,
        wx,
        wy,
        // The renderer's own radius rule (lod.ts), so a label hangs off the
        // dot that is actually painted — a hub's label clears its whole disc.
        screenRadiusPx: nodeScreenRadiusPx(tile.nodeR[i], k),
        text,
        weight: kind === KIND_CLAIM ? 0 : 1,
        importance: tile.nodeImportance[i],
        ...(isForced ? { forced: true } : {}),
        ...(isForced && opts.focusId === id ? { pinned: true } : {}),
      }
      if (isForced) forcedOut.push(candidate)
      else if (out.length < maxCandidates) out.push(candidate)
    }
  }

  // The backwards walk is importance-descending WITHIN a tile but not across
  // tiles (a deep tile's best node can outrank a shallow tile's worst). The
  // kept set is at most `maxCandidates`, so one sort here is cheap — and
  // selectLabels' greedy packing is only "most important wins" if it is sorted.
  out.sort((a, b) => b.importance - a.importance)
  // Forced first: selectLabels places them in its own first pass anyway, but
  // keeping them at the head means a `max` cut can never drop one.
  return forcedOut.length > 0 ? [...forcedOut, ...out] : out
}
