import { describe, expect, it } from 'vitest'
import { surroundingsFrom } from '../surroundings'
import { SKY_PRESETS } from '../dev-override'
import { CLEAR_SKY } from '../weather'
import { nextSunCrossing } from '../sun'
import type { SkyState } from '../sky-state'

const TORONTO: SkyState = {
  location: { lat: 43.65, lon: -79.38, city: 'Toronto' },
  city: 'Toronto',
  country: 'CA',
  weather: { ...SKY_PRESETS.rain, condition: 'Light rain', temperatureC: 9.4 },
  sunElevation: 30,
  phase: 'day',
  latitude: 43.65,
  longitude: -79.38,
  approximate: false,
  fetchedAt: '2026-10-09T16:00:00Z',
  ready: true,
  timeOverride: null,
}

describe('surroundingsFrom', () => {
  it('carries the reading, the city and the next sunset while the sun is up', () => {
    const s = surroundingsFrom(TORONTO, new Date('2026-10-09T16:00:00Z'))
    expect(s).toMatchObject({ condition: 'Light rain', temperatureC: 9.4, city: 'Toronto' })
    expect(s?.nextSun?.kind).toBe('sunset')
    expect(s?.nextSun?.at).toMatch(/^\d{2}:\d{2}$/)
  })

  it('names the next sunrise once the sun is down', () => {
    const now = new Date('2026-10-10T03:00:00Z')
    const s = surroundingsFrom({ ...TORONTO, sunElevation: -20, phase: 'night', fetchedAt: now.toISOString() }, now)
    expect(s?.nextSun?.kind).toBe('sunrise')
  })

  it('names the next sunrise just after sunset, even when the stored sun is minutes old', () => {
    const sunset = nextSunCrossing(new Date('2026-10-09T16:00:00Z'), TORONTO.latitude, TORONTO.longitude, 'set')!
    const twoMinutesLater = new Date(sunset.getTime() + 2 * 60_000)
    // The store last placed the sun before it set (it refreshes every five minutes).
    const s = surroundingsFrom({ ...TORONTO, sunElevation: 0.4, fetchedAt: sunset.toISOString() }, twoMinutesLater)
    expect(s?.nextSun?.kind).toBe('sunrise')
    const sunrise = nextSunCrossing(twoMinutesLater, TORONTO.latitude, TORONTO.longitude, 'rise')!
    const pad = (n: number) => String(n).padStart(2, '0')
    expect(s?.nextSun?.at).toBe(`${pad(sunrise.getHours())}:${pad(sunrise.getMinutes())}`)
  })

  it('names the next sunset just before it, even when the stored sun is minutes old', () => {
    const sunset = nextSunCrossing(new Date('2026-10-09T16:00:00Z'), TORONTO.latitude, TORONTO.longitude, 'set')!
    const now = new Date(sunset.getTime() - 2 * 60_000)
    const s = surroundingsFrom({ ...TORONTO, sunElevation: -2, fetchedAt: now.toISOString() }, now)
    expect(s?.nextSun?.kind).toBe('sunset')
  })

  it('sends nothing without a real reading', () => {
    expect(surroundingsFrom({ ...TORONTO, fetchedAt: null })).toBeNull()
    expect(surroundingsFrom({ ...TORONTO, approximate: true, location: null })).toBeNull()
    expect(surroundingsFrom({ ...TORONTO, weather: CLEAR_SKY })).toBeNull()
  })

  it('sends nothing from a reading three hours old or more', () => {
    const fetched = new Date('2026-10-09T16:00:00Z')
    const later = (ms: number) => new Date(fetched.getTime() + ms)
    expect(surroundingsFrom(TORONTO, later(3 * 60 * 60_000 - 60_000))).not.toBeNull()
    expect(surroundingsFrom(TORONTO, later(3 * 60 * 60_000))).toBeNull()
    expect(surroundingsFrom(TORONTO, later(26 * 60 * 60_000))).toBeNull()
    expect(surroundingsFrom({ ...TORONTO, fetchedAt: 'not a date' }, fetched)).toBeNull()
  })

  it('leaves the city out when there is none', () => {
    const s = surroundingsFrom({ ...TORONTO, city: null }, new Date('2026-10-09T16:00:00Z'))
    expect(s && 'city' in s).toBe(false)
  })
})
