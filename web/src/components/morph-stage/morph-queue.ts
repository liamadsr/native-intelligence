/**
 * When a morph stage draws. Framework- and GL-free, so it's testable.
 *
 * Frames run ONLY while a morph is in flight (~a second); between morphs the
 * stage holds one still frame and nothing runs — no rAF, no timer. Asking for
 * a new picture mid-morph doesn't interrupt it: the newest ask waits and runs
 * when this one lands (asks in between are dropped), so however fast the asks
 * come there is at most one morph in flight and one waiting.
 *
 * A timer lands each morph on its end state on time even if no frame comes
 * (an occluded or hidden webview can stop firing rAF).
 */

export interface MorphRenderer<K> {
  /** Draw `key` as is. */
  still(key: K): void
  /** Draw `from` melting into `to`, `progress` 0..1 (eased), `seconds` in. */
  morph(from: K, to: K, progress: number, seconds: number): void
}

export interface MorphClock {
  now(): number
  frame(cb: () => void): number
  cancelFrame(id: number): void
  timeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(id: ReturnType<typeof setTimeout>): void
}

export const browserClock: MorphClock = {
  now: () => performance.now(),
  frame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  timeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
}

/** Lands the morph on its end state if frames stop coming (ms past its length). */
const LANDING_GRACE_MS = 120

/** GSAP's power2.inOut. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

export class MorphQueue<K> {
  private current: K | null = null
  private run: { from: K; to: K; start: number } | null = null
  private pending: K | null = null
  private raf: number | null = null
  private guard: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly renderer: MorphRenderer<K>,
    private readonly durationMs: number,
    private readonly clock: MorphClock = browserClock,
  ) {}

  /** What's on screen, or on its way there. */
  get target(): K | null {
    return this.pending ?? this.run?.to ?? this.current
  }

  /** Every key the stage may still draw (keep their pictures). */
  get inUse(): K[] {
    const keys: K[] = []
    for (const k of [this.current, this.run?.from ?? null, this.run?.to ?? null, this.pending]) {
      if (k !== null && !keys.includes(k)) keys.push(k)
    }
    return keys
  }

  get animating(): boolean {
    return this.run !== null
  }

  /** Show `key`: at once if nothing is shown yet, else by a morph. */
  show(key: K): void {
    if (this.disposed) return
    if (this.run) {
      this.pending = key === this.run.to ? null : key
      return
    }
    if (this.current === null) {
      this.current = key
      this.renderer.still(key)
      return
    }
    if (key === this.current) return
    this.begin(key)
  }

  /** The picture needs drawing again (a resize, a context restore). A morph
   *  in flight redraws on its next frame. */
  redraw(): void {
    if (this.disposed || this.run || this.current === null) return
    this.renderer.still(this.current)
  }

  dispose(): void {
    this.disposed = true
    this.stopTimers()
    this.run = null
    this.pending = null
  }

  private begin(to: K): void {
    this.run = { from: this.current as K, to, start: this.clock.now() }
    this.guard = this.clock.timeout(() => this.land(), this.durationMs + LANDING_GRACE_MS)
    this.tick()
  }

  private tick = (): void => {
    this.raf = null
    const run = this.run
    if (!run || this.disposed) return
    const elapsed = this.clock.now() - run.start
    if (elapsed >= this.durationMs) {
      this.land()
      return
    }
    this.renderer.morph(run.from, run.to, easeInOut(elapsed / this.durationMs), elapsed / 1000)
    this.raf = this.clock.frame(this.tick)
  }

  private land(): void {
    const run = this.run
    if (!run || this.disposed) return
    this.stopTimers()
    this.run = null
    this.current = run.to
    this.renderer.still(run.to)
    const next = this.pending
    this.pending = null
    if (next !== null && next !== this.current) this.begin(next)
  }

  private stopTimers(): void {
    if (this.raf !== null) this.clock.cancelFrame(this.raf)
    if (this.guard !== null) this.clock.clearTimeout(this.guard)
    this.raf = null
    this.guard = null
  }
}
