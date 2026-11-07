/**
 * Knowledge Map — wire contract + shared constants.
 *
 * This file is the seam between the server (layout + tiling) and the client
 * (tile store + WebGL renderer). It is imported by both, so it must stay free
 * of server-only and browser-only imports. See
 * docs/KNOWLEDGE_MAP_ARCHITECTURE.md for the design.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Bump when layout/tiling output changes for identical input (busts caches).
 *
 * 2: the degree → radius curves moved from `√` to `log2` and virtual hubs
 * stopped being a fixed size. Positions are untouched, but `r` is part of a
 * cached layout, so without this a viewer would keep the old sizes for up to
 * the cache TTL and see the map resize under them for no reason they caused.
 */
export const ALGO_VERSION = 2

/** Node capacity of a tile; also the client's node-slab size. */
export const TILE_CAPACITY = 1000
/** Deepest quadtree level. Tiles at MAX_Z may overflow up to HARD_TILE_CAP. */
export const MAX_Z = 10
/** Absolute per-tile node ceiling (only reachable at MAX_Z). */
export const HARD_TILE_CAP = 4 * TILE_CAPACITY
/** Per-tile edge ceiling; also the client's edge-slab size. */
export const TILE_EDGE_CAPACITY = 4 * TILE_CAPACITY
/** `GET …/map` inlines whole tiles (ascending z) until this many nodes. */
export const INLINE_NODE_BUDGET = 8000
/** Max tiles per `GET …/map/tiles` request. */
export const MAX_TILES_PER_REQUEST = 32

/** Phyllotaxis slot spacing, world units. Shared by disc sizing and slots. */
export const SPACING = 14
/** Radius kept clear around a hub's own dot, world units. */
export const HUB_R0 = 18
/** Gap kept between neighbouring hub discs, world units. */
export const DISC_PAD = 24
/** ± fraction of radial hash jitter applied to claim slots. */
export const SLOT_JITTER = 0.15

// ─── Node / edge encoding ─────────────────────────────────────────────────────

export const NODE_KIND = { claim: 0, entity: 1, virtual: 2 } as const
export type NodeKindCode = (typeof NODE_KIND)[keyof typeof NODE_KIND]

export const CLAIM_TYPES = [
  'fact',
  'open_question',
  'inference',
  'decision_summary',
] as const
export type ClaimType = (typeof CLAIM_TYPES)[number]

/**
 * Per-node `flags` byte.
 *   bit 0      suggested (claims only; confirmed = 0)
 *   bits 1-2   claim type index into CLAIM_TYPES (claims only)
 */
export const FLAG_SUGGESTED = 1
export const FLAG_CLAIM_TYPE_SHIFT = 1
export const FLAG_CLAIM_TYPE_MASK = 0b110

/** `claim:<uuid>` | `<entity_type>:<uuid>` | `unfiled:<yyyy-mm>` */
export type NodeKey = string

// ─── Filters ──────────────────────────────────────────────────────────────────

/**
 * Filters are applied on the server BEFORE tiling (positions never change).
 *
 * The vocabulary itself lives in `./filter-model`, because it is shared with
 * the views system's SQL engine and is asserted against `FILTERABLE_FIELDS`.
 * Re-exported here so the wire contract still reads as one file.
 *
 * `export type` and not a value re-export: `filter-model` reads `CLAIM_TYPES`
 * out of THIS module at evaluation time, so a value re-export would close a
 * runtime import cycle. A type-only re-export is erased entirely.
 */
export type { MapFilters, MapPredicate } from './filter-model'

// ─── Tiles ────────────────────────────────────────────────────────────────────

export type TileId = string // `${z}.${x}.${y}`

/**
 * Columnar tile. All arrays in `nodes` share one length (≤ HARD_TILE_CAP) and
 * are ordered by importance ASCENDING (draw order: most important last = on
 * top). All arrays in `edges` share one length (≤ TILE_EDGE_CAPACITY).
 */
export interface MapTile {
  z: number
  x: number
  y: number
  /** World coordinates of the tile's min corner — float64, never Float32. */
  ox: number
  oy: number
  /** Tile edge length in world units. */
  size: number
  /** Nodes that belonged here but were cut by HARD_TILE_CAP. */
  dropped: number
  /** Edges that belonged here but were cut by TILE_EDGE_CAPACITY. */
  droppedEdges: number
  nodes: {
    /** Per-version numeric id (index into the key-sorted node list). */
    id: number[]
    key: NodeKey[]
    kind: NodeKindCode[]
    /** Index into MapMeta.entityTypes; -1 for claims / virtual hubs. */
    etype: number[]
    /** Tile-local position (world − tile origin). Safe to store as Float32. */
    x: number[]
    y: number[]
    /** Dot radius in world units. */
    r: number[]
    importance: number[]
    degree: number[]
    flags: number[]
    /** Short display label (≤ 80 chars); '' when none. */
    label: string[]
  }
  edges: {
    /** Index of the source node within THIS tile's `nodes` arrays. */
    s: number[]
    /** Numeric id of the target node (may live in any tile). */
    t: number[]
    /** Target position, tile-local to THIS tile's origin. */
    tx: number[]
    ty: number[]
    /** Index into MapMeta.relations. */
    rel: number[]
  }
}

/** `[z, x, y, nodeCount, edgeCount]` */
export type ManifestEntry = [number, number, number, number, number]

export interface MapCounts {
  /** Nodes / edges in this (filtered) map. */
  nodes: number
  edges: number
  claims: number
  hubs: number
  /** Claims in the unfiltered map (for "N of M" and the empty state). */
  totalClaims: number
}

export interface MapMeta {
  /** Opaque; changes whenever source rows or ALGO_VERSION change. */
  version: string
  /** Square world bounds. */
  world: { minX: number; minY: number; size: number }
  /** Deepest level that has at least one tile. */
  maxZ: number
  counts: MapCounts
  /** Lookup table for `nodes.etype`. */
  entityTypes: string[]
  /** Lookup table for `edges.rel`. */
  relations: string[]
  manifest: ManifestEntry[]
  /** Projects present in the unfiltered map, for the filter select. */
  projects: Array<{ id: string; label: string }>
  /** Promote-to-package (frozen): matching claims and the top 50 by confidence. */
  promote: { total: number; topClaimIds: string[] }
}

/** `GET /api/account/knowledge/map` */
export type MapResponse =
  | { unchanged: true; version: string }
  | (MapMeta & { unchanged?: false; tiles: MapTile[] })

/** `GET /api/account/knowledge/map/tiles` */
export interface TilesResponse {
  tiles: MapTile[]
}

// ─── Node detail (inspector) ──────────────────────────────────────────────────

export interface ClaimDetail {
  kind: 'claim'
  key: NodeKey
  claim: {
    id: string
    text: string
    type: ClaimType
    confidence: number | null
    confirmation: 'suggested' | 'confirmed' | 'dismissed'
    auto_accepted: boolean | null
    created_at: string
  }
  sources: Array<{
    source_type: string
    source_id: string | null
    source_uri: string | null
    excerpt: string | null
    label: string | null
  }>
  links: Array<{ relation: string; type: string; id: string; label: string }>
}

export interface EntityDetail {
  kind: 'entity'
  key: NodeKey
  entityType: string
  entityId: string
  label: string
  claims: Array<{
    id: string
    text: string
    type: ClaimType
    confidence: number | null
    confirmation: 'suggested' | 'confirmed' | 'dismissed'
  }>
  total: number
  nextCursor: string | null
}

export type NodeDetail = ClaimDetail | EntityDetail

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function tileId(z: number, x: number, y: number): TileId {
  return `${z}.${x}.${y}`
}

export function parseTileId(id: TileId): { z: number; x: number; y: number } | null {
  const m = /^(\d{1,2})\.(\d{1,7})\.(\d{1,7})$/.exec(id)
  if (!m) return null
  const z = Number(m[1])
  const x = Number(m[2])
  const y = Number(m[3])
  if (z > MAX_Z || x >= 2 ** z || y >= 2 ** z) return null
  return { z, x, y }
}

// ─── Source rows (input of the pure core) ─────────────────────────────────────

/** `claim.scope` — 'personal' means "about a specific member" (migration 117). */
export type ClaimScope = 'workspace' | 'personal'

/**
 * Every claim row of the workspace the viewer can read (ALL statuses).
 *
 * Every column here is one the claim filter vocabulary can be asked about
 * (`MAP_FILTER_FIELDS`), plus the three the layout itself needs (`status`,
 * `confirmation`, `created_at`). Nothing else: each field is permanent weight
 * in the in-memory map and in the per-viewer row snapshot, so a column nobody
 * can filter on is pure cost.
 *
 * The nullable ones are typed nullable even where the column is NOT NULL
 * (`scope`, `auto_accepted`): PostgREST hands back whatever the row holds, and
 * a map that assumes a value it did not get would answer a filter with a
 * fabricated one. The mask's null handling is the honest reading.
 */
export interface SourceClaimRow {
  id: string
  text: string
  type: ClaimType
  confidence: number | null
  confirmation: 'suggested' | 'confirmed' | 'dismissed'
  status: 'active' | 'superseded' | 'disputed' | 'archived'
  scope: ClaimScope | null
  auto_accepted: boolean | null
  /** `member.id` of the author, not the subject. Null for un-attributed rows. */
  created_by: string | null
  created_at: string
  /** When the evidence actually happened (migration 180). Nullable. */
  event_at: string | null
  last_verified_at: string | null
}

/** `entity_link` rows with `source_type = 'claim'`. */
export interface SourceLinkRow {
  /** Claim id. */
  source_id: string
  target_type: string
  target_id: string
  relation: string
  created_at: string
}

/** An entity the viewer can read (label resolved under their RLS). */
export interface SourceHubRow {
  type: string
  id: string
  label: string
}

export interface SourceRows {
  claims: SourceClaimRow[]
  links: SourceLinkRow[]
  /** Only hubs present here exist in the map; links to others are dropped. */
  hubs: SourceHubRow[]
}
