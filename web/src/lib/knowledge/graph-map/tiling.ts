/**
 * Tiling — filters, then the additive importance-ordered quadtree.
 *
 * Nodes are sorted by importance desc and each goes to the SHALLOWEST tile on
 * its root-to-leaf path that still has capacity. So 0/0/0 holds the 1000 most
 * important nodes of the whole map and deeper tiles only ever add nodes — the
 * property the client relies on to zoom without anything moving or vanishing.
 * See docs/KNOWLEDGE_MAP_ARCHITECTURE.md §4.3.
 */

import { filtersKey } from './filters'
import { shortLabel } from './graph-build'
import type { LaidOutMap } from './layout'
import { maskClaims } from './mask'
import {
  HARD_TILE_CAP,
  INLINE_NODE_BUDGET,
  MAX_Z,
  NODE_KIND,
  TILE_CAPACITY,
  TILE_EDGE_CAPACITY,
  tileId,
  type ManifestEntry,
  type MapFilters,
  type MapMeta,
  type MapTile,
  type NodeKindCode,
  type TileId,
} from './types'

export interface BuiltMap {
  meta: MapMeta
  tiles: Map<TileId, MapTile>
  /** Whole tiles in ascending z (then x, y) while cumulative nodes ≤ budget. */
  inline: MapTile[]
}

export interface TileMapOptions {
  filters: MapFilters
  version: string
  /**
   * The request clock.
   *
   * Read by callers for cache identity, NOT by the filter mask. The only
   * clock-dependent predicate is `is_relative`, and `service.ts` resolves that
   * upstream through the views engine's own `resolveRelativeDate` so the list
   * and the canvas cannot answer one saved view with two different windows. A
   * second clock down here could disagree with that one, so the mask
   * deliberately has no access to it.
   */
  nowMs: number
}

/** Quadtree path of a point: tile (x, y) at each level, packed per level. */
/**
 * A claim's wire label, computed once per claim per LAYOUT.
 *
 * The cache hangs off the laid-out map rather than off a build, because the
 * layout is what the tilings share: every distinct filter set re-tiles, and all
 * of them want the same short label for a claim that survives. A WeakMap so it
 * dies with the map when the service's LRU evicts it.
 */
const shortLabelCache = new WeakMap<LaidOutMap, Array<string | undefined>>()

function shortClaimLabel(map: LaidOutMap, claim: number): string {
  let cache = shortLabelCache.get(map)
  if (!cache) {
    cache = new Array(map.claimCount)
    shortLabelCache.set(map, cache)
  }
  const hit = cache[claim]
  if (hit !== undefined) return hit
  const value = shortLabel(map.labels[claim])
  cache[claim] = value
  return value
}

function pathIndex(
  wx: number,
  wy: number,
  world: { minX: number; minY: number; size: number },
  z: number,
): { x: number; y: number } {
  const n = 2 ** z
  const fx = ((wx - world.minX) / world.size) * n
  const fy = ((wy - world.minY) / world.size) * n
  const x = Math.min(n - 1, Math.max(0, Math.floor(fx)))
  const y = Math.min(n - 1, Math.max(0, Math.floor(fy)))
  return { x, y }
}

interface Bucket {
  z: number
  x: number
  y: number
  nodes: number[]
  dropped: number
}

/** Apply filters and build the tile pyramid. */
export function tileMap(map: LaidOutMap, opts: TileMapOptions): BuiltMap {
  const { filters, version } = opts
  const keepClaim = maskClaims(map, filters)

  // ── Kept hubs = hubs with ≥1 kept claim whose primary hub OR any link
  // targets them (§4.3). ──
  const keepNode = new Uint8Array(map.count)
  let keptClaims = 0
  for (let c = 0; c < map.claimCount; c++) {
    if (!keepClaim[c]) continue
    keptClaims++
    keepNode[c] = 1
    keepNode[map.claimHub[c]] = 1
    const end = map.claimHubOffsets[c + 1]
    for (let i = map.claimHubOffsets[c]; i < end; i++) keepNode[map.claimHubTargets[i]] = 1
  }

  // ── Numeric ids: index of the key in the ascending-sorted list of ALL kept
  // node keys. Stable for the whole (version, filters) pair. ──
  const keptNodes: number[] = []
  for (let n = 0; n < map.count; n++) if (keepNode[n]) keptNodes.push(n)
  const byKey = keptNodes.slice().sort((a, b) => (map.keys[a] < map.keys[b] ? -1 : map.keys[a] > map.keys[b] ? 1 : 0))
  const numericId = new Int32Array(map.count).fill(-1)
  for (let i = 0; i < byKey.length; i++) numericId[byKey[i]] = i

  let keptHubs = 0
  for (const n of keptNodes) if (n >= map.claimCount) keptHubs++

  // ── Nodes by importance desc (tie: key asc). ──
  const ordered = keptNodes.slice().sort((a, b) => {
    const d = map.importance[b] - map.importance[a]
    if (d !== 0) return d
    return map.keys[a] < map.keys[b] ? -1 : map.keys[a] > map.keys[b] ? 1 : 0
  })

  const world = map.world
  const buckets = new Map<TileId, Bucket>()

  const getBucket = (z: number, x: number, y: number): Bucket => {
    const id = tileId(z, x, y)
    let b = buckets.get(id)
    if (!b) {
      b = { z, x, y, nodes: [], dropped: 0 }
      buckets.set(id, b)
    }
    return b
  }

  for (const n of ordered) {
    const wx = map.x[n]
    const wy = map.y[n]
    let placedAt: Bucket | null = null
    for (let z = 0; z <= MAX_Z; z++) {
      const p = pathIndex(wx, wy, world, z)
      const b = getBucket(z, p.x, p.y)
      const cap = z === MAX_Z ? HARD_TILE_CAP : TILE_CAPACITY
      if (b.nodes.length < cap) {
        b.nodes.push(n)
        placedAt = b
        break
      }
    }
    if (!placedAt) {
      // Every tile on the path is full, including MAX_Z at HARD_TILE_CAP.
      const p = pathIndex(wx, wy, world, MAX_Z)
      getBucket(MAX_Z, p.x, p.y).dropped++
    }
  }

  // ── Edges ship with the SOURCE claim's tile. ──
  const tileOfNode = new Map<number, Bucket>()
  for (const b of buckets.values()) for (const n of b.nodes) tileOfNode.set(n, b)

  const edgesByTile = new Map<TileId, Array<{ s: number; t: number; rel: number; target: number; srcImp: number }>>()
  const droppedEdges = new Map<TileId, number>()
  const slotInTile = new Map<number, number>()

  // Node slots are assigned after the per-tile importance-ASCENDING sort below,
  // so collect edges first and resolve `s` afterwards.
  const pendingEdges: Array<{ tile: Bucket; source: number; target: number; rel: number }> = []
  for (let e = 0; e < map.edgeSource.length; e++) {
    const s = map.edgeSource[e]
    const t = map.edgeTarget[e]
    if (!keepNode[s] || !keepNode[t]) continue
    const tile = tileOfNode.get(s)
    if (!tile) continue // source was dropped at MAX_Z
    if (!tileOfNode.has(t)) continue // target dropped → no valid numeric target
    pendingEdges.push({ tile, source: s, target: t, rel: map.edgeRel[e] })
  }

  // ── Materialise tiles. Columns ordered by importance ASCENDING (draw order:
  // most important last = on top). ──
  const tiles = new Map<TileId, MapTile>()
  const bucketList = Array.from(buckets.values()).filter((b) => b.nodes.length > 0 || b.dropped > 0)
  bucketList.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y)

  let maxZ = 0
  for (const b of bucketList) {
    if (b.nodes.length > 0 && b.z > maxZ) maxZ = b.z
    b.nodes.sort((p, q) => {
      const d = map.importance[p] - map.importance[q]
      if (d !== 0) return d
      return map.keys[p] < map.keys[q] ? -1 : map.keys[p] > map.keys[q] ? 1 : 0
    })
    b.nodes.forEach((n, i) => slotInTile.set(n, i))
  }

  for (const pe of pendingEdges) {
    const id = tileId(pe.tile.z, pe.tile.x, pe.tile.y)
    let list = edgesByTile.get(id)
    if (!list) {
      list = []
      edgesByTile.set(id, list)
    }
    list.push({
      s: slotInTile.get(pe.source) as number,
      t: numericId[pe.target],
      rel: pe.rel,
      target: pe.target,
      srcImp: map.importance[pe.source],
    })
  }

  let totalEdges = 0
  for (const b of bucketList) {
    const size = world.size / 2 ** b.z
    const ox = world.minX + b.x * size
    const oy = world.minY + b.y * size
    const id = tileId(b.z, b.x, b.y)

    const n = b.nodes.length
    const nodes: MapTile['nodes'] = {
      id: new Array(n),
      key: new Array(n),
      kind: new Array(n),
      etype: new Array(n),
      x: new Array(n),
      y: new Array(n),
      r: new Array(n),
      importance: new Array(n),
      degree: new Array(n),
      flags: new Array(n),
      label: new Array(n),
    }
    for (let i = 0; i < n; i++) {
      const node = b.nodes[i]
      nodes.id[i] = numericId[node]
      nodes.key[i] = map.keys[node]
      nodes.kind[i] = map.kind[node] as NodeKindCode
      nodes.etype[i] = map.etype[node]
      // Round-trip through Float32 so tests see exactly what the GPU sees.
      nodes.x[i] = Math.fround(map.x[node] - ox)
      nodes.y[i] = Math.fround(map.y[node] - oy)
      nodes.r[i] = Math.fround(map.r[node])
      nodes.importance[i] = Math.fround(map.importance[node])
      nodes.degree[i] = map.degree[node]
      nodes.flags[i] = map.flags[node]
      // The wire label is capped here, not in the layout: `map.labels` holds a
      // claim's FULL text so the `text` mask can see all of it, and only the
      // renderer needs it short. Hub labels were already shortened in
      // `graph-build` (they are names, not sentences), so they skip the
      // whitespace-collapse regex that would otherwise run per hub per tiling.
      nodes.label[i] = node < map.claimCount ? shortLabel(map.labels[node]) : map.labels[node]
    }

    // Keep the edges of the most important sources when a tile overflows.
    const rawEdges = edgesByTile.get(id) ?? []
    let dropped = 0
    if (rawEdges.length > TILE_EDGE_CAPACITY) {
      rawEdges.sort((p, q) => q.srcImp - p.srcImp || p.s - q.s || p.t - q.t)
      dropped = rawEdges.length - TILE_EDGE_CAPACITY
      rawEdges.length = TILE_EDGE_CAPACITY
    }
    // Restore a deterministic wire order after any capacity cut.
    rawEdges.sort((p, q) => p.s - q.s || p.t - q.t || p.rel - q.rel)

    const m = rawEdges.length
    const edges: MapTile['edges'] = {
      s: new Array(m),
      t: new Array(m),
      tx: new Array(m),
      ty: new Array(m),
      rel: new Array(m),
    }
    for (let i = 0; i < m; i++) {
      const e = rawEdges[i]
      edges.s[i] = e.s
      edges.t[i] = e.t
      edges.tx[i] = Math.fround(map.x[e.target] - ox)
      edges.ty[i] = Math.fround(map.y[e.target] - oy)
      edges.rel[i] = e.rel
    }
    totalEdges += m
    droppedEdges.set(id, dropped)

    tiles.set(id, {
      z: b.z,
      x: b.x,
      y: b.y,
      ox,
      oy,
      size,
      dropped: b.dropped,
      droppedEdges: dropped,
      nodes,
      edges,
    })
  }

  // ── Manifest sorted by (z, x, y). ──
  const manifest: ManifestEntry[] = []
  for (const b of bucketList) {
    const t = tiles.get(tileId(b.z, b.x, b.y)) as MapTile
    manifest.push([b.z, b.x, b.y, t.nodes.id.length, t.edges.s.length])
  }

  // ── Inline: whole tiles, ascending z (then x, y), while the cumulative node
  // count stays within budget. 0.0.0 is always first when it exists. ──
  const inline: MapTile[] = []
  let inlineNodes = 0
  for (const b of bucketList) {
    const t = tiles.get(tileId(b.z, b.x, b.y)) as MapTile
    const n = t.nodes.id.length
    if (inline.length > 0 && inlineNodes + n > INLINE_NODE_BUDGET) break
    inline.push(t)
    inlineNodes += n
  }

  // ── promote: kept claims, top 50 by confidence desc (null last, tie id asc).
  const keptClaimIdx: number[] = []
  for (let c = 0; c < map.claimCount; c++) if (keepClaim[c]) keptClaimIdx.push(c)
  const promoteOrder = keptClaimIdx.slice().sort((a, b) => {
    const ca = map.claimConfidence[a]
    const cb = map.claimConfidence[b]
    const na = ca < 0
    const nb = cb < 0
    if (na !== nb) return na ? 1 : -1
    if (!na && ca !== cb) return cb - ca
    const ia = map.claimIds[a]
    const ib = map.claimIds[b]
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  const topClaimIds = promoteOrder.slice(0, 50).map((c) => map.claimIds[c])

  const meta: MapMeta = {
    version,
    world: { minX: world.minX, minY: world.minY, size: world.size },
    maxZ,
    counts: {
      nodes: keptNodes.length,
      edges: totalEdges,
      claims: keptClaims,
      hubs: keptHubs,
      // Unfiltered, so the UI can say "N of M" and tell an empty filter result
      // apart from an empty workspace.
      totalClaims: map.claimCount,
    },
    entityTypes: map.entityTypes,
    relations: map.relations,
    manifest,
    projects: map.projects,
    promote: { total: keptClaims, topClaimIds },
  }

  return { meta, tiles, inline }
}

/** Cache key for a (version, filters) tiling. */
export function tilingCacheKey(version: string, filters: MapFilters): string {
  return `${version}\u0000${filtersKey(filters)}`
}

/** Re-export for consumers that only import tiling. */
export { NODE_KIND }
