/**
 * Hand-built fixture maps for the client data-layer tests.
 *
 * Deliberately NOT built through the server core (`@/lib/knowledge/graph-map`)
 * — that package is being written in parallel, and a client test that fails
 * because someone else's layout changed is a test that teaches nothing. Every
 * tile here is written literally, so the expectations below are about the tile
 * store, not about the tiler.
 */

import {
  tileId,
  type ManifestEntry,
  type MapMeta,
  type MapTile,
  type NodeKindCode,
  type TileId,
} from '@/lib/knowledge/graph-map/types'
import type { InMemoryMap } from '../data-source'

export const WORLD = { minX: 0, minY: 0, size: 1024 }

export interface NodeSpec {
  id: number
  /** Tile-local coordinates. */
  x: number
  y: number
  r?: number
  importance?: number
  kind?: number
  key?: string
  label?: string
  etype?: number
  degree?: number
  flags?: number
}

export interface EdgeSpec {
  /** Index of the source node within this tile. */
  s: number
  /** Numeric id of the target (any tile). */
  t: number
  /** Target position, local to THIS tile's origin. */
  tx: number
  ty: number
  rel?: number
}

export function makeTile(
  z: number,
  x: number,
  y: number,
  nodes: NodeSpec[],
  edges: EdgeSpec[] = [],
): MapTile {
  const size = WORLD.size / 2 ** z
  return {
    z,
    x,
    y,
    ox: WORLD.minX + x * size,
    oy: WORLD.minY + y * size,
    size,
    dropped: 0,
    droppedEdges: 0,
    nodes: {
      id: nodes.map((n) => n.id),
      key: nodes.map((n) => n.key ?? `claim:n${n.id}`),
      kind: nodes.map((n) => (n.kind ?? 0) as NodeKindCode),
      etype: nodes.map((n) => n.etype ?? -1),
      x: nodes.map((n) => n.x),
      y: nodes.map((n) => n.y),
      r: nodes.map((n) => n.r ?? 4),
      importance: nodes.map((n) => n.importance ?? 1),
      degree: nodes.map((n) => n.degree ?? 0),
      flags: nodes.map((n) => n.flags ?? 0),
      label: nodes.map((n) => n.label ?? `node ${n.id}`),
    },
    edges: {
      s: edges.map((e) => e.s),
      t: edges.map((e) => e.t),
      tx: edges.map((e) => e.tx),
      ty: edges.map((e) => e.ty),
      rel: edges.map((e) => e.rel ?? 0),
    },
  }
}

export function makeMeta(
  version: string,
  manifest: ManifestEntry[],
  overrides: Partial<MapMeta> = {},
): MapMeta {
  const maxZ = manifest.reduce((m, [z]) => Math.max(m, z), 0)
  return {
    version,
    world: WORLD,
    maxZ,
    counts: { nodes: 0, edges: 0, claims: 0, hubs: 0, totalClaims: 0 },
    entityTypes: ['capture', 'document', 'contact'],
    relations: ['mentions', 'about'],
    manifest,
    projects: [],
    promote: { total: 0, topClaimIds: [] },
    ...overrides,
  }
}

/** Assemble an InMemoryMap from literal tiles; `inlineIds` become the inline set. */
export function buildMap(
  version: string,
  tiles: MapTile[],
  inlineIds: TileId[],
  metaOverrides: Partial<MapMeta> = {},
): InMemoryMap {
  const byId = new Map<TileId, MapTile>()
  const manifest: ManifestEntry[] = []
  for (const t of tiles) {
    byId.set(tileId(t.z, t.x, t.y), t)
    manifest.push([t.z, t.x, t.y, t.nodes.id.length, t.edges.s.length])
  }
  const inline = inlineIds
    .map((id) => byId.get(id))
    .filter((t): t is MapTile => Boolean(t))
    .sort((a, b) => a.z - b.z)

  return { meta: makeMeta(version, manifest, metaOverrides), tiles: byId, inline }
}

/**
 * A three-level map: one overview tile, its four children at z=1, and two
 * grandchildren in the top-left corner at z=2. Enough to exercise
 * parents-first ordering, manifest gaps (z=2 exists only under 1.0.0) and
 * deep-corner zoom.
 */
export function buildLayeredMap(version = 'v1'): InMemoryMap {
  const tiles: MapTile[] = [
    makeTile(0, 0, 0, [
      { id: 1, x: 100, y: 100, importance: 500 },
      { id: 2, x: 900, y: 900, importance: 400 },
    ]),
    makeTile(1, 0, 0, [{ id: 10, x: 100, y: 100, importance: 100 }]),
    makeTile(1, 1, 0, [{ id: 11, x: 100, y: 100, importance: 100 }]),
    makeTile(1, 0, 1, [{ id: 12, x: 100, y: 100, importance: 100 }]),
    makeTile(1, 1, 1, [{ id: 13, x: 100, y: 100, importance: 100 }]),
    makeTile(2, 0, 0, [{ id: 20, x: 50, y: 50, importance: 10 }]),
    makeTile(2, 1, 0, [{ id: 21, x: 50, y: 50, importance: 10 }]),
  ]
  return buildMap(version, tiles, [tileId(0, 0, 0)])
}
