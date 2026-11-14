/**
 * GET /api/account/sky — where the person roughly is, its country (for the
 * temperature unit) and the weather there, for the Sky background and the empty
 * chat's conditions line. Not a model call. Weather failures degrade to the
 * clear-sky default, never an error. The place is the principal city of the
 * client's IANA time zone (`?tz=America/Toronto`), marked `approximate`, with
 * the real weather there. Without a known zone, location is null and the client
 * places the sun from its own UTC offset.
 */

import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { fetchSkyWeather } from '@/lib/sky/met-norway'
import { placeFromTimeZone } from '@/lib/sky/time-zone-place'
import { CLEAR_SKY } from '@/lib/sky/weather'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth

  const place = placeFromTimeZone(new URL(request.url).searchParams.get('tz'))
  const location = place?.location ?? null
  const country = place?.country ?? null
  const weather = location ? await fetchSkyWeather(location.lat, location.lon) : CLEAR_SKY

  return NextResponse.json(
    { location, country, weather, fetchedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'private, max-age=900' } },
  )
}
