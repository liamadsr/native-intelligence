// @vitest-environment jsdom
/**
 * The dev sky preview store (sky-dev-store.ts) and how the sky store takes it:
 * remembered on the device, malformed values read as defaults, storage that
 * throws never breaks it, inert in production; the URL's override wins field
 * by field over it, which wins over the real reading; a change re-publishes
 * the sky state live; a fixed time of day holds the sun there.
 * Each test loads the modules fresh, since both read storage at load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKY_PRESETS, mergeSkyOverrides, parseSkyOverride } from '../dev-override'

type DevStore = typeof import('../sky-dev-store')
type SkyStateModule = typeof import('../sky-state')

const KEY = 'dial8.sky.devOverride.v1'
const NOW = Date.parse('2026-10-10T15:00:00Z')

async function loadStore(): Promise<DevStore> {
  vi.resetModules()
  return import('../sky-dev-store')
}

async function loadBoth(): Promise<{ store: DevStore; sky: SkyStateModule }> {
  vi.resetModules()
  const store = await import('../sky-dev-store')
  const sky = await import('../sky-state')
  return { store, sky }
}

describe('sky dev store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('starts on the defaults, and a change is saved and read back by a fresh load', async () => {
    let store = await loadStore()
    expect(store.getSkyDevSettings()).toEqual({ weather: null, minuteOfDay: null, place: null, floating: false })
    const heard = vi.fn()
    store.subscribeSkyDevSettings(heard)
    store.setSkyDevSettings({ weather: 'rain', minuteOfDay: 18 * 60 + 40, place: 'new-york', floating: true })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({
      weather: 'rain',
      minuteOfDay: 1120,
      place: 'new-york',
      floating: true,
    })
    // The same again: nothing to tell anyone.
    store.setSkyDevSettings({ weather: 'rain' })
    expect(heard).toHaveBeenCalledTimes(1)

    store = await loadStore()
    expect(store.getSkyDevSettings()).toEqual({ weather: 'rain', minuteOfDay: 1120, place: 'new-york', floating: true })
  })

  it('reset goes back to the real sky and keeps the floating panel as it was', async () => {
    const store = await loadStore()
    store.setSkyDevSettings({ weather: 'snow', minuteOfDay: 300, place: 'tokyo', floating: true })
    store.resetSkyDevOverride()
    expect(store.getSkyDevSettings()).toEqual({ weather: null, minuteOfDay: null, place: null, floating: true })
  })

  it('reads anything malformed as its default', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ weather: 'hail', minuteOfDay: 1440, place: 'mars', floating: 'yes' }))
    expect((await loadStore()).getSkyDevSettings()).toEqual({ weather: null, minuteOfDay: null, place: null, floating: false })
    window.localStorage.setItem(KEY, '{not json')
    expect((await loadStore()).getSkyDevSettings()).toEqual({ weather: null, minuteOfDay: null, place: null, floating: false })
    const store = await loadStore()
    store.setSkyDevSettings({ minuteOfDay: 12.5, weather: 'nope' })
    expect(store.getSkyDevSettings().minuteOfDay).toBeNull()
    expect(store.getSkyDevSettings().weather).toBeNull()
  })

  it('storage that throws never breaks it: defaults on read, and a change still applies for the session', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const store = await loadStore()
    expect(store.getSkyDevSettings().weather).toBeNull()
    expect(() => store.setSkyDevSettings({ weather: 'fog' })).not.toThrow()
    expect(store.getSkyDevSettings().weather).toBe('fog')
  })

  it('does nothing in production: reads the defaults whatever is stored, and never writes', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ weather: 'rain', minuteOfDay: 600, place: 'london', floating: true }))
    vi.stubEnv('NODE_ENV', 'production')
    const store = await loadStore()
    expect(store.getSkyDevSettings()).toEqual({ weather: null, minuteOfDay: null, place: null, floating: false })
    const heard = vi.fn()
    store.subscribeSkyDevSettings(heard)
    store.setSkyDevSettings({ weather: 'snow' })
    store.setSkyDevScrubbing(true)
    expect(heard).not.toHaveBeenCalled()
    expect(store.isSkyDevScrubbing()).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(KEY)!).weather).toBe('rain')
  })

  it('turns the settings into an override: a preset, the time, and the place with its city and country', async () => {
    const store = await loadStore()
    expect(store.skyDevOverride(store.SKY_DEV_DEFAULTS)).toBeNull()
    expect(store.skyDevOverride({ weather: 'storm', minuteOfDay: 1200, place: 'reykjavik', floating: false })).toEqual({
      weather: SKY_PRESETS.storm,
      minuteOfDay: 1200,
      place: { location: { lat: 64.15, lon: -21.94, city: 'Reykjavik' }, country: 'IS' },
    })
  })
})

describe('precedence: the URL, then the dev settings, then the real reading', () => {
  it('merges field by field, the URL winning wherever it says something', () => {
    const url = parseSkyOverride('?sky=fog')
    const stored = { weather: SKY_PRESETS.rain, minuteOfDay: 1120, place: { location: { lat: 1, lon: 2, city: 'X' }, country: null } }
    expect(mergeSkyOverrides(url, stored)).toEqual({ weather: SKY_PRESETS.fog, minuteOfDay: 1120, place: stored.place })
    expect(mergeSkyOverrides(null, stored)).toBe(stored)
    expect(mergeSkyOverrides(url, null)).toBe(url)
    expect(mergeSkyOverrides(null, null)).toBeNull()
  })
})

describe('the sky state with the dev settings', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    window.history.replaceState({}, '', '/')
  })

  it('applies the stored settings from the first read, before any feed runs', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ weather: 'rain', minuteOfDay: 1120, place: 'new-york', floating: false }))
    const { sky } = await loadBoth()
    const s = sky.getSkyState()
    expect(s.weather).toEqual(SKY_PRESETS.rain)
    expect(s.timeOverride).toBe(1120)
    expect(s.city).toBe('New York')
    expect(s.latitude).toBe(40.71)
    expect(s.longitude).toBe(-74.01)
    expect(s.country).toBe('US')
  })

  it('a change re-publishes at once, and back to real restores the reading', async () => {
    const { store, sky } = await loadBoth()
    sky.receiveSkyResponse({ location: { lat: 51.5, lon: -0.1, city: 'London' }, weather: SKY_PRESETS.cloudy, fetchedAt: '2026-10-10T14:00:00Z' })
    const heard = vi.fn()
    sky.subscribeSkyState(heard)

    store.setSkyDevSettings({ weather: 'snow', place: 'sydney' })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(sky.getSkyState().weather).toEqual(SKY_PRESETS.snow)
    expect(sky.getSkyState().city).toBe('Sydney')

    store.resetSkyDevOverride()
    expect(sky.getSkyState().weather).toEqual(SKY_PRESETS.cloudy)
    expect(sky.getSkyState().city).toBe('London')
    expect(sky.getSkyState().timeOverride).toBeNull()
  })

  it('the URL wins over the stored settings where it says something; the settings fill the rest', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ weather: 'rain', minuteOfDay: 1120, place: 'tokyo', floating: false }))
    window.history.replaceState({}, '', '/?sky=fog')
    const { sky } = await loadBoth()
    const s = sky.getSkyState()
    expect(s.weather).toEqual(SKY_PRESETS.fog)
    expect(s.timeOverride).toBe(1120)
    expect(s.city).toBe('Tokyo')
  })

  it('a fixed time of day holds the sun there as the clock runs on', async () => {
    const { store, sky } = await loadBoth()
    store.setSkyDevSettings({ minuteOfDay: 9 * 60, place: 'london' })
    const before = sky.getSkyState().sunElevation
    vi.setSystemTime(NOW + 90 * 60_000)
    // Anything that re-derives the state (here, the weather changing).
    store.setSkyDevSettings({ weather: 'clear' })
    expect(sky.getSkyState().sunElevation).toBeCloseTo(before, 6)
    // "Now" again: the sun is where the clock says.
    store.setSkyDevSettings({ minuteOfDay: null })
    expect(sky.getSkyState().sunElevation).not.toBeCloseTo(before, 1)
  })

  it('production ignores whatever the device has stored', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ weather: 'rain', minuteOfDay: 1120, place: 'tokyo', floating: true }))
    vi.stubEnv('NODE_ENV', 'production')
    const { sky } = await loadBoth()
    const s = sky.getSkyState()
    expect(s.weather.condition).toBeNull()
    expect(s.timeOverride).toBeNull()
    expect(s.city).toBeNull()
  })
})
