// @vitest-environment jsdom
/**
 * The sky on launch: with no saved reading it stays hidden (no controller, so
 * no GL context and no loop) until the store is ready, then fades in once;
 * the 2.5 s timeout path; with a saved reading it shows at once, with no fade
 * and no blend when the fetch confirms the same reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SKY_CACHE_KEY, type SavedSkyReading } from '@/lib/sky/sky-cache'
import { SKY_PRESETS } from '@/lib/sky/dev-override'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctl = vi.hoisted(() => ({
  created: 0,
  options: null as null | { precipHost?: HTMLElement | null },
  setSource: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../sky-controller', () => ({
  SkyController: class {
    constructor(options: { precipHost?: HTMLElement | null }) {
      ctl.created++
      ctl.options = options
    }
    setSource = ctl.setSource
    setBackground = () => {}
    dispose = ctl.dispose
  },
}))

const NOW = Date.parse('2026-10-10T15:00:00Z')

const reading: SavedSkyReading = {
  location: { lat: 43.7, lon: -79.4, city: 'Toronto' },
  city: 'Toronto',
  country: 'CA',
  weather: { ...SKY_PRESETS.rain, condition: 'Light rain', temperatureC: 9.4 },
  fetchedAt: new Date(NOW - 10 * 60_000).toISOString(),
  approximate: false,
}

let root: Root
let host: HTMLDivElement

async function mount() {
  vi.resetModules()
  const state = await import('@/lib/sky/sky-state')
  const { SkyCanvas, SKY_FADE_MS } = await import('../sky-canvas')
  act(() => root.render(h(SkyCanvas)))
  const layer = () => host.querySelector<HTMLDivElement>('[data-sky-layer]')!
  return { state, layer, SKY_FADE_MS }
}

describe('SkyCanvas on launch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    ctl.created = 0
    ctl.setSource.mockClear()
    ctl.dispose.mockClear()
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

  it('no saved reading: hidden with no controller until ready, then one fade in', async () => {
    const { state, layer, SKY_FADE_MS } = await mount()
    expect(layer().style.opacity).toBe('0')
    expect(ctl.created).toBe(0)

    act(() => {
      state.receiveSkyResponse({ location: reading.location, country: 'CA', weather: reading.weather, fetchedAt: new Date(NOW).toISOString() })
    })
    // The first frame is drawn (the controller exists) while still at 0…
    expect(ctl.created).toBe(1)
    expect(layer().style.opacity).toBe('0')
    expect(layer().style.transition).toBe(`opacity ${SKY_FADE_MS}ms ease-out`)
    // …then it fades in.
    act(() => vi.advanceTimersByTime(30))
    expect(layer().style.opacity).toBe('1')
    // Once: later answers don't fade or remount anything.
    act(() => {
      state.receiveSkyResponse({ location: reading.location, country: 'CA', weather: SKY_PRESETS.cloudy, fetchedAt: new Date(NOW).toISOString() })
    })
    expect(ctl.created).toBe(1)
    expect(layer().style.opacity).toBe('1')
  })

  it('no saved reading and no answer: shows the best state after the 2.5 s timeout', async () => {
    const { state, layer } = await mount()
    const stop = state.startSkyFeed()
    act(() => vi.advanceTimersByTime(state.SKY_READY_TIMEOUT_MS - 1))
    expect(ctl.created).toBe(0)
    expect(layer().style.opacity).toBe('0')
    act(() => vi.advanceTimersByTime(1))
    expect(ctl.created).toBe(1)
    act(() => vi.advanceTimersByTime(30))
    expect(layer().style.opacity).toBe('1')
    stop()
  })

  it('a saved reading: shown from the first frame, no fade, and no change when the fetch confirms it', async () => {
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(reading))
    const { state, layer } = await mount()
    expect(ctl.created).toBe(1)
    expect(layer().style.opacity).toBe('1')
    expect(layer().style.transition).toBe('')
    const first = ctl.setSource.mock.calls.at(-1)![0]
    act(() => {
      state.receiveSkyResponse({ location: reading.location, country: 'CA', weather: reading.weather, fetchedAt: new Date(NOW).toISOString() })
    })
    expect(ctl.created).toBe(1)
    expect(ctl.setSource.mock.calls.at(-1)![0]).toEqual(first)
  })

  it('hands the controller an empty host for the crisp rain and snow canvas, over the sky and under the grain', async () => {
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(reading))
    const { layer } = await mount()
    const precipHost = layer().querySelector('[data-sky-precip-host]')
    expect(precipHost).not.toBeNull()
    expect(ctl.options?.precipHost).toBe(precipHost)
    expect(precipHost!.childElementCount).toBe(0)
    const order = [...layer().children].map((el) => (el.hasAttribute('data-sky-canvas') ? 'sky' : el.hasAttribute('data-sky-precip-host') ? 'precip' : el.hasAttribute('data-sky-grain') ? 'grain' : '?'))
    expect(order).toEqual(['sky', 'precip', 'grain'])
  })

  it('dev: the sky preview settings reach the controller live, snapping while the time slider drags', async () => {
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(reading))
    await mount()
    const dev = await import('@/lib/sky/sky-dev-store')
    act(() => dev.setSkyDevSettings({ weather: 'snow' }))
    expect(ctl.setSource.mock.calls.at(-1)).toEqual([expect.objectContaining({ weather: SKY_PRESETS.snow }), { snap: false }])

    act(() => {
      dev.setSkyDevScrubbing(true)
      dev.setSkyDevSettings({ minuteOfDay: 18 * 60 + 40 })
    })
    expect(ctl.setSource.mock.calls.at(-1)).toEqual([expect.objectContaining({ minuteOfDay: 1120 }), { snap: true }])
    dev.setSkyDevScrubbing(false)
    act(() => dev.resetSkyDevOverride())
    expect(ctl.setSource.mock.calls.at(-1)).toEqual([expect.objectContaining({ weather: reading.weather, minuteOfDay: null }), { snap: false }])
  })
})
