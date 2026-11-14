/**
 * A place for the sky: where the sun and the weather are read for. It comes
 * from the browser's time zone (time-zone-place.ts): no permission prompt,
 * nothing stored. Coordinates are rounded to one decimal place (about 11 km):
 * enough for the sun and the weather, kinder to privacy, and what MET Norway
 * asks for (it also makes their cache hit).
 */

export interface SkyLocation {
  lat: number
  lon: number
  city?: string
  /**
   * True when placed from the browser's time zone (its principal city): real
   * weather for a real place, but maybe not the person's own town.
   */
  approximate?: boolean
}

export function roundCoord(v: number): number {
  return Math.round(v * 10) / 10 + 0
}
