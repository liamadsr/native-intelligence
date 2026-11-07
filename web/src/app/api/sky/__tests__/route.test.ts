/**
 * GET /api/sky, the public front door: no auth; the geolocation headers (or a
 * validated `?tz=` zone) are rounded to a cell and the browser is redirected
 * (307) to that cell's cacheable URL; never cached by the CDN itself; no city
 * or IP in the redirect; with no place at all, the clear default directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_SKY } from '@/lib/sky/weather'

const fetched: Array<[number, number]> = []
vi.mock('@/lib/sky/met-norway', () => ({
  fetchSkyWeather: async (lat: number, lon: number) => (fetched.push([lat, lon]), CLEAR_SKY),
}))

import { GET } from '../route'

const get = (query = '', headers: Record<string, string> = {}) =>
  GET(new Request(`https://dial8.ai/api/sky${query}`, { headers }))

beforeEach(() => {
  fetched.length = 0
})

describe('GET /api/sky', () => {
  it('redirects (307) to the cell of the geolocation headers, with the country, ignoring the time zone', async () => {
    const res = await get('?tz=Asia/Tokyo', {
      'x-vercel-ip-latitude': '43.651',
      'x-vercel-ip-longitude': '-79.383',
      'x-vercel-ip-city': 'Toronto',
      'x-vercel-ip-country': 'CA',
    })
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://dial8.ai/api/sky/cell?lat=43.7&lon=-79.4&c=CA')
    // Depends on the request's own headers: never on the CDN.
    expect(res.headers.get('cache-control')).toMatch(/^private/)
    // No city, no weather fetched here (the cell does that).
    expect(res.headers.get('location')).not.toMatch(/Toronto/i)
    expect(fetched).toEqual([])
  })

  it('leaves the country out when the headers carry none', async () => {
    const res = await get('', { 'x-vercel-ip-latitude': '-33.87', 'x-vercel-ip-longitude': '151.21' })
    expect(res.headers.get('location')).toBe('https://dial8.ai/api/sky/cell?lat=-33.9&lon=151.2')
  })

  it("falls back to a valid time zone's principal city", async () => {
    const res = await get('?tz=America/Toronto')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://dial8.ai/api/sky/cell?lat=43.7&lon=-79.4&c=CA')
  })

  it("keeps the header's country when only the coordinates are missing", async () => {
    const res = await get('?tz=Europe/Paris', { 'x-vercel-ip-country': 'BE' })
    expect(res.headers.get('location')).toMatch(/&c=BE$/)
  })

  it('with no headers and no usable time zone, answers the clear default directly (private, no redirect)', async () => {
    for (const q of ['', '?tz=', '?tz=Mars/Base', '?tz=__proto__', `?tz=${'A'.repeat(200)}`]) {
      const res = await get(q)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toMatch(/^private/)
      const body = await res.json()
      expect(body.location).toBeNull()
      expect(body.weather).toEqual(CLEAR_SKY)
      expect(typeof body.fetchedAt).toBe('string')
    }
    expect(fetched).toEqual([])
  })

  it('ignores malformed geolocation headers and uses the time zone', async () => {
    const res = await get('?tz=America/Toronto', { 'x-vercel-ip-latitude': 'nope', 'x-vercel-ip-longitude': '999' })
    expect(res.headers.get('location')).toBe('https://dial8.ai/api/sky/cell?lat=43.7&lon=-79.4&c=CA')
  })
})
