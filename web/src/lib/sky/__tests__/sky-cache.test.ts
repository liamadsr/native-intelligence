// @vitest-environment jsdom
/**
 * The saved sky reading: what's written (only the route's fields), what's read
 * back (validated, or ignored), the staleness rules (location a week, weather
 * three hours), and storage that throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOCATION_FRESH_MS,
  SKY_CACHE_KEY,
  WEATHER_FRESH_MS,
  isWeatherFresh,
  loadSkyReading,
  parseSavedReading,
  saveSkyReading,
  type SavedSkyReading,
} from '../sky-cache'
import { SKY_PRESETS } from '../dev-override'
import { CLEAR_SKY, SKY_CONDITION_LABELS, readSymbol, coverLabel } from '../weather'

const FETCHED = Date.parse('2026-10-10T12:00:00Z')

const reading = (over: Partial<SavedSkyReading> = {}): SavedSkyReading => ({
  location: { lat: 43.7, lon: -79.4, city: 'Toronto' },
  city: 'Toronto',
  country: 'CA',
  weather: { ...SKY_PRESETS.rain, condition: 'Light rain', temperatureC: 9.4 },
  fetchedAt: new Date(FETCHED).toISOString(),
  approximate: false,
  ...over,
})

const store = (value: unknown) => window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(value))

describe('sky cache', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('round-trips a reading under one key, with only the route fields', () => {
    saveSkyReading({ ...reading(), extra: 'nope' } as SavedSkyReading)
    const stored = JSON.parse(window.localStorage.getItem(SKY_CACHE_KEY)!)
    expect(Object.keys(stored).sort()).toEqual(['approximate', 'city', 'country', 'fetchedAt', 'location', 'weather'])
    expect(loadSkyReading(FETCHED + 60_000)).toEqual({ ...reading(), weatherFresh: true })
  })

  it('keeps the location for a week and the weather for three hours', () => {
    saveSkyReading(reading())
    expect(loadSkyReading(FETCHED + WEATHER_FRESH_MS - 1)?.weatherFresh).toBe(true)
    const stale = loadSkyReading(FETCHED + WEATHER_FRESH_MS)
    expect(stale?.weatherFresh).toBe(false)
    expect(stale?.location).toEqual(reading().location)
    expect(loadSkyReading(FETCHED + LOCATION_FRESH_MS - 1)).not.toBeNull()
    expect(loadSkyReading(FETCHED + LOCATION_FRESH_MS)).toBeNull()
  })

  it('ignores a reading stamped far in the future', () => {
    saveSkyReading(reading())
    expect(loadSkyReading(FETCHED - 2 * 60 * 60_000)).toBeNull()
    expect(loadSkyReading(FETCHED - 5 * 60_000)?.weatherFresh).toBe(true)
  })

  it('reads nothing when storage is empty', () => {
    expect(loadSkyReading(FETCHED)).toBeNull()
  })

  it('ignores a corrupt or malformed value', () => {
    window.localStorage.setItem(SKY_CACHE_KEY, '{not json')
    expect(loadSkyReading(FETCHED)).toBeNull()
    window.localStorage.setItem(SKY_CACHE_KEY, 'null')
    expect(loadSkyReading(FETCHED)).toBeNull()
    store([1, 2, 3])
    expect(loadSkyReading(FETCHED)).toBeNull()
    store({ ...reading(), weather: undefined })
    expect(loadSkyReading(FETCHED)).toBeNull()
  })

  it('validates every field', () => {
    const bad: Array<Partial<Record<keyof SavedSkyReading, unknown>>> = [
      { location: { lat: 91, lon: 0 } },
      { location: { lat: 0, lon: 'x' } },
      { location: { lat: Number.NaN, lon: 0 } },
      { location: { lat: 0, lon: 0, city: 42 } },
      { location: { lat: 0, lon: 0, approximate: 'yes' } },
      { location: null, approximate: false },
      { approximate: true },
      { country: 'ca' },
      { country: 'CAN' },
      { city: 7 },
      { fetchedAt: 'yesterday' },
      { fetchedAt: 12 },
      { weather: { ...CLEAR_SKY, cloudCover: 1.5 } },
      { weather: { ...CLEAR_SKY, cloudCover: -0.1 } },
      { weather: { ...CLEAR_SKY, windSpeedMs: -1 } },
      { weather: { ...CLEAR_SKY, windFromDeg: 400 } },
      { weather: { ...CLEAR_SKY, precip: 'hail' } },
      { weather: { ...CLEAR_SKY, precipIntensity: 2 } },
      { weather: { ...CLEAR_SKY, fog: 1 } },
      { weather: { ...CLEAR_SKY, storm: 'no' } },
      { weather: { ...CLEAR_SKY, temperatureC: 500, condition: 'Clear' } },
      { weather: { ...CLEAR_SKY, temperatureC: 10, condition: 'Raining cats and dogs' } },
      { weather: { ...CLEAR_SKY, temperatureC: 10, condition: '<img src=x>' } },
    ]
    for (const over of bad) {
      expect(parseSavedReading({ ...reading(), ...over }), JSON.stringify(over)).toBeNull()
    }
    // A reading with no location (placed from the UTC offset) and the clear default is fine.
    expect(parseSavedReading({ ...reading(), location: null, city: null, country: null, approximate: true, weather: CLEAR_SKY })).not.toBeNull()
  })

  it('reads a weather saved without cirrus as none, and rejects one out of range', () => {
    const { cirrus: _drop, ...noCirrus } = reading().weather
    void _drop
    const parsed = parseSavedReading({ ...reading(), weather: noCirrus })
    expect(parsed?.weather.cirrus).toBe(0)
    expect(parsed?.weather).toEqual({ ...reading().weather, cirrus: 0 })
    expect(parseSavedReading({ ...reading(), weather: { ...CLEAR_SKY, cirrus: 0.9 } })?.weather.cirrus).toBe(0.9)
    for (const cirrus of [1.2, -0.1, 'thin', null, Number.NaN]) {
      expect(parseSavedReading({ ...reading(), weather: { ...CLEAR_SKY, cirrus } }), String(cirrus)).toBeNull()
    }
  })

  it('is under the v2 key: a v1 reading (cloud cover from the old total) is ignored, and dropped on the next save', () => {
    expect(SKY_CACHE_KEY).toBe('dial8.sky.lastReading.v2')
    // A v1 reading of a clear New York sky under cirrus, saved as "Cloudy".
    const v1 = reading({ weather: { ...CLEAR_SKY, cloudCover: 0.914, temperatureC: 14.7, condition: 'Cloudy' } })
    window.localStorage.setItem('dial8.sky.lastReading.v1', JSON.stringify(v1))
    expect(loadSkyReading(FETCHED + 60_000)).toBeNull()
    saveSkyReading(reading())
    expect(window.localStorage.getItem('dial8.sky.lastReading.v1')).toBeNull()
    expect(loadSkyReading(FETCHED + 60_000)?.weather).toEqual(reading().weather)
  })

  it('takes the city from the location, never a stored one that disagrees', () => {
    expect(parseSavedReading({ ...reading(), city: 'Elsewhere' })?.city).toBe('Toronto')
  })

  it('knows every label the weather module can produce', () => {
    const codes = ['clearsky', 'fair', 'partlycloudy', 'cloudy', 'fog', 'rain', 'lightrain', 'heavyrain', 'rainshowers', 'lightsnowshowers', 'heavysleet', 'sleetshowers', 'rainandthunder']
    for (const code of codes) expect(SKY_CONDITION_LABELS.has(readSymbol(code)!.label), code).toBe(true)
    for (const cover of [0, 0.3, 0.6, 0.9]) expect(SKY_CONDITION_LABELS.has(coverLabel(cover))).toBe(true)
    for (const cover of [0, 0.3, 0.6, 0.9]) expect(SKY_CONDITION_LABELS.has(coverLabel(cover, 1))).toBe(true)
    for (const preset of Object.values(SKY_PRESETS)) expect(SKY_CONDITION_LABELS.has(preset.condition!)).toBe(true)
  })

  it('survives storage that throws, on read and on write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveSkyReading(reading())).not.toThrow()
    expect(loadSkyReading(FETCHED)).toBeNull()
  })

  it('survives localStorage itself being off limits', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => saveSkyReading(reading())).not.toThrow()
    expect(loadSkyReading(FETCHED)).toBeNull()
  })

  it('isWeatherFresh: under three hours from the reading', () => {
    const at = new Date(FETCHED).toISOString()
    expect(isWeatherFresh(at, FETCHED + WEATHER_FRESH_MS - 1)).toBe(true)
    expect(isWeatherFresh(at, FETCHED + WEATHER_FRESH_MS)).toBe(false)
    expect(isWeatherFresh(null, FETCHED)).toBe(false)
    expect(isWeatherFresh('garbage', FETCHED)).toBe(false)
  })
})
