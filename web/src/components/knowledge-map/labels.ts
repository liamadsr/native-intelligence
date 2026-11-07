/**
 * Knowledge Map labels — screen-space selection (pure) + a GPU texture atlas.
 *
 * Why an atlas at all: in the desktop app's WKWebView every Canvas2D call is
 * an IPC message to the GPU process (the PixelCanvas typing-lag bug class,
 * architecture §1 row 5). Rasterising each distinct string ONCE into a shared
 * texture and drawing it thereafter as an instanced textured quad makes the
 * per-frame Canvas2D cost exactly zero, no matter how many labels are on
 * screen.
 *
 * Why `fillText` and not an SDF glyph atlas: names in this workspace can be
 * Arabic, Persian, CJK — shaping, bidi and font fallback come free from the
 * browser's text stack and would be a project on their own to reimplement.
 */

import { worldToScreen } from './camera'
import type { CameraState, LabelSprite, Viewport } from './types'

/** Longest label drawn; longer ones are cut with an ellipsis, as today. */
export const LABEL_MAX_CHARS = 42
/**
 * Font size in CSS px (multiplied by dpr when rasterising).
 *
 * Labels are the map's SECOND layer: at 12px a name was physically larger than
 * the dot it belonged to, so the view read as a word cloud with specks between
 * the words. 10px is small enough that the dots win the page and still large
 * enough to read at 1× — and because the atlas is keyed by (text, dpr) and
 * rasterised once, the size costs nothing per frame.
 */
export const LABEL_FONT_PX = 10
/**
 * Line box height in CSS px — the atlas shelf height and the collision box.
 * Tracks LABEL_FONT_PX at ~1.3× so descenders have room and the collision grid
 * keeps rejecting overlaps at the same tightness as before.
 */
export const LABEL_LINE_HEIGHT_PX = 13
/**
 * Gap between the bottom of the node dot and the top of its label. Grown with
 * the dots: a label now hangs off a disc rather than a speck, and at 2.5 px it
 * touched the antialiasing ramp of a hub.
 */
export const LABEL_GAP_PX = 3.5
/** Default cap on labels per frame; beyond this the map reads as noise. */
export const DEFAULT_MAX_LABELS = 120
/** Collision grid cell, CSS px. Bigger than a label box would over-reject. */
const GRID_CELL_PX = 24
/** Labels are allowed this far outside the viewport before being skipped. */
const OFFSCREEN_MARGIN_PX = 48
/** Rough average glyph width used when no real `measureText` is available. */
const FALLBACK_CHAR_WIDTH = 6.2

export interface LabelCandidate {
  id: number
  wx: number
  wy: number
  /** The node's radius on screen in CSS px — sets the label's vertical offset. */
  screenRadiusPx: number
  text: string
  /** 0 = regular (claims), 1 = strong (entities). */
  weight: 0 | 1
  importance: number
  /**
   * Hovered / selected NEIGHBOURHOOD: placed before ordinary labels and drawn
   * emphasised, but still subject to collision — a hub's 35 claims sit a pixel
   * or two apart at overview zoom, and printing all of them unconditionally
   * produces a solid black smear (seen in the real view).
   */
  forced?: boolean
  /** The FOCUS node itself (hovered / selected): placed first, never rejected. */
  pinned?: boolean
}

export interface SelectLabelsOpts {
  max?: number
  /** Real text measurement; defaults to a width estimate (tests, SSR). */
  measure?: (text: string, weight: 0 | 1) => number
}

/**
 * Greedy screen-space label placement. `cands` must arrive importance-DESC —
 * greedy placement is only "most important wins" if the caller sorted.
 *
 * Three tiers, in order: the PINNED focus label is never rejected (a label the
 * user is pointing at must not blink out because a neighbour claimed the
 * cell); FORCED neighbourhood labels go next and win ties against ordinary
 * labels, but collide with each other like any label; then everything else.
 */
export function selectLabels(
  cands: LabelCandidate[],
  camera: CameraState,
  viewport: Viewport,
  opts: SelectLabelsOpts = {},
): LabelSprite[] {
  const max = opts.max ?? DEFAULT_MAX_LABELS
  if (max <= 0 || cands.length === 0) return []
  const measure = opts.measure ?? estimateWidth

  const cols = Math.max(1, Math.ceil(viewport.width / GRID_CELL_PX))
  const rows = Math.max(1, Math.ceil(viewport.height / GRID_CELL_PX))
  // One flat array of buckets keyed `row * cols + col`; occupied boxes are
  // pushed into every cell they touch, so a hit test only walks the boxes
  // near the candidate rather than all placed labels.
  const grid: Box[][] = new Array(cols * rows)
  const out: LabelSprite[] = []

  // Passes over one array rather than a sort: the pinned/forced sets are a
  // handful (one neighbourhood) and this keeps the caller's importance order.
  const tierOf = (c: LabelCandidate): number => (c.pinned ? 0 : c.forced ? 1 : 2)
  for (const pass of [0, 1, 2]) {
    for (const c of cands) {
      if (out.length >= max) break
      if (tierOf(c) !== pass) continue

      // One projection for the whole system (camera.ts): the collision boxes
      // packed here must sit where the label quads are actually drawn.
      const { x: sx, y: sy } = worldToScreen(camera, viewport, c.wx, c.wy)
      if (
        sx < -OFFSCREEN_MARGIN_PX ||
        sy < -OFFSCREEN_MARGIN_PX ||
        sx > viewport.width + OFFSCREEN_MARGIN_PX ||
        sy > viewport.height + OFFSCREEN_MARGIN_PX
      ) {
        continue
      }

      const text = truncateLabel(c.text)
      if (!text) continue
      const w = measure(text, c.weight)
      if (!(w > 0)) continue

      const offsetPx = c.screenRadiusPx + LABEL_GAP_PX
      // Box is centred under the node: x spans ±w/2, y runs down from the gap.
      const box: Box = {
        x0: sx - w / 2,
        y0: sy + offsetPx,
        x1: sx + w / 2,
        y1: sy + offsetPx + LABEL_LINE_HEIGHT_PX,
      }

      if (!c.pinned && collides(grid, cols, rows, box)) continue
      insert(grid, cols, rows, box)
      out.push({
        wx: c.wx,
        wy: c.wy,
        offsetPx,
        text,
        weight: c.weight,
        emphasised: Boolean(c.forced || c.pinned),
      })
    }
  }
  return out
}

/** Cut to LABEL_MAX_CHARS with a trailing ellipsis, matching the legacy graph. */
export function truncateLabel(text: string): string {
  const t = text.trim()
  if (t.length <= LABEL_MAX_CHARS) return t
  return t.slice(0, LABEL_MAX_CHARS - 1) + '…'
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function cellRange(
  cols: number,
  rows: number,
  box: Box,
): { c0: number; c1: number; r0: number; r1: number } {
  return {
    c0: clampInt(Math.floor(box.x0 / GRID_CELL_PX), 0, cols - 1),
    c1: clampInt(Math.floor(box.x1 / GRID_CELL_PX), 0, cols - 1),
    r0: clampInt(Math.floor(box.y0 / GRID_CELL_PX), 0, rows - 1),
    r1: clampInt(Math.floor(box.y1 / GRID_CELL_PX), 0, rows - 1),
  }
}

function collides(grid: Box[][], cols: number, rows: number, box: Box): boolean {
  const { c0, c1, r0, r1 } = cellRange(cols, rows, box)
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const bucket = grid[r * cols + c]
      if (!bucket) continue
      for (const other of bucket) {
        if (box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0) {
          return true
        }
      }
    }
  }
  return false
}

function insert(grid: Box[][], cols: number, rows: number, box: Box): void {
  const { c0, c1, r0, r1 } = cellRange(cols, rows, box)
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * cols + c
      ;(grid[i] ??= []).push(box)
    }
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function estimateWidth(text: string, weight: 0 | 1): number {
  return text.length * FALLBACK_CHAR_WIDTH * (weight === 1 ? 1.06 : 1)
}

// ─── Atlas ────────────────────────────────────────────────────────────────────

export interface AtlasEntry {
  u0: number
  v0: number
  u1: number
  v1: number
  /** Drawn size in CSS px (device px / dpr). */
  wPx: number
  hPx: number
}

/**
 * The atlas's device-px shelf height for a given dpr, and the CSS height the
 * quad is then drawn at.
 *
 * Extracted as a pure function because it is the whole of the "is the atlas
 * actually at device resolution?" question, and that question cannot otherwise
 * be asked without a GL context: the shelf is the number of device rows a
 * glyph run is rasterised into, and `hPx` is what the vertex shader sizes the
 * quad with (CSS px, projected against `uViewportCss`). The invariant that
 * makes labels crisp is `deviceRows ≈ cssPx × dpr` — an atlas built at dpr 1
 * and drawn on a dpr-2 display yields 15 device rows stretched over 30, which
 * is exactly the half-resolution blur.
 *
 * `ceil` (not round) because a shelf must never be shorter than the glyphs it
 * holds; the sub-pixel slack lands in the transparent margin below the
 * baseline, so the quad stays pixel-snapped.
 */
export function atlasShelfMetrics(
  dpr: number,
  rowHeightCssPx: number = LABEL_LINE_HEIGHT_PX,
): { dpr: number; deviceRows: number; cssPx: number } {
  const clamped = Math.max(1, dpr)
  const deviceRows = Math.ceil(rowHeightCssPx * clamped)
  return { dpr: clamped, deviceRows, cssPx: deviceRows / clamped }
}

export interface LabelAtlasOpts {
  /** Square texture edge in device px. 2048 is the probe's minimum. */
  size?: number
  rowHeightCssPx?: number
  dpr: number
}

interface Shelf {
  /** Device-px y of the shelf top. */
  y: number
  height: number
  /** Device-px x cursor within the shelf. */
  cursor: number
}

interface Pending {
  text: string
  weight: 0 | 1
}

/**
 * Shelf-packed texture atlas of rasterised labels.
 *
 * Eviction is "clear everything when full" rather than an LRU with holes:
 * shelf packing cannot reuse a freed rectangle without a real bin packer, and
 * re-rasterisation is already amortised by `pump()`'s per-frame budget. A full
 * atlas at 2048² holds roughly 2048/20 ≈ 100 shelves × many labels — far more
 * than the 120-label cap — so clearing is a rare event, not a per-frame cost.
 */
export class LabelAtlas {
  private readonly gl: WebGL2RenderingContext
  private readonly size: number
  /**
   * The dpr every cached entry was rasterised at. Public so the renderer can
   * tell whether a display change invalidated the whole atlas without keeping
   * a second copy of the number that could drift from this one.
   */
  readonly dpr: number
  private readonly rowHeightCss: number
  private readonly rowHeightDevice: number

  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null
  private texture: WebGLTexture | null = null

  private readonly entries = new Map<string, AtlasEntry>()
  private readonly pending = new Map<string, Pending>()
  private shelves: Shelf[] = []
  /** Device-px rows touched since the last upload: [y0, y1). */
  private dirtyY0 = Infinity
  private dirtyY1 = -Infinity
  private full = false

  constructor(gl: WebGL2RenderingContext, opts: LabelAtlasOpts) {
    this.gl = gl
    this.size = opts.size ?? 2048
    this.rowHeightCss = opts.rowHeightCssPx ?? LABEL_LINE_HEIGHT_PX
    const metrics = atlasShelfMetrics(opts.dpr, this.rowHeightCss)
    this.dpr = metrics.dpr
    this.rowHeightDevice = metrics.deviceRows
  }

  /** The GL texture, created lazily on first use. Null if the context is lost. */
  getTexture(): WebGLTexture | null {
    if (!this.texture) this.createTexture()
    return this.texture
  }

  /**
   * Look a label up. Returns null when it is not rasterised YET — the caller
   * skips that sprite this frame and `needsAnotherFrame()` keeps the loop
   * alive until `pump()` has caught up.
   */
  get(text: string, weight: 0 | 1): AtlasEntry | null {
    const key = cacheKey(text, weight)
    const hit = this.entries.get(key)
    if (hit) return hit
    if (!this.pending.has(key)) this.pending.set(key, { text, weight })
    return null
  }

  /** Measure a label without rasterising it — feeds `selectLabels`'s collision box. */
  measure(text: string, weight: 0 | 1): number {
    const ctx = this.ensureCanvas()
    if (!ctx) return estimateWidth(text, weight)
    ctx.font = fontSpec(weight, this.dpr)
    return ctx.measureText(text).width / this.dpr
  }

  /**
   * Rasterise up to `maxPerFrame` queued labels and upload the dirty rows.
   * Returns true while more are queued.
   */
  pump(maxPerFrame = 8): boolean {
    if (this.pending.size === 0) return false
    const ctx = this.ensureCanvas()
    if (!ctx) return false

    this.full = false
    let done = 0
    for (const [key, item] of this.pending) {
      if (done >= maxPerFrame) break
      this.pending.delete(key)
      const entry = this.rasterise(ctx, item)
      if (entry) this.entries.set(key, entry)
      done++
      // The atlas filled mid-batch: everything already drawn is invalid, so
      // stop and let the next pump start over on the cleared texture.
      if (this.full) break
    }
    this.flush()
    return this.pending.size > 0
  }

  /** True while labels are still waiting to be rasterised. */
  hasPending(): boolean {
    return this.pending.size > 0
  }

  /** Drop every cached label (theme flip changes nothing — the atlas is white). */
  clear(): void {
    this.entries.clear()
    this.pending.clear()
    this.shelves = []
    this.full = false
    const ctx = this.ensureCanvas()
    if (ctx) {
      ctx.clearRect(0, 0, this.size, this.size)
      this.markDirty(0, this.size)
      this.flush()
    }
  }

  dispose(): void {
    if (this.texture) {
      try {
        this.gl.deleteTexture(this.texture)
      } catch {
        // Context already lost — the driver freed it for us.
      }
      this.texture = null
    }
    this.entries.clear()
    this.pending.clear()
    this.shelves = []
    this.canvas = null
    this.ctx = null
  }

  // ── Internals ──

  private ensureCanvas():
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null {
    if (this.ctx) return this.ctx
    let canvas: HTMLCanvasElement | OffscreenCanvas | null = null
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas')
      c.width = this.size
      c.height = this.size
      canvas = c
    } else if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(this.size, this.size)
    }
    if (!canvas) return null
    // `willReadFrequently` is wrong here: we never read back, we upload.
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
    if (!ctx) return null
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    this.canvas = canvas
    this.ctx = ctx
    return ctx
  }

  private rasterise(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    item: Pending,
  ): AtlasEntry | null {
    ctx.font = fontSpec(item.weight, this.dpr)
    const wDevice = Math.ceil(ctx.measureText(item.text).width) + 2
    if (wDevice <= 0 || wDevice > this.size) return null

    const slot = this.allocate(wDevice)
    if (!slot) return null

    ctx.clearRect(slot.x, slot.y, wDevice, this.rowHeightDevice)
    // Always WHITE: the fragment shader tints by palette.label / palette.accent,
    // so a theme flip costs a uniform write, not a re-rasterisation.
    ctx.fillStyle = '#ffffff'
    ctx.fillText(item.text, slot.x + 1, slot.y)
    this.markDirty(slot.y, slot.y + this.rowHeightDevice)

    return {
      u0: slot.x / this.size,
      v0: slot.y / this.size,
      u1: (slot.x + wDevice) / this.size,
      v1: (slot.y + this.rowHeightDevice) / this.size,
      wPx: wDevice / this.dpr,
      hPx: this.rowHeightDevice / this.dpr,
    }
  }

  /**
   * Find room on an existing shelf, open a new one, or — when the atlas is
   * out of shelves — wipe it and start again at the top. `full` is set on that
   * wipe so `pump()` ends the batch: every entry rasterised earlier in the
   * same batch has just been erased, and its owner will re-queue it on the
   * next `get()`.
   */
  private allocate(wDevice: number): { x: number; y: number } | null {
    for (const shelf of this.shelves) {
      if (shelf.cursor + wDevice <= this.size) {
        const x = shelf.cursor
        shelf.cursor += wDevice
        return { x, y: shelf.y }
      }
    }
    const nextY = this.shelves.length
      ? this.shelves[this.shelves.length - 1].y + this.rowHeightDevice
      : 0
    if (nextY + this.rowHeightDevice <= this.size) {
      this.shelves.push({ y: nextY, height: this.rowHeightDevice, cursor: wDevice })
      return { x: 0, y: nextY }
    }
    this.clear()
    this.full = true
    this.shelves.push({ y: 0, height: this.rowHeightDevice, cursor: wDevice })
    return { x: 0, y: 0 }
  }

  private markDirty(y0: number, y1: number): void {
    if (y0 < this.dirtyY0) this.dirtyY0 = y0
    if (y1 > this.dirtyY1) this.dirtyY1 = y1
  }

  /** Upload only the touched rows — a full 2048² upload is 16 MB per frame. */
  private flush(): void {
    if (this.dirtyY1 <= this.dirtyY0) return
    const gl = this.gl
    const canvas = this.canvas
    const tex = this.getTexture()
    if (!canvas || !tex || gl.isContextLost()) {
      this.dirtyY0 = Infinity
      this.dirtyY1 = -Infinity
      return
    }
    const y0 = Math.max(0, Math.floor(this.dirtyY0))
    const y1 = Math.min(this.size, Math.ceil(this.dirtyY1))
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    // `texSubImage2D` cannot take a row slice of a canvas source directly, so
    // pass the whole canvas with an unpack row offset.
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      y0,
      this.size,
      y1 - y0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      canvas as TexImageSource,
    )
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.dirtyY0 = Infinity
    this.dirtyY1 = -Infinity
  }

  private createTexture(): void {
    const gl = this.gl
    if (gl.isContextLost()) return
    const tex = gl.createTexture()
    if (!tex) return
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.size,
      this.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    )
    // No mipmaps: labels are drawn at (near) 1:1 device px, and generating
    // mipmaps on every atlas write would dominate the upload cost.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.texture = tex
    // A fresh texture has none of the previously packed pixels.
    this.entries.clear()
    this.shelves = []
    this.markDirty(0, this.size)
  }
}

export function fontSpec(weight: 0 | 1, dpr: number): string {
  const px = LABEL_FONT_PX * dpr
  return `${weight === 1 ? 600 : 400} ${px}px Inter, ui-sans-serif, system-ui, sans-serif`
}

function cacheKey(text: string, weight: 0 | 1): string {
  return `${weight}\u0000${text}`
}
