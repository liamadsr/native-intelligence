/**
 * Knowledge Map camera — pure projection math + an input controller.
 *
 * Deliberately not d3-zoom: d3-zoom owns the transform, re-emits on every
 * event and fights React state; here the handlers only COMPUTE the next
 * `CameraState` and hand it to `set()`, which writes a ref and marks the frame
 * dirty. Nothing in this file renders, allocates per event, or touches the
 * DOM beyond listeners — WKWebView delivers momentum wheel events at up to
 * 120 Hz and every one of them must stay O(1).
 *
 * All world math is float64. The Float32 boundary is inside the renderer,
 * after the per-tile `origin − camera` subtraction.
 *
 * ─── AXIS CONVENTION: WORLD +Y IS SCREEN DOWN ───────────────────────────────
 *
 * The RENDERER defines it. `shaders.ts` projectLocal computes
 * `px = (local + tileOffset) * k` in a y-DOWN pixel space and negates y exactly
 * once, when converting those pixels to clip space (clip y points up). Label
 * quads are likewise laid out in y-down pixels below their anchor.
 *
 * So the CPU side flips NOTHING: screen y and world y grow in the same
 * direction, and `screenToWorld` / `worldToScreen` below are a pure
 * translate-and-scale. Every other CPU consumer (spatial-index picking,
 * label-candidates, labels) calls these two functions rather than re-deriving
 * the transform, so there is ONE definition here and one negation in the GLSL.
 *
 * This was wrong once: the CPU half flipped y while the GL half did not, which
 * drew the map mirrored about the viewport's horizontal centre line relative to
 * picking — a visible hub hit nothing, and its mirror image hit the hub. Both
 * halves were internally consistent, so no unit test caught it. `projectToClip`
 * (shaders.ts) plus `__tests__/projection-parity.test.ts` are the guard.
 */

import type { CameraState, Viewport } from './types'

/**
 * Zoom-out floor, as a multiple of the fit-the-world scale: you may pull back
 * to half the size of the whole map and no further, so the map can never get
 * lost in the void.
 */
export const MIN_K_FACTOR = 0.5
/** CSS px per world unit at maximum zoom (SPACING = 14 ⇒ ~900 px apart). */
export const MAX_K = 64

/** Drag distance (CSS px) past which a pointer gesture stops being a click. */
const CLICK_SLOP_PX = 4
/** Arrow keys pan by this many CSS px. */
const KEY_PAN_PX = 80
/** `+` / `-` zoom step per press. */
const KEY_ZOOM_FACTOR = 1.35
/** Default `flyTo` duration. */
const FLY_MS = 420

// ─── Projection ───────────────────────────────────────────────────────────────

/** Screen (CSS px, origin top-left) → world. World +y is screen DOWN. */
export function screenToWorld(
  camera: CameraState,
  viewport: Viewport,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: camera.x + (sx - viewport.width / 2) / camera.k,
    y: camera.y + (sy - viewport.height / 2) / camera.k,
  }
}

/** World → screen (CSS px, origin top-left). World +y is screen DOWN. */
export function worldToScreen(
  camera: CameraState,
  viewport: Viewport,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return {
    x: viewport.width / 2 + (wx - camera.x) * camera.k,
    y: viewport.height / 2 + (wy - camera.y) * camera.k,
  }
}

/**
 * Scale by `factor` about the screen point `(sx, sy)`, keeping the world point
 * currently under that pixel exactly under it afterwards. Solving
 * `screenToWorld(next, sx, sy) === screenToWorld(camera, sx, sy)` for the
 * centre gives the expression below; doing it in one step (rather than
 * pan-zoom-pan) keeps the fixed point exact to float64.
 */
export function zoomAt(
  camera: CameraState,
  viewport: Viewport,
  sx: number,
  sy: number,
  factor: number,
  limits: { minK: number; maxK: number },
): CameraState {
  const k = clampK(camera.k * factor, limits)
  if (k === camera.k) return camera
  const dx = sx - viewport.width / 2
  const dy = sy - viewport.height / 2
  return {
    x: camera.x + dx * (1 / camera.k - 1 / k),
    y: camera.y + dy * (1 / camera.k - 1 / k),
    k,
  }
}

/** Centre the whole world square in the viewport with `padPx` of margin. */
export function fitWorld(
  world: { minX: number; minY: number; size: number },
  viewport: Viewport,
  padPx = 32,
): CameraState {
  const w = Math.max(1, viewport.width - padPx * 2)
  const h = Math.max(1, viewport.height - padPx * 2)
  const size = world.size > 0 ? world.size : 1
  return {
    x: world.minX + size / 2,
    y: world.minY + size / 2,
    k: Math.min(w / size, h / size),
  }
}

/**
 * Fit an arbitrary world rectangle. The world square reserves room for hub
 * discs that are mostly empty, so fitting IT leaves the actual graph small and
 * off-centre; the opening view should frame the content instead.
 */
export function fitRect(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  viewport: Viewport,
  padPx = 48,
): CameraState {
  const w = Math.max(1, viewport.width - padPx * 2)
  const h = Math.max(1, viewport.height - padPx * 2)
  const rw = Math.max(1, rect.maxX - rect.minX)
  const rh = Math.max(1, rect.maxY - rect.minY)
  return {
    x: (rect.minX + rect.maxX) / 2,
    y: (rect.minY + rect.maxY) / 2,
    k: Math.min(w / rw, h / rh),
  }
}

/** The zoom range for a given world + viewport: fit-scale × MIN_K_FACTOR … MAX_K. */
export function cameraLimits(
  world: { minX: number; minY: number; size: number },
  viewport: Viewport,
): { minK: number; maxK: number } {
  const fit = fitWorld(world, viewport, 0).k
  const minK = fit * MIN_K_FACTOR
  // A degenerate viewport can push minK above MAX_K; never invert the range.
  return { minK, maxK: Math.max(minK, MAX_K) }
}

export function clampK(k: number, limits: { minK: number; maxK: number }): number {
  if (!Number.isFinite(k)) return limits.minK
  return Math.min(Math.max(k, limits.minK), limits.maxK)
}

/** Clamp a whole camera into range (used after a resize changes the fit scale). */
export function clampCamera(
  camera: CameraState,
  limits: { minK: number; maxK: number },
): CameraState {
  const k = clampK(camera.k, limits)
  return k === camera.k ? camera : { x: camera.x, y: camera.y, k }
}

// ─── Controller ───────────────────────────────────────────────────────────────

export interface CameraControllerOpts {
  get(): CameraState
  /** Write the ref + mark dirty. MUST NOT render. */
  set(next: CameraState): void
  getViewport(): Viewport
  limits(): { minK: number; maxK: number }
  onClick?(sx: number, sy: number): void
  /** `null, null` when the pointer leaves the element. */
  onHover?(sx: number | null, sy: number | null): void
  /** Any user gesture — the shell uses it to cancel idle/settle timers. */
  onInteraction?(): void
}

interface ActivePointer {
  x: number
  y: number
}

/**
 * Pointer / wheel / keyboard input for one canvas element. Listeners are
 * attached in the constructor and removed by `dispose()`; the element is
 * expected to be focusable (`tabIndex=0`) for the keyboard path.
 */
export class CameraController {
  private readonly el: HTMLElement
  private readonly opts: CameraControllerOpts
  private readonly pointers = new Map<number, ActivePointer>()

  /** Pointer id currently panning, if any. */
  private panId: number | null = null
  private panStart = { x: 0, y: 0 }
  private panMoved = false
  /** Distance between the two fingers when the pinch began. */
  private pinchDist = 0

  private flyRaf: number | null = null
  private disposed = false

  constructor(el: HTMLElement, opts: CameraControllerOpts) {
    this.el = el
    this.opts = opts
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerUp)
    el.addEventListener('pointerleave', this.onPointerLeave)
    // Non-passive: we call preventDefault so the page never scrolls or
    // back-swipes under the map. Chrome treats wheel as passive by default.
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('keydown', this.onKeyDown)
  }

  /**
   * Animate to `target`. Interpolates log(k) so a 100× zoom feels uniform
   * rather than sprinting at the end, and cancels the moment the user touches
   * anything.
   */
  flyTo(target: CameraState, ms = FLY_MS): void {
    if (this.disposed) return
    this.cancelFly()
    const from = this.opts.get()
    const limits = this.opts.limits()
    const to: CameraState = { x: target.x, y: target.y, k: clampK(target.k, limits) }
    if (ms <= 0 || typeof requestAnimationFrame !== 'function') {
      this.opts.set(to)
      return
    }
    const logFrom = Math.log(from.k)
    const logTo = Math.log(to.k)
    const t0 = now()
    const step = () => {
      if (this.disposed) return
      const t = Math.min(1, (now() - t0) / ms)
      const e = easeInOutCubic(t)
      this.opts.set({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: Math.exp(logFrom + (logTo - logFrom) * e),
      })
      if (t < 1) this.flyRaf = requestAnimationFrame(step)
      else this.flyRaf = null
    }
    this.flyRaf = requestAnimationFrame(step)
  }

  dispose(): void {
    this.disposed = true
    this.cancelFly()
    const el = this.el
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointercancel', this.onPointerUp)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    el.removeEventListener('wheel', this.onWheel)
    el.removeEventListener('keydown', this.onKeyDown)
    this.pointers.clear()
  }

  // ── Pointer ──

  private onPointerDown = (e: PointerEvent): void => {
    this.cancelFly()
    this.opts.onInteraction?.()
    const p = this.local(e)
    this.pointers.set(e.pointerId, p)
    try {
      this.el.setPointerCapture(e.pointerId)
    } catch {
      // Capture is an optimisation; a browser that refuses still gets moves.
    }
    if (this.pointers.size === 1) {
      this.panId = e.pointerId
      this.panStart = p
      this.panMoved = false
    } else if (this.pointers.size === 2) {
      // A second finger converts the drag into a pinch; no click can follow.
      this.panId = null
      this.panMoved = true
      this.pinchDist = this.twoPointerDistance()
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.local(e)
    if (!this.pointers.has(e.pointerId)) {
      this.opts.onHover?.(p.x, p.y)
      return
    }
    const prev = this.pointers.get(e.pointerId)!
    this.pointers.set(e.pointerId, p)

    if (this.pointers.size >= 2) {
      this.pinch()
      return
    }
    if (this.panId !== e.pointerId) return

    if (
      !this.panMoved &&
      Math.abs(p.x - this.panStart.x) + Math.abs(p.y - this.panStart.y) > CLICK_SLOP_PX
    ) {
      this.panMoved = true
    }
    if (!this.panMoved) return

    const cam = this.opts.get()
    this.opts.onInteraction?.()
    // Dragging right moves the world right, so the camera centre moves LEFT —
    // and, with world +y = screen down, dragging down moves it UP. Both axes
    // are the same subtraction; there is no y special case.
    this.opts.set({
      x: cam.x - (p.x - prev.x) / cam.k,
      y: cam.y - (p.y - prev.y) / cam.k,
      k: cam.k,
    })
  }

  private onPointerUp = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId)
    this.pointers.delete(e.pointerId)
    try {
      this.el.releasePointerCapture(e.pointerId)
    } catch {
      // Already released (pointercancel) — nothing to do.
    }
    if (this.panId === e.pointerId) {
      this.panId = null
      if (!this.panMoved && p) this.opts.onClick?.(p.x, p.y)
    }
    // Lifting one finger of a pinch: re-seat the remaining one as a pan that
    // can never be read as a click.
    if (this.pointers.size === 1) {
      const [id, remaining] = [...this.pointers.entries()][0]
      this.panId = id
      this.panStart = remaining
      this.panMoved = true
    }
  }

  private onPointerLeave = (): void => {
    this.opts.onHover?.(null, null)
  }

  private pinch(): void {
    const dist = this.twoPointerDistance()
    if (this.pinchDist <= 0 || dist <= 0) {
      this.pinchDist = dist
      return
    }
    const mid = this.twoPointerMidpoint()
    const factor = dist / this.pinchDist
    this.pinchDist = dist
    this.opts.onInteraction?.()
    this.opts.set(
      zoomAt(this.opts.get(), this.opts.getViewport(), mid.x, mid.y, factor, this.opts.limits()),
    )
  }

  private twoPointerDistance(): number {
    const [a, b] = [...this.pointers.values()]
    if (!a || !b) return 0
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  private twoPointerMidpoint(): { x: number; y: number } {
    const [a, b] = [...this.pointers.values()]
    if (!a || !b) return { x: 0, y: 0 }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  // ── Wheel ──

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.cancelFly()
    this.opts.onInteraction?.()
    const p = this.local(e)
    // macOS trackpad pinch arrives as a wheel event with ctrlKey set, at a
    // much coarser delta — it needs its own, larger, per-unit gain.
    const factor = Math.exp(-normalizeWheelDeltaY(e) * (e.ctrlKey ? 0.01 : 0.0015))
    this.opts.set(
      zoomAt(this.opts.get(), this.opts.getViewport(), p.x, p.y, factor, this.opts.limits()),
    )
  }

  // ── Keyboard ──

  private onKeyDown = (e: KeyboardEvent): void => {
    let dxPx = 0
    let dyPx = 0
    let zoom = 1
    switch (e.key) {
      case 'ArrowLeft':
        dxPx = -KEY_PAN_PX
        break
      case 'ArrowRight':
        dxPx = KEY_PAN_PX
        break
      case 'ArrowUp':
        dyPx = -KEY_PAN_PX
        break
      case 'ArrowDown':
        dyPx = KEY_PAN_PX
        break
      case '+':
      case '=':
        zoom = KEY_ZOOM_FACTOR
        break
      case '-':
      case '_':
        zoom = 1 / KEY_ZOOM_FACTOR
        break
      default:
        return
    }
    e.preventDefault()
    this.cancelFly()
    this.opts.onInteraction?.()
    const cam = this.opts.get()
    const vp = this.opts.getViewport()
    if (zoom !== 1) {
      this.opts.set(zoomAt(cam, vp, vp.width / 2, vp.height / 2, zoom, this.opts.limits()))
      return
    }
    // ArrowDown pans the VIEW down, i.e. the camera centre moves to a larger
    // world y — world +y is screen down, so both axes add their pixel delta.
    this.opts.set({ x: cam.x + dxPx / cam.k, y: cam.y + dyPx / cam.k, k: cam.k })
  }

  // ── Helpers ──

  private local(e: { clientX: number; clientY: number }): ActivePointer {
    const rect = this.el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private cancelFly(): void {
    if (this.flyRaf !== null) {
      cancelAnimationFrame(this.flyRaf)
      this.flyRaf = null
    }
  }
}

/**
 * Wheel deltas arrive in pixels, lines or pages depending on device and
 * browser; normalise to approximate pixels so one gain constant works for all
 * three.
 */
export function normalizeWheelDeltaY(e: {
  deltaY: number
  deltaMode?: number
}): number {
  const mode = e.deltaMode ?? 0
  if (mode === 1) return e.deltaY * 16 // DOM_DELTA_LINE
  if (mode === 2) return e.deltaY * 400 // DOM_DELTA_PAGE
  return e.deltaY
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
