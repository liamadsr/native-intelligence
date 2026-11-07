// @vitest-environment jsdom
/**
 * The sky store's endpoint is per mount: the dashboard shell's feed (the
 * default) asks the signed-in /api/account/sky, the signed-out pages' feed
 * the public /api/sky (which redirects to a cached cell); either answer
 * feeds the same store, and the public one carries no city.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKY_PRESETS } from '../dev-override'

const NOW = Date.parse('2026-10-10T15:00:00Z')

let fetchMock: ReturnType<typeof vi.fn>

async function load() {
  vi.resetModules()
  return import('../sky-state')
}

// Let the feed's fetch settle. Reading a Response body takes a different number
// of microtask turns on different Node versions (5 was enough on Node 24, not on
// 22), so wait for a macrotask instead: setImmediate runs only once every pending
// microtask has drained, and it is not one of the faked timers.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('sky store endpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ location: { lat: 43.7, lon: -79.4 }, country: 'CA', weather: SKY_PRESETS.cloudy, fetchedAt: new Date(NOW).toISOString() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('the app feed (default) asks the signed-in route', async () => {
    const state = await load()
    const stop = state.startSkyFeed()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/account\/sky(\?tz=|$)/)
    stop()
  })

  it('the signed-out feed asks the public route, and its answer feeds the store with no city', async () => {
    const state = await load()
    const stop = state.startSkyFeed(state.PUBLIC_SKY_ENDPOINT)
    expect(state.PUBLIC_SKY_ENDPOINT).toBe('/api/sky')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/sky(\?tz=|$)/)
    await flush()
    const s = state.getSkyState()
    expect(s.ready).toBe(true)
    expect(s.latitude).toBe(43.7)
    expect(s.city).toBeNull()
    expect(s.weather.condition).toBe('Partly cloudy')
    stop()
  })

  it("passes the browser's time zone to either endpoint", async () => {
    const state = await load()
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'America/Toronto' } as Intl.ResolvedDateTimeFormatOptions)
    expect(state.skyUrl()).toBe('/api/account/sky?tz=America%2FToronto')
    expect(state.skyUrl(state.PUBLIC_SKY_ENDPOINT)).toBe('/api/sky?tz=America%2FToronto')
    vi.restoreAllMocks()
  })

  it('one loop at a time: a second mount shares the first one and its endpoint', async () => {
    const state = await load()
    const a = state.startSkyFeed(state.PUBLIC_SKY_ENDPOINT)
    const b = state.startSkyFeed(state.PUBLIC_SKY_ENDPOINT)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    a()
    b()
    // Both gone: a new mount (the app, after a navigation) starts its own loop on its own endpoint.
    const c = state.startSkyFeed()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/^\/api\/account\/sky/)
    c()
  })
})
