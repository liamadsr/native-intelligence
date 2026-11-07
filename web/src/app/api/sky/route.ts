/**
 * GET /api/sky — the public front door of the sky, for the signed-out pages
 * (landing, blog). No auth. Where the request is comes from Vercel's IP
 * geolocation headers (or, without them, a validated `?tz=` IANA zone's
 * principal city); it is rounded to its ~11 km cell and the browser is
 * redirected (307) to GET /api/sky/cell for that cell, which the CDN caches.
 *
 * This answer depends on the request's own headers, so it is never cached by
 * the CDN (`private`). Only the cell's coordinates and the country go in the
 * redirect: no city, no IP. With no place at all it answers directly: no
 * location and the clear-sky default, the same shape as the cell.
 */

import { NextResponse } from 'next/server'
import { countryFromHeaders, locationFromHeaders } from '@/lib/sky/location'
import { cellUrl } from '@/lib/sky/public-cell'
import { placeFromTimeZone } from '@/lib/sky/time-zone-place'
import { CLEAR_SKY } from '@/lib/sky/weather'

export const dynamic = 'force-dynamic'

const PRIVATE = 'private, max-age=900'

export async function GET(request: Request) {
  let location = locationFromHeaders(request.headers)
  let country = countryFromHeaders(request.headers)
  if (!location) {
    const place = placeFromTimeZone(new URL(request.url).searchParams.get('tz'))
    if (place) {
      location = place.location
      country ??= place.country
    }
  }
  if (!location) {
    return NextResponse.json(
      { location: null, country, weather: CLEAR_SKY, fetchedAt: new Date().toISOString() },
      { headers: { 'Cache-Control': PRIVATE } },
    )
  }
  const target = new URL(cellUrl({ lat: location.lat, lon: location.lon, country }), request.url)
  const res = NextResponse.redirect(target, 307)
  res.headers.set('Cache-Control', PRIVATE)
  return res
}
