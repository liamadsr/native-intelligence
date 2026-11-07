/**
 * Render-on-demand scheduling.
 *
 * The map must cost NOTHING when nothing changes. A perpetual
 * `requestAnimationFrame` loop that renders an identical frame 60 times a
 * second is the default failure mode of canvas components, and in the desktop
 * app it is worse than wasted work: WKWebView composites the GL surface
 * through the GPU process, so an idle map taxes the same channel the rest of
 * the UI types through (architecture §1 row 5, and the PixelCanvas typing-lag
 * incident).
 *
 * So: a single rAF, armed only by `markDirty()`, which runs the callback once
 * and then disarms unless the callback itself asks for another frame. The
 * class is deliberately free of React and of the DOM beyond `requestAnimationFrame`,
 * so the whole state machine is unit-testable with a fake clock.
 *
 * `SettleTimer` is the companion: work that must happen when the camera STOPS
 * (recomputing the label set) rather than while it moves.
 */

export interface FrameSchedulerOpts {
  /**
   * Runs at most once per animation frame. Return true to request another
   * frame immediately (fade-ins, label rasterisation still in flight).
   */
  onFrame(now: number): boolean
  raf?: (cb: (now: number) => void) => number
  caf?: (handle: number) => void
}

/**
 * One armed rAF at a time; `markDirty` during a frame re-arms for the next one
 * rather than recursing.
 */
export class FrameScheduler {
  private readonly onFrame: (now: number) => boolean
  private readonly raf: (cb: (now: number) => void) => number
  private readonly caf: (handle: number) => void

  private handle: number | null = null
  private dirty = false
  private running = false
  private paused = false
  private disposed = false

  /** Frames actually rendered — the stats overlay's fps denominator. */
  frameCount = 0

  constructor(opts: FrameSchedulerOpts) {
    this.onFrame = opts.onFrame
    this.raf =
      opts.raf ??
      ((cb) =>
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(cb)
          : (setTimeout(() => cb(nowMs()), 16) as unknown as number))
    this.caf =
      opts.caf ??
      ((h) => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h)
        else clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
      })
  }

  /** True while a frame is armed — the test hook that proves idle costs nothing. */
  get isScheduled(): boolean {
    return this.handle !== null
  }

  /** Something changed; render one frame. Cheap and idempotent — call freely. */
  markDirty(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.paused) return
    // Re-arming from inside a frame is pointless: the frame body checks
    // `dirty` again on the way out and schedules exactly one successor.
    if (this.running || this.handle !== null) return
    this.arm()
  }

  /** Stop scheduling (tab hidden / inactive). Pending dirt is remembered. */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.cancel()
  }

  /** Resume; renders immediately if anything was marked dirty while paused. */
  resume(): void {
    if (!this.paused || this.disposed) return
    this.paused = false
    if (this.dirty) this.arm()
  }

  get isPaused(): boolean {
    return this.paused
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private arm(): void {
    if (this.disposed || this.paused || this.handle !== null) return
    this.handle = this.raf(this.tick)
  }

  private cancel(): void {
    if (this.handle !== null) {
      this.caf(this.handle)
      this.handle = null
    }
  }

  private tick = (now: number): void => {
    this.handle = null
    if (this.disposed || this.paused) return
    this.dirty = false
    this.running = true
    let again = false
    try {
      again = this.onFrame(now)
    } finally {
      this.running = false
      this.frameCount++
    }
    // `dirty` can have been set again BY the frame (a tile arrived mid-render).
    if (again || this.dirty) this.arm()
  }
}

/**
 * Run a callback once the stream of `bump()`s goes quiet for `delayMs`.
 *
 * Used for two different burst shapes with different costs: the camera settle
 * (~120 ms, then rebuild labels) and the resize settle (180 ms, then
 * reallocate the GL backing store — the same constant the dashboard's
 * PixelCanvas uses, for the same WKWebView reason).
 */
export class SettleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly delayMs: number,
    private readonly onSettle: () => void,
  ) {}

  /** Restart the quiet period. Trailing edge only — the callback always runs. */
  bump(): void {
    if (this.disposed) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(this.fire, this.delayMs)
  }

  /** Run now if armed — used when a burst must settle synchronously. */
  flush(): void {
    if (this.timer === null || this.disposed) return
    clearTimeout(this.timer)
    this.timer = null
    this.onSettle()
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  get isPending(): boolean {
    return this.timer !== null
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private fire = (): void => {
    this.timer = null
    if (this.disposed) return
    this.onSettle()
  }
}

/**
 * Rolling frame-interval window for the stats overlay.
 *
 * Deliberately over RENDERED frames, not wall-clock: a render-on-demand map is
 * idle most of the time, so "fps" here means "how fast frames run when they
 * run". A gap longer than IDLE_GAP_MS is dropped rather than averaged in —
 * otherwise one idle second would read as 1 fps and hide a real stall.
 */
export const IDLE_GAP_MS = 250

export class FpsMeter {
  private readonly intervals: number[] = []
  /**
   * NaN rather than 0 as "no previous sample": a rAF timestamp is legitimately
   * 0 on some engines' first frame, and treating that as "unset" would silently
   * drop the first real interval.
   */
  private last = Number.NaN

  constructor(private readonly window = 60) {}

  /** Record a rendered frame at `now` (ms). */
  sample(now: number): void {
    if (Number.isFinite(this.last)) {
      const dt = now - this.last
      if (dt > 0 && dt < IDLE_GAP_MS) {
        this.intervals.push(dt)
        if (this.intervals.length > this.window) this.intervals.shift()
      } else {
        // An idle gap breaks the window: intervals across it are meaningless.
        this.intervals.length = 0
      }
    }
    this.last = now
  }

  /** Mean fps over the window, or 0 before there are two frames. */
  fps(): number {
    if (this.intervals.length === 0) return 0
    let sum = 0
    for (const dt of this.intervals) sum += dt
    return sum > 0 ? (this.intervals.length * 1000) / sum : 0
  }

  reset(): void {
    this.intervals.length = 0
    this.last = Number.NaN
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
