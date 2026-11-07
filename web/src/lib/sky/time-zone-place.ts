/**
 * Where a request roughly is from the browser's IANA time zone alone, for
 * when there is no IP geolocation (local dev, and in production whenever
 * Vercel's headers are missing): the zone's principal city from tzdata
 * ("America/Toronto" → Toronto), so the sky still gets real weather and a
 * real sun. Marked `approximate`: a zone spans far more than one city.
 *
 * Strict: the name must be in the bundled table (time-zone-places.ts,
 * generated from tzdata) exactly as given, or a legacy alias of one.
 */

import { roundCoord, type SkyLocation } from './location'
import { TIME_ZONE_ALIASES, TIME_ZONE_PLACES } from './time-zone-places'

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** The time zone's place and its country, or null for anything not in the table. */
export function placeFromTimeZone(tz: string | null | undefined): { location: SkyLocation; country: string } | null {
  if (typeof tz !== 'string' || tz.length > 64) return null
  const zone = has(TIME_ZONE_PLACES, tz) ? tz : has(TIME_ZONE_ALIASES, tz) ? TIME_ZONE_ALIASES[tz] : null
  if (!zone || !has(TIME_ZONE_PLACES, zone)) return null
  const [lat, lon, country] = TIME_ZONE_PLACES[zone]
  const city = zone.slice(zone.lastIndexOf('/') + 1).replace(/_/g, ' ')
  return { location: { lat: roundCoord(lat), lon: roundCoord(lon), city, approximate: true }, country }
}
