/**
 * Runs the sky: decides what to draw (the scene for now, here, this weather,
 * this theme) and when. Framework-free, so React never re-renders for it.
 *
 * The animation loop exists only while the activity store says the sky may
 * move (calm, nothing holding it, and the calm run not yet at its cap). Each
 * frame is a setTimeout wrapping one requestAnimationFrame rather than rAF
 * re-registered every display frame (the PixelCanvas lesson: raw rAF keeps
 * the rendering timer hot at display rate): ~30 fps while rain, snow or sleet
 * is falling, ~24 fps otherwise (on a 120 Hz display; display frames round
 * it to ~20 on 60 Hz), ~15 fps with another app in front (the drift
 * moves under a texel a frame at quarter resolution, so it reads smooth).
 * Frozen means no loop and no
 * timer of the loop's: the canvas keeps its last frame. Anything that changes
 * the picture while frozen (the weather, the theme, the sun having moved, a
 * resize) draws ONE static frame.
 *
 * Motion glides: the drift's speed eases toward full when the sky may move
 * and toward zero when it may not, from wherever it is, so it never starts or
 * stops with a jolt (Liam, 10-10: "slows to a full stop"). Input or a hold
 * glides it to a stop in about a second; a calm run reaching its cap (the
 * store resting) in a little longer; the loop ends once it has stopped. A
 * hidden page, reduced motion or a lost context stops it at once.
 *
 * A new source mid-session (the thirty-minute weather, a better location)
 * blends: the scene eases from the old picture to the new over BLEND_MS
 * instead of snapping. The blend is bounded: the motion loop carries it when
 * it's running; otherwise (frozen or resting) it runs its own short loop at
 * the calm frame rate (~30 frames), then stops. A timer ends it on time too,
 * so with no frames at all (a hidden page never fires rAF) it still lands on
 * the end state. Hidden, or with no GL, a new source just snaps (nobody sees
 * it). The source the controller is built with draws as is: no blend.
 *
 * Rain, snow and sleet are drawn crisp on a canvas of their own at full
 * resolution (sky-precip.ts), in `precipHost`, by this same loop from this
 * same clock: they move, freeze, ease and rest with the sky, and while
 * frozen keep their last frame. That canvas exists only while something is
 * falling: created the first frame the drawn scene has precipitation (a new
 * reading, the dev preview, a blend fading it in) and disposed the first
 * frame it has none, so a dry sky has no second canvas, context or work.
 */

import { hslTripletToRgb, smoothstep, type Rgb } from '@/lib/sky/palette'
import { computeSkyScene, lerpScene, washedStrength, type SkyScene } from '@/lib/sky/scene'
import type { SkyActivity } from '@/lib/sky/sky-activity'
import type { SkyWeather } from '@/lib/sky/weather'
import { applyOverrideTime } from '@/lib/sky/dev-override'
import { SkyGL } from './sky-gl'
import { PRECIP_MAX_DPR, SkyPrecip, createPrecipFrame, isFalling, precipBackdrop } from './sky-precip'
import { markSkyTone, skyTone } from '@/lib/sky/sky-tone'

/** Canvas pixels per CSS pixel, regardless of devicePixelRatio. */
export const SKY_RESOLUTION = 0.25
/** ~30 fps while something is falling (rain, snow, sleet)… */
export const FRAME_MS_PRECIP = 33
/** …~24 fps for clouds alone (Liam, 10-10: the drift sped up in steps, so smaller steps a frame). */
export const FRAME_MS_CALM = 42
/**
 * ~15 fps while the window is on screen but another app has the focus (Liam,
 * 10-10: Native Intelligence open beside the app he types in, and the clouds never moved).
 * A hidden or covered window still stops it (the page is hidden then).
 */
export const FRAME_MS_BACKGROUND = 67
/** Speed ramps 0 → 1 over this long when the sky resumes, and 1 → 0 when it comes to rest. */
/** Time constants (s) of the speed's glide: up to full (~1.5 s to 95%)… */
const SPEED_IN_TAU = 0.5
/** …down after input or a hold (~1 s to a stop)… */
const SPEED_GLIDE_TAU = 0.25
/** …and down at the calm run's cap (~1.6 s to a stop). */
const SPEED_REST_TAU = 0.4
/** Below this the glide has stopped. */
const SPEED_STOPPED = 0.02
/** A new weather or place eases in over this long instead of snapping. */
export const BLEND_MS = 2_000
/** How often the sun's position is brought up to date (it moves a quarter degree a minute). */
const SUN_REFRESH_MS = 5 * 60_000
/** The light theme's default `--sidebar-background` (0 0% 96%, tailwind.css). */
const FALLBACK_SURFACE: Rgb = [0.96, 0.96, 0.96]

export interface SkySource {
  weather: SkyWeather
  latitude: number
  longitude: number
  /** Dev override: minutes after local midnight. */
  minuteOfDay: number | null
}

export interface SkyControllerOptions {
  canvas: HTMLCanvasElement
  activity: SkyActivity
  source: SkySource
  /** WebGL is unavailable: draw this scene as a static CSS gradient instead (null when GL works). */
  onFallback: (scene: SkyScene | null, surface: Rgb) => void
  /**
   * The theme colour the sky is mixed over (an HSL-triplet CSS variable on
   * <html>): `--sidebar-background`, the app shell's surface, by default; the
   * page `--background` on the signed-out pages.
   */
  surfaceVar?: string
  /**
   * 0..1: an even wash toward that surface, on top of the scene's own
   * strength (the signed-out pages, where text sits right on the sky). One
   * number for the whole canvas: it only lowers the final mix's strength,
   * never anything that depends on x or y. Per theme: [light, dark].
   */
  wash?: readonly [number, number]
  /**
   * The signed-out pages' dark theme, where text sits right on the sky: a
   * dark page dims the whole sky (the scene's \`dark\`) over the dark theme's
   * surface. Off (the app): a dark page shows the same weather exposed for a
   * dark app instead (the scene's \`dim\`, darkExposure: the blue deeper and
   * richer, the clouds still bright, the glare calmed), over the dark theme's
   * surface. The weather stays the weather (Liam, 10-16: "the background is
   * supposed to be the weather outside"), and dark mode no longer reads as a
   * dark filter over it (Liam, 10-18).
   */
  themed?: boolean
  /**
   * Where the crisp rain and snow canvas goes while something is falling: an
   * empty element over the sky canvas and under the grain, the same size.
   * None: no precipitation is drawn.
   */
  precipHost?: HTMLElement | null
}


export class SkyController {
  /** On screen, but another app has the focus: drawn at FRAME_MS_BACKGROUND. */
  private background = false
  private gl: SkyGL | null
  private canvas: HTMLCanvasElement
  private activity: SkyActivity
  private source: SkySource
  private onFallback: SkyControllerOptions['onFallback']
  private surfaceVar: string
  private washByTheme: readonly [number, number]
  private scene: SkyScene
  private surface: Rgb = FALLBACK_SURFACE
  private themed: boolean
  /** The page's dark theme is on (the `dark` class on <html>). */
  private pageDark = false
  /** The sky draws the signed-out pages' dimmed version: only when it's `themed` and the page is dark. */
  private dark = false
  /** The sky draws the app's dark-theme exposure: not `themed`, and the page is dark. */
  private dim = false
  private width = 0
  private height = 0

  private time = 0
  private cloudX = 0
  private cloudY = 0
  private running = false
  /** The drift's speed now (0..1), gliding toward `speedTarget`. */
  private speed = 0
  private speedTarget = 0
  private speedOutTau = SPEED_GLIDE_TAU
  private lastTs = 0
  private raf: number | null = null
  private frameTimer: ReturnType<typeof setTimeout> | null = null
  private sunTimer: ReturnType<typeof setTimeout> | null = null
  private sceneAt = 0
  /** A blend in flight: from the picture on screen when it began, to the new scene. */
  private blend: { from: SkyScene; to: SkyScene; at: number } | null = null
  private blendTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private cleanups: Array<() => void> = []
  /** The scene as drawn (washed), cached per scene object: no allocation per frame. */
  private drawnFrom: SkyScene | null = null
  private drawnCache: SkyScene | null = null
  private drawnWash = -1
  /** The canvas's CSS size, for the precipitation layer's full-resolution size. */
  private cssWidth = 0
  private cssHeight = 0
  private precipHost: HTMLElement | null
  /** The rain and snow layer, only while something is falling. */
  private precip: SkyPrecip | null = null
  /** It couldn't be created (no WebGL): not retried until the precipitation stops and starts again. */
  private precipFailed = false
  private precipFrame = createPrecipFrame()

  constructor({ canvas, activity, source, onFallback, surfaceVar = '--sidebar-background', wash = [0, 0], themed = false, precipHost = null }: SkyControllerOptions) {
    this.canvas = canvas
    this.themed = themed
    this.precipHost = precipHost
    this.activity = activity
    this.source = source
    this.onFallback = onFallback
    this.surfaceVar = surfaceVar
    this.washByTheme = wash
    // Start the cloud field somewhere different each session.
    this.cloudX = Math.random() * 50
    this.cloudY = Math.random() * 50
    this.readTheme()
    this.scene = this.computeScene()
    this.markTone(this.scene)
    this.gl = SkyGL.create(canvas)
    if (!this.gl) this.onFallback(this.drawnScene(), this.surface)

    const onLost = (e: Event) => {
      e.preventDefault()
      this.stop()
    }
    const onRestored = () => {
      if (this.gl?.init()) {
        this.drawStatic()
        this.sync()
      }
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    this.cleanups.push(() => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
    })

    // Size: the canvas's own box (it fills the shell backdrop).
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.resize())
      ro.observe(canvas)
      this.cleanups.push(() => ro.disconnect())
    } else {
      const onResize = () => this.resize()
      window.addEventListener('resize', onResize)
      this.cleanups.push(() => window.removeEventListener('resize', onResize))
    }

    // Theme: the `dark` class (the app follows the system) and inline theme
    // variables on <html>. The sky never changes them; it follows them.
    // Cheap checks first (a class test, an inline-style read): getComputedStyle
    // runs only when the theme or its inline variables really changed, so
    // other code toggling classes or styles on <html> costs nothing here.
    const root = document.documentElement
    let inlineSurface = root.style.getPropertyValue(this.surfaceVar)
    const mo = new MutationObserver(() => {
      const dark = root.classList.contains('dark')
      const inline = root.style.getPropertyValue(this.surfaceVar)
      if (dark === this.pageDark && inline === inlineSurface) return
      inlineSurface = inline
      const surfaceBefore = this.surface
      const pageDarkBefore = this.pageDark
      this.readTheme()
      if (pageDarkBefore !== this.pageDark || !sameRgb(surfaceBefore, this.surface)) this.refreshScene()
    })
    mo.observe(root, { attributes: true, attributeFilter: ['class', 'style'] })
    this.cleanups.push(() => mo.disconnect())

    this.cleanups.push(this.activity.subscribe(() => this.onActivity()))
    this.cleanups.push(this.activity.attach())
    this.scheduleSunRefresh()

    this.resize()
    this.sync()
  }

  /**
   * New weather / location (the API answered, or the dev override changed).
   * A real change blends; the same reading again (the fetch confirming what
   * the controller started from) only brings the sun up to date. `snap`
   * (dev: a time slider mid-drag) jumps straight to the new scene, ending any
   * blend in flight, and draws it at once even while frozen.
   */
  setSource(source: SkySource, { snap = false }: { snap?: boolean } = {}): void {
    const changed = !sameSource(this.source, source)
    this.source = source
    this.refreshScene(changed ? (snap ? 'snap' : 'blend') : 'update')
  }

  /** The window lost (true) or regained (false) the focus: a lower frame rate meanwhile, still moving. */
  setBackground(on: boolean): void {
    this.background = on
  }

  dispose(): void {
    this.disposed = true
    this.endBlend()
    this.stop()
    if (this.sunTimer) clearTimeout(this.sunTimer)
    for (const c of this.cleanups.splice(0)) c()
    this.disposePrecip()
    this.gl?.dispose()
    this.gl = null
    markSkyTone(null)
  }

  /**
   * <html data-sky-tone> for the scene the sky is going to (sky-tone.ts): the
   * ink of what sits right on it (the chat's day lines, times, reply hooks)
   * follows it. One attribute write, only when the tone changes.
   */
  private markTone(scene: SkyScene): void {
    markSkyTone(skyTone(scene, this.surface))
  }

  // ── Scene ────────────────────────────────────────────────────────────────

  private computeScene(): SkyScene {
    this.sceneAt = Date.now()
    return computeSkyScene({
      date: applyOverrideTime(new Date(), this.source.minuteOfDay),
      latitude: this.source.latitude,
      longitude: this.source.longitude,
      weather: this.source.weather,
      dark: this.dark,
      dim: this.dim,
    })
  }

  /**
   * `update` (the sun's step, the theme) eases on with a blend in flight and
   * otherwise redraws; `blend` eases into a new source; `snap` jumps to it.
   */
  private refreshScene(mode: 'update' | 'blend' | 'snap' = 'update'): void {
    if (this.disposed) return
    const next = this.computeScene()
    this.markTone(next)
    const blend = mode === 'blend'
    if (this.blend && mode === 'update') {
      // Mid-blend (the sun's step, the theme): keep easing, toward the updated scene.
      this.blend.to = next
      return
    }
    if (blend && this.canBlend() && !scenesClose(this.scene, next)) {
      this.startBlend(next)
      return
    }
    this.endBlend()
    this.scene = next
    if (!this.gl) this.onFallback(this.drawnScene(), this.surface)
    else if (!this.running) this.drawStatic()
  }

  // ── Blend ────────────────────────────────────────────────────────────────

  private canBlend(): boolean {
    return !!this.gl && !this.gl.isLost() && document.visibilityState === 'visible'
  }

  private startBlend(to: SkyScene): void {
    // From whatever is on screen now (mid-blend, the blended picture).
    this.blend = { from: this.scene, to, at: performance.now() }
    if (this.blendTimer !== null) clearTimeout(this.blendTimer)
    // Lands on the end state on time even if no frame ever runs.
    this.blendTimer = setTimeout(() => {
      this.blendTimer = null
      if (!this.blend) return
      this.endBlend()
      if (!this.running) this.drawStatic()
    }, BLEND_MS + 100)
    // The motion loop, when it runs, carries the blend; otherwise frames of its own.
    if (this.raf === null && this.frameTimer === null) this.raf = requestAnimationFrame(this.frame)
  }

  /** Jump to the blend's end state (nothing drawn here) and drop its frames if they're its alone. */
  private endBlend(): void {
    if (this.blendTimer !== null) clearTimeout(this.blendTimer)
    this.blendTimer = null
    if (!this.blend) return
    this.scene = this.blend.to
    this.blend = null
    if (!this.running) this.cancelPending()
  }

  private readTheme(): void {
    const root = document.documentElement
    this.pageDark = root.classList.contains('dark')
    this.dark = this.themed && this.pageDark
    this.dim = !this.themed && this.pageDark
    // Mixed over the page's own surface, the dark theme's on a dark page.
    const raw = getComputedStyle(root).getPropertyValue(this.surfaceVar)
    this.surface = hslTripletToRgb(raw) ?? (this.pageDark ? [0.03, 0.03, 0.03] : FALLBACK_SURFACE)
  }

  private scheduleSunRefresh(): void {
    this.sunTimer = setTimeout(() => {
      this.sunTimer = null
      if (this.disposed) return
      // Hidden: skip the draw; it's brought up to date when it shows again.
      if (document.visibilityState === 'visible') this.refreshScene()
      this.scheduleSunRefresh()
    }, SUN_REFRESH_MS)
  }

  // ── Size ─────────────────────────────────────────────────────────────────

  private resize(): void {
    if (this.disposed) return
    const cssW = this.canvas.clientWidth
    const cssH = this.canvas.clientHeight
    this.cssWidth = cssW
    this.cssHeight = cssH
    const w = Math.max(1, Math.round(cssW * SKY_RESOLUTION))
    const h = Math.max(1, Math.round(cssH * SKY_RESOLUTION))
    if (w !== this.width || h !== this.height) {
      this.width = w
      this.height = h
      // Setting the size clears the drawing buffer: draw straight away.
      this.canvas.width = w
      this.canvas.height = h
    }
    this.drawStatic()
  }

  // ── Activity and the loop ────────────────────────────────────────────────

  private onActivity(): void {
    if (this.disposed) return
    // Back from hidden with a stale sun: bring it up to date.
    if (document.visibilityState === 'visible' && Date.now() - this.sceneAt > SUN_REFRESH_MS) this.refreshScene()
    this.sync()
  }

  private sync(): void {
    const drawable = !this.disposed && !!this.gl && !this.gl.isLost()
    const shouldRun = drawable && this.activity.canMove()
    if (shouldRun) {
      this.speedTarget = 1
      if (!this.running) this.start()
    } else if (this.running) {
      // A hidden page (where rAF never fires), reduced motion or a lost
      // context stops it at once. Anything else (input, a reply streaming, a
      // page full screen, the calm run's cap) glides it to a stop.
      const holds = this.activity.holds()
      if (!drawable || holds.includes('hidden') || holds.includes('reduced-motion')) {
        this.stop()
      } else {
        this.speedTarget = 0
        this.speedOutTau = this.activity.isResting() && holds.length === 0 ? SPEED_REST_TAU : SPEED_GLIDE_TAU
      }
    }
  }

  private start(): void {
    // One loop, ever: drop anything a previous one left pending.
    this.cancelPending()
    this.running = true
    this.lastTs = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  private stop(): void {
    this.running = false
    this.speed = 0
    this.speedTarget = 0
    this.cancelPending()
    // A blend in flight is bounded: it finishes on frames of its own.
    if (this.blend && !this.disposed && this.gl && !this.gl.isLost()) this.raf = requestAnimationFrame(this.frame)
  }

  private cancelPending(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    if (this.frameTimer !== null) clearTimeout(this.frameTimer)
    this.raf = null
    this.frameTimer = null
  }

  private frame = (ts: number) => {
    this.raf = null
    if (!this.running && !this.blend) return
    let rested = false
    if (this.running) {
      const dt = Math.min(0.1, Math.max(0, (ts - this.lastTs) / 1000))
      this.lastTs = ts
      const tau = this.speedTarget > this.speed ? SPEED_IN_TAU : this.speedOutTau
      this.speed += (this.speedTarget - this.speed) * (1 - Math.exp(-dt / tau))
      rested = this.speedTarget === 0 && this.speed < SPEED_STOPPED
      const step = dt * this.speed
      this.time += step
      this.cloudX -= this.scene.windX * step
      this.cloudY -= this.scene.windY * step
      // Keep the offsets small so the shader's float precision never runs out.
      if (Math.abs(this.cloudX) > 1000) this.cloudX %= 1000
      if (Math.abs(this.cloudY) > 1000) this.cloudY %= 1000
      if (this.time > 10_000) this.time %= 10_000
    }
    if (this.blend) {
      const t = (ts - this.blend.at) / BLEND_MS
      if (t >= 1) this.endBlend()
      else this.scene = lerpScene(this.blend.from, this.blend.to, smoothstep(0, 1, t))
    }
    this.draw()
    if (rested) {
      // Glided to a stop: the loop ends here, unless a blend still has frames to go.
      this.running = false
      this.speed = 0
    }
    // Stopped, or stopped and started again, during this frame: the new loop
    // (if any) has its own rAF pending already.
    if (this.raf !== null || this.frameTimer !== null) return
    if (!this.running && !this.blend) return
    const falling = this.running && this.scene.precipKind > 0 && this.scene.precipIntensity > 0
    const frameMs = this.background ? FRAME_MS_BACKGROUND : falling ? FRAME_MS_PRECIP : FRAME_MS_CALM
    const delay = Math.max(0, frameMs - (performance.now() - ts) - 4)
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null
      if (this.running || this.blend) this.raf = requestAnimationFrame(this.frame)
    }, delay)
  }

  private drawStatic(): void {
    if (this.gl && !this.gl.isLost()) this.draw()
  }

  /** The theme's wash (0 in the app). */
  private wash(): number {
    return this.washByTheme[this.dark ? 1 : 0]
  }

  /** The scene as drawn: with the wash, its strength lowered, alike everywhere. */
  private drawnScene(): SkyScene {
    const wash = this.wash()
    if (wash <= 0) return this.scene
    if (this.drawnFrom !== this.scene || this.drawnWash !== wash || !this.drawnCache) {
      this.drawnFrom = this.scene
      this.drawnWash = wash
      this.drawnCache = { ...this.scene, strength: washedStrength(this.scene.strength, wash) }
    }
    return this.drawnCache
  }

  private draw(): void {
    if (!this.gl || this.width === 0) return
    const scene = this.drawnScene()
    this.gl.draw(this.width, this.height, {
      scene,
      bg: this.surface,
      time: this.time,
      cloudX: this.cloudX,
      cloudY: this.cloudY,
    })
    this.drawPrecip(scene)
  }

  /** Rain and snow, in the same frame as the sky: the layer made when something starts falling, gone when it stops. */
  private drawPrecip(scene: SkyScene): void {
    if (!this.precipHost || !isFalling(scene)) {
      this.disposePrecip()
      this.precipFailed = false
      return
    }
    if (!this.precip) {
      if (this.precipFailed || this.disposed) return
      this.precip = SkyPrecip.create(this.precipHost, () => {
        if (!this.running) this.drawStatic()
      })
      if (!this.precip) {
        this.precipFailed = true
        return
      }
    }
    const f = this.precipFrame
    f.cssWidth = this.cssWidth
    f.cssHeight = this.cssHeight
    f.dpr = Math.min(PRECIP_MAX_DPR, Math.max(1, window.devicePixelRatio || 1))
    f.time = this.time
    f.kind = scene.precipKind
    f.intensity = scene.precipIntensity
    f.lean = scene.rainLean
    f.alpha = scene.precipAlpha * (1 - this.wash())
    precipBackdrop(scene, this.surface, scene.strength, f.skyTop, f.skyBottom)
    this.precip.draw(f)
  }

  private disposePrecip(): void {
    this.precip?.dispose()
    this.precip = null
  }
}

/** The same place, clock and weather: nothing for a blend to show. */
function sameSource(a: SkySource, b: SkySource): boolean {
  if (a.latitude !== b.latitude || a.longitude !== b.longitude || a.minuteOfDay !== b.minuteOfDay) return false
  if (a.weather === b.weather) return true
  return (Object.keys(b.weather) as Array<keyof SkyWeather>).every((k) => a.weather[k] === b.weather[k])
}

/** Two scenes no one could tell apart. */
function scenesClose(a: SkyScene, b: SkyScene): boolean {
  return (Object.keys(b) as Array<keyof SkyScene>).every((k) => {
    const x = a[k]
    const y = b[k]
    return typeof y === 'number' ? Math.abs((x as number) - y) < 1e-3 : sameRgb(x as Rgb, y)
  })
}

function sameRgb(a: Rgb, b: Rgb): boolean {
  return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3
}
