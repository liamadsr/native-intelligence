// @vitest-environment jsdom
/**
 * The sky store on launch, in the browser: it starts from a saved reading
 * (fresh weather, or a usable location with the weather left blank), and is
 * not ready without one until the fetch answers, fails, or the launch timeout
 * passes. Each test loads the module fresh, since the saved reading is read at
 * module load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKY_CACHE_KEY, WEATHER_FRESH_MS, type SavedSkyReading } from '../sky-cache'
import { SKY_PRESETS } from '../dev-override'
import { CLEAR_SKY } from '../weather'

type SkyStateModule = typeof import('../sky-state')

const NOW = Date.parse('2026-10-10T15:00:00Z')

const saved = (ageMs: number, over: Partial<SavedSkyReading> = {}): SavedSkyReading => ({
  location: { lat: 43.7, lon: -79.4, city: 'Toronto' },
  city: 'Toronto',
  country: 'CA',
  weather: { ...SKY_PRESETS.rain, condition: 'Light rain', temperatureC: 9.4 },
  fetchedAt: new Date(NOW - ageMs).toISOString(),
  approximate: false,
  ...over,
})

async function load(): Promise<SkyStateModule> {
  vi.resetModules()
  return import('../sky-state')
}

let fetchMock: ReturnType<typeof vi.fn>

/** Let the feed's fetch promise chain settle (fake timers don't touch microtasks). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('sky state on launch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts from a fresh saved reading: place, weather, ready, before any fetch', async () => {
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(saved(30 * 60_000)))
    const { getSkyState } = await load()
    const s = getSkyState()
    expect(s.ready).toBe(true)
    expect(s.approximate).toBe(false)
    expect(s.city).toBe('Toronto')
    expect(s.latitude).toBe(43.7)
    expect(s.weather.condition).toBe('Light rain')
    expect(s.fetchedAt).toBe(saved(30 * 60_000).fetchedAt)
  })

  it('then the fetch returning the same reading changes nothing the sky draws', async () => {
    const reading = saved(30 * 60_000)
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(reading))
    const { getSkyState, receiveSkyResponse } = await load()
    const before = getSkyState()
    receiveSkyResponse({ location: reading.location, country: reading.country, weather: reading.weather, fetchedAt: new Date(NOW).toISOString() })
    const after = getSkyState()
    expect(after.latitude).toBe(before.latitude)
    expect(after.longitude).toBe(before.longitude)
    expect(after.weather).toEqual(before.weather)
    expect(after.timeOverride).toBe(before.timeOverride)
    expect(after.fetchedAt).toBe(new Date(NOW).toISOString())
  })

  it('a stale weather keeps the saved place but leaves the weather blank', async () => {
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(saved(WEATHER_FRESH_MS + 60_000)))
    const { getSkyState } = await load()
    const s = getSkyState()
    expect(s.ready).toBe(true)
    expect(s.city).toBe('Toronto')
    expect(s.latitude).toBe(43.7)
    expect(s.weather).toEqual(CLEAR_SKY)
    expect(s.weather.condition).toBeNull()
    expect(s.weather.temperatureC).toBeNull()
  })

  it('a saved reading over a week old, or a corrupt one, is ignored', async () => {
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(saved(8 * 24 * 60 * 60_000)))
    expect((await load()).getSkyState().ready).toBe(false)
    window.localStorage.setItem(SKY_CACHE_KEY, '{"location":')
    const s = (await load()).getSkyState()
    expect(s.ready).toBe(false)
    expect(s.approximate).toBe(true)
  })

  it('storage that throws reads as no saved reading', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const s = (await load()).getSkyState()
    expect(s.ready).toBe(false)
    expect(s.fetchedAt).toBeNull()
  })

  it('with no saved reading: not ready until the fetch answers, which is then saved', async () => {
    let answer!: (r: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)))
    const { getSkyState, startSkyFeed } = await load()
    expect(getSkyState().ready).toBe(false)
    const stop = startSkyFeed()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getSkyState().ready).toBe(false)
    const body = { location: { lat: 51.5, lon: -0.1, city: 'London' }, country: 'GB', weather: SKY_PRESETS.cloudy, fetchedAt: new Date(NOW).toISOString() }
    answer(new Response(JSON.stringify(body), { status: 200 }))
    await vi.waitFor(() => expect(getSkyState().ready).toBe(true))
    expect(getSkyState().city).toBe('London')
    expect(JSON.parse(window.localStorage.getItem(SKY_CACHE_KEY)!)).toEqual({
      location: body.location,
      city: 'London',
      country: 'GB',
      weather: SKY_PRESETS.cloudy,
      fetchedAt: body.fetchedAt,
      approximate: false,
    })
    stop()
  })

  it('with no saved reading and a fetch that never answers: ready after the 2.5 s timeout', async () => {
    const { getSkyState, startSkyFeed, SKY_READY_TIMEOUT_MS } = await load()
    const stop = startSkyFeed()
    vi.advanceTimersByTime(SKY_READY_TIMEOUT_MS - 1)
    expect(getSkyState().ready).toBe(false)
    vi.advanceTimersByTime(1)
    const s = getSkyState()
    expect(s.ready).toBe(true)
    // The best there is: the clear default at the approximate place, nothing reported.
    expect(s.approximate).toBe(true)
    expect(s.fetchedAt).toBeNull()
    expect(s.weather).toEqual(CLEAR_SKY)
    stop()
  })

  it('a failing fetch makes it ready at once', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('offline')))
    const { getSkyState, startSkyFeed } = await load()
    const stop = startSkyFeed()
    await settle()
    expect(getSkyState().ready).toBe(true)
    expect(getSkyState().fetchedAt).toBeNull()
    stop()
  })

  it('a non-OK answer makes it ready at once', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('no', { status: 401 })))
    const { getSkyState, startSkyFeed } = await load()
    const stop = startSkyFeed()
    await settle()
    expect(getSkyState().ready).toBe(true)
    stop()
  })

  it('stopping the feed clears the launch timeout', async () => {
    const { startSkyFeed } = await load()
    const before = vi.getTimerCount()
    const stop = startSkyFeed()
    expect(vi.getTimerCount()).toBeGreaterThan(before)
    stop()
    expect(vi.getTimerCount()).toBe(before)
  })
})
