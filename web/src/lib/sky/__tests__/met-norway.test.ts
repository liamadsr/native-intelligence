/**
 * fetchSkyWeather (MET Norway `complete`, server side): never throws, falls back to the
 * clear sky, remembers a failure for five minutes, honours `Expires` within
 * 30 min – 2 h, and keeps its per-cell cache bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_SKY } from '../weather'

const T0 = Date.UTC(2026, 9, 10, 12)
const MIN = 60_000

/**
 * A real Locationforecast 2.0 `complete` body for New York (40.7, -74.0) on
 * 10 October 2026, trimmed to its first entry and the fields around the ones
 * we read: a blue sky under thin cirrus (91.4% cloud, all of it high), which
 * the total alone drew as "Cloudy".
 */
const BODY = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-74, 40.7, 9] },
  properties: {
    meta: { updated_at: '2026-10-10T11:19:16Z', units: { cloud_area_fraction: '%', air_temperature: 'celsius', wind_speed: 'm/s' } },
    timeseries: [
      {
        time: '2026-10-10T13:00:00Z',
        data: {
          instant: {
            details: {
              air_pressure_at_sea_level: 1030.4,
              air_temperature: 14.7,
              apparent_air_temperature: 14.3,
              cloud_area_fraction: 91.4,
              cloud_area_fraction_high: 91.4,
              cloud_area_fraction_low: 0.0,
              cloud_area_fraction_medium: 0.0,
              dew_point_temperature: 7.5,
              fog_area_fraction: 0.0,
              relative_humidity: 62.6,
              ultraviolet_index_clear_sky: 1.1,
              wind_from_direction: 358.7,
              wind_speed: 2.5,
            },
          },
          next_12_hours: { summary: { symbol_code: 'partlycloudy_day' }, details: {} },
          next_1_hours: { summary: { symbol_code: 'partlycloudy_day' }, details: { precipitation_amount: 0.0 } },
          next_6_hours: {
            summary: { symbol_code: 'partlycloudy_day' },
            details: { air_temperature_max: 20.6, air_temperature_min: 16.6, precipitation_amount: 0.0 },
          },
        },
      },
      {
        time: '2026-10-10T14:00:00Z',
        data: {
          instant: { details: { air_temperature: 16.1, cloud_area_fraction: 98.2, cloud_area_fraction_high: 98.2, cloud_area_fraction_low: 0.0, cloud_area_fraction_medium: 3.1, fog_area_fraction: 0.0, wind_from_direction: 10.2, wind_speed: 2.8 } },
          next_1_hours: { summary: { symbol_code: 'partlycloudy_day' }, details: { precipitation_amount: 0.0 } },
        },
      },
    ],
  },
}

const ok = (expires?: number) =>
  new Response(JSON.stringify(BODY), {
    status: 200,
    headers: expires === undefined ? {} : { expires: new Date(expires).toUTCString() },
  })

let fetchMock: ReturnType<typeof vi.fn>
let fetchSkyWeather: (lat: number, lon: number) => Promise<typeof CLEAR_SKY>

describe('fetchSkyWeather', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // A fresh module per test: the cache is module state.
    vi.resetModules()
    ;({ fetchSkyWeather } = await import('../met-norway'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('maps a good answer, with the coordinates rounded to one decimal', async () => {
    fetchMock.mockResolvedValueOnce(ok())
    const w = await fetchSkyWeather(40.7128, -74.006)
    expect(w).toMatchObject({ condition: 'Mostly clear', temperatureC: 14.7, windSpeedMs: 2.5, fog: false, precip: 'none' })
    expect(w.windFromDeg).toBeCloseTo(358.7)
    expect(String(fetchMock.mock.calls[0][0])).toContain('lat=40.7&lon=-74.0')
  })

  it('reads the complete endpoint, with its cloud layers: high cloud is cirrus, not cover', async () => {
    fetchMock.mockResolvedValueOnce(ok())
    const w = await fetchSkyWeather(40.7, -74)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url.startsWith('https://api.met.no/weatherapi/locationforecast/2.0/complete?')).toBe(true)
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toMatch(/^Dial8\/1\.0 https:\/\/dial8\.ai/)
    expect(w.cloudCover).toBe(0)
    expect(w.cirrus).toBeCloseTo(0.914)
  })

  it('a timeout or network error gives the clear-sky default', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
    expect(await fetchSkyWeather(10, 10)).toEqual(CLEAR_SKY)
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await fetchSkyWeather(20, 20)).toEqual(CLEAR_SKY)
  })

  it('an error status or an unreadable body gives the clear-sky default', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }))
    expect(await fetchSkyWeather(10, 10)).toEqual(CLEAR_SKY)
    fetchMock.mockResolvedValueOnce(new Response('{"properties":{}}', { status: 200 }))
    expect(await fetchSkyWeather(20, 20)).toEqual(CLEAR_SKY)
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
    expect(await fetchSkyWeather(30, 30)).toEqual(CLEAR_SKY)
  })

  it('remembers a failure for five minutes, then asks again', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await fetchSkyWeather(10, 10)
    vi.setSystemTime(T0 + 5 * MIN - 1)
    expect(await fetchSkyWeather(10, 10)).toEqual(CLEAR_SKY)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(ok())
    vi.setSystemTime(T0 + 5 * MIN)
    expect((await fetchSkyWeather(10, 10)).condition).toBe('Mostly clear')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honours Expires, clamped to at least 30 minutes', async () => {
    fetchMock.mockResolvedValue(ok(T0 + 2 * MIN))
    await fetchSkyWeather(10, 10)
    vi.setSystemTime(T0 + 30 * MIN - 1)
    await fetchSkyWeather(10, 10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(T0 + 30 * MIN)
    await fetchSkyWeather(10, 10)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honours Expires, clamped to at most 2 hours', async () => {
    fetchMock.mockResolvedValue(ok(T0 + 24 * 60 * MIN))
    await fetchSkyWeather(10, 10)
    vi.setSystemTime(T0 + 120 * MIN - 1)
    await fetchSkyWeather(10, 10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(T0 + 120 * MIN)
    await fetchSkyWeather(10, 10)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honours an Expires inside the window as given, and 30 minutes without one', async () => {
    fetchMock.mockResolvedValue(ok(T0 + 45 * MIN))
    await fetchSkyWeather(10, 10)
    vi.setSystemTime(T0 + 45 * MIN - 1)
    await fetchSkyWeather(10, 10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(T0 + 45 * MIN)
    await fetchSkyWeather(10, 10)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValue(ok())
    await fetchSkyWeather(20, 20)
    const calls = fetchMock.mock.calls.length
    vi.setSystemTime(T0 + 45 * MIN + 30 * MIN - 1)
    await fetchSkyWeather(20, 20)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })

  it('evicts past the cap: expired cells first, everything when none have expired', async () => {
    fetchMock.mockImplementation(async () => ok(T0 + 60 * MIN))
    // Fill the cache to its cap (2,000 cells) with fresh answers.
    for (let i = 0; i < 2_000; i++) await fetchSkyWeather(i / 10, 0)
    expect(fetchMock).toHaveBeenCalledTimes(2_000)
    // Still fresh: a cached cell costs no fetch.
    await fetchSkyWeather(0, 0)
    expect(fetchMock).toHaveBeenCalledTimes(2_000)

    // One more cell, none expired: the cache is cleared, so the first cell is fetched again.
    await fetchSkyWeather(0, 50)
    await fetchSkyWeather(0, 0)
    expect(fetchMock).toHaveBeenCalledTimes(2_002)
  })

  it('evicts only expired cells when some have expired', async () => {
    // 1,000 cells with a 30-minute life, then 1,000 with an hour.
    fetchMock.mockImplementation(async () => ok(T0 + 30 * MIN))
    for (let i = 0; i < 1_000; i++) await fetchSkyWeather(i / 10, 0)
    fetchMock.mockImplementation(async () => ok(T0 + 60 * MIN))
    for (let i = 0; i < 1_000; i++) await fetchSkyWeather(i / 10, 10)
    vi.setSystemTime(T0 + 40 * MIN)

    // A new cell at the cap drops the expired half; the hour-long half survives.
    await fetchSkyWeather(0, 50)
    const calls = fetchMock.mock.calls.length
    await fetchSkyWeather(0.1, 10)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })
})
