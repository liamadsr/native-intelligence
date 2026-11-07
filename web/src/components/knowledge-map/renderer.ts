/**
 * Knowledge Map WebGL2 renderer.
 *
 * Contract: O(resident tiles) draw calls per frame and ZERO per-node JS work.
 * Node data lives in two fixed GPU "slabs" that are allocated once and never
 * move; a tile owns one slab range for its whole residency, so uploading a
 * tile is a `bufferSubData` at a known offset and evicting one is a CPU-side
 * count reset. Nothing is ever compacted — compaction would be a per-frame
 * copy of megabytes.
 *
 * Slab arithmetic at the default 96 resident tiles:
 *   nodes: 96 × HARD_TILE_CAP(4000) × NODE_STRIDE(20 B) ≈ 7.3 MB
 *   edges: 96 × TILE_EDGE_CAPACITY(4000) × EDGE_STRIDE(16 B) ≈ 5.9 MB
 * ≈ 13 MB of VRAM, fixed, whatever the workspace size.
 *
 * Precision: per-tile `uTileOffset = (tile.ox − camera.x, tile.oy − camera.y)`
 * is computed in float64 on the CPU and only then narrowed. World coordinates
 * never enter a Float32 (architecture §4.3).
 */

import { HARD_TILE_CAP, TILE_EDGE_CAPACITY } from '@/lib/knowledge/graph-map/types'
import { LabelAtlas } from './labels'
import {
  continuousZoom,
  MAX_NODE_SCREEN_RADIUS_PX,
  MIN_NODE_SCREEN_RADIUS_PX,
  NODE_RADIUS_FLOOR_K,
  tileLoadAlpha,
  tileZoomAlpha,
} from './lod'
import {
  ATTR,
  EDGE_FS,
  EDGE_VS,
  LABEL_FS,
  LABEL_VS,
  NODE_FS,
  NODE_VS,
  PALETTE_SLOTS,
  QUAD_STRIP,
  RING_FS,
  RING_VS,
} from './shaders'
import type {
  CameraState,
  Highlight,
  LabelSprite,
  MapRenderer,
  Palette,
  ResidentTile,
  Viewport,
} from './types'

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Node instance layout: x, y, r (f32) + kind, flags (f32) = 5 × 4 B. */
const NODE_FLOATS = 5
const NODE_STRIDE = NODE_FLOATS * 4
/** Edge instance layout: sx, sy, tx, ty (f32) = 4 × 4 B. */
const EDGE_FLOATS = 4
const EDGE_STRIDE = EDGE_FLOATS * 4

/** On-screen dot radius clamp, CSS px — dots neither vanish nor balloon. */
const MIN_NODE_RADIUS_PX = MIN_NODE_SCREEN_RADIUS_PX
const MAX_NODE_RADIUS_PX = MAX_NODE_SCREEN_RADIUS_PX
/** Edge width in CSS px (the shader also floors it at one device px). */
const EDGE_WIDTH_CSS_PX = 1
/**
 * A SELECTION's edges (a node picked, nothing hovered): wider than the
 * hairline base pass, in the accent, slightly under full strength. Nothing is
 * dimmed then, so the edges themselves have to stand out.
 *
 * A HOVER's edges don't use these. Everything else is already dimmed to a
 * sixth (palette DIM), so the hovered node's connections keep the width and
 * colour every edge rests at, and read as highlighted by contrast alone. Drawn
 * in the bright accent they were too loud: hovering the biggest hub fanned up
 * to DEFAULT_MAX_HIGHLIGHT_EDGES near-white lines across the whole viewport.
 *
 * The alpha is one uniform per pass — the nodes and the focus ring stay at 1.
 */
const HIGHLIGHT_EDGE_WIDTH_SCALE = 1.5
const HIGHLIGHT_EDGE_ALPHA = 0.85
/** Focus ring: how far outside the dot it sits, and how thick it is (device px). */
const RING_PAD_PX = 3
const RING_WIDTH_PX = 1.5

/**
 * Edge LOD, in CSS px between neighbouring claims (`SPACING` = 14 world units
 * apart). Below EDGE_FADE_MIN the map is a dust cloud and edges are pure
 * noise; by EDGE_FADE_MAX neighbours are far enough apart that the lines read
 * as structure. Converted to `k` (CSS px per world unit) by dividing by
 * SPACING — see `edgeLodAlpha`.
 */
export const EDGE_FADE_MIN_NEIGHBOUR_PX = 1.0
export const EDGE_FADE_MAX_NEIGHBOUR_PX = 3.5
/** World units between neighbouring claim slots (graph-map `SPACING`). */
const NEIGHBOUR_SPACING = 14

/**
 * Edge LENGTH fade, in WORLD units — a second, independent cut from the zoom
 * LOD above.
 *
 * About half the claims carry a second link to a far-away anchor hub (one real
 * project hub has 1,614 of them). At mid and deep zoom those links cross the
 * whole viewport as long straight lines and the view becomes a hairball that
 * drowns the short claim → own-hub spokes, which are what actually carry the
 * structure. So: a link stays at full strength out to EDGE_LENGTH_FADE_START
 * (6 × SPACING — comfortably longer than any spoke inside a hub's disc) and
 * smoothsteps down to EDGE_LENGTH_FADE_FLOOR by EDGE_LENGTH_FADE_END
 * (40 × SPACING), where it reads as context rather than as clutter.
 *
 * World units, not pixels, because a link's length is a property of the graph:
 * the same link must read the same way at every zoom. Applied per instance in
 * the edge vertex shader, computed from the attributes already there — no new
 * buffers. The HIGHLIGHT pass opts out (`uHighlight`): hovering or selecting a
 * hub shows all of its long links at full strength, which is how they are read.
 */
export const EDGE_LENGTH_FADE_START = 6 * NEIGHBOUR_SPACING // 84 world units
export const EDGE_LENGTH_FADE_END = 40 * NEIGHBOUR_SPACING // 560 world units
export const EDGE_LENGTH_FADE_FLOOR = 0.22

/** Highlight buffers are small and rebuilt on change; cap them so they are fixed too. */
const MAX_HIGHLIGHT_NODES = 512
const MAX_HIGHLIGHT_EDGES = 512
const MAX_HIGHLIGHT_FOCUS = 8
/** Labels are capped by `selectLabels` (120 by default); leave headroom. */
const MAX_LABELS = 256
/** Label instance layout: anchor xy, rect xyzw, uv xyzw, style = 11 floats. */
const LABEL_FLOATS = 11

export interface RendererStats {
  drawCalls: number
  nodesDrawn: number
  edgesDrawn: number
  labels: number
}

/**
 * Superset of the frozen `MapRenderer`: the shell also calls `setWorld` (the
 * zoom LOD needs the world size and depth, which only the map meta knows) and
 * `stats` (dev overlay). The interface in types.ts stays frozen.
 */
export interface MapRendererImpl extends MapRenderer {
  /** World bounds + deepest level; required before tile alpha is meaningful. */
  setWorld(world: { size: number }, maxZ: number): void
  stats(): RendererStats
  /**
   * Measure a label in CSS px with the atlas's real font — pass this as
   * `selectLabels`'s `measure` so collision boxes match what is drawn.
   */
  measureLabel(text: string, weight: 0 | 1): number
  /**
   * Re-point this renderer's slabs at `tiles` WITHOUT rebuilding GL state.
   *
   * This is what a freshly-constructed renderer wants after the shell recreates
   * it (idle return, dpr change): the constructor has already built every
   * program, buffer and VAO, so calling `restore()` — which exists for the
   * context-LOSS path and therefore rebuilds — would allocate a second full set
   * and orphan the first on a context that is still alive.
   */
  reupload(tiles: ResidentTile[]): void
  /** The dpr the label atlas is currently rasterising at (0 when there is none). */
  atlasDpr(): number
  /**
   * DEV/BENCHMARK ONLY. Blocks until the GPU has finished the frame (a 1×1
   * readPixels is the only portable hard sync — gl.finish() is a no-op in
   * Chrome's GPU-process model). Lets the stats overlay report true CPU+GPU
   * frame cost, which stays meaningful even when rAF itself is throttled
   * (background tab, hidden preview pane). Never call this in production: a
   * sync per frame is exactly the stall a renderer exists to avoid.
   */
  syncForTiming(): void
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function createMapRenderer(
  canvas: HTMLCanvasElement,
  opts: { maxResidentTiles: number; viewport?: Viewport },
): MapRendererImpl {
  return new Renderer(canvas, Math.max(1, Math.floor(opts.maxResidentTiles)), opts.viewport)
}

// ─── Implementation ───────────────────────────────────────────────────────────

interface Program {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

class Renderer implements MapRendererImpl {
  private readonly canvas: HTMLCanvasElement
  private readonly maxTiles: number
  private gl: WebGL2RenderingContext | null = null

  private palette: Palette = neutralPalette()
  private paletteFlat = new Float32Array(PALETTE_SLOTS * 4)
  private highlight: Highlight | null = null
  private labels: LabelSprite[] = []
  private labelsDirty = true
  private world = { size: 1 }
  private maxZ = 0
  private viewport: Viewport = { width: 1, height: 1, dpr: 1 }

  private contextLost = false
  private disposed = false
  private animating = false
  private lastStats: RendererStats = { drawCalls: 0, nodesDrawn: 0, edgesDrawn: 0, labels: 0 }
  private readonly syncPixel = new Uint8Array(4)

  /** CPU-side instance counts per slab; `removeTile` just zeroes them. */
  private readonly slabNodeCount: Uint32Array
  private readonly slabEdgeCount: Uint32Array

  // GL objects (all recreated by `restore`).
  private quadBuffer: WebGLBuffer | null = null
  private nodeBuffer: WebGLBuffer | null = null
  private edgeBuffer: WebGLBuffer | null = null
  private hlNodeBuffer: WebGLBuffer | null = null
  private hlEdgeBuffer: WebGLBuffer | null = null
  private hlFocusBuffer: WebGLBuffer | null = null
  private labelBuffer: WebGLBuffer | null = null

  private nodeVao: WebGLVertexArrayObject | null = null
  private edgeVao: WebGLVertexArrayObject | null = null
  private hlNodeVao: WebGLVertexArrayObject | null = null
  private hlEdgeVao: WebGLVertexArrayObject | null = null
  private hlFocusVao: WebGLVertexArrayObject | null = null
  private labelVao: WebGLVertexArrayObject | null = null

  private nodeProgram: Program | null = null
  private edgeProgram: Program | null = null
  private ringProgram: Program | null = null
  private labelProgram: Program | null = null

  private atlas: LabelAtlas | null = null

  /** Highlight geometry is stored relative to this origin (same float64 trick). */
  private hlOrigin = { x: 0, y: 0 }
  private hlNodeCount = 0
  private hlEdgeCount = 0
  private hlFocusCount = 0
  private labelCount = 0
  /** Label anchors are relative to this origin. */
  private labelOrigin = { x: 0, y: 0 }

  private readonly scratchNodes: Float32Array
  private readonly scratchEdges: Float32Array

  constructor(canvas: HTMLCanvasElement, maxResidentTiles: number, viewport?: Viewport) {
    this.canvas = canvas
    this.maxTiles = maxResidentTiles
    // BEFORE buildGlState: the label atlas bakes its device-px shelf height
    // from `this.viewport.dpr`, and the field initialiser is dpr 1. Without
    // this every fresh renderer rasterised text at half resolution on a Retina
    // display (the shell only calls `resize()` after the constructor returns).
    // `resize()` also rebuilds the atlas on a dpr change, so this is belt and
    // braces — but it saves a rasterisation on the very first frame.
    if (viewport) this.viewport = viewport
    this.slabNodeCount = new Uint32Array(maxResidentTiles)
    this.slabEdgeCount = new Uint32Array(maxResidentTiles)
    // One scratch buffer per layer, reused for every upload: interleaving a
    // 4000-instance tile must not allocate.
    this.scratchNodes = new Float32Array(HARD_TILE_CAP * NODE_FLOATS)
    this.scratchEdges = new Float32Array(TILE_EDGE_CAPACITY * EDGE_FLOATS)

    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    this.gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null
    // `getContext` on a canvas whose context was deliberately lost returns that
    // SAME lost object — non-null, so a bare `!this.gl` check passes and the
    // failure surfaces later as a baffling "shader failed to compile". The
    // shell now gives every renderer a fresh <canvas> so this cannot happen;
    // this check makes the contract explicit rather than implicit.
    if (!this.gl || this.gl.isContextLost()) {
      throw new Error('knowledge map: WebGL2 context unavailable or already lost')
    }
    this.buildGlState()
  }

  // ── Frozen MapRenderer surface ──

  setWorld(world: { size: number }, maxZ: number): void {
    this.world = { size: world.size > 0 ? world.size : 1 }
    this.maxZ = maxZ
  }

  uploadTile(tile: ResidentTile): void {
    const gl = this.gl
    if (!gl || this.contextLost) return
    if (tile.slab < 0 || tile.slab >= this.maxTiles) {
      throw new Error(`knowledge map: slab ${tile.slab} out of range (max ${this.maxTiles})`)
    }

    const n = Math.min(tile.nodeCount, HARD_TILE_CAP)
    const nodes = this.scratchNodes
    for (let i = 0; i < n; i++) {
      const o = i * NODE_FLOATS
      nodes[o] = tile.nodeX[i]
      nodes[o + 1] = tile.nodeY[i]
      nodes[o + 2] = tile.nodeR[i]
      nodes[o + 3] = tile.nodeKind[i]
      nodes[o + 4] = tile.nodeFlags[i]
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer)
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      tile.slab * HARD_TILE_CAP * NODE_STRIDE,
      nodes,
      0,
      n * NODE_FLOATS,
    )

    const e = Math.min(tile.edgeCount, TILE_EDGE_CAPACITY)
    const edges = this.scratchEdges
    for (let i = 0; i < e; i++) {
      // The wire ships the source as an INDEX into this tile's nodes; the
      // position it needs is that node's own position.
      const s = tile.edgeSource[i]
      const o = i * EDGE_FLOATS
      edges[o] = tile.nodeX[s]
      edges[o + 1] = tile.nodeY[s]
      edges[o + 2] = tile.edgeTX[i]
      edges[o + 3] = tile.edgeTY[i]
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer)
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      tile.slab * TILE_EDGE_CAPACITY * EDGE_STRIDE,
      edges,
      0,
      e * EDGE_FLOATS,
    )
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    this.slabNodeCount[tile.slab] = n
    this.slabEdgeCount[tile.slab] = e
  }

  removeTile(tile: ResidentTile): void {
    if (tile.slab < 0 || tile.slab >= this.maxTiles) return
    // No GPU work: a slab with a zero count is never drawn, and the stale
    // bytes are overwritten by whichever tile takes the slab next.
    this.slabNodeCount[tile.slab] = 0
    this.slabEdgeCount[tile.slab] = 0
  }

  clear(): void {
    this.slabNodeCount.fill(0)
    this.slabEdgeCount.fill(0)
    this.highlight = null
    this.hlNodeCount = 0
    this.hlEdgeCount = 0
    this.hlFocusCount = 0
    this.labels = []
    this.labelCount = 0
    this.labelsDirty = true
  }

  setPalette(palette: Palette): void {
    this.palette = palette
    const flat = this.paletteFlat
    writeSlot(flat, 0, palette.claim)
    writeSlot(flat, 1, palette.claimSuggested)
    writeSlot(flat, 2, palette.entity)
    writeSlot(flat, 3, palette.virtual)
    writeSlot(flat, 4, palette.edge)
    writeSlot(flat, 5, palette.accent)
    writeSlot(flat, 6, palette.label)
  }

  setHighlight(highlight: Highlight | null): void {
    this.highlight = highlight
    this.uploadHighlight()
  }

  setLabels(labels: LabelSprite[]): void {
    this.labels = labels.length > MAX_LABELS ? labels.slice(0, MAX_LABELS) : labels
    this.labelsDirty = true
  }

  render(camera: CameraState, cssViewport: Viewport, tiles: ResidentTile[], now: number): void {
    const gl = this.gl
    const stats: RendererStats = { drawCalls: 0, nodesDrawn: 0, edgesDrawn: 0, labels: 0 }
    this.lastStats = stats
    this.animating = false
    if (!gl || this.contextLost || this.disposed) return

    // BOTH the rasterised rectangle and the projection come from the BACKING
    // STORE, never from the CSS viewport the shell handed in. The shell updates
    // the CSS size immediately on every ResizeObserver tick but debounces the
    // (expensive) backing-store realloc, so for up to RESIZE_SETTLE_MS the two
    // disagree. Sizing gl.viewport from the CSS size while the buffer is still
    // the old size clipped the image to the smaller buffer and let CSS stretch
    // it — the whole map wobbling for the duration of a splitter drag. Deriving
    // both from `drawingBuffer*` makes them agree by construction, whichever
    // side of the debounce a frame lands on: the frame is simply rendered at
    // the old size and scaled by CSS, which is a uniform scale, not a crop.
    const bw = gl.drawingBufferWidth
    const bh = gl.drawingBufferHeight
    if (bw <= 0 || bh <= 0) return
    // dpr comes from the incoming viewport: the backing store was allocated at
    // that ratio (a dpr change reallocs immediately, never through the debounce).
    const dpr = cssViewport.dpr
    const viewport: Viewport = { width: bw / dpr, height: bh / dpr, dpr }
    this.viewport = viewport
    gl.viewport(0, 0, bw, bh)

    // Transparent: the dashboard's dot grid shows through, as today.
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const zc = continuousZoom(camera, this.world.size, this.maxZ)
    const dim = this.highlight?.dimOthers ? this.palette.dim : 1
    const edgeLod = edgeLodAlpha(camera.k)

    // Pass 1 — edges of every tile, under everything else.
    if (edgeLod > 0 && this.edgeProgram && this.edgeVao) {
      gl.useProgram(this.edgeProgram.program)
      gl.bindVertexArray(this.edgeVao)
      this.setCommonUniforms(this.edgeProgram, camera, viewport)
      gl.uniform1f(this.edgeProgram.uniforms.uWidthCss, EDGE_WIDTH_CSS_PX)
      gl.uniform1i(this.edgeProgram.uniforms.uHighlight, 0)
      gl.uniform1i(this.edgeProgram.uniforms.uAccent, 0)
      this.setEdgeLengthFade(this.edgeProgram)
      for (const tile of tiles) {
        const count = this.slabEdgeCount[tile.slab]
        if (!count) continue
        const alpha = this.tileAlpha(tile, zc, now) * dim * edgeLod
        if (alpha <= 0.002) continue
        this.drawEdgeSlab(this.edgeProgram, camera, tile, alpha, count)
        stats.drawCalls++
        stats.edgesDrawn += count
      }
    }

    // Pass 2 — nodes. Tile arrays are importance-ASCENDING, so the most
    // important nodes are the last instances drawn and land on top.
    if (this.nodeProgram && this.nodeVao) {
      gl.useProgram(this.nodeProgram.program)
      gl.bindVertexArray(this.nodeVao)
      this.setCommonUniforms(this.nodeProgram, camera, viewport)
      gl.uniform1i(this.nodeProgram.uniforms.uHighlight, 0)
      for (const tile of tiles) {
        const count = this.slabNodeCount[tile.slab]
        if (!count) continue
        const alpha = this.tileAlpha(tile, zc, now) * dim
        if (alpha <= 0.002) continue
        this.drawNodeSlab(this.nodeProgram, camera, tile, alpha, count)
        stats.drawCalls++
        stats.nodesDrawn += count
      }
    }

    // Pass 3 — highlight, at full alpha over the dimmed base.
    this.drawHighlight(camera, viewport, stats)

    // Pass 4 — labels, always last.
    this.drawLabels(camera, viewport, stats)

    gl.bindVertexArray(null)
  }

  needsAnotherFrame(): boolean {
    return this.animating || Boolean(this.atlas?.hasPending())
  }

  resize(viewport: Viewport): void {
    this.viewport = viewport
    const w = Math.max(1, Math.round(viewport.width * viewport.dpr))
    const h = Math.max(1, Math.round(viewport.height * viewport.dpr))
    // Reallocating the backing store is expensive; only do it on a real change.
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
    const gl = this.gl
    if (gl && !this.contextLost) gl.viewport(0, 0, w, h)
    this.syncAtlasDpr()
  }

  /**
   * Rebuild the label atlas when the device pixel ratio it was built for is no
   * longer the one we are drawing at.
   *
   * Every cached AtlasEntry's UVs and wPx/hPx were derived from the old dpr, so
   * there is nothing to salvage — a fresh atlas is both correct and simpler
   * than re-deriving each entry. This is also what makes a display change work
   * without recreating the whole renderer: the atlas was the ONLY piece of GL
   * state that baked dpr.
   */
  private syncAtlasDpr(): void {
    const gl = this.gl
    if (!gl || this.contextLost || this.disposed) return
    const want = Math.max(1, this.viewport.dpr)
    if (this.atlas && this.atlas.dpr === want) return
    this.atlas?.dispose()
    this.atlas = new LabelAtlas(gl, { dpr: want })
    // Every sprite must be re-rasterised and the label buffer rewritten.
    this.labelsDirty = true
  }

  atlasDpr(): number {
    return this.atlas?.dpr ?? 0
  }

  /**
   * Point the slabs at `tiles` again, reusing the GL state we already have.
   *
   * The shell calls this on a freshly-constructed renderer (idle return, and
   * historically the dpr recreate). `restore()` would be wrong there: it is the
   * context-LOSS path and unconditionally runs `buildGlState()`, so on a live
   * context it allocates a second full set of programs, buffers and VAOs and
   * `forgetGlObjects()` drops the first set's names without deleting them —
   * ~13 MB of VRAM orphaned per recreation, with no reference left to free it.
   */
  reupload(tiles: ResidentTile[]): void {
    if (this.disposed) return
    const gl = this.gl
    if (!gl || this.contextLost || gl.isContextLost()) return
    this.slabNodeCount.fill(0)
    this.slabEdgeCount.fill(0)
    for (const tile of tiles) this.uploadTile(tile)
    this.uploadHighlight()
    this.labelsDirty = true
    this.resize(this.viewport)
  }

  isContextLost(): boolean {
    return this.contextLost || Boolean(this.gl?.isContextLost())
  }

  /**
   * Rebuild every GL object after a context LOSS and re-upload from the tile
   * store's CPU copies (zero network).
   *
   * Only for a genuinely lost context. A renderer that still holds live GL
   * state wants `reupload()` instead — see the comment there. The guard below
   * enforces that rather than trusting the caller, because the failure mode is
   * silent: a second `buildGlState()` on a live context leaks the first set.
   */
  restore(tiles: ResidentTile[]): void {
    if (this.disposed) return
    const previous = this.gl
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null
    if (!gl || gl.isContextLost()) return
    this.gl = gl
    this.contextLost = false

    // The state we hold is still live on this very context: nothing died, so
    // rebuilding would double-allocate. Re-upload and stop.
    if (previous === gl && this.nodeProgram && !previous.isContextLost()) {
      this.reupload(tiles)
      return
    }
    // A live-but-different context still owns real objects; delete them rather
    // than merely dropping the names (`forgetGlObjects` is the loss-path
    // helper — after a real loss the names are already dead).
    if (previous && previous !== gl && !previous.isContextLost()) {
      this.deleteGlObjects(previous)
    }

    this.forgetGlObjects()
    this.buildGlState()
    this.slabNodeCount.fill(0)
    this.slabEdgeCount.fill(0)
    for (const tile of tiles) this.uploadTile(tile)
    this.uploadHighlight()
    this.labelsDirty = true
    this.resize(this.viewport)
  }

  stats(): RendererStats {
    return this.lastStats
  }

  syncForTiming(): void {
    const gl = this.gl
    if (this.disposed || !gl || this.isContextLost()) return
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    const gl = this.gl
    this.atlas?.dispose()
    this.atlas = null
    if (gl && !gl.isContextLost()) {
      this.deleteGlObjects(gl)
      // React 19 strict mode double-mounts effects in dev and pop-out windows
      // share one WKWebView GPU process: a leaked context per mount is a real
      // bug, not a tidiness nit.
      try {
        const ext = gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null
        ext?.loseContext()
      } catch {
        // Best effort.
      }
    }
    this.forgetGlObjects()
    this.gl = null
  }

  // ── Drawing helpers ──

  private tileAlpha(tile: ResidentTile, zc: number, now: number): number {
    const zoom = tileZoomAlpha(zc, tile.z)
    const load = tileLoadAlpha(now, tile.loadedAt)
    if (load < 1) this.animating = true
    return zoom * load
  }

  private setCommonUniforms(p: Program, camera: CameraState, viewport: Viewport): void {
    const gl = this.gl!
    gl.uniform1f(p.uniforms.uK, camera.k)
    gl.uniform2f(p.uniforms.uViewportCss, viewport.width, viewport.height)
    gl.uniform1f(p.uniforms.uDpr, viewport.dpr)
    if (p.uniforms.uPalette) gl.uniform4fv(p.uniforms.uPalette, this.paletteFlat)
    if (p.uniforms.uMinRadiusPx) gl.uniform1f(p.uniforms.uMinRadiusPx, MIN_NODE_RADIUS_PX)
    if (p.uniforms.uMaxRadiusPx) gl.uniform1f(p.uniforms.uMaxRadiusPx, MAX_NODE_RADIUS_PX)
    // The degree signal survives zoom-out because the SCALE is floored, not the
    // radius — one uniform, no per-instance attribute (lod.ts).
    if (p.uniforms.uFloorK) gl.uniform1f(p.uniforms.uFloorK, NODE_RADIUS_FLOOR_K)
  }

  /** The world-length fade thresholds, for whichever edge pass is bound. */
  private setEdgeLengthFade(p: Program): void {
    const gl = this.gl!
    gl.uniform1f(p.uniforms.uLenFadeStart, EDGE_LENGTH_FADE_START)
    gl.uniform1f(p.uniforms.uLenFadeEnd, EDGE_LENGTH_FADE_END)
    gl.uniform1f(p.uniforms.uLenFadeFloor, EDGE_LENGTH_FADE_FLOOR)
  }

  /**
   * Draw one tile's slab range.
   *
   * `drawArraysInstanced` always reads instances from index 0, and
   * `drawArraysInstancedBaseInstance` needs an extension that ANGLE/Metal does
   * not reliably expose — so the slab's byte offset is applied by re-pointing
   * the instanced attributes before the draw. That is 2-3 `vertexAttribPointer`
   * calls per tile (tens per frame), not per node.
   */
  private drawNodeSlab(
    p: Program,
    camera: CameraState,
    tile: ResidentTile,
    alpha: number,
    count: number,
  ): void {
    const gl = this.gl!
    const base = tile.slab * HARD_TILE_CAP * NODE_STRIDE
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer)
    gl.vertexAttribPointer(ATTR.nodePos, 2, gl.FLOAT, false, NODE_STRIDE, base)
    gl.vertexAttribPointer(ATTR.nodeRadius, 1, gl.FLOAT, false, NODE_STRIDE, base + 8)
    gl.vertexAttribPointer(ATTR.nodeStyle, 2, gl.FLOAT, false, NODE_STRIDE, base + 12)
    // FLOAT64 subtraction, narrowed only here. This is the whole precision story.
    gl.uniform2f(p.uniforms.uTileOffset, tile.ox - camera.x, tile.oy - camera.y)
    gl.uniform1f(p.uniforms.uAlpha, alpha)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
  }

  private drawEdgeSlab(
    p: Program,
    camera: CameraState,
    tile: ResidentTile,
    alpha: number,
    count: number,
  ): void {
    const gl = this.gl!
    const base = tile.slab * TILE_EDGE_CAPACITY * EDGE_STRIDE
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer)
    gl.vertexAttribPointer(ATTR.edgeA, 2, gl.FLOAT, false, EDGE_STRIDE, base)
    gl.vertexAttribPointer(ATTR.edgeB, 2, gl.FLOAT, false, EDGE_STRIDE, base + 8)
    gl.uniform2f(p.uniforms.uTileOffset, tile.ox - camera.x, tile.oy - camera.y)
    gl.uniform1f(p.uniforms.uAlpha, alpha)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
  }

  private drawHighlight(camera: CameraState, viewport: Viewport, stats: RendererStats): void {
    const gl = this.gl!
    const h = this.highlight
    if (!h) return
    const ox = this.hlOrigin.x - camera.x
    const oy = this.hlOrigin.y - camera.y

    if (this.hlEdgeCount && this.edgeProgram && this.hlEdgeVao) {
      gl.useProgram(this.edgeProgram.program)
      gl.bindVertexArray(this.hlEdgeVao)
      this.setCommonUniforms(this.edgeProgram, camera, viewport)
      // A hover dims everything else, so its edges keep the resting look; only
      // a selection, which dims nothing, draws them emphasised (see
      // HIGHLIGHT_EDGE_ALPHA).
      const emphasise = !h.dimOthers
      gl.uniform1f(
        this.edgeProgram.uniforms.uWidthCss,
        emphasise ? EDGE_WIDTH_CSS_PX * HIGHLIGHT_EDGE_WIDTH_SCALE : EDGE_WIDTH_CSS_PX,
      )
      gl.uniform1i(this.edgeProgram.uniforms.uAccent, emphasise ? 1 : 0)
      // uHighlight = 1 switches the shader's length fade OFF: a hovered or
      // selected hub shows ALL of its long links at a short link's strength.
      // The thresholds are still uploaded so the program never carries a stale
      // uniform.
      gl.uniform1i(this.edgeProgram.uniforms.uHighlight, 1)
      this.setEdgeLengthFade(this.edgeProgram)
      gl.uniform2f(this.edgeProgram.uniforms.uTileOffset, ox, oy)
      gl.uniform1f(this.edgeProgram.uniforms.uAlpha, emphasise ? HIGHLIGHT_EDGE_ALPHA : 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.hlEdgeCount)
      stats.drawCalls++
      stats.edgesDrawn += this.hlEdgeCount
    }

    if (this.hlNodeCount && this.nodeProgram && this.hlNodeVao) {
      gl.useProgram(this.nodeProgram.program)
      gl.bindVertexArray(this.hlNodeVao)
      this.setCommonUniforms(this.nodeProgram, camera, viewport)
      gl.uniform1i(this.nodeProgram.uniforms.uHighlight, 1)
      gl.uniform2f(this.nodeProgram.uniforms.uTileOffset, ox, oy)
      gl.uniform1f(this.nodeProgram.uniforms.uAlpha, 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.hlNodeCount)
      stats.drawCalls++
      stats.nodesDrawn += this.hlNodeCount
    }

    if (this.hlFocusCount && this.ringProgram && this.hlFocusVao) {
      gl.useProgram(this.ringProgram.program)
      gl.bindVertexArray(this.hlFocusVao)
      this.setCommonUniforms(this.ringProgram, camera, viewport)
      gl.uniform2f(this.ringProgram.uniforms.uTileOffset, ox, oy)
      gl.uniform1f(this.ringProgram.uniforms.uAlpha, 1)
      gl.uniform1f(this.ringProgram.uniforms.uRingPadPx, RING_PAD_PX)
      gl.uniform1f(this.ringProgram.uniforms.uRingWidthPx, RING_WIDTH_PX * viewport.dpr)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.hlFocusCount)
      stats.drawCalls++
    }
  }

  private drawLabels(camera: CameraState, viewport: Viewport, stats: RendererStats): void {
    const gl = this.gl!
    const atlas = this.atlas
    if (!atlas || !this.labelProgram || !this.labelVao) return
    // Rasterise a few queued labels per frame; `needsAnotherFrame` keeps the
    // loop alive until the queue drains.
    if (atlas.pump()) this.labelsDirty = true
    if (this.labelsDirty) this.uploadLabels()
    if (!this.labelCount) return
    const tex = atlas.getTexture()
    if (!tex) return

    gl.useProgram(this.labelProgram.program)
    gl.bindVertexArray(this.labelVao)
    this.setCommonUniforms(this.labelProgram, camera, viewport)
    gl.uniform2f(
      this.labelProgram.uniforms.uTileOffset,
      this.labelOrigin.x - camera.x,
      this.labelOrigin.y - camera.y,
    )
    gl.uniform1f(this.labelProgram.uniforms.uAlpha, 1)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(this.labelProgram.uniforms.uAtlas, 0)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.labelCount)
    gl.bindTexture(gl.TEXTURE_2D, null)
    stats.drawCalls++
    stats.labels = this.labelCount
  }

  // ── Dynamic buffer uploads ──

  /**
   * Highlight geometry is a handful of items, rebuilt only when the highlight
   * changes. It uses the same per-origin uniform trick as tiles rather than
   * camera-relative Float32 per frame, so hovering costs one upload, not one
   * per frame.
   */
  private uploadHighlight(): void {
    const gl = this.gl
    const h = this.highlight
    this.hlNodeCount = 0
    this.hlEdgeCount = 0
    this.hlFocusCount = 0
    if (!gl || this.contextLost || !h) return

    const anchor = h.focus[0] ?? h.nodes[0]
    this.hlOrigin = anchor ? { x: anchor.wx, y: anchor.wy } : { x: 0, y: 0 }
    const ox = this.hlOrigin.x
    const oy = this.hlOrigin.y

    const nodeCount = Math.min(h.nodes.length, MAX_HIGHLIGHT_NODES)
    if (nodeCount) {
      const data = new Float32Array(nodeCount * NODE_FLOATS)
      for (let i = 0; i < nodeCount; i++) {
        const n = h.nodes[i]
        const o = i * NODE_FLOATS
        data[o] = n.wx - ox
        data[o + 1] = n.wy - oy
        data[o + 2] = n.r
        data[o + 3] = n.kind
        data[o + 4] = n.flags
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hlNodeBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
      this.hlNodeCount = nodeCount
    }

    const edgeCount = Math.min(h.edges.length, MAX_HIGHLIGHT_EDGES)
    if (edgeCount) {
      const data = new Float32Array(edgeCount * EDGE_FLOATS)
      for (let i = 0; i < edgeCount; i++) {
        const e = h.edges[i]
        const o = i * EDGE_FLOATS
        data[o] = e.x1 - ox
        data[o + 1] = e.y1 - oy
        data[o + 2] = e.x2 - ox
        data[o + 3] = e.y2 - oy
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hlEdgeBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
      this.hlEdgeCount = edgeCount
    }

    const focusCount = Math.min(h.focus.length, MAX_HIGHLIGHT_FOCUS)
    if (focusCount) {
      const data = new Float32Array(focusCount * 3)
      for (let i = 0; i < focusCount; i++) {
        const f = h.focus[i]
        data[i * 3] = f.wx - ox
        data[i * 3 + 1] = f.wy - oy
        data[i * 3 + 2] = f.r
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hlFocusBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
      this.hlFocusCount = focusCount
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  private uploadLabels(): void {
    const gl = this.gl
    const atlas = this.atlas
    this.labelCount = 0
    this.labelsDirty = false
    if (!gl || this.contextLost || !atlas || this.labels.length === 0) return

    const first = this.labels[0]
    this.labelOrigin = { x: first.wx, y: first.wy }
    const data = new Float32Array(this.labels.length * LABEL_FLOATS)
    let n = 0
    for (const sprite of this.labels) {
      const entry = atlas.get(sprite.text, sprite.weight)
      // Not rasterised yet: skip it this frame. `atlas.hasPending()` keeps
      // `needsAnotherFrame` true so it appears on a later frame.
      if (!entry) {
        this.labelsDirty = true
        continue
      }
      const o = n * LABEL_FLOATS
      data[o] = sprite.wx - this.labelOrigin.x
      data[o + 1] = sprite.wy - this.labelOrigin.y
      // Centred under the node: the box's top-left is half a width to the left.
      data[o + 2] = -entry.wPx / 2
      data[o + 3] = sprite.offsetPx
      data[o + 4] = entry.wPx
      data[o + 5] = entry.hPx
      data[o + 6] = entry.u0
      data[o + 7] = entry.v0
      data[o + 8] = entry.u1
      data[o + 9] = entry.v1
      data[o + 10] = sprite.emphasised ? 1 : 0
      n++
    }
    if (!n) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.labelBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * LABEL_FLOATS)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    this.labelCount = n
  }

  /** The atlas measures text with the real font — hand it to the shell's selector. */
  measureLabel = (text: string, weight: 0 | 1): number => {
    return this.atlas ? this.atlas.measure(text, weight) : text.length * 6.2
  }

  // ── GL state construction ──

  private buildGlState(): void {
    const gl = this.gl!
    this.nodeProgram = link(gl, NODE_VS, NODE_FS, 'node', [
      'uTileOffset',
      'uK',
      'uViewportCss',
      'uDpr',
      'uMinRadiusPx',
      'uMaxRadiusPx',
      'uFloorK',
      'uPalette',
      'uAlpha',
      'uHighlight',
    ])
    this.edgeProgram = link(gl, EDGE_VS, EDGE_FS, 'edge', [
      'uTileOffset',
      'uK',
      'uViewportCss',
      'uDpr',
      'uWidthCss',
      'uLenFadeStart',
      'uLenFadeEnd',
      'uLenFadeFloor',
      'uPalette',
      'uAlpha',
      'uHighlight',
      'uAccent',
    ])
    this.ringProgram = link(gl, RING_VS, RING_FS, 'ring', [
      'uTileOffset',
      'uK',
      'uViewportCss',
      'uDpr',
      'uMinRadiusPx',
      'uMaxRadiusPx',
      'uFloorK',
      'uRingPadPx',
      'uRingWidthPx',
      'uPalette',
      'uAlpha',
    ])
    this.labelProgram = link(gl, LABEL_VS, LABEL_FS, 'label', [
      'uTileOffset',
      'uK',
      'uViewportCss',
      'uDpr',
      'uPalette',
      'uAlpha',
      'uAtlas',
    ])

    this.quadBuffer = staticBuffer(gl, QUAD_STRIP)
    this.nodeBuffer = emptyBuffer(gl, this.maxTiles * HARD_TILE_CAP * NODE_STRIDE)
    this.edgeBuffer = emptyBuffer(gl, this.maxTiles * TILE_EDGE_CAPACITY * EDGE_STRIDE)
    this.hlNodeBuffer = emptyBuffer(gl, MAX_HIGHLIGHT_NODES * NODE_STRIDE)
    this.hlEdgeBuffer = emptyBuffer(gl, MAX_HIGHLIGHT_EDGES * EDGE_STRIDE)
    this.hlFocusBuffer = emptyBuffer(gl, MAX_HIGHLIGHT_FOCUS * 3 * 4)
    this.labelBuffer = emptyBuffer(gl, MAX_LABELS * LABEL_FLOATS * 4)

    this.nodeVao = this.makeNodeVao(gl, this.nodeBuffer)
    this.hlNodeVao = this.makeNodeVao(gl, this.hlNodeBuffer)
    this.edgeVao = this.makeEdgeVao(gl, this.edgeBuffer)
    this.hlEdgeVao = this.makeEdgeVao(gl, this.hlEdgeBuffer)
    this.hlFocusVao = this.makeFocusVao(gl, this.hlFocusBuffer)
    this.labelVao = this.makeLabelVao(gl, this.labelBuffer)

    this.atlas = new LabelAtlas(gl, { dpr: Math.max(1, this.viewport.dpr) })
    this.setPalette(this.palette)
  }

  private bindQuad(gl: WebGL2RenderingContext): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.enableVertexAttribArray(ATTR.corner)
    gl.vertexAttribPointer(ATTR.corner, 2, gl.FLOAT, false, 0, 0)
    // Divisor 0 = per vertex; the quad is the only non-instanced attribute.
    gl.vertexAttribDivisor(ATTR.corner, 0)
  }

  private makeNodeVao(gl: WebGL2RenderingContext, buffer: WebGLBuffer | null) {
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('knowledge map: could not create node VAO')
    gl.bindVertexArray(vao)
    this.bindQuad(gl)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(ATTR.nodePos)
    gl.vertexAttribPointer(ATTR.nodePos, 2, gl.FLOAT, false, NODE_STRIDE, 0)
    gl.vertexAttribDivisor(ATTR.nodePos, 1)
    gl.enableVertexAttribArray(ATTR.nodeRadius)
    gl.vertexAttribPointer(ATTR.nodeRadius, 1, gl.FLOAT, false, NODE_STRIDE, 8)
    gl.vertexAttribDivisor(ATTR.nodeRadius, 1)
    gl.enableVertexAttribArray(ATTR.nodeStyle)
    gl.vertexAttribPointer(ATTR.nodeStyle, 2, gl.FLOAT, false, NODE_STRIDE, 12)
    gl.vertexAttribDivisor(ATTR.nodeStyle, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return vao
  }

  private makeEdgeVao(gl: WebGL2RenderingContext, buffer: WebGLBuffer | null) {
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('knowledge map: could not create edge VAO')
    gl.bindVertexArray(vao)
    this.bindQuad(gl)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(ATTR.edgeA)
    gl.vertexAttribPointer(ATTR.edgeA, 2, gl.FLOAT, false, EDGE_STRIDE, 0)
    gl.vertexAttribDivisor(ATTR.edgeA, 1)
    gl.enableVertexAttribArray(ATTR.edgeB)
    gl.vertexAttribPointer(ATTR.edgeB, 2, gl.FLOAT, false, EDGE_STRIDE, 8)
    gl.vertexAttribDivisor(ATTR.edgeB, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return vao
  }

  private makeFocusVao(gl: WebGL2RenderingContext, buffer: WebGLBuffer | null) {
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('knowledge map: could not create focus VAO')
    gl.bindVertexArray(vao)
    this.bindQuad(gl)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(ATTR.nodePos)
    gl.vertexAttribPointer(ATTR.nodePos, 2, gl.FLOAT, false, 12, 0)
    gl.vertexAttribDivisor(ATTR.nodePos, 1)
    gl.enableVertexAttribArray(ATTR.nodeRadius)
    gl.vertexAttribPointer(ATTR.nodeRadius, 1, gl.FLOAT, false, 12, 8)
    gl.vertexAttribDivisor(ATTR.nodeRadius, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return vao
  }

  private makeLabelVao(gl: WebGL2RenderingContext, buffer: WebGLBuffer | null) {
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('knowledge map: could not create label VAO')
    const stride = LABEL_FLOATS * 4
    gl.bindVertexArray(vao)
    this.bindQuad(gl)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(ATTR.labelAnchor)
    gl.vertexAttribPointer(ATTR.labelAnchor, 2, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(ATTR.labelAnchor, 1)
    gl.enableVertexAttribArray(ATTR.labelRect)
    gl.vertexAttribPointer(ATTR.labelRect, 4, gl.FLOAT, false, stride, 8)
    gl.vertexAttribDivisor(ATTR.labelRect, 1)
    gl.enableVertexAttribArray(ATTR.labelUV)
    gl.vertexAttribPointer(ATTR.labelUV, 4, gl.FLOAT, false, stride, 24)
    gl.vertexAttribDivisor(ATTR.labelUV, 1)
    gl.enableVertexAttribArray(ATTR.labelStyle)
    gl.vertexAttribPointer(ATTR.labelStyle, 1, gl.FLOAT, false, stride, 40)
    gl.vertexAttribDivisor(ATTR.labelStyle, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return vao
  }

  private deleteGlObjects(gl: WebGL2RenderingContext): void {
    for (const p of [this.nodeProgram, this.edgeProgram, this.ringProgram, this.labelProgram]) {
      if (p) gl.deleteProgram(p.program)
    }
    for (const b of [
      this.quadBuffer,
      this.nodeBuffer,
      this.edgeBuffer,
      this.hlNodeBuffer,
      this.hlEdgeBuffer,
      this.hlFocusBuffer,
      this.labelBuffer,
    ]) {
      if (b) gl.deleteBuffer(b)
    }
    for (const v of [
      this.nodeVao,
      this.edgeVao,
      this.hlNodeVao,
      this.hlEdgeVao,
      this.hlFocusVao,
      this.labelVao,
    ]) {
      if (v) gl.deleteVertexArray(v)
    }
  }

  /**
   * Drop references without touching GL.
   *
   * ONLY valid when the context those names belonged to is genuinely gone
   * (lost, or already deleted from). On a live context the names are real
   * objects and dropping them leaks; `deleteGlObjects(gl)` is the one that
   * frees.
   */
  private forgetGlObjects(): void {
    this.nodeProgram = null
    this.edgeProgram = null
    this.ringProgram = null
    this.labelProgram = null
    this.quadBuffer = null
    this.nodeBuffer = null
    this.edgeBuffer = null
    this.hlNodeBuffer = null
    this.hlEdgeBuffer = null
    this.hlFocusBuffer = null
    this.labelBuffer = null
    this.nodeVao = null
    this.edgeVao = null
    this.hlNodeVao = null
    this.hlEdgeVao = null
    this.hlFocusVao = null
    this.labelVao = null
    this.atlas?.dispose()
    this.atlas = null
  }

  // ── Context loss ──

  private onContextLost = (e: Event): void => {
    // Without preventDefault the browser never fires `webglcontextrestored`.
    e.preventDefault()
    this.contextLost = true
    this.forgetGlObjects()
  }

  private onContextRestored = (): void => {
    // The shell owns the CPU copies, so it calls `restore(tiles)`; all this
    // handler can do is clear the flag so `isContextLost()` reports the truth.
    this.contextLost = false
  }
}

// ─── Free helpers ─────────────────────────────────────────────────────────────

/**
 * Edge visibility from zoom alone. Below EDGE_FADE_MIN_NEIGHBOUR_PX of
 * separation between neighbouring claims the lines are pure noise; by
 * EDGE_FADE_MAX_NEIGHBOUR_PX they read as structure. `k` is CSS px per world
 * unit, and neighbouring claims sit NEIGHBOUR_SPACING world units apart.
 */
export function edgeLodAlpha(k: number): number {
  const minK = EDGE_FADE_MIN_NEIGHBOUR_PX / NEIGHBOUR_SPACING
  const maxK = EDGE_FADE_MAX_NEIGHBOUR_PX / NEIGHBOUR_SPACING
  if (k <= minK) return 0
  if (k >= maxK) return 1
  const t = (k - minK) / (maxK - minK)
  return t * t * (3 - 2 * t)
}

/**
 * The per-instance length fade the EDGE VERTEX SHADER applies, in TypeScript.
 *
 * Mirrors `mix(1.0, uLenFadeFloor, smoothstep(start, end, worldLen))` in
 * EDGE_VS — the renderer never calls this, the GPU does the work. It exists so
 * the thresholds are unit-testable without a GL context, the same way
 * `edgeLodAlpha` is. Keep the two in step.
 *
 * @param worldLen edge length in WORLD units (the shader divides px by k)
 */
export function edgeLengthAlpha(worldLen: number): number {
  const start = EDGE_LENGTH_FADE_START
  const end = EDGE_LENGTH_FADE_END
  if (!(worldLen > start)) return 1
  if (worldLen >= end) return EDGE_LENGTH_FADE_FLOOR
  const t = (worldLen - start) / (end - start)
  const s = t * t * (3 - 2 * t)
  return 1 + (EDGE_LENGTH_FADE_FLOOR - 1) * s
}

function link(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
  name: string,
  uniformNames: string[],
): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource, `${name} vertex`)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource, `${name} fragment`)
  const program = gl.createProgram()
  if (!program) throw new Error(`knowledge map: could not create ${name} program`)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  // Shaders are attached to the program, which keeps them alive; detaching and
  // deleting here frees the compiler's copy.
  gl.detachShader(program, vs)
  gl.detachShader(program, fs)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`knowledge map: ${name} program link failed: ${log ?? 'no info log'}`)
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  for (const u of uniformNames) uniforms[u] = gl.getUniformLocation(program, u)
  return { program, uniforms }
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error(`knowledge map: could not create ${label} shader`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`knowledge map: ${label} shader failed to compile: ${log ?? 'no info log'}`)
  }
  return shader
}

function staticBuffer(gl: WebGL2RenderingContext, data: Float32Array): WebGLBuffer {
  const b = gl.createBuffer()
  if (!b) throw new Error('knowledge map: could not create buffer')
  gl.bindBuffer(gl.ARRAY_BUFFER, b)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  return b
}

/** Allocate a slab once; it is written with `bufferSubData` and never resized. */
function emptyBuffer(gl: WebGL2RenderingContext, bytes: number): WebGLBuffer {
  const b = gl.createBuffer()
  if (!b) throw new Error('knowledge map: could not create buffer')
  gl.bindBuffer(gl.ARRAY_BUFFER, b)
  gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  return b
}

function writeSlot(flat: Float32Array, slot: number, c: [number, number, number, number]): void {
  flat[slot * 4] = c[0]
  flat[slot * 4 + 1] = c[1]
  flat[slot * 4 + 2] = c[2]
  flat[slot * 4 + 3] = c[3]
}

/** Used before the shell's first `setPalette`, so a frame before theme read is not blank. */
function neutralPalette(): Palette {
  const grey: [number, number, number, number] = [0.12, 0.14, 0.2, 0.34]
  return {
    claim: grey,
    claimSuggested: grey,
    entity: grey,
    virtual: grey,
    edge: [0.05, 0.06, 0.08, 0.14],
    // Premultiplied light-theme accent; the real one arrives with the first
    // setPalette, a few milliseconds later.
    accent: [0.376, 0.235, 0.797, 0.95],
    label: [0.13, 0.16, 0.23, 0.72],
    dim: 0.16,
    isDark: false,
  }
}
