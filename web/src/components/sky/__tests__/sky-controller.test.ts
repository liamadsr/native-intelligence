// @vitest-environment jsdom
/**
 * The SkyController's loop guarantees, with a fake requestAnimationFrame,
 * fake timers and a stubbed GL wrapper: frozen means no rAF and no frame
 * timer pending and no frame drawn; a hold flipping inside a frame never
 * leaves two loops; the calm run's cap eases the loop to a stop and the next
 * activity starts it again; a lost context stops it, and a restore draws once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALM_MS, MAX_CALM_RUN_MS, createSkyActivity, type SkyActivity } from '@/lib/sky/sky-activity'
import { CLEAR_SKY } from '@/lib/sky/weather'
import { SKY_PRESETS, applyOverrideTime } from '@/lib/sky/dev-override'
import { computeSkyScene, type SkyScene } from '@/lib/sky/scene'
import { CLOSEUP_FRONT_SPEED, CLOUD_DRIFT } from '@/lib/sky/cloud-closeup'

const gl = vi.hoisted(() => ({
  lost: false,
  init: vi.fn(() => true),
  isLost: vi.fn((): boolean => false),
  draw: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../sky-gl', () => ({ SkyGL: { create: vi.fn(() => gl) } }))

import { BLEND_MS, FRAME_MS_BACKGROUND, FRAME_MS_CALM, FRAME_MS_PRECIP, SkyController, type SkySource } from '../sky-controller'

const EASE_MS = 1_500
/** A display frame. */
const VSYNC = 16

// ── A fake requestAnimationFrame: callbacks wait until flushed ──────────────
let rafs = new Map<number, FrameRequestCallback>()
let nextRaf = 1
let maxPending = 0
const cancelSpy = vi.fn()

function flushRaf(): void {
  const due = [...rafs]
  rafs = new Map()
  for (const [, cb] of due) cb(performance.now())
}

/** Let `ms` pass a display frame at a time, servicing rAF like a browser. */
function play(ms: number): void {
  for (let t = 0; t < ms; t += VSYNC) {
    vi.advanceTimersByTime(VSYNC)
    flushRaf()
  }
}

const source = (weather = CLEAR_SKY): SkySource => ({ weather, latitude: 43.65, longitude: -79.38, minuteOfDay: 12 * 60 })

let canvas: HTMLCanvasElement
let controller: SkyController | null = null

function mount(activity: SkyActivity, weather = CLEAR_SKY): SkyController {
  controller = new SkyController({ canvas, activity, source: source(weather), onFallback: () => {} })
  return controller
}

describe('SkyController', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    rafs = new Map()
    nextRaf = 1
    maxPending = 0
    cancelSpy.mockClear()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRaf++
      rafs.set(id, cb)
      maxPending = Math.max(maxPending, rafs.size)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelSpy(id)
      rafs.delete(id)
    })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    gl.lost = false
    gl.isLost.mockImplementation(() => gl.lost)
    gl.init.mockClear()
    gl.draw.mockReset()
    gl.dispose.mockClear()
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    controller?.dispose()
    controller = null
    canvas.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('input glides the drift to a stop in about a second, then nothing runs; a hidden page stops it at once', () => {
    const activity = createSkyActivity()
    mount(activity)
    vi.advanceTimersByTime(CALM_MS)
    play(3_000)
    const timeOf = () => (gl.draw.mock.calls.at(-1)![2] as { time: number }).time

    // Input: the drift slows (each frame's step smaller than the last), then stops.
    activity.markActive()
    const steps: number[] = []
    let prev = timeOf()
    for (let i = 0; i < 8; i++) {
      play(100)
      const now = timeOf()
      steps.push(now - prev)
      prev = now
    }
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-9)
    expect(steps[0]).toBeGreaterThan(0)
    play(400)
    expect(rafs.size).toBe(0)
    const draws = gl.draw.mock.calls.length
    // (play rounds each call up to whole display frames: stay short of the calm spell.)
    play(400)
    expect(gl.draw.mock.calls.length).toBe(draws)

    // Moving again; a hidden page stops it at once, nothing pending.
    play(CALM_MS)
    play(2_000)
    activity.setHold('hidden', true)
    expect(rafs.size).toBe(0)
    const hiddenDraws = gl.draw.mock.calls.length
    play(1_000)
    expect(gl.draw.mock.calls.length).toBe(hiddenDraws)
  })

  it('a hold that flips inside a frame never leaves two loops', () => {
    let canMove = false
    const listeners = new Set<() => void>()
    const emit = () => listeners.forEach((l) => l())
    const activity = {
      canMove: () => canMove,
      isResting: () => false,
      isCalm: () => canMove,
      holds: () => (canMove ? [] : ['stream']),
      isChatEmpty: () => false,
      setChatEmpty: () => {},
      setHold: () => {},
      markActive: () => {},
      subscribe: (l: () => void) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      attach: () => () => {},
    } as unknown as SkyActivity
    mount(activity)
    canMove = true
    emit()
    play(500)

    // The next frame's draw sees a hold go on and off before the frame ends.
    gl.draw.mockImplementationOnce(() => {
      canMove = false
      emit()
      canMove = true
      emit()
    })
    play(2_000)
    expect(maxPending).toBe(1)
    // One loop: the calm rate, not double that.
    const before = gl.draw.mock.calls.length
    play(1_000)
    expect(gl.draw.mock.calls.length - before).toBeLessThanOrEqual(Math.ceil(1_000 / FRAME_MS_CALM) + 1)
  })

  it('a hold set and released inside a frame (the real store) leaves no loop', () => {
    const activity = createSkyActivity()
    mount(activity)
    vi.advanceTimersByTime(CALM_MS)
    gl.draw.mockImplementationOnce(() => {
      activity.setHold('stream', true)
      activity.setHold('stream', false)
    })
    flushRaf()
    // Released inside the frame: that counts as input, so the drift glides
    // to a stop on the one loop, and then nothing runs.
    play(1_300)
    expect(maxPending).toBeLessThanOrEqual(1)
    expect(rafs.size).toBe(0)
    const draws = gl.draw.mock.calls.length
    play(CALM_MS - 1_300 - VSYNC * 2)
    expect(gl.draw.mock.calls.length).toBe(draws)
  })

  it('draws ~20 fps for clouds alone and ~30 fps while something is falling', () => {
    const calm = createSkyActivity()
    mount(calm)
    vi.advanceTimersByTime(CALM_MS)
    play(500)
    let before = gl.draw.mock.calls.length
    play(1_000)
    const cloudsOnly = gl.draw.mock.calls.length - before
    expect(cloudsOnly).toBeGreaterThanOrEqual(Math.floor(1_000 / FRAME_MS_CALM) - 2)
    expect(cloudsOnly).toBeLessThanOrEqual(Math.ceil(1_000 / FRAME_MS_CALM) + 1)

    controller!.setSource(source(SKY_PRESETS.rain))
    // The rain blends in first (BLEND_MS); measure once it has.
    play(BLEND_MS + 500)
    before = gl.draw.mock.calls.length
    play(1_000)
    const raining = gl.draw.mock.calls.length - before
    // Display frames quantize the timer (a 16 ms vsync here), so ~20–24.
    expect(raining).toBeGreaterThanOrEqual(cloudsOnly + 4)
    expect(raining).toBeLessThanOrEqual(Math.ceil(1_000 / FRAME_MS_PRECIP) + 1)
  })

  it('another app in front keeps it moving, at ~10 fps (no freeze), and back in front it is ~15 fps again', () => {
    const calm = createSkyActivity()
    mount(calm)
    vi.advanceTimersByTime(CALM_MS)
    play(500)
    controller!.setBackground(true)
    play(300)
    let before = gl.draw.mock.calls.length
    play(1_000)
    const behind = gl.draw.mock.calls.length - before
    expect(behind).toBeGreaterThanOrEqual(Math.floor(1_000 / FRAME_MS_BACKGROUND) - 2)
    expect(behind).toBeLessThanOrEqual(Math.ceil(1_000 / FRAME_MS_BACKGROUND) + 1)
    controller!.setBackground(false)
    play(300)
    before = gl.draw.mock.calls.length
    play(1_000)
    expect(gl.draw.mock.calls.length - before).toBeGreaterThan(behind)
  })

  it('a calm store with nothing holding it runs frames and visibly drifts the clouds over 10 s', () => {
    const activity = createSkyActivity()
    // A moderate westerly with some cloud: straight across the view.
    mount(activity, { ...CLEAR_SKY, cloudCover: 0.5, windSpeedMs: 5, windFromDeg: 270 })
    // Still for the calm spell: the loop starts on its own, nothing holds it.
    vi.advanceTimersByTime(CALM_MS)
    expect(activity.canMove()).toBe(true)
    expect(activity.holds()).toEqual([])
    expect(rafs.size).toBe(1)
    type Frame = { cloudX: number; cloudY: number; time: number }
    const last = () => gl.draw.mock.calls.at(-1)![2] as Frame
    const start = last()
    const drawsBefore = gl.draw.mock.calls.length

    play(10_000)

    // Frames at the calm rate the whole time (the first 1.5 s easing in),
    // each landing on the display frame after its timer (16 ms here).
    const frameMs = Math.ceil((FRAME_MS_CALM - 4) / VSYNC) * VSYNC
    expect(gl.draw.mock.calls.length - drawsBefore).toBeGreaterThanOrEqual(Math.floor(10_000 / frameMs) - 10)
    const end = last()
    expect(end.time - start.time).toBeGreaterThan(8)
    // The drift uniform moved straight across the layer…
    expect(Math.abs(end.cloudY - start.cloudY)).toBeLessThan(1e-6)
    // …by a visible amount: the near cloud, on a 900 px tall window, well
    // over a hundred pixels in ten seconds.
    const moved = Math.abs(end.cloudX - start.cloudX) * CLOUD_DRIFT * CLOSEUP_FRONT_SPEED
    expect(moved * 900).toBeGreaterThan(100)
  })

  it('the calm run cap eases the loop to a stop, and the next activity starts it again', () => {
    const activity = createSkyActivity()
    mount(activity)
    vi.advanceTimersByTime(CALM_MS)
    play(MAX_CALM_RUN_MS - 200)
    expect(activity.canMove()).toBe(true)
    const step = (call: unknown[]) => (call[2] as { time: number }).time
    const atCap = gl.draw.mock.calls.length
    play(400)
    expect(activity.isResting()).toBe(true)

    // Still drawing while it eases out, each step smaller than the one before the cap.
    const fullStep = step(gl.draw.mock.calls[atCap - 1]) - step(gl.draw.mock.calls[atCap - 2])
    play(EASE_MS)
    const calls = gl.draw.mock.calls
    const lateStep = step(calls[calls.length - 1]) - step(calls[calls.length - 2])
    expect(lateStep).toBeLessThan(fullStep / 4)

    // Then nothing: no rAF, no frame, however long it stays still.
    play(200)
    const rested = gl.draw.mock.calls.length
    expect(rafs.size).toBe(0)
    play(10_000)
    expect(gl.draw.mock.calls.length).toBe(rested)

    // Input, then a calm spell: it moves again.
    activity.markActive()
    expect(rafs.size).toBe(0)
    play(CALM_MS + 500)
    expect(gl.draw.mock.calls.length).toBeGreaterThan(rested)
    expect(activity.canMove()).toBe(true)
  })

  it('input during the glide to rest keeps gliding to a stop, then nothing runs', () => {
    const activity = createSkyActivity()
    mount(activity)
    vi.advanceTimersByTime(CALM_MS)
    play(MAX_CALM_RUN_MS + 100)
    expect(activity.isResting()).toBe(true)
    activity.markActive()
    play(1_300)
    expect(rafs.size).toBe(0)
    const draws = gl.draw.mock.calls.length
    play(CALM_MS - 1_300 - VSYNC * 2)
    expect(gl.draw.mock.calls.length).toBe(draws)
  })

  it('a lost context stops the loop, and a restore draws once', () => {
    const activity = createSkyActivity()
    mount(activity)
    vi.advanceTimersByTime(CALM_MS)
    play(500)

    gl.lost = true
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(rafs.size).toBe(0)
    const lostDraws = gl.draw.mock.calls.length
    play(2_000)
    expect(gl.draw.mock.calls.length).toBe(lostDraws)

    // Restored while frozen: one static frame and no loop.
    activity.markActive()
    gl.lost = false
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(gl.init).toHaveBeenCalledTimes(1)
    expect(gl.draw.mock.calls.length).toBe(lostDraws + 1)
    expect(rafs.size).toBe(0)
    play(CALM_MS - VSYNC * 2)
    expect(gl.draw.mock.calls.length).toBe(lostDraws + 1)

    // Calm again: the loop is back.
    play(500)
    expect(gl.draw.mock.calls.length).toBeGreaterThan(lostDraws + 1)
  })

  it('restored while calm draws once at once, then resumes the loop', () => {
    const activity = createSkyActivity()
    mount(activity)
    vi.advanceTimersByTime(CALM_MS)
    play(500)
    gl.lost = true
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    const lostDraws = gl.draw.mock.calls.length
    gl.lost = false
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(gl.draw.mock.calls.length).toBe(lostDraws + 1)
    expect(rafs.size).toBe(1)
  })

  it('dispose leaves nothing pending', () => {
    const activity = createSkyActivity()
    mount(activity)
    vi.advanceTimersByTime(CALM_MS)
    play(300)
    controller!.dispose()
    controller = null
    expect(rafs.size).toBe(0)
    const draws = gl.draw.mock.calls.length
    play(1_000)
    expect(gl.draw.mock.calls.length).toBe(draws)
    expect(vi.getTimerCount()).toBe(0)
  })
  describe('blend', () => {
    const sceneOf = (call: unknown[]) => (call[2] as { scene: SkyScene }).scene
    const lastScene = () => sceneOf(gl.draw.mock.calls[gl.draw.mock.calls.length - 1])
    const target = (weather = SKY_PRESETS.rain) =>
      computeSkyScene({ date: applyOverrideTime(new Date(), 12 * 60), latitude: 43.65, longitude: -79.38, weather, dark: false })

    it('frozen: eases to the new weather over BLEND_MS on its own short loop, then stops', () => {
      const activity = createSkyActivity()
      activity.setHold('stream', true)
      mount(activity)
      const start = lastScene()
      const draws = gl.draw.mock.calls.length
      controller!.setSource(source(SKY_PRESETS.rain))
      expect(rafs.size).toBe(1)

      play(BLEND_MS / 2)
      const mid = lastScene().cloudCover
      expect(mid).toBeGreaterThan(start.cloudCover + 0.05)
      expect(mid).toBeLessThan(target().cloudCover - 0.05)

      play(BLEND_MS / 2 + 200)
      expect(lastScene()).toEqual(target())
      expect(rafs.size).toBe(0)
      // A bounded loop at the calm rate: about BLEND_MS / FRAME_MS_CALM frames.
      const blendDraws = gl.draw.mock.calls.length - draws
      expect(blendDraws).toBeLessThanOrEqual(Math.ceil(BLEND_MS / FRAME_MS_CALM) + 3)

      // Then nothing.
      const done = gl.draw.mock.calls.length
      play(5_000)
      expect(gl.draw.mock.calls.length).toBe(done)
      expect(rafs.size).toBe(0)
    })

    it('with no frames at all (rAF never fires), it lands on the end state on time', () => {
      const activity = createSkyActivity()
      activity.setHold('stream', true)
      mount(activity)
      controller!.setSource(source(SKY_PRESETS.rain))
      expect(rafs.size).toBe(1)
      vi.advanceTimersByTime(BLEND_MS + 200)
      expect(lastScene()).toEqual(target())
      expect(rafs.size).toBe(0)
      const draws = gl.draw.mock.calls.length
      vi.advanceTimersByTime(5_000)
      expect(gl.draw.mock.calls.length).toBe(draws)
    })

    it('the same reading again does not blend (the fetch confirming the saved one)', () => {
      const activity = createSkyActivity()
      activity.setHold('stream', true)
      mount(activity)
      const draws = gl.draw.mock.calls.length
      controller!.setSource({ ...source(), weather: { ...CLEAR_SKY } })
      expect(rafs.size).toBe(0)
      expect(gl.draw.mock.calls.length).toBeLessThanOrEqual(draws + 1)
      expect(lastScene()).toEqual(target(CLEAR_SKY))
    })

    it('hidden: a new source snaps, with nothing pending', () => {
      const activity = createSkyActivity()
      activity.setHold('stream', true)
      mount(activity)
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      controller!.setSource(source(SKY_PRESETS.rain))
      expect(rafs.size).toBe(0)
      expect(lastScene()).toEqual(target())
    })

    it('while moving, the motion loop carries the blend: one loop, and it ends on the target', () => {
      const activity = createSkyActivity()
      mount(activity)
      vi.advanceTimersByTime(CALM_MS)
      play(500)
      controller!.setSource(source(SKY_PRESETS.rain))
      play(BLEND_MS + 200)
      expect(maxPending).toBe(1)
      expect(lastScene()).toEqual(target())
      // Still moving (calm), so the loop goes on; input glides it to a stop.
      activity.markActive()
      play(1_300)
      expect(rafs.size).toBe(0)
      const draws = gl.draw.mock.calls.length
      play(CALM_MS - 1_300 - VSYNC * 2)
      expect(gl.draw.mock.calls.length).toBe(draws)
    })

    it('input mid-blend stops the motion but the blend finishes, then nothing runs', () => {
      const activity = createSkyActivity()
      mount(activity)
      vi.advanceTimersByTime(CALM_MS)
      play(500)
      controller!.setSource(source(SKY_PRESETS.rain))
      play(600)
      activity.markActive()
      play(BLEND_MS)
      expect(lastScene()).toEqual(target())
      // The drift glided to a stop while the colours finished easing.
      const time = (gl.draw.mock.calls.at(-1)![2] as { time: number }).time
      expect(rafs.size).toBe(0)
      // Nothing more until the calm spell after the input is up.
      const draws = gl.draw.mock.calls.length
      play(CALM_MS - BLEND_MS - VSYNC * 4)
      expect(gl.draw.mock.calls.length).toBe(draws)
      expect((gl.draw.mock.calls.at(-1)![2] as { time: number }).time).toBe(time)
    })

    it('frozen, a snapped source (dev: the time slider mid-drag) draws once, at once, with nothing pending', () => {
      const activity = createSkyActivity()
      mount(activity)
      // Input: frozen, no loop.
      activity.markActive()
      expect(activity.canMove()).toBe(false)
      expect(rafs.size).toBe(0)
      const draws = gl.draw.mock.calls.length
      const at = (minuteOfDay: number) => ({ ...source(SKY_PRESETS.rain), minuteOfDay })
      controller!.setSource(at(18 * 60 + 40), { snap: true })
      expect(gl.draw.mock.calls.length).toBe(draws + 1)
      expect(rafs.size).toBe(0)
      expect(lastScene()).toEqual(
        computeSkyScene({ date: applyOverrideTime(new Date(), 18 * 60 + 40), latitude: 43.65, longitude: -79.38, weather: SKY_PRESETS.rain, dark: false }),
      )
      // Each step of the drag: one frame each, nothing left running.
      controller!.setSource(at(18 * 60 + 45), { snap: true })
      controller!.setSource(at(18 * 60 + 50), { snap: true })
      expect(gl.draw.mock.calls.length).toBe(draws + 3)
      play(CALM_MS - VSYNC * 4)
      expect(gl.draw.mock.calls.length).toBe(draws + 3)
    })

    it('a snap mid-blend ends the blend on the snapped scene', () => {
      const activity = createSkyActivity()
      activity.setHold('stream', true)
      mount(activity)
      controller!.setSource(source(SKY_PRESETS.rain))
      play(300)
      expect(rafs.size + vi.getTimerCount()).toBeGreaterThan(0)
      controller!.setSource(source(SKY_PRESETS.snow), { snap: true })
      expect(lastScene()).toEqual(target(SKY_PRESETS.snow))
      expect(rafs.size).toBe(0)
      const draws = gl.draw.mock.calls.length
      play(BLEND_MS)
      expect(gl.draw.mock.calls.length).toBe(draws)
      expect(lastScene()).toEqual(target(SKY_PRESETS.snow))
    })

    it('dispose mid-blend leaves nothing pending', () => {
      const activity = createSkyActivity()
      activity.setHold('stream', true)
      mount(activity)
      controller!.setSource(source(SKY_PRESETS.rain))
      play(300)
      controller!.dispose()
      controller = null
      expect(rafs.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('draws the weather\'s cirrus, and blends it in when high cloud arrives', () => {
      const activity = createSkyActivity()
      activity.setHold('stream', true)
      mount(activity)
      expect(lastScene().cirrus).toBe(0)
      controller!.setSource(source(SKY_PRESETS.cirrus))
      play(BLEND_MS / 2)
      const mid = lastScene()
      expect(mid.cirrus).toBeGreaterThan(0.05)
      expect(mid.cirrus).toBeLessThan(target(SKY_PRESETS.cirrus).cirrus - 0.05)
      play(BLEND_MS / 2 + 200)
      expect(lastScene().cirrus).toBeCloseTo(target(SKY_PRESETS.cirrus).cirrus)
      expect(lastScene().cirrus).toBeGreaterThan(0.8)
      // Thin cirrus never brings the dense cloud field in.
      expect(lastScene().cloudCover).toBe(0)
    })
  })
})
