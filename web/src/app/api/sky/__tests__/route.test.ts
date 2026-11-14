/**
 * GET /api/sky, the public front door: no auth; a validated `?tz=` zone's
 * principal city is rounded to a cell and the browser is redirected (307) to
 * that cell's cacheable URL; no city in the redirect; without a known zone,
 * the clear default directly. Nothing in the request's headers places it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_SKY } from '@/lib/sky/weather'

const fetched: Array<[number, number]> = []
vi.mock('@/lib/sky/met-norway', () => ({
  fetchSkyWeather: async (lat: number, lon: number) => (fetched.push([lat, lon]), CLEAR_SKY),
}))

import { GET } from '../route'

const get = (query = '', headers: Record<string, string> = {}) =>
  GET(new Request(`https://nativeintelligence.dev/api/sky${query}`, { headers }))

beforeEach(() => {
  fetched.length = 0
})

describe('GET /api/sky', () => {
  it("redirects (307) to the cell of the time zone's principal city, with its country", async () => {
    const res = await get('?tz=America/Toronto')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://nativeintelligence.dev/api/sky/cell?lat=43.7&lon=-79.4&c=CA')
    expect(res.headers.get('cache-control')).toMatch(/^private/)
    // No city, no weather fetched here (the cell does that).
    expect(res.headers.get('location')).not.toMatch(/Toronto/i)
    expect(fetched).toEqual([])
  })

  it('without a usable time zone, answers the clear default directly (private, no redirect)', async () => {
    for (const q of ['', '?tz=', '?tz=Mars/Base', '?tz=__proto__', `?tz=${'A'.repeat(200)}`]) {
      const res = await get(q)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toMatch(/^private/)
      const body = await res.json()
      expect(body.location).toBeNull()
      expect(body.country).toBeNull()
      expect(body.weather).toEqual(CLEAR_SKY)
      expect(typeof body.fetchedAt).toBe('string')
    }
    expect(fetched).toEqual([])
  })

  it('takes no place from a header a client can send', async () => {
    const claimed = { 'x-vercel-ip-latitude': '-33.87', 'x-vercel-ip-longitude': '151.21', 'x-vercel-ip-country': 'AU' }
    const placed = await get('?tz=America/Toronto', claimed)
    expect(placed.headers.get('location')).toBe('https://nativeintelligence.dev/api/sky/cell?lat=43.7&lon=-79.4&c=CA')
    const unplaced = await get('', claimed)
    expect(unplaced.status).toBe(200)
    expect((await unplaced.json()).location).toBeNull()
  })
})
