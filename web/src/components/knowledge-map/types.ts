/**
 * Knowledge Map viewer — internal seams.
 *
 *   data-source ──▶ tile-store ──▶ renderer / labels / spatial-index
 *                        ▲
 *                     camera
 *
 * Everything here is plain data + interfaces so the data layer (tile store,
 * picking, visible-set math) is unit-testable without WebGL, and the GL layer
 * can be swapped or restored after a context loss from the CPU copies the
 * tile store keeps. See docs/KNOWLEDGE_MAP_ARCHITECTURE.md §5.
 */

import type {
  MapFilters,
  MapMeta,
  MapResponse,
  MapTile,
  NodeKey,
  TileId,
} from '@/lib/knowledge/graph-map/types'

// ─── Data source ──────────────────────────────────────────────────────────────

/** Thrown by `loadTiles` when the server reports the version is no longer current. */
export class StaleMapError extends Error {
  constructor() {
    super('knowledge map version is stale')
    this.name = 'StaleMapError'
  }
}

/**
 * Where tiles come from. Network implementation talks to
 * `/api/account/knowledge/map*`; the in-memory implementation serves a
 * pre-built map (synthetic benchmark, tests).
 */
export interface MapDataSource {
  /** `have` = version already held; the source may answer `{ unchanged: true }`. */
  loadMap(opts: { have?: string; signal?: AbortSignal }): Promise<MapResponse>
  /** Rejects with StaleMapError when `version` is no longer current. */
  loadTiles(version: string, ids: TileId[], signal?: AbortSignal): Promise<MapTile[]>
  /** Identity of the filter set baked into this source (for cache keys / effects). */
  readonly filters: MapFilters
}

// ─── Camera ───────────────────────────────────────────────────────────────────

/** World point at the viewport centre (float64) + scale in CSS px per world unit. */
export interface CameraState {
  x: number
  y: number
  k: number
}

/** Canvas size in CSS px, plus the (capped) device pixel ratio. */
export interface Viewport {
  width: number
  height: number
  dpr: number
}

export interface WorldRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ─── Resident tiles ───────────────────────────────────────────────────────────

/**
 * A tile held by the tile store. CPU typed arrays are the source of truth; the
 * renderer uploads them into the GPU slab `slab` and can re-upload them at any
 * time (context restore). `slab` and array contents never change while the
 * tile is resident, so `(slab, index)` is a stable node address.
 */
export interface ResidentTile {
  id: TileId
  z: number
  x: number
  y: number
  /** float64 world origin + size. */
  ox: number
  oy: number
  size: number
  /** Slab index in [0, maxResidentTiles). */
  slab: number
  nodeCount: number
  edgeCount: number

  nodeId: Uint32Array
  nodeX: Float32Array
  nodeY: Float32Array
  nodeR: Float32Array
  nodeImportance: Float32Array
  nodeDegree: Uint32Array
  nodeKind: Uint8Array
  nodeFlags: Uint8Array
  nodeEtype: Int16Array
  keys: NodeKey[]
  labels: string[]

  edgeSource: Uint16Array
  edgeTarget: Uint32Array
  edgeTX: Float32Array
  edgeTY: Float32Array
  edgeRel: Uint8Array

  /** `performance.now()` when the tile became resident — drives the fade-in. */
  loadedAt: number
  /** Frame counter of the last frame this tile intersected the viewport. */
  lastVisibleFrame: number
}

/** Stable address of a node while its tile is resident. */
export interface NodeRef {
  tile: ResidentTile
  index: number
}

export interface PickedNode {
  ref: NodeRef
  id: number
  key: NodeKey
  kind: 'claim' | 'entity' | 'virtual'
  entityType?: string
  label: string
  /** World position (float64). */
  wx: number
  wy: number
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

/** Premultiplied RGBA, 0..1. Index = palette slot used by the shaders. */
export interface Palette {
  claim: [number, number, number, number]
  claimSuggested: [number, number, number, number]
  entity: [number, number, number, number]
  virtual: [number, number, number, number]
  edge: [number, number, number, number]
  /**
   * The single highlight colour: the hovered/selected node, its neighbours,
   * their labels, and the focus ring — and the edges between them for a
   * selection. A HOVER's edges keep the resting `edge` colour: everything else
   * dims, so they already stand out, and in the accent they were too loud. One
   * slot, because the highlight has to read as ONE thing lighting up rather
   * than as several parts of the map getting darker.
   */
  accent: [number, number, number, number]
  label: [number, number, number, number]
  /** Multiplier applied to everything NOT highlighted while a highlight is set. */
  dim: number
  isDark: boolean
}

/** Nodes + edges to draw emphasised (hover neighbourhood / selection). */
export interface Highlight {
  /** Focus node (ring) — hovered and/or selected. */
  focus: Array<{ wx: number; wy: number; r: number }>
  /** Neighbour nodes drawn in the accent. */
  nodes: Array<{ wx: number; wy: number; r: number; kind: number; flags: number }>
  /** Edges drawn in the accent, world coordinates (float64). */
  edges: Array<{ x1: number; y1: number; x2: number; y2: number }>
  /** When true everything else is dimmed (hover); false for selection-only. */
  dimOthers: boolean
}

export interface LabelSprite {
  /** World anchor (float64) — the node centre. */
  wx: number
  wy: number
  /** Vertical offset below the anchor in CSS px (node radius on screen + gap). */
  offsetPx: number
  text: string
  /** 0 = regular (claims), 1 = strong (entities). */
  weight: 0 | 1
  emphasised: boolean
}

export interface MapRenderer {
  /** Upload (or re-upload) a tile's CPU arrays into its slab. */
  uploadTile(tile: ResidentTile): void
  /** Mark a slab empty. */
  removeTile(tile: ResidentTile): void
  clear(): void
  setPalette(palette: Palette): void
  setHighlight(highlight: Highlight | null): void
  setLabels(labels: LabelSprite[]): void
  /** Draw one frame. `tiles` = resident tiles intersecting the viewport. */
  render(camera: CameraState, viewport: Viewport, tiles: ResidentTile[], now: number): void
  /** True while fade-ins / label rasterisation still need more frames. */
  needsAnotherFrame(): boolean
  resize(viewport: Viewport): void
  isContextLost(): boolean
  /** Rebuild all GL state and re-upload `tiles` after a context restore. */
  restore(tiles: ResidentTile[]): void
  dispose(): void
}

// ─── React shell ──────────────────────────────────────────────────────────────

export type MapStatus = 'loading' | 'ready' | 'empty' | 'error' | 'unsupported'

export interface SelectedMapNode {
  key: NodeKey
  kind: 'claim' | 'entity' | 'virtual'
  entityType?: string
  label: string
}

export interface KnowledgeMapProps {
  /** New identity ⇒ reload data (filters changed) while keeping the camera. */
  dataSource: MapDataSource
  selectedKey?: NodeKey | null
  onSelect?: (node: SelectedMapNode | null) => void
  /** Fired whenever a (new) map meta is loaded — counts, projects, promote. */
  onMeta?: (meta: MapMeta) => void
  onStatus?: (status: MapStatus) => void
  /** Bump to revalidate against the source (realtime change / tab re-shown). */
  refreshToken?: number
  /** False ⇒ pause rendering + network (tab hidden). Defaults to true. */
  active?: boolean
  /** Dev/benchmark overlay: fps, resident tiles, nodes, draw calls. */
  showStats?: boolean
}

export interface KnowledgeMapHandle {
  flyTo(wx: number, wy: number, k?: number): void
  fitAll(): void
}
