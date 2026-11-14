/**
 * GET /api/sky — the public front door of the sky, for the signed-out pages
 * (landing, blog). No auth. The request is placed at the principal city of a
 * validated `?tz=` IANA zone; it is rounded to its ~11 km cell and the browser
 * is redirected (307) to GET /api/sky/cell for that cell, which can be cached.
 *
 * Only the cell's coordinates and the country go in the redirect: no city.
 * Without a known zone it answers directly: no location and the clear-sky
 * default, the same shape as the cell.
 */

import { NextResponse } from 'next/server'
import { cellUrl } from '@/lib/sky/public-cell'
import { placeFromTimeZone } from '@/lib/sky/time-zone-place'
import { CLEAR_SKY } from '@/lib/sky/weather'

export const dynamic = 'force-dynamic'

const PRIVATE = 'private, max-age=900'

export async function GET(request: Request) {
  const place = placeFromTimeZone(new URL(request.url).searchParams.get('tz'))
  const location = place?.location ?? null
  const country = place?.country ?? null
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
