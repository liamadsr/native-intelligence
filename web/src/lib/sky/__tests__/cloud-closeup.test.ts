import { describe, expect, it } from 'vitest'
import {
  CLOSEUP_BACK_SCALE,
  CLOSEUP_BACK_SPEED,
  CLOSEUP_FRONT_SCALE,
  CLOSEUP_FRONT_SPEED,
  WISP_COVER,
  closeUpAmount,
  closeUpCrossingSeconds,
  closeUpLightDir,
  closeUpThreshold,
} from '../cloud-closeup'
import { BASE_VEIL, computeSkyScene } from '../scene'
import { SKY_PRESETS } from '../dev-override'

/** The share of a standard normal above z (Abramowitz-Stegun 26.2.17). */
function above(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? p : 1 - p
}

const sceneFor = (key: keyof typeof SKY_PRESETS) =>
  computeSkyScene({ date: new Date(2026, 9, 18, 15, 0), latitude: 40.7, longitude: -74, weather: SKY_PRESETS[key], dark: false })

describe('close-up cloud', () => {
  it('gives every dry sky some cloud, and lets the forecast win once it has more', () => {
    expect(closeUpAmount(0, BASE_VEIL)).toBeCloseTo(BASE_VEIL * WISP_COVER)
    expect(closeUpAmount(0, BASE_VEIL)).toBeGreaterThan(0.1)
    expect(closeUpAmount(0.6, BASE_VEIL)).toBe(0.6)
    expect(closeUpAmount(1.4, 1)).toBe(1)
    expect(closeUpAmount(0, 0)).toBe(0)
  })

  it('covers about as much of the screen as the cover says: sparse when clear, closed when overcast', () => {
    const share = (amount: number) => above(closeUpThreshold(amount))
    // A clear sky's wisps: a small share, never a lid.
    const clear = share(closeUpAmount(sceneFor('clear').cloudCover, sceneFor('clear').veil))
    expect(clear).toBeGreaterThan(0.05)
    expect(clear).toBeLessThan(0.25)
    // Fair, partly cloudy: close to the forecast's cover.
    expect(share(0.25)).toBeGreaterThan(0.15)
    expect(share(0.25)).toBeLessThan(0.3)
    expect(share(0.6)).toBeGreaterThan(0.5)
    expect(share(0.6)).toBeLessThan(0.75)
    // A full deck has no holes.
    expect(share(0.97)).toBeGreaterThan(0.995)
    // More cover never means less cloud.
    for (let a = 0; a < 1; a += 0.05) expect(closeUpThreshold(a + 0.05)).toBeLessThan(closeUpThreshold(a))
  })

  it('drifts across the window at a calm, steady pace for every forecast', () => {
    for (const key of Object.keys(SKY_PRESETS) as Array<keyof typeof SKY_PRESETS>) {
      const s = sceneFor(key)
      // A wind straight toward or away from the viewer barely moves it sideways.
      if (Math.abs(s.windX) < 0.05) continue
      const secs = closeUpCrossingSeconds(s.windX, 16 / 10)
      expect(secs, key).toBeGreaterThan(20)
      expect(secs, key).toBeLessThan(70)
    }
    expect(closeUpCrossingSeconds(0, 1.6)).toBe(Infinity)
  })

  it('puts the farther layer smaller and slower behind the near cloud (parallax)', () => {
    expect(CLOSEUP_BACK_SCALE / CLOSEUP_FRONT_SCALE).toBeGreaterThan(1.5)
    expect(CLOSEUP_BACK_SPEED / CLOSEUP_FRONT_SPEED).toBeGreaterThan(0.3)
    expect(CLOSEUP_BACK_SPEED / CLOSEUP_FRONT_SPEED).toBeLessThan(0.8)
  })

  it('lights the cloud from the sun, from below at night, and from above under a full deck', () => {
    // The sun up and to the right of the point: the light comes from there.
    const [x, y] = closeUpLightDir([0.5, 0.5], [1.5, 1.5], 0)
    expect(x).toBeCloseTo(Math.SQRT1_2)
    expect(y).toBeCloseTo(Math.SQRT1_2)
    // A sun below the bottom edge (just set) lights the cloud from below.
    expect(closeUpLightDir([0.8, 0.6], [0.8, -0.2], 0)[1]).toBeCloseTo(-1)
    // Night: from below, the city's glow, wherever the sun is.
    expect(closeUpLightDir([0.5, 0.5], [2, 3], 1)).toEqual([0, -1])
    // A full deck by day: broadly from above, even with the sun off to the side.
    const [ox, oy] = closeUpLightDir([0.5, 0.5], [2.5, 0.5], 0, 1)
    expect(oy).toBeGreaterThan(0.95)
    expect(Math.abs(ox)).toBeLessThan(0.3)
    // Always a unit direction.
    const [ux, uy] = closeUpLightDir([0.2, 0.9], [1.1, 0.4], 0.4, 0.7)
    expect(Math.hypot(ux, uy)).toBeCloseTo(1)
  })
})
