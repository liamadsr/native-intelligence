// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { computeSkyScene } from '../scene'
import { markSkyTone, skyTone } from '../sky-tone'

const SURFACE = [0.96, 0.96, 0.96] as const
// Absolute instants (New York is UTC-4 in October), never the runner's local
// clock: the build runs in UTC, where a local "10 PM" is 6 PM in New York.
const at = (isoUtc: string) =>
  computeSkyScene({ date: new Date(isoUtc), latitude: 40.7, longitude: -74, weather: { cloudCover: 0.2, storm: false, fog: false, precip: 'none' } as never, dark: false })

describe('skyTone', () => {
  it('reads the app sky light by day and dark at night (New York, October)', () => {
    expect(skyTone(at('2026-10-18T16:00:00Z'), SURFACE)).toBe('light') // noon
    expect(skyTone(at('2026-10-18T20:00:00Z'), SURFACE)).toBe('light') // 4 PM
    expect(skyTone(at('2026-10-19T02:00:00Z'), SURFACE)).toBe('dark') // 10 PM
    expect(skyTone(at('2026-10-18T07:00:00Z'), SURFACE)).toBe('dark') // 3 AM
  })
})

describe('skyTone in the dark theme', () => {
  // The app's dark theme exposes the same weather for the dark (scene.ts
  // darkExposure) over the dark surface: it reads dark by day too, so what
  // sits on it takes the light ink.
  const DARK_SURFACE = [0.03, 0.03, 0.03] as const
  const dim = (isoUtc: string, cloudCover: number) =>
    computeSkyScene({ date: new Date(isoUtc), latitude: 40.7, longitude: -74, weather: { cloudCover, storm: false, fog: false, precip: 'none' } as never, dark: false, dim: true })
  it('reads dark at noon, clear or overcast, and at night', () => {
    expect(skyTone(dim('2026-10-18T16:00:00Z', 0.2), DARK_SURFACE)).toBe('dark')
    expect(skyTone(dim('2026-10-18T16:00:00Z', 0.97), DARK_SURFACE)).toBe('dark')
    expect(skyTone(dim('2026-10-19T02:00:00Z', 0.2), DARK_SURFACE)).toBe('dark')
  })
})

describe('markSkyTone', () => {
  afterEach(() => markSkyTone(null))
  it('marks <html> with the tone, and clears it', () => {
    markSkyTone('dark')
    expect(document.documentElement.dataset.skyTone).toBe('dark')
    markSkyTone('light')
    expect(document.documentElement.getAttribute('data-sky-tone')).toBe('light')
    markSkyTone(null)
    expect(document.documentElement.hasAttribute('data-sky-tone')).toBe(false)
  })
})
