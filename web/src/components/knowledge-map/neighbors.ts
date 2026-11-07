/**
 * Hover neighbourhood resolution — O(degree), never O(N).
 *
 * Edges ship with their SOURCE claim's tile (§4.3), so a claim's outgoing
 * edges are always in its own tile and cost one scan of that tile's edge
 * arrays. A hub's incoming edges are the opposite: they live in the tiles of
 * every claim citing it, scattered across the resident set. Scanning every
 * resident tile on each hover would be O(resident edges) — at 96 tiles × 4000
 * edges that is 384k iterations per pointer move.
 *
 * `NeighborIndex` pays that cost once per tile load instead: it keeps
 * `targetId → [(tile, edgeIndex)…]` over the resident tiles, built
 * incrementally on load and dropped on eviction.
 */

import type { Highlight, NodeRef, ResidentTile } from './types'
// Type-only: the value import would be a cycle (tile-store imports this file
// for NeighborIndex). `import type` is erased, so no cycle exists at runtime.
import type { TileStore } from './tile-store'

/** Default cap on edges drawn in a highlight — a 5k-degree hub must not stall. */
export const DEFAULT_MAX_HIGHLIGHT_EDGES = 400

interface EdgeRef {
  tile: ResidentTile
  edge: number
}

export class NeighborIndex {
  private readonly incoming = new Map<number, EdgeRef[]>()

  addTile(tile: ResidentTile): void {
    for (let e = 0; e < tile.edgeCount; e++) {
      const target = tile.edgeTarget[e]
      const list = this.incoming.get(target)
      if (list) list.push({ tile, edge: e })
      else this.incoming.set(target, [{ tile, edge: e }])
    }
  }

  removeTile(tile: ResidentTile): void {
    // Walk the tile's own edges rather than the whole map: each edge names the
    // one bucket it could be in, so removal is O(tile edges), not O(index).
    for (let e = 0; e < tile.edgeCount; e++) {
      const target = tile.edgeTarget[e]
      const list = this.incoming.get(target)
      if (!list) continue
      const kept = list.filter((ref) => ref.tile !== tile)
      if (kept.length === 0) this.incoming.delete(target)
      else this.incoming.set(target, kept)
    }
  }

  clear(): void {
    this.incoming.clear()
  }

  /** Edges from resident tiles whose target is `id`. */
  incomingEdges(id: number): readonly EdgeRef[] {
    return this.incoming.get(id) ?? []
  }
}

export interface ResolveHighlightOptions {
  dimOthers: boolean
  maxEdges?: number
  /** Reverse index; omitted ⇒ derived by scanning the resident tiles. */
  neighborIndex?: NeighborIndex
}

/** World position of node `index` in `tile` — float64, never Float32. */
function nodeWorld(tile: ResidentTile, index: number): { wx: number; wy: number; r: number } {
  return {
    wx: tile.ox + tile.nodeX[index],
    wy: tile.oy + tile.nodeY[index],
    r: tile.nodeR[index],
  }
}

/**
 * The nodes and edges to draw emphasised around `focus`.
 *
 * Outgoing edges come from the focus tile's own edge arrays; incoming ones
 * from the reverse index (or, without it, a scan of the resident tiles — the
 * fallback exists so this stays usable in tests and after a tile-store swap).
 * Edge endpoints are resolved through the tile-local target offsets the wire
 * carries, so a neighbour whose own tile is not resident still gets drawn.
 */
export function resolveHighlight(
  store: Pick<TileStore, 'findById' | 'residentTiles'>,
  focus: NodeRef,
  opts: ResolveHighlightOptions,
): Highlight {
  const maxEdges = opts.maxEdges ?? DEFAULT_MAX_HIGHLIGHT_EDGES
  const { tile, index } = focus
  const focusId = tile.nodeId[index]
  const focusPos = nodeWorld(tile, index)

  const edges: Highlight['edges'] = []
  const nodes: Highlight['nodes'] = []
  const seen = new Set<number>([focusId])

  /** Record a neighbour at world (nx, ny); prefer its resident node for style. */
  const addNeighbour = (neighbourId: number, nx: number, ny: number, fallbackR: number) => {
    if (seen.has(neighbourId)) return
    seen.add(neighbourId)
    const ref = store.findById(neighbourId)
    if (ref) {
      const pos = nodeWorld(ref.tile, ref.index)
      nodes.push({
        wx: pos.wx,
        wy: pos.wy,
        r: pos.r,
        kind: ref.tile.nodeKind[ref.index],
        flags: ref.tile.nodeFlags[ref.index],
      })
      return
    }
    // Not resident: the edge still carries its position, so draw a plain dot
    // rather than a dangling line.
    nodes.push({ wx: nx, wy: ny, r: fallbackR, kind: 0, flags: 0 })
  }

  // ── Outgoing: always in the focus node's own tile ──
  for (let e = 0; e < tile.edgeCount && edges.length < maxEdges; e++) {
    if (tile.edgeSource[e] !== index) continue
    const tx = tile.ox + tile.edgeTX[e]
    const ty = tile.oy + tile.edgeTY[e]
    edges.push({ x1: focusPos.wx, y1: focusPos.wy, x2: tx, y2: ty })
    addNeighbour(tile.edgeTarget[e], tx, ty, focusPos.r)
  }

  // ── Incoming: edges anywhere in the resident set that target the focus ──
  if (edges.length < maxEdges) {
    const refs = opts.neighborIndex
      ? opts.neighborIndex.incomingEdges(focusId)
      : scanIncoming(store.residentTiles(), focusId)

    for (const { tile: src, edge } of refs) {
      if (edges.length >= maxEdges) break
      const sourceIndex = src.edgeSource[edge]
      if (sourceIndex >= src.nodeCount) continue
      // A self-edge is already in `edges` from the outgoing pass; drawing it
      // again would double the accent on a zero-length line.
      if (src === tile && sourceIndex === index) continue
      const pos = nodeWorld(src, sourceIndex)
      edges.push({ x1: pos.wx, y1: pos.wy, x2: focusPos.wx, y2: focusPos.wy })
      addNeighbour(src.nodeId[sourceIndex], pos.wx, pos.wy, pos.r)
    }
  }

  return {
    focus: [{ wx: focusPos.wx, wy: focusPos.wy, r: focusPos.r }],
    nodes,
    edges,
    dimOthers: opts.dimOthers,
  }
}

function scanIncoming(tiles: ResidentTile[], targetId: number): EdgeRef[] {
  const out: EdgeRef[] = []
  for (const tile of tiles) {
    for (let e = 0; e < tile.edgeCount; e++) {
      if (tile.edgeTarget[e] === targetId) out.push({ tile, edge: e })
    }
  }
  return out
}
