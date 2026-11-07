/**
 * GET /api/account/sky — where the person is (from Vercel's IP geolocation
 * headers, rounded to ~11 km), its country (for the temperature unit) and the
 * weather there, for the Sky background and the empty chat's conditions line.
 * Not a model call. Weather failures degrade to the clear-sky default, never
 * an error. With no geolocation headers (local dev, some previews) the
 * client's IANA time zone (`?tz=America/Toronto`) stands in: its principal
 * city, marked `approximate`, gets the real weather there. With neither,
 * location is null and the client places the sun from its own UTC offset.
 */

import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { countryFromHeaders, locationFromHeaders } from '@/lib/sky/location'
import { fetchSkyWeather } from '@/lib/sky/met-norway'
import { placeFromTimeZone } from '@/lib/sky/time-zone-place'
import { CLEAR_SKY } from '@/lib/sky/weather'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth

  let location = locationFromHeaders(request.headers)
  let country = countryFromHeaders(request.headers)
  if (!location) {
    const place = placeFromTimeZone(new URL(request.url).searchParams.get('tz'))
    if (place) {
      location = place.location
      country ??= place.country
    }
  }
  const weather = location ? await fetchSkyWeather(location.lat, location.lon) : CLEAR_SKY

  return NextResponse.json(
    { location, country, weather, fetchedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'private, max-age=900' } },
  )
}
