/**
 * GET /api/sky/cell, the cacheable public cell: the account route's JSON
 * shape (no city); CDN cache headers (shorter after a failed fetch); one
 * spelling per cell, so anything else redirects there (308) and anything
 * that isn't a cell is refused, neither touching MET.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_SKY, type SkyWeather } from '@/lib/sky/weather'

const fetched: Array<[number, number]> = []
const RAIN: SkyWeather = { ...CLEAR_SKY, cloudCover: 0.9, precip: 'rain', precipIntensity: 0.5, condition: 'Rain', temperatureC: 9 }
let answer: SkyWeather = RAIN

vi.mock('@/lib/sky/met-norway', () => ({
  fetchSkyWeather: async (lat: number, lon: number) => (fetched.push([lat, lon]), answer),
}))

import { GET } from '../route'
import { CELL_CACHE, CELL_FAILURE_CACHE } from '@/lib/sky/public-cell'

const get = (query: string) => GET(new Request(`https://dial8.ai/api/sky/cell${query}`))

beforeEach(() => {
  fetched.length = 0
  answer = RAIN
})

describe('GET /api/sky/cell', () => {
  it("answers the cell's weather in the account route's shape, cacheable on the CDN", async () => {
    const res = await get('?lat=43.7&lon=-79.4&c=CA')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe(CELL_CACHE)
    expect(CELL_CACHE).toBe('public, s-maxage=1800, stale-while-revalidate=3600')
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['country', 'fetchedAt', 'location', 'weather'])
    expect(body.location).toEqual({ lat: 43.7, lon: -79.4 })
    expect(body.country).toBe('CA')
    expect(body.weather).toEqual(RAIN)
    expect(fetched).toEqual([[43.7, -79.4]])
  })

  it('works without a country, and on whole-degree and negative-zero-free cells', async () => {
    const body = await (await get('?lat=43.0&lon=0.0')).json()
    expect(body.location).toEqual({ lat: 43, lon: 0 })
    expect(body.country).toBeNull()
  })

  it('caches the clear-sky default after a failed fetch for five minutes only', async () => {
    answer = CLEAR_SKY
    const res = await get('?lat=43.7&lon=-79.4')
    expect(res.headers.get('cache-control')).toBe(CELL_FAILURE_CACHE)
    expect(CELL_FAILURE_CACHE).toMatch(/s-maxage=300/)
  })

  it("redirects (308) any other spelling to the cell's one spelling, without fetching", async () => {
    const cases: Array<[string, string]> = [
      ['?lat=43.651&lon=-79.383&c=CA', '?lat=43.7&lon=-79.4&c=CA'], // extra digits
      ['?lat=43&lon=-79', '?lat=43.0&lon=-79.0'], // no decimal
      ['?lon=-79.4&lat=43.7', '?lat=43.7&lon=-79.4'], // order
      ['?lat=43.7&lon=-79.4&c=ca', '?lat=43.7&lon=-79.4&c=CA'], // case
      ['?lat=43.7&lon=-79.4&junk=1', '?lat=43.7&lon=-79.4'], // junk params
      ['?lat=95&lon=200', '?lat=90.0&lon=180.0'], // clamped
      ['?lat=-95.5&lon=-181', '?lat=-90.0&lon=-180.0'],
      ['?lat=-0.01&lon=-0.04', '?lat=0.0&lon=0.0'], // no "-0.0"
    ]
    for (const [query, canonical] of cases) {
      const res = await get(query)
      expect(res.status, query).toBe(308)
      expect(res.headers.get('location'), query).toBe(`https://dial8.ai/api/sky/cell${canonical}`)
      expect(res.headers.get('cache-control'), query).toMatch(/^public/)
    }
    expect(fetched).toEqual([])
  })

  it('refuses (400) anything that is not a cell, without fetching', async () => {
    for (const query of [
      '',
      '?lat=43.7',
      '?lon=-79.4',
      '?lat=abc&lon=1.0',
      '?lat=1e3&lon=1.0',
      '?lat=Infinity&lon=1.0',
      '?lat=0x10&lon=1.0',
      '?lat=%2043.7&lon=1.0',
      '?lat=1234.5&lon=1.0',
      '?lat=43.7&lon=-79.4&c=USA',
      '?lat=43.7&lon=-79.4&c=1A',
      '?lat=43.7&lon=-79.4&c=',
    ]) {
      const res = await get(query)
      expect(res.status, query).toBe(400)
      const body = await res.json()
      expect(body.code, query).toBe('BAD_REQUEST')
    }
    expect(fetched).toEqual([])
  })
})
