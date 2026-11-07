/**
 * The public sky's cells: the signed-out pages (landing, blog) get the sky
 * from GET /api/sky, which reads the request's place and redirects to the
 * cacheable GET /api/sky/cell for its ~11 km cell. The cell URL is the CDN's
 * cache key, so it has exactly one spelling per cell: `lat` and `lon` to one
 * decimal (clamped to the globe), then `c` (the country, two capital letters,
 * only when known), in that order and nothing else. Anything spelled
 * otherwise is redirected to that spelling, so junk parameters or extra
 * digits can't multiply the cache entries for one cell.
 *
 * No city goes in the URL: the marketing pages never show it.
 */

import { roundCoord } from './location'

export const PUBLIC_SKY_ENDPOINT = '/api/sky'
export const PUBLIC_SKY_CELL_PATH = '/api/sky/cell'

/** A cell's weather on the CDN: 30 minutes fresh, then an hour stale while it refreshes. */
export const CELL_CACHE = 'public, s-maxage=1800, stale-while-revalidate=3600'
/** The clear-sky default after a failed fetch: retried soon, not held for half an hour. */
export const CELL_FAILURE_CACHE = 'public, s-maxage=300, stale-while-revalidate=300'
/** A misspelled cell's redirect to its one spelling never changes. */
export const CELL_CANONICAL_REDIRECT_CACHE = 'public, max-age=86400, s-maxage=86400'

export interface SkyCell {
  lat: number
  lon: number
  /** ISO 3166-1 alpha-2, or null. */
  country: string | null
}

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v)

/** One decimal, always with the decimal ("43.0", not "43"), and never "-0.0". */
const fixed1 = (v: number) => roundCoord(v).toFixed(1)

/** A strict decimal number: no exponent, hex, Infinity, whitespace or empty string. */
const DECIMAL = /^-?\d{1,3}(\.\d{1,12})?$/

/** The cell's canonical query string (no leading `?`). */
export function cellQuery(cell: SkyCell): string {
  const q = `lat=${fixed1(cell.lat)}&lon=${fixed1(cell.lon)}`
  return cell.country ? `${q}&c=${cell.country}` : q
}

/** Where a cell's weather lives: the cacheable URL path with its canonical query. */
export function cellUrl(cell: SkyCell): string {
  return `${PUBLIC_SKY_CELL_PATH}?${cellQuery(cell)}`
}

/**
 * Read a cell from a request's query: `lat` and `lon` must be plain decimal
 * numbers (clamped to ±90 / ±180, rounded to one decimal); `c`, when present,
 * must be two letters. Null when `lat` / `lon` are missing or not numbers, or
 * `c` is malformed. `canonical` says whether the query was already spelled the
 * one way (the caller redirects when it isn't).
 */
export function parseCellQuery(search: URLSearchParams): { cell: SkyCell; canonical: boolean } | null {
  const latRaw = search.get('lat') ?? ''
  const lonRaw = search.get('lon') ?? ''
  if (!DECIMAL.test(latRaw) || !DECIMAL.test(lonRaw)) return null
  const lat = Number.parseFloat(latRaw)
  const lon = Number.parseFloat(lonRaw)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const cRaw = search.get('c')
  let country: string | null = null
  if (cRaw !== null) {
    if (!/^[A-Za-z]{2}$/.test(cRaw)) return null
    country = cRaw.toUpperCase()
  }
  const cell: SkyCell = { lat: roundCoord(clamp(lat, -90, 90)), lon: roundCoord(clamp(lon, -180, 180)), country }
  return { cell, canonical: search.toString() === cellQuery(cell) }
}
