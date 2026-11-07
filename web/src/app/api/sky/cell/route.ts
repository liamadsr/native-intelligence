/**
 * GET /api/sky/cell?lat=43.7&lon=-79.4[&c=CA] — the weather for one ~11 km
 * cell, public and cacheable: what GET /api/sky redirects to. The same JSON
 * shape as /api/account/sky (`{ location, country, weather, fetchedAt }`),
 * with no city (the marketing pages never show it). Not a model call.
 *
 * Caching, three layers deep: Vercel's CDN keeps each cell's answer for 30
 * minutes and serves it stale for an hour more while it refreshes; behind it,
 * fetchSkyWeather's per-cell memory and the Next data cache keep MET Norway's
 * answer for 30 minutes to 2 hours. A failed weather fetch (the clear-sky
 * default, which has no condition) is cached for five minutes only.
 *
 * Abuse: anyone can ask for any cell. The query must be the cell's one
 * spelling (public-cell.ts): anything else is redirected there (or refused
 * when it isn't a cell at all), so the CDN holds one entry per cell and MET
 * sees at most one request per cell per half hour per instance, never one per
 * visitor.
 */

import { NextResponse } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { fetchSkyWeather } from '@/lib/sky/met-norway'
import {
  CELL_CACHE,
  CELL_CANONICAL_REDIRECT_CACHE,
  CELL_FAILURE_CACHE,
  cellUrl,
  parseCellQuery,
} from '@/lib/sky/public-cell'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = parseCellQuery(url.searchParams)
  if (!parsed) {
    const res = badRequest('lat and lon must be decimal numbers; c, when given, a two-letter country')
    res.headers.set('Cache-Control', 'public, s-maxage=86400')
    return res
  }
  const { cell, canonical } = parsed
  if (!canonical) {
    const res = NextResponse.redirect(new URL(cellUrl(cell), request.url), 308)
    res.headers.set('Cache-Control', CELL_CANONICAL_REDIRECT_CACHE)
    return res
  }

  const weather = await fetchSkyWeather(cell.lat, cell.lon)
  return NextResponse.json(
    { location: { lat: cell.lat, lon: cell.lon }, country: cell.country, weather, fetchedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': weather.condition === null ? CELL_FAILURE_CACHE : CELL_CACHE } },
  )
}
