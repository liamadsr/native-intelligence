/**
 * The weather provider: MET Norway Locationforecast 2.0, server side only.
 * Free for commercial use under CC BY 4.0 / NLOD (credited in Preferences →
 * Background, where the Sky option is chosen). Their terms, all kept here:
 *   - a descriptive User-Agent with contact details,
 *   - coordinates rounded (the caller passes 1-decimal coordinates),
 *   - cached: honour `Expires`, never sooner than MIN_CACHE_MS per coordinate.
 * The Next data cache (shared across instances on Vercel) holds the response
 * for 30 minutes, and an in-memory map in front of it honours `Expires`.
 *
 * Swap the provider by replacing fetchSkyWeather: the rest of the sky only
 * knows SkyWeather. It never throws: any failure is the clear-sky default.
 */

import 'server-only'
import { CLEAR_SKY, skyWeatherFromMetNorway, type SkyWeather } from './weather'

/**
 * `complete`, not `compact`: only `complete` splits the clouds into low,
 * medium and high layers (and carries the fog fraction). Compact's single
 * total counts thin high cirrus as cloud, which drew a blue sky as overcast.
 * The body is larger (about 60 KB against 41 KB raw, ~4.7 KB against ~2.9 KB
 * gzipped, for New York in October 2026), fetched at most once per ~11 km
 * cell per 30 minutes to 2 hours, server side, behind the caches below.
 */
const ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/complete'
const USER_AGENT = 'Dial8/1.0 https://dial8.ai'
const MIN_CACHE_MS = 30 * 60_000
const MAX_CACHE_MS = 2 * 60 * 60_000
/** A failure is remembered briefly, so a MET outage isn't hammered by every refresh. */
const FAILURE_CACHE_MS = 5 * 60_000
const TIMEOUT_MS = 4_000
const MAX_ENTRIES = 2_000

const cache = new Map<string, { weather: SkyWeather; until: number }>()

export async function fetchSkyWeather(lat: number, lon: number): Promise<SkyWeather> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && hit.until > now) return hit.weather

  let weather: SkyWeather = CLEAR_SKY
  let until = now + FAILURE_CACHE_MS
  try {
    const res = await fetch(`${ENDPOINT}?lat=${lat.toFixed(1)}&lon=${lon.toFixed(1)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: MIN_CACHE_MS / 1000 },
    })
    if (res.ok) {
      const mapped = skyWeatherFromMetNorway(await res.json())
      if (mapped) {
        weather = mapped
        const expires = Date.parse(res.headers.get('expires') ?? '')
        const ttl = Number.isFinite(expires) ? expires - now : MIN_CACHE_MS
        until = now + Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, ttl))
      }
    }
  } catch {
    // Timeout, network, bad JSON: the clear-sky default.
  }

  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k)
    if (cache.size >= MAX_ENTRIES) cache.clear()
  }
  cache.set(key, { weather, until })
  return weather
}
