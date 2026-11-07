/**
 * Where the request comes from, from Vercel's IP geolocation headers: no
 * permission prompt, nothing stored. Coordinates are rounded to one decimal
 * place (about 11 km): enough for the sun and the weather, kinder to privacy,
 * and what MET Norway asks for (it also makes their cache hit).
 */

export interface SkyLocation {
  lat: number
  lon: number
  city?: string
  /**
   * True when placed from the browser's time zone (its principal city), not
   * from the request's IP: real weather for a real place, but maybe not
   * the person's own town.
   */
  approximate?: boolean
}

export function roundCoord(v: number): number {
  return Math.round(v * 10) / 10 + 0
}

export function locationFromHeaders(headers: Pick<Headers, 'get'>): SkyLocation | null {
  const lat = Number.parseFloat(headers.get('x-vercel-ip-latitude') ?? '')
  const lon = Number.parseFloat(headers.get('x-vercel-ip-longitude') ?? '')
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const location: SkyLocation = { lat: roundCoord(lat), lon: roundCoord(lon) }
  const rawCity = headers.get('x-vercel-ip-city')
  if (rawCity) {
    try {
      location.city = decodeURIComponent(rawCity)
    } catch {
      location.city = rawCity
    }
  }
  return location
}

/**
 * The request's country (ISO 3166-1 alpha-2, from `x-vercel-ip-country`), or
 * null. Only for the temperature unit people expect where they are.
 */
export function countryFromHeaders(headers: Pick<Headers, 'get'>): string | null {
  const raw = headers.get('x-vercel-ip-country')?.trim().toUpperCase() ?? ''
  return /^[A-Z]{2}$/.test(raw) ? raw : null
}
