// @vitest-environment jsdom
/**
 * The signed-out pages' sky mount: a fixed, full-viewport layer under the
 * page with a static gradient from the first render; the WebGL code fetched
 * only after the window's `load` event and a timeout; never with reduced
 * motion or Save-Data; the feed on the public endpoint; and the controller
 * (its one WebGL context) disposed when the page unmounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctl = vi.hoisted(() => ({ created: 0, options: [] as unknown[], dispose: vi.fn() }))

vi.mock('../sky-controller', () => ({
  SkyController: class {
    constructor(options: unknown) {
      ctl.created++
      ctl.options.push(options)
    }
    setSource = () => {}
    setBackground = () => {}
    dispose = ctl.dispose
  },
}))

const NOW = Date.parse('2026-10-10T15:00:00Z')

let root: Root
let host: HTMLDivElement
let readyState: DocumentReadyState
let fetchMock: ReturnType<typeof vi.fn>
let reducedMotion = false

async function load() {
  vi.resetModules()
  // Warm the module cache, so the component's own dynamic import resolves in
  // a few microtasks (it still only starts after load + the timeout).
  await import('../sky-canvas')
  const mod = await import('../marketing-sky')
  const { MARKETING_SKY_LOAD_DELAY_MS } = await import('@/lib/sky/marketing-sky')
  return { ...mod, MARKETING_SKY_LOAD_DELAY_MS }
}

/** Let the dynamic import and the state updates after it settle. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('MarketingSky', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    ctl.created = 0
    ctl.options = []
    ctl.dispose.mockClear()
    reducedMotion = false
    readyState = 'loading'
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => readyState })
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce') ? reducedMotion : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (navigator as unknown as { connection?: unknown }).connection
  })

  it('server-renders a fixed full-viewport layer under the page with a static gradient and no canvas', async () => {
    const { MarketingSky } = await load()
    const html = renderToString(h(MarketingSky))
    expect(html).toContain('data-marketing-sky')
    expect(html).toMatch(/class="[^"]*pointer-events-none fixed inset-0 -z-10/)
    expect(html).toMatch(/--sky-light:linear-gradient/)
    expect(html).toMatch(/--sky-dark:linear-gradient/)
    expect(html).not.toContain('<canvas')
  })

  it('fetches the WebGL code only after load + the timeout, then fades the canvas in over the gradient', async () => {
    const { MarketingSky, MARKETING_SKY_LOAD_DELAY_MS } = await load()
    act(() => root.render(h(MarketingSky)))
    await settle()
    // Before `load`: nothing but the gradient, however long it takes.
    act(() => vi.advanceTimersByTime(10_000))
    await settle()
    expect(host.querySelector('canvas')).toBeNull()

    readyState = 'complete'
    act(() => {
      window.dispatchEvent(new Event('load'))
    })
    act(() => vi.advanceTimersByTime(MARKETING_SKY_LOAD_DELAY_MS - 1))
    await settle()
    expect(host.querySelector('canvas')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    await settle()
    const canvas = host.querySelector('canvas')
    expect(canvas).not.toBeNull()
    // Under the gradient's layer box, fading in (never instant), over the page background with the wash.
    const layer = host.querySelector<HTMLDivElement>('[data-sky-layer]')!
    expect(layer.style.opacity).toBe('0')
    expect(layer.style.transition).toMatch(/opacity/)
    expect(host.querySelector('[data-marketing-sky]')!.contains(layer)).toBe(true)
  })

  it('creates one controller once ready, with the page background and the wash, and disposes it on unmount', async () => {
    readyState = 'complete'
    const { MarketingSky, MARKETING_SKY_LOAD_DELAY_MS } = await load()
    const { receiveSkyResponse } = await import('@/lib/sky/sky-state')
    const { MARKETING_SKY_WASH } = await import('@/lib/sky/marketing-sky')
    const { SKY_PRESETS } = await import('@/lib/sky/dev-override')
    act(() => root.render(h(MarketingSky)))
    act(() => vi.advanceTimersByTime(MARKETING_SKY_LOAD_DELAY_MS))
    await settle()
    act(() => receiveSkyResponse({ location: { lat: 43.7, lon: -79.4 }, country: 'CA', weather: SKY_PRESETS.cloudy, fetchedAt: new Date(NOW).toISOString() }))
    expect(ctl.created).toBe(1)
    expect(ctl.options[0]).toMatchObject({ surfaceVar: '--background', wash: MARKETING_SKY_WASH })
    act(() => root.unmount())
    expect(ctl.dispose).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })

  it('starts the feed on the public endpoint', async () => {
    const { MarketingSky } = await load()
    act(() => root.render(h(MarketingSky)))
    expect(fetchMock).toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/sky(\?|$)/)
  })

  it('reduced motion: the gradient only, the WebGL code never fetched', async () => {
    reducedMotion = true
    readyState = 'complete'
    const { MarketingSky, MARKETING_SKY_LOAD_DELAY_MS } = await load()
    act(() => root.render(h(MarketingSky)))
    act(() => vi.advanceTimersByTime(MARKETING_SKY_LOAD_DELAY_MS * 5))
    await settle()
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelector('[data-marketing-sky]')).not.toBeNull()
  })

  it('Save-Data: the gradient only, the WebGL code never fetched', async () => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } })
    readyState = 'complete'
    const { MarketingSky, MARKETING_SKY_LOAD_DELAY_MS } = await load()
    act(() => root.render(h(MarketingSky)))
    act(() => vi.advanceTimersByTime(MARKETING_SKY_LOAD_DELAY_MS * 5))
    await settle()
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('unmounting before the timeout cancels the load', async () => {
    readyState = 'complete'
    const { loadSkyCanvasAfterLoad } = await load()
    const loader = vi.fn(async () => () => null)
    const onLoaded = vi.fn()
    const cancel = loadSkyCanvasAfterLoad(loader, onLoaded, 500)
    cancel()
    act(() => vi.advanceTimersByTime(1_000))
    await settle()
    expect(loader).not.toHaveBeenCalled()
    expect(onLoaded).not.toHaveBeenCalled()
  })
})
