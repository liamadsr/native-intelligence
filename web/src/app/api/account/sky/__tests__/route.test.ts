/**
 * GET /api/account/sky: the browser's time zone places the request, at its
 * principal city, approximate; without a known zone, no location and the
 * clear-sky default. Nothing in the request's headers places it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_SKY, type SkyWeather } from '@/lib/sky/weather'

const fetched: Array<[number, number]> = []
const RAIN: SkyWeather = { ...CLEAR_SKY, cloudCover: 0.9, precip: 'rain', precipIntensity: 0.5, condition: 'Rain', temperatureC: 9 }

vi.mock('@/lib/api-auth', () => ({ requireUser: async () => ({ user: { id: 'user-1' } }) }))
vi.mock('@/lib/sky/met-norway', () => ({
  fetchSkyWeather: async (lat: number, lon: number) => (fetched.push([lat, lon]), RAIN),
}))

import { GET } from '../route'

const get = async (query = '', headers: Record<string, string> = {}) =>
  (await GET(new Request(`https://nativeintelligence.dev/api/account/sky${query}`, { headers }))).json()

beforeEach(() => {
  fetched.length = 0
})

describe('GET /api/account/sky', () => {
  it("places the request at the time zone's principal city, approximate, with its real weather", async () => {
    const body = await get('?tz=America/Toronto')
    expect(body.location).toEqual({ lat: 43.7, lon: -79.4, city: 'Toronto', approximate: true })
    expect(body.country).toBe('CA')
    expect(fetched).toEqual([[43.7, -79.4]])
    expect(body.weather.condition).toBe('Rain')
  })

  it('takes no place from a header a client can send', async () => {
    const body = await get('?tz=Europe/Paris', { 'x-vercel-ip-latitude': '43.651', 'x-vercel-ip-longitude': '-79.383', 'x-vercel-ip-country': 'CA' })
    expect(body.location.city).toBe('Paris')
    expect(body.country).toBe('FR')
  })

  it('has no location and fetches nothing for an unknown time zone or none', async () => {
    for (const q of ['', '?tz=Mars/Base', '?tz=__proto__', '?tz=']) {
      const body = await get(q)
      expect(body.location).toBeNull()
      expect(body.weather).toEqual(CLEAR_SKY)
    }
    expect(fetched).toEqual([])
  })
})
