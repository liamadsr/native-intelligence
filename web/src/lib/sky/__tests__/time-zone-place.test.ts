import { describe, expect, it } from 'vitest'
import { placeFromTimeZone } from '../time-zone-place'
import { TIME_ZONE_ALIASES, TIME_ZONE_PLACES } from '../time-zone-places'

describe('placeFromTimeZone', () => {
  it("places a zone at its principal city, rounded and marked approximate", () => {
    expect(placeFromTimeZone('America/Toronto')).toEqual({
      location: { lat: 43.7, lon: -79.4, city: 'Toronto', approximate: true },
      country: 'CA',
    })
  })

  it('names the city from the last part of the zone, underscores as spaces', () => {
    expect(placeFromTimeZone('America/Argentina/Buenos_Aires')?.location.city).toBe('Buenos Aires')
    expect(placeFromTimeZone('America/New_York')?.location.city).toBe('New York')
    expect(placeFromTimeZone('Europe/London')?.country).toBe('GB')
  })

  it('takes the legacy names browsers still report, as the zone they became', () => {
    expect(placeFromTimeZone('Asia/Calcutta')).toEqual(placeFromTimeZone('Asia/Kolkata'))
    expect(placeFromTimeZone('Europe/Kiev')?.location.city).toBe('Kyiv')
  })

  it('refuses anything not in the table, exactly as given', () => {
    for (const tz of [null, undefined, '', 'Mars/Olympus_Mons', 'america/toronto', 'America/Toronto ', 'UTC', 'EST5EDT', '../etc/passwd', '__proto__', 'constructor', 'toString', 'A'.repeat(200)]) {
      expect(placeFromTimeZone(tz)).toBeNull()
    }
  })

  it('has a sane table: every coordinate on the globe, every alias pointing at a zone', () => {
    const zones = Object.entries(TIME_ZONE_PLACES)
    expect(zones.length).toBeGreaterThan(300)
    for (const [, [lat, lon, cc]] of zones) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(lon)).toBeLessThanOrEqual(180)
      expect(cc).toMatch(/^[A-Z]{2}$/)
    }
    for (const target of Object.values(TIME_ZONE_ALIASES)) expect(TIME_ZONE_PLACES[target]).toBeDefined()
  })

  it("covers every zone this runtime's Intl reports", () => {
    const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
    const missing = supported.filter((tz) => tz !== 'UTC' && !placeFromTimeZone(tz))
    expect(missing).toEqual([])
  })
})
