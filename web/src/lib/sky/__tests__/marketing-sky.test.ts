/**
 * The signed-out pages' wash: one number per theme that only lowers the final
 * mix's strength, so it can't depend on where on the screen a pixel is. The
 * shader's only use of that strength is the last mix over the surface, and
 * the static gradient is that same mix at its two stops.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mix } from '../palette'
import { computeSkyScene, WASHED_STRENGTH_CAP, washedStrength } from '../scene'
import { SKY_PRESETS } from '../dev-override'
import {
  MARKETING_SKY_WASH,
  NEUTRAL_DAY_GRADIENTS,
  PAGE_SURFACE_DARK,
  PAGE_SURFACE_LIGHT,
  cssRgb,
  marketingGradients,
  parseWashOverride,
  skyGradientCss,
} from '../marketing-sky'

describe('marketing sky wash', () => {
  it('is a scalar on the strength: strength * (1 - wash), clamped, from at most a day sky\'s strength', () => {
    expect(washedStrength(0.8, 0)).toBe(0.8)
    expect(washedStrength(0.7, 0.5)).toBeCloseTo(0.35)
    // The light theme's stronger night is not carried under text.
    expect(washedStrength(0.92, 0.5)).toBeCloseTo(WASHED_STRENGTH_CAP * 0.5)
    expect(WASHED_STRENGTH_CAP).toBeLessThanOrEqual(0.76)
    expect(washedStrength(0.8, 1)).toBe(0)
    expect(washedStrength(0.8, -1)).toBe(0.8)
    expect(washedStrength(0.8, 2)).toBe(0)
    for (const w of MARKETING_SKY_WASH) {
      expect(w).toBeGreaterThan(0)
      expect(w).toBeLessThan(1)
    }
  })

  it('equals laying the surface over the sky at opacity `wash`, for any colour at any point', () => {
    const surface = PAGE_SURFACE_LIGHT
    const strength = 0.76
    const wash = MARKETING_SKY_WASH[0]
    for (const sky of [[0.1, 0.2, 0.6], [0.9, 0.7, 0.4], [0.5, 0.5, 0.5]] as const) {
      const drawn = mix(surface, sky, washedStrength(strength, wash))
      const overlaid = mix(mix(surface, sky, strength), surface, wash)
      for (let i = 0; i < 3; i++) expect(drawn[i]).toBeCloseTo(overlaid[i], 10)
    }
  })

  it('reaches the shader only as the uniform strength of its last mix: nothing that depends on x or y', () => {
    const shader = readFileSync(join(process.cwd(), 'src/components/sky/sky-shader.ts'), 'utf8')
    const uses = shader.split('\n').filter((l) => l.includes('uStrength') && !l.trim().startsWith('*'))
    expect(uses.map((l) => l.trim())).toEqual(['uniform float uStrength;', 'vec3 outc = mix(uBg, col, uStrength);'])
  })

  it("gives the static gradient the same mix at its stops, per theme", () => {
    const source = { weather: SKY_PRESETS.clear, latitude: 40.7, longitude: -74, minuteOfDay: 12 * 60 }
    const now = new Date(2026, 9, 10, 9, 0)
    const g = marketingGradients(source, now)
    const date = new Date(2026, 9, 10, 12, 0)
    const light = computeSkyScene({ date, latitude: 40.7, longitude: -74, weather: SKY_PRESETS.clear, dark: false })
    const dark = computeSkyScene({ date, latitude: 40.7, longitude: -74, weather: SKY_PRESETS.clear, dark: true })
    expect(g.light).toBe(skyGradientCss(light, PAGE_SURFACE_LIGHT, washedStrength(light.strength, MARKETING_SKY_WASH[0])))
    expect(g.dark).toBe(skyGradientCss(dark, PAGE_SURFACE_DARK, washedStrength(dark.strength, MARKETING_SKY_WASH[1])))
    expect(g.light).toMatch(/^linear-gradient\(to top, rgb\(\d+ \d+ \d+\), rgb\(\d+ \d+ \d+\)\)$/)
    // A stronger wash moves both stops toward the page background.
    const washed = marketingGradients(source, now, [0.9, 0.9])
    const top = mix(PAGE_SURFACE_LIGHT, light.top, washedStrength(light.strength, 0.9))
    expect(washed.light).toContain(cssRgb(top))
  })

  it('has a neutral daytime sky for the server: a blue that reads as day in both themes', () => {
    const rgb = (css: string) => [...css.matchAll(/rgb\((\d+) (\d+) (\d+)\)/g)].map((m) => m.slice(1).map(Number))
    const [lightHorizon, lightTop] = rgb(NEUTRAL_DAY_GRADIENTS.light)
    const [, darkTop] = rgb(NEUTRAL_DAY_GRADIENTS.dark)
    expect(lightTop[2]).toBeGreaterThan(lightTop[0]) // blue over red
    expect(lightHorizon[2]).toBeGreaterThanOrEqual(lightHorizon[0])
    expect(darkTop[2]).toBeGreaterThan(darkTop[0])
  })

  it('parses the dev wash override strictly', () => {
    expect(parseWashOverride('?skyWash=0.4')).toEqual([0.4, 0.4])
    expect(parseWashOverride('?skyWash=0.5,0.3')).toEqual([0.5, 0.3])
    for (const bad of ['', '?skyWash=', '?skyWash=2', '?skyWash=-0.1', '?skyWash=a', '?skyWash=0.1,0.2,0.3']) {
      expect(parseWashOverride(bad)).toBeNull()
    }
  })
})
