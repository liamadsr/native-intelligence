import { describe, expect, it } from 'vitest'
import { getSkyState, receiveSkyResponse } from '../sky-state'
import { SKY_PRESETS } from '../dev-override'

describe('sky state', () => {
  it('starts on the clear default, approximate, with no reading', () => {
    const s = getSkyState()
    expect(s.fetchedAt).toBeNull()
    expect(s.approximate).toBe(true)
    expect(s.weather.condition).toBeNull()
    expect(s.city).toBeNull()
  })

  it('takes the server answer: location, city, weather, and the sun there', () => {
    receiveSkyResponse({ location: { lat: 51.5, lon: -0.1, city: 'London' }, weather: SKY_PRESETS.rain, fetchedAt: '2026-10-09T12:00:00Z' })
    const s = getSkyState()
    expect(s.approximate).toBe(false)
    expect(s.city).toBe('London')
    expect(s.latitude).toBe(51.5)
    expect(s.weather.condition).toBe('Rain')
    expect(['night', 'dawn', 'day', 'golden', 'dusk']).toContain(s.phase)
    expect(Number.isFinite(s.sunElevation)).toBe(true)
  })
})
