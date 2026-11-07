// @vitest-environment jsdom
/**
 * Crisp rain and snow (sky-precip.ts): a full-resolution canvas of their own,
 * drawn by the SkyController's loop. With the sky's GL stubbed and a fake
 * WebGL context for the precipitation canvas: it exists only while something
 * falls (no canvas, no context otherwise) and goes when it stops; it moves,
 * freezes and resumes with the sky's one loop and the activity store; the
 * count follows the intensity, the lean the wind; the wash lowers it; it
 * disposes cleanly. And the quarter-resolution sky shader no longer draws
 * any precipitation of its own.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALM_MS, createSkyActivity, type SkyActivity } from '@/lib/sky/sky-activity'
import { CLEAR_SKY, type SkyWeather } from '@/lib/sky/weather'
import { SKY_PRESETS } from '@/lib/sky/dev-override'
import { computeSkyScene } from '@/lib/sky/scene'

const skyGl = vi.hoisted(() => ({
  init: vi.fn(() => true),
  isLost: vi.fn(() => false),
  draw: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('../sky-gl', () => ({ SkyGL: { create: vi.fn(() => skyGl) } }))

import { SkyController, type SkySource } from '../sky-controller'
import {
  PRECIP_MAX_PARTICLES,
  RAIN_SLANT,
  SNOW_SLANT,
  buildPrecipBuffer,
  isFalling,
  rainCount,
  snowCount,
} from '../sky-precip'
import { SKY_FRAGMENT } from '../sky-shader'

// ── A fake WebGL context for the precipitation canvas ───────────────────────
interface Call {
  name: string
  args: unknown[]
}
function fakeGl() {
  const calls: Call[] = []
  const loseContext = vi.fn()
  const base: Record<string, unknown> = {
    isContextLost: () => false,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: (_p: unknown, name: string) => (name === 'aCorner' ? 0 : 1),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
  }
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop in target) return target[prop]
      // Constants (TRIANGLES, COLOR_BUFFER_BIT…) as their names.
      if (/^[A-Z0-9_]+$/.test(prop)) return prop
      return (...args: unknown[]) => {
        calls.push({ name: prop, args })
        return { id: calls.length }
      }
    },
  })
  return { ctx, calls, loseContext }
}

let gls: ReturnType<typeof fakeGl>[] = []
const lastGl = () => gls.at(-1)!

/** The values each draw last set for a uniform, in order. */
function uniformValues(g: ReturnType<typeof fakeGl>, name: string): number[][] {
  return g.calls.filter((c) => c.name.startsWith('uniform') && (c.args[0] as { name: string }).name === name).map((c) => c.args.slice(1) as number[])
}
const drawCounts = (g: ReturnType<typeof fakeGl>) => g.calls.filter((c) => c.name === 'drawArrays').map((c) => c.args[2] as number)

// ── A fake requestAnimationFrame ────────────────────────────────────────────
let rafs = new Map<number, FrameRequestCallback>()
let nextRaf = 1
let maxPending = 0
function flushRaf(): void {
  const due = [...rafs]
  rafs = new Map()
  for (const [, cb] of due) cb(performance.now())
}
function play(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    vi.advanceTimersByTime(16)
    flushRaf()
  }
}

const source = (weather: SkyWeather): SkySource => ({ weather, latitude: 40.71, longitude: -74.01, minuteOfDay: 15 * 60 })
let canvas: HTMLCanvasElement
let host: HTMLDivElement
let controller: SkyController | null = null

function mount(activity: SkyActivity, weather: SkyWeather, wash: readonly [number, number] = [0, 0]): SkyController {
  controller = new SkyController({ canvas, activity, source: source(weather), onFallback: () => {}, precipHost: host, wash })
  return controller
}

const precipCanvas = () => host.querySelector<HTMLCanvasElement>('canvas[data-sky-precip]')

describe('crisp precipitation layer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    rafs = new Map()
    nextRaf = 1
    maxPending = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRaf++
      rafs.set(id, cb)
      maxPending = Math.max(maxPending, rafs.size)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => rafs.delete(id))
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    skyGl.draw.mockReset()
    gls = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const g = fakeGl()
      gls.push(g)
      return g.ctx as unknown as RenderingContext
    } as unknown as HTMLCanvasElement['getContext'])
    const parent = document.createElement('div')
    canvas = document.createElement('canvas')
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 1440 })
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 900 })
    host = document.createElement('div')
    parent.append(canvas, host)
    document.body.appendChild(parent)
  })

  afterEach(() => {
    controller?.dispose()
    controller = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('mounts only while something is falling, and unmounts when it stops', () => {
    const activity = createSkyActivity()
    mount(activity, SKY_PRESETS.cloudy)
    play(CALM_MS + 1_000)
    // Clear or cloudy: no canvas, no context, nothing drawn for it.
    expect(precipCanvas()).toBeNull()
    expect(gls).toHaveLength(0)

    // The dev preview switches rain on (a snap draws at once, frozen or not).
    controller!.setSource(source(SKY_PRESETS.rain), { snap: true })
    play(100)
    const layer = precipCanvas()
    expect(layer).not.toBeNull()
    expect(gls).toHaveLength(1)
    // Full resolution: CSS size × devicePixelRatio (2).
    expect([layer!.width, layer!.height]).toEqual([2880, 1800])

    // …and off again: the canvas leaves the page and its context goes back.
    const g = lastGl()
    controller!.setSource(source(SKY_PRESETS.overcast), { snap: true })
    play(100)
    expect(precipCanvas()).toBeNull()
    expect(host.childElementCount).toBe(0)
    expect(g.loseContext).toHaveBeenCalledTimes(1)
    expect(g.calls.some((c) => c.name === 'deleteBuffer')).toBe(true)
    expect(g.calls.some((c) => c.name === 'deleteProgram')).toBe(true)
  })

  it('caps the canvas at 2 device pixels per CSS pixel', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
    mount(createSkyActivity(), SKY_PRESETS.snow)
    expect([precipCanvas()!.width, precipCanvas()!.height]).toEqual([2880, 1800])
  })

  it('a blend fades it in and out with the scene: made when the rain starts, gone when it ends', () => {
    const activity = createSkyActivity()
    mount(activity, SKY_PRESETS.cloudy)
    play(CALM_MS + 500)
    controller!.setSource(source(SKY_PRESETS.rain))
    play(3_000)
    expect(precipCanvas()).not.toBeNull()
    controller!.setSource(source(SKY_PRESETS.cloudy))
    play(3_000)
    expect(precipCanvas()).toBeNull()
  })

  it('moves with the sky’s one loop and freezes with the activity store, keeping its last frame', () => {
    const activity = createSkyActivity()
    mount(activity, SKY_PRESETS.rain)
    const g = lastGl()
    play(CALM_MS + 2_000)
    // Drawn in the same frames as the sky: one loop, no rAF of its own.
    expect(maxPending).toBe(1)
    const times = uniformValues(g, 'uTime')
    expect(times.length).toBeGreaterThan(20)
    expect(times.length).toBe(skyGl.draw.mock.calls.length)
    expect(times.at(-1)![0]).toBeGreaterThan(times[0][0])

    // A click glides it to a stop (on the same loop), then no frame at all;
    // the canvas keeps the last one.
    activity.markActive()
    play(1_200)
    const frozenAt = uniformValues(g, 'uTime').length
    play(CALM_MS - 1_500)
    expect(uniformValues(g, 'uTime')).toHaveLength(frozenAt)
    expect(rafs.size).toBe(0)
    expect(precipCanvas()).not.toBeNull()

    // Calm again: it resumes from where it stopped.
    play(1_500)
    const after = uniformValues(g, 'uTime')
    expect(after.length).toBeGreaterThan(frozenAt)
    expect(after.at(-1)![0]).toBeGreaterThan(times.at(-1)![0])
    expect(maxPending).toBe(1)
  })

  it('a hold (reduced motion, a hidden page) leaves a static frame and no loop', () => {
    const activity = createSkyActivity()
    // A named hold, as reduced motion or a hidden page sets one.
    activity.setHold('test-hold', true)
    mount(activity, SKY_PRESETS.snow)
    const g = lastGl()
    const drawn = drawCounts(g).length
    expect(drawn).toBeGreaterThan(0)
    play(CALM_MS * 3)
    expect(drawCounts(g)).toHaveLength(drawn)
    expect(rafs.size).toBe(0)
  })

  it('draws more with more intensity, both kinds for sleet, and leans with the wind', () => {
    mount(createSkyActivity(), { ...SKY_PRESETS.rain, precipIntensity: 0.35 })
    const light = drawCounts(lastGl()).at(-1)!
    controller!.setSource(source({ ...SKY_PRESETS.rain, precipIntensity: 0.7 }), { snap: true })
    const heavy = drawCounts(lastGl()).at(-1)!
    expect(light).toBe(rainCount(1, 0.35, 1440, 900) * 6)
    expect(heavy).toBe(rainCount(1, 0.7, 1440, 900) * 6)
    expect(heavy / light).toBeCloseTo(2, 1)

    // The lean: the scene's, from the same wind the clouds drift with.
    const scene = computeSkyScene({ date: new Date(), latitude: 40.71, longitude: -74.01, weather: SKY_PRESETS.rain, dark: false })
    expect(scene.rainLean).not.toBe(0)
    expect(uniformValues(lastGl(), 'uLean').at(-1)![0]).toBeCloseTo(scene.rainLean * RAIN_SLANT, 6)

    controller!.setSource(source(SKY_PRESETS.sleet), { snap: true })
    const g = lastGl()
    const n = drawCounts(g).length
    // Sleet: snow then rain, two draws in one frame.
    expect(drawCounts(g).slice(n - 2)).toEqual([snowCount(3, 0.6, 1440, 900) * 6, rainCount(3, 0.6, 1440, 900) * 6])
    const leans = uniformValues(g, 'uLean').slice(-2).map((v) => v[0])
    const sleet = computeSkyScene({ date: new Date(), latitude: 40.71, longitude: -74.01, weather: SKY_PRESETS.sleet, dark: false })
    expect(leans[0]).toBeCloseTo(sleet.rainLean * SNOW_SLANT, 6)
    expect(leans[1]).toBeCloseTo(sleet.rainLean * RAIN_SLANT, 6)
  })

  it('the signed-out pages’ wash lowers it like the sky', () => {
    mount(createSkyActivity(), SKY_PRESETS.rain)
    const plain = uniformValues(lastGl(), 'uAlpha').at(-1)![0]
    controller!.dispose()
    mount(createSkyActivity(), SKY_PRESETS.rain, [0.5, 0.5])
    expect(uniformValues(lastGl(), 'uAlpha').at(-1)![0]).toBeCloseTo(plain * 0.5, 6)
  })

  it('disposes with the controller: canvas removed, GL objects deleted, context handed back', () => {
    mount(createSkyActivity(), SKY_PRESETS.storm)
    const g = lastGl()
    expect(precipCanvas()).not.toBeNull()
    controller!.dispose()
    controller = null
    expect(host.childElementCount).toBe(0)
    expect(g.loseContext).toHaveBeenCalledTimes(1)
    expect(g.calls.filter((c) => c.name === 'deleteBuffer')).toHaveLength(1)
    expect(g.calls.filter((c) => c.name === 'deleteProgram')).toHaveLength(1)
  })

  it('without WebGL it leaves nothing behind and does not retry every frame', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => null)
    const activity = createSkyActivity()
    mount(activity, SKY_PRESETS.rain)
    play(CALM_MS + 1_000)
    expect(precipCanvas()).toBeNull()
    expect(vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length).toBe(1)
  })

  it('no precipitation host: nothing is drawn', () => {
    controller = new SkyController({ canvas, activity: createSkyActivity(), source: source(SKY_PRESETS.rain), onFallback: () => {} })
    expect(gls).toHaveLength(0)
  })
})

describe('precipitation counts and buffer', () => {
  it('scales the count with intensity and window area, by kind, capped', () => {
    expect(rainCount(0, 1, 1440, 900)).toBe(0)
    expect(rainCount(2, 1, 1440, 900)).toBe(0)
    expect(snowCount(1, 1, 1440, 900)).toBe(0)
    expect(rainCount(1, 0, 1440, 900)).toBe(0)
    expect(rainCount(1, 1, 1440, 900)).toBeGreaterThan(300)
    expect(rainCount(1, 1, 1440, 900)).toBeLessThan(500)
    expect(Math.abs(rainCount(1, 0.5, 1440, 900) - rainCount(1, 1, 1440, 900) / 2)).toBeLessThanOrEqual(1)
    expect(rainCount(1, 1, 2880, 900)).toBeCloseTo(rainCount(1, 1, 1440, 900) * 2, -1)
    expect(rainCount(3, 1, 1440, 900)).toBeLessThan(rainCount(1, 1, 1440, 900))
    expect(snowCount(3, 1, 1440, 900)).toBeGreaterThan(0)
    expect(rainCount(1, 1, 7680, 4320)).toBe(PRECIP_MAX_PARTICLES)
  })

  it('is falling only with a kind and an intensity', () => {
    expect(isFalling({ precipKind: 1, precipIntensity: 0.4 })).toBe(true)
    expect(isFalling({ precipKind: 1, precipIntensity: 0 })).toBe(false)
    expect(isFalling({ precipKind: 0, precipIntensity: 0.4 })).toBe(false)
  })

  it('builds one static buffer: six vertices per particle, each with its corner and the particle’s seed', () => {
    let i = 0
    const data = buildPrecipBuffer(2, () => (++i % 10) / 10)
    expect(data).toHaveLength(2 * 6 * 6)
    // The same seed on all six vertices of a particle.
    for (let v = 1; v < 6; v++) expect(Array.from(data.slice(v * 6 + 2, v * 6 + 6))).toEqual(Array.from(data.slice(2, 6)))
  })
})

describe('the sky shader', () => {
  it('no longer draws rain or snow (the crisp layer does), and the sky no longer sends them', () => {
    expect(SKY_FRAGMENT).not.toMatch(/uPrecip/)
    expect(SKY_FRAGMENT).not.toMatch(/flakes/)
    const glSource = readFileSync(join(__dirname, '..', 'sky-gl.ts'), 'utf8')
    expect(glSource).not.toMatch(/uPrecip|precipKind|precipIntensity/)
    // The storm's darkening stays in the sky.
    expect(SKY_FRAGMENT).toMatch(/uStorm \* 0\.15/)
    expect(CLEAR_SKY.precip).toBe('none')
  })
})
