import { describe, expect, it } from 'vitest'
import { nextSunCrossing, solarPosition } from '../sun'

/** Sunrise/sunset is the instant the geometric elevation crosses -0.833° (refraction + the disc's radius). */
const HORIZON = -0.833

const at = (iso: string) => new Date(iso)

describe('solarPosition', () => {
  it('peaks at 90° minus the latitude on an equinox', () => {
    let peak = -90
    for (let minute = 0; minute < 1440; minute += 2) {
      const d = new Date(Date.UTC(2024, 2, 20, 0, minute))
      peak = Math.max(peak, solarPosition(d, 40, 0).elevation)
    }
    expect(peak).toBeGreaterThan(49.5)
    expect(peak).toBeLessThan(50.5)
  })

  it('stands due south at local solar noon in the northern hemisphere', () => {
    // Greenwich, equation of time is about -7 min on the March equinox.
    const { azimuth, elevation } = solarPosition(at('2024-03-20T12:07:00Z'), 51.48, 0)
    expect(Math.abs(azimuth - 180)).toBeLessThan(2)
    expect(elevation).toBeGreaterThan(38)
  })

  it('is well below the horizon at local midnight', () => {
    expect(solarPosition(at('2024-03-20T00:00:00Z'), 40, 0).elevation).toBeLessThan(-40)
    // New York midnight EDT = 04:00 UTC.
    expect(solarPosition(at('2024-06-21T04:00:00Z'), 40.71, -74.0).elevation).toBeLessThan(-20)
  })

  it('rises and sets in London on the June solstice within a few minutes of the almanac', () => {
    const lat = 51.5074
    const lon = -0.1278
    // Almanac: sunrise 04:43 BST (03:43 UTC), sunset 21:21 BST (20:21 UTC).
    expect(solarPosition(at('2024-06-21T03:38:00Z'), lat, lon).elevation).toBeLessThan(HORIZON)
    expect(solarPosition(at('2024-06-21T03:48:00Z'), lat, lon).elevation).toBeGreaterThan(HORIZON)
    expect(solarPosition(at('2024-06-21T20:16:00Z'), lat, lon).elevation).toBeGreaterThan(HORIZON)
    expect(solarPosition(at('2024-06-21T20:26:00Z'), lat, lon).elevation).toBeLessThan(HORIZON)
  })

  it('rises in the east and sets in the west', () => {
    const lat = 51.5074
    const lon = -0.1278
    const morning = solarPosition(at('2024-06-21T03:43:00Z'), lat, lon).azimuth
    const evening = solarPosition(at('2024-06-21T20:21:00Z'), lat, lon).azimuth
    expect(morning).toBeGreaterThan(30)
    expect(morning).toBeLessThan(70)
    expect(evening).toBeGreaterThan(290)
    expect(evening).toBeLessThan(330)
  })
})

describe('nextSunCrossing', () => {
  // Toronto: sunset on 2026-10-09 about 18:43, sunrise on the 10th about 07:22 (EDT, UTC-4).
  const LAT = 43.65
  const LON = -79.38
  const minutesUtc = (d: Date | null) => (d ? d.getUTCHours() * 60 + d.getUTCMinutes() : NaN)

  it('finds the next sunset and sunrise to within a few minutes', () => {
    const noon = new Date('2026-10-09T16:00:00Z')
    expect(Math.abs(minutesUtc(nextSunCrossing(noon, LAT, LON, 'set')) - (22 * 60 + 43))).toBeLessThanOrEqual(3)
    const evening = new Date('2026-10-10T01:00:00Z')
    const rise = nextSunCrossing(evening, LAT, LON, 'rise')
    expect(rise?.toISOString().slice(0, 10)).toBe('2026-10-10')
    expect(Math.abs(minutesUtc(rise) - (11 * 60 + 22))).toBeLessThanOrEqual(4)
  })

  it('lands on the horizon, after the start', () => {
    const from = new Date('2026-10-09T16:00:00Z')
    const set = nextSunCrossing(from, LAT, LON, 'set')!
    expect(set.getTime()).toBeGreaterThan(from.getTime())
    expect(Math.abs(solarPosition(set, LAT, LON).elevation - HORIZON)).toBeLessThan(0.05)
  })

  it('is null in the polar night', () => {
    expect(nextSunCrossing(new Date('2026-12-21T12:00:00Z'), 80, 15, 'rise')).toBeNull()
  })
})
