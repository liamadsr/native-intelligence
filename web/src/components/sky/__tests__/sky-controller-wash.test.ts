// @vitest-environment jsdom
/**
 * The controller's wash (the signed-out pages): every drawn frame carries
 * the scene's own strength times (1 - wash) for the current theme, and every
 * other field of the scene unchanged; the mix is over the configured surface
 * variable. With no wash (the app) the scene is drawn as computed.
 *
 * The theme: a `themed` sky (the signed-out pages) dims in the dark theme; the
 * app's (not themed) is exposed for the dark instead (the scene's `dim`), over
 * the dark theme's surface, live as the theme flips.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSkyActivity } from '@/lib/sky/sky-activity'
import { SKY_PRESETS } from '@/lib/sky/dev-override'
import { WASHED_STRENGTH_CAP, computeSkyScene, type SkyScene } from '@/lib/sky/scene'

const gl = vi.hoisted(() => ({
  init: vi.fn(() => true),
  isLost: vi.fn((): boolean => false),
  draw: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../sky-gl', () => ({ SkyGL: { create: vi.fn(() => gl) } }))

import { SkyController, type SkyControllerOptions } from '../sky-controller'

let canvas: HTMLCanvasElement
let controller: SkyController | null = null

// Noon in New York on one fixed day (the clock is pinned below), not "12:00 wherever the
// runner is": the sky follows the real instant, so a set local hour gave another sky in
// UTC or Tokyo than here (a GitHub run in UTC failed on 2026-11-12).
const NOON_NEW_YORK = new Date('2026-06-15T16:00:00Z')
const source = { weather: SKY_PRESETS.fair, latitude: 40.7, longitude: -74, minuteOfDay: null }

function mount(extra: Partial<SkyControllerOptions> = {}): SkyController {
  controller = new SkyController({ canvas, activity: createSkyActivity(), source, onFallback: () => {}, ...extra })
  return controller
}

const lastFrame = () => gl.draw.mock.calls.at(-1)![2] as { scene: SkyScene; bg: readonly number[] }

/**
 * A washed strength as scene.ts's washedStrength makes it: the scene's own,
 * at most WASHED_STRENGTH_CAP, times (1 - wash). The cap counts whenever the
 * scene is stronger than a light day's: the scene follows the real date and
 * a light day can be stronger too, so the expectation is washedStrength's.
 */
const washedOf = (strength: number, wash: number) => Math.min(strength, WASHED_STRENGTH_CAP) * (1 - wash)

describe('SkyController wash', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    vi.setSystemTime(NOON_NEW_YORK)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    gl.draw.mockReset()
    canvas = document.createElement('canvas')
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => 400 })
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => 300 })
    document.body.appendChild(canvas)
    document.documentElement.classList.remove('dark')
    document.documentElement.style.setProperty('--sidebar-background', '0 0% 96%')
    document.documentElement.style.setProperty('--background', '0 0% 100%')
  })

  afterEach(() => {
    controller?.dispose()
    controller = null
    canvas.remove()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('style')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** The frame a controller draws first, in one theme, then gone. */
  function frameFor(dark: boolean, extra: Partial<SkyControllerOptions> = {}) {
    document.documentElement.classList.toggle('dark', dark)
    gl.draw.mockReset()
    mount(extra)
    const frame = lastFrame()
    controller!.dispose()
    controller = null
    return frame
  }

  it('lowers only the strength, by the theme’s wash, on every draw', () => {
    for (const [dark, wash] of [[false, 0.5], [true, 0.25]] as const) {
      const plain = frameFor(dark, { themed: true })
      const washed = frameFor(dark, { wash: [0.5, 0.25], surfaceVar: '--background', themed: true })
      expect(washed.scene.strength).toBeCloseTo(washedOf(plain.scene.strength, wash), 10)
      const { strength: _a, ...restWashed } = washed.scene
      const { strength: _b, ...restPlain } = plain.scene
      expect(restWashed).toEqual(restPlain)
    }
  })

  it('mixes over the configured surface variable', () => {
    expect(frameFor(false, { surfaceVar: '--background' }).bg).toEqual([1, 1, 1])
    expect(frameFor(false).bg[0]).toBeCloseTo(0.96, 2)
  })

  it('follows a theme change to the other wash', async () => {
    document.documentElement.classList.remove('dark')
    mount({ wash: [0.5, 0.25], surfaceVar: '--background', themed: true })
    const light = lastFrame().scene.strength
    document.documentElement.classList.add('dark')
    await Promise.resolve() // the MutationObserver's microtask
    const dark = lastFrame().scene.strength
    controller!.dispose()
    controller = null
    const plainDark = frameFor(true, { themed: true }).scene.strength
    expect(dark).toBeCloseTo(washedOf(plainDark, 0.25), 10)
    expect(dark).not.toBeCloseTo(light, 3)
  })

  it('without a wash draws the scene as computed (the app)', () => {
    mount()
    const a = lastFrame()
    expect(a.scene.strength).toBeGreaterThan(0.7)
  })

  /** The dark theme's own surface on <html>, as the theme script leaves it. */
  const darkPage = () => {
    document.documentElement.classList.add('dark')
    document.documentElement.style.setProperty('--sidebar-background', '0 0% 3%')
  }

  it('the app’s sky in the dark theme is the same weather exposed for the dark, over the dark surface', () => {
    const light = frameFor(false)
    darkPage()
    gl.draw.mockReset()
    mount()
    const dark = lastFrame()
    const at = new Date() // the pinned noon in New York
    const expected = computeSkyScene({ date: at, latitude: source.latitude, longitude: source.longitude, weather: source.weather, dark: false, dim: true })
    expect(dark.scene.top).toEqual(expected.top)
    expect(dark.scene.cloudLit).toEqual(expected.cloudLit)
    expect(dark.scene.strength).toBe(expected.strength)
    // Not the light sky, and not the signed-out pages' dimmed one.
    expect(dark.scene.top).not.toEqual(light.scene.top)
    expect(dark.bg[0]).toBeCloseTo(0.03, 2)
    controller!.dispose()
    gl.draw.mockReset()
    mount({ themed: true })
    expect(lastFrame().scene.top).not.toEqual(dark.scene.top)
    expect(lastFrame().bg[0]).toBeCloseTo(0.03, 2)
  })

  it('flipping the theme live moves the app’s sky to the dark exposure and back', async () => {
    mount()
    const before = lastFrame()
    darkPage()
    await Promise.resolve() // the MutationObserver's microtask
    const dark = lastFrame()
    expect(dark.scene.top).not.toEqual(before.scene.top)
    expect(dark.bg[0]).toBeCloseTo(0.03, 2)
    document.documentElement.classList.remove('dark')
    document.documentElement.style.setProperty('--sidebar-background', '0 0% 96%')
    await Promise.resolve()
    const back = lastFrame()
    expect(back.scene).toEqual(before.scene)
    expect(back.bg).toEqual(before.bg)
  })
})
