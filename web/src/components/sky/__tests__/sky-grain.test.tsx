// @vitest-environment jsdom
/**
 * The photographic grain over the sky: a static CSS layer (never in the
 * quarter-resolution shader), over the canvas and over the no-WebGL fallback
 * gradient, under the UI, at a barely-there opacity, with nothing animated.
 * The signed-out pages lay one over their whole mount (gradients and canvas)
 * and turn the canvas's own off, so it is never doubled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { SKY_PRESETS } from '@/lib/sky/dev-override'
import { computeSkyScene, type SkyScene } from '@/lib/sky/scene'
import type { Rgb } from '@/lib/sky/palette'
import { SKY_FRAGMENT } from '../sky-shader'
import { SKY_GRAIN_IMAGE, SKY_GRAIN_OPACITY, SkyGrain } from '../sky-grain'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Options = { onFallback: (scene: SkyScene | null, surface: Rgb) => void }
const ctl = vi.hoisted(() => ({ options: [] as unknown[] }))

vi.mock('../sky-controller', () => ({
  SkyController: class {
    constructor(options: unknown) {
      ctl.options.push(options)
    }
    setSource = () => {}
    setBackground = () => {}
    dispose = () => {}
  },
}))

const NOW = Date.parse('2026-10-10T22:40:00Z')

let root: Root
let host: HTMLDivElement

function grainOf(el: ParentNode): HTMLDivElement[] {
  return Array.from(el.querySelectorAll<HTMLDivElement>('[data-sky-grain]'))
}

function follows(a: Element, b: Element): boolean {
  return Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('SkyGrain', () => {
  it('is static: no animation or transition, a fixed tiling image, a soft blend, no pointer events', () => {
    const html = renderToString(h(SkyGrain))
    expect(html).not.toMatch(/animation|transition|animate-|@keyframes/)
    expect(html).toContain('mix-blend-mode:soft-light')
    expect(html).toContain('pointer-events-none')
    expect(html).toContain('background-repeat:repeat')
    // A small inline noise tile (feTurbulence), no network fetch.
    expect(SKY_GRAIN_IMAGE.startsWith('url("data:image/svg+xml,')).toBe(true)
    expect(decodeURIComponent(SKY_GRAIN_IMAGE)).toContain('feTurbulence')
    expect(SKY_GRAIN_IMAGE.length).toBeLessThan(2000)
  })

  it('has a bounded, barely-there opacity per theme, spelled the same in its class', () => {
    for (const o of [SKY_GRAIN_OPACITY.light, SKY_GRAIN_OPACITY.dark]) {
      expect(o).toBeGreaterThanOrEqual(0.03)
      expect(o).toBeLessThanOrEqual(0.06)
    }
    expect(SKY_GRAIN_OPACITY.dark).toBeLessThanOrEqual(SKY_GRAIN_OPACITY.light)
    // Both skies follow the dark theme (the app's exposed for the dark), so
    // the grain takes the dark theme's opacity there too.
    const html = renderToString(h(SkyGrain))
    expect(html).toContain(`opacity-[${SKY_GRAIN_OPACITY.light}]`)
    expect(html).toContain(`dark:opacity-[${SKY_GRAIN_OPACITY.dark}]`)
  })

  it('is not in the quarter-resolution shader (it would upscale into blotches)', () => {
    expect(SKY_FRAGMENT).not.toMatch(/grain/i)
  })
})

describe('SkyCanvas grain', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    ctl.options = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function mountCanvas(props: Record<string, unknown> = {}) {
    vi.resetModules()
    const state = await import('@/lib/sky/sky-state')
    const { SkyCanvas } = await import('../sky-canvas')
    act(() => root.render(h(SkyCanvas, props)))
    act(() =>
      state.receiveSkyResponse({ location: { lat: 40.7, lon: -74 }, country: 'US', weather: SKY_PRESETS.clear, fetchedAt: new Date(NOW).toISOString() }),
    )
    return host.querySelector<HTMLDivElement>('[data-sky-layer]')!
  }

  it('lays one grain layer over the canvas, inside the sky layer (under the UI)', async () => {
    const layer = await mountCanvas()
    const grains = grainOf(layer)
    expect(grains).toHaveLength(1)
    expect(follows(grains[0], layer.querySelector('canvas')!)).toBe(true)
  })

  it('lays it over the no-WebGL fallback gradient too', async () => {
    const layer = await mountCanvas()
    expect(ctl.options).toHaveLength(1)
    const scene = computeSkyScene({ date: new Date(NOW), latitude: 40.7, longitude: -74, weather: SKY_PRESETS.clear, dark: false })
    act(() => (ctl.options[0] as Options).onFallback(scene, [1, 1, 1]))
    const fallback = Array.from(layer.querySelectorAll<HTMLDivElement>('div')).find((d) => d.style.background.includes('linear-gradient'))
    expect(fallback).toBeTruthy()
    const grains = grainOf(layer)
    expect(grains).toHaveLength(1)
    expect(follows(grains[0], fallback!)).toBe(true)
  })

  it('can be turned off (the public mount lays its own)', async () => {
    const layer = await mountCanvas({ grain: false })
    expect(grainOf(layer)).toHaveLength(0)
  })
})

describe('MarketingSky grain', () => {
  it('server-renders one grain layer over the static gradients, from the first paint', async () => {
    vi.resetModules()
    const { MarketingSky } = await import('../marketing-sky')
    const html = renderToString(h(MarketingSky))
    const grainAt = html.indexOf('data-sky-grain')
    expect(grainAt).toBeGreaterThan(0)
    expect(html.indexOf('data-sky-grain', grainAt + 1)).toBe(-1)
    // After (over) both gradient layers.
    expect(grainAt).toBeGreaterThan(html.lastIndexOf('--sky-light'))
  })

  it('passes grain={false} to the canvas it loads, so the mount has exactly one', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.resolve(__dirname, '../marketing-sky.tsx'), 'utf8')
    expect(src).toMatch(/<Canvas [^>]*grain=\{false\}/)
    // Text sits right on the sky here: it dims with the dark theme (the app's is exposed for the dark instead).
    expect(src).toMatch(/<Canvas [^>]*\bthemed\b/)
    // The mount's own grain is its last layer: over the gradients and the canvas.
    expect(src).toMatch(/<Canvas [^\n]*\n\s*<SkyGrain \/>\n\s*<\/div>/)
  })
})
