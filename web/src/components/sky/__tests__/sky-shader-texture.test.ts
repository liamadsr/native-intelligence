/**
 * The clear sky's texture, read as source: brighter and whiter toward the sun
 * and deepest about 90° from it; haze strata stretched far along x and low in
 * the view; a low-frequency texture with bounded amplitude; all of it at most
 * one extra noise call, and none of it cloud. Then the close-up cloud every
 * dry sky has (its wisps, its light, its cost), the twilight glow round the
 * sky, the city skyglow, and no stars.
 */
import { describe, expect, it } from 'vitest'
import {
  CLOSEUP_WISP_ALPHA,
  GLOW_FLOOR,
  SKY_FRAGMENT,
  SKY_STRATA_DARK,
  SKY_STRATA_LIGHT,
  SKY_STRATA_TOP_DEG,
  SKY_STRATA_X,
  SKY_STRATA_Y,
  SKY_SUN_BRIGHT,
  SKY_SUN_DEEP,
  SKY_SUN_SAT,
  SKY_TEXTURE_HUE,
  SKY_TEXTURE_LUMA,
} from '../sky-shader'
import { WISP_COVER } from '@/lib/sky/cloud-closeup'
import { BASE_VEIL } from '@/lib/sky/scene'

const main = SKY_FRAGMENT.slice(SKY_FRAGMENT.indexOf('void main()'))
const between = (from: string, to: string) => main.slice(main.indexOf(from), main.indexOf(to))
const noiseCalls = (src: string) => (src.match(/\bnoise\(/g) ?? []).length
const gnoiseCalls = (src: string) => (src.match(/\bgnoise\(/g) ?? []).length

describe('sky shader texture', () => {
  it('has a sun-relative brightness term: up toward the sun, down about 90° from it, from the angle to the sun', () => {
    const sun = between('float sp = uTex.x;', 'float ta = uTex.y;')
    expect(sun).toContain('float cg2 = cosG * cosG;')
    expect(sun).toMatch(/float toward = exp\(-gamma \* [\d.]+\);/)
    expect(sun).toContain('float perp = 1.0 - cg2;')
    expect(sun).toContain('col *= 1.0 + sp * (SUN_BRIGHT * toward + 0.02 * cg2 - SUN_DEEP * perp);')
    // More saturated about 90° from the sun, whiter toward it.
    expect(sun).toMatch(/mix\(vec3\(lum\), col, 1\.0 \+ sp \* \(SUN_SAT \* perp - [\d.]+ \* toward\)\)/)
    expect(SKY_FRAGMENT).toContain(`#define SUN_BRIGHT ${SKY_SUN_BRIGHT.toFixed(3)}`)
    // Before the twilight glow, which keeps its own colours.
    expect(main.indexOf('float sp = uTex.x;')).toBeLessThan(main.indexOf('float twi = uTwi.x;'))
  })

  it('keeps the sun-relative pattern within a few percent', () => {
    // Brightest at the sun (where the glow is anyway), darkest at 90°.
    expect(SKY_SUN_BRIGHT + 0.02).toBeLessThanOrEqual(0.15)
    expect(SKY_SUN_DEEP).toBeLessThanOrEqual(0.08)
    expect(SKY_SUN_SAT).toBeLessThanOrEqual(0.25)
  })

  it('draws anisotropic haze strata: one noise call, far wider in x than in y, on a log-elevation coordinate, low in the view', () => {
    const strata = between('float sa = uTex.z;', '// The close-up cloud')
    expect(noiseCalls(strata)).toBe(1)
    expect(strata).toContain('noise(vec2(az * STRATA_X + drift.x * 0.03 + 7.3, log(h + 1.5) * STRATA_Y + 1.9))')
    expect(SKY_FRAGMENT).toContain(`#define STRATA_X ${SKY_STRATA_X.toFixed(3)}`)
    expect(SKY_FRAGMENT).toContain(`#define STRATA_Y ${SKY_STRATA_Y.toFixed(3)}`)
    // Noise cells per degree: across (per degree of azimuth) vs up (per degree
    // of elevation at the horizon and at 8°): stretched far along x.
    const xPerDeg = SKY_STRATA_X * (Math.PI / 180)
    const yPerDegAtHorizon = SKY_STRATA_Y / 1.5
    const yPerDegAt8 = SKY_STRATA_Y / (8 + 1.5)
    expect(yPerDegAtHorizon / xPerDeg).toBeGreaterThan(40)
    expect(yPerDegAt8 / xPerDeg).toBeGreaterThan(10)
    // Only in the lowest part of the view.
    expect(strata).toContain('(1.0 - smoothstep(STRATA_TOP * 0.35, STRATA_TOP, elD))')
    expect(SKY_STRATA_TOP_DEG).toBeLessThanOrEqual(15)
    // Drifts with the existing drift: no new motion.
    expect(strata).not.toMatch(/uTime/)
  })

  it('keeps the strata a few percent: lighter toward their sunlit colour, darker by a few percent, never cloud-strong', () => {
    const strata = between('float sa = uTex.z;', '// The close-up cloud')
    expect(strata).toContain('col = mix(col, lit, max(st, 0.0) * STRATA_LIGHT);')
    expect(strata).toContain('col *= 1.0 + min(st, 0.0) * STRATA_DARK;')
    expect(strata).toContain('vec3 lit = mix(col, uSunCol, 0.3 + 0.3 * side) * 1.04;')
    expect(SKY_STRATA_DARK).toBeLessThanOrEqual(0.06)
    // At most 0.6 of the way toward a lit colour that is itself at most 60%
    // sun colour: well under even a wisp's opacity.
    expect(SKY_STRATA_LIGHT * 0.6).toBeLessThanOrEqual(0.36)
    expect(SKY_STRATA_LIGHT * 0.6).toBeLessThan(CLOSEUP_WISP_ALPHA)
  })

  it('bounds the low-frequency texture: about ±4% luminance at most, a slight hue drift, reusing its own noise', () => {
    const tex = between('float ta = uTex.y;', 'float twi = uTwi.x;')
    expect(noiseCalls(tex)).toBe(1)
    expect(tex).toContain('col *= 1.0 + tex * TEX_LUMA * ta;')
    expect(tex).toContain('col *= 1.0 + vec3(1.0, 0.15, -1.0) * (TEX_HUE * ta * warm);')
    // The hue drift is warped by the same noise value (no second noise call).
    expect(tex).toMatch(/float warm = sin\([^;]*tex \* [\d.]+/)
    // tex is noise - 0.5, so the luminance swing is at most ±TEX_LUMA / 2.
    expect(SKY_TEXTURE_LUMA / 2).toBeGreaterThanOrEqual(0.03)
    expect(SKY_TEXTURE_LUMA / 2).toBeLessThanOrEqual(0.045)
    expect(SKY_TEXTURE_HUE).toBeLessThanOrEqual(0.03)
    // Screen-sized patches: about one noise cell per screen height.
    expect(tex).toMatch(/noise\(p \* (0\.\d+|1\.0) /)
  })

  it('adds at most one noise call to a clear sky beyond its cloud', () => {
    // A clear sky runs everything outside the fog and precipitation branches:
    // the luminance texture's noise (as before) and the strata's; its cloud is
    // the close-up's gradient noise, counted below.
    const clear = main.slice(0, main.indexOf('if (uFog > 0.0)'))
    expect(noiseCalls(clear)).toBe(2)
  })

  it('draws the close-up cloud in every sky the scene gives a veil: a clear one a few translucent wisps', () => {
    const cloud = between('float amount = ', '// Fog:')
    expect(main).toContain('float amount = max(uCover, uVeil.x * WISP_COVER);')
    expect(cloud).toContain('if (amount > 0.01) {')
    // A clear sky's floor of thin cloud is drawn (a few wisps, about a fifth
    // cover at most), and is see-through.
    expect(BASE_VEIL * WISP_COVER).toBeGreaterThan(0.01)
    expect(BASE_VEIL * WISP_COVER).toBeLessThan(0.25)
    expect(cloud).toContain('float thin = 1.0 - smoothstep(0.05, 0.25, uCover);')
    expect(cloud).toContain('fa * mix(SOLID_ALPHA, WISP_ALPHA, thin)')
    // Lit by the sky: the glow at dusk, the skyglow at night, the sun's colour by day.
    expect(cloud).toContain('uGlow')
    expect(cloud).toContain('uSkyglow')
    expect(cloud).toContain('uSunCol * glow')
  })

  it("lights the near cloud from the light's side: density summed toward the light, through Beer's law", () => {
    const cloud = between('float amount = ', '// Fog:')
    // Toward the sun, from below once it is down, from above under a full deck.
    expect(cloud).toContain('vec2 toSun = vec2(uSun.x * aspect, uSun.y) - p;')
    expect(cloud).toContain('- vec2(0.0, night)')
    expect(cloud).toMatch(/L = mix\(L, vec2\(0\.0, 1\.0\), smoothstep\(0\.6, 1\.0, uCover\)/)
    expect(cloud).toContain('float lightT = exp(-od * ABSORB * relief);')
    // Every light sample is compared with the same octaves of the density
    // (an octave in one and not the other shows as hairlines).
    expect(cloud).toContain('vec4 fN = cloudFbm(fq + fw, et, 6, puff) * FBM_NORM;')
    expect(cloud).toMatch(/float f1 = cloudFbm\([^;]*, et, 4, puff\)\.z \* FBM_NORM;/)
    expect(cloud).toContain('(fN.z - f1)')
    expect(cloud).toMatch(/float ns = cloudFbm\([^;]*, et, 3, puff\)\.y \* FBM_NORM;/)
  })

  it('bounds the close-up cloud: at most 34 gradient-noise calls a pixel, none in fog or precipitation branches', () => {
    const cloud = between('float amount = ', '// Fog:')
    // Calls written out: two warps of two each, then the cloudFbm calls by
    // their octave counts (the light march's call runs four times).
    expect(gnoiseCalls(cloud)).toBe(4)
    const fbmOctaves = [...cloud.matchAll(/cloudFbm\([^;]*?, et, (\d), puff\)/g)].map((m) => Number(m[1]))
    expect(fbmOctaves.sort()).toEqual([2, 2, 3, 4, 4, 6])
    const marchSteps = 4
    expect(cloud).toContain(`for (int k = 1; k <= ${marchSteps}; k++) {`)
    const total = gnoiseCalls(cloud) + fbmOctaves.reduce((a, b) => a + b, 0) + 3 * (marchSteps - 1)
    expect(total).toBe(34)
  })

  it('has no stars', () => {
    expect(SKY_FRAGMENT).not.toContain('uStars')
    expect(main).not.toMatch(/\bstar\b/)
  })

  it('reaches some of the twilight glow round the sky, the city skyglow low, and a longer ramp from sunset', () => {
    expect(main).toContain('float gw = twi * mix(GLOW_FLOOR * (1.0 - smoothstep(-1.0 * DEG, 4.0 * DEG, uSunDir.x)), 1.0, side)')
    expect(GLOW_FLOOR).toBeGreaterThan(0)
    expect(GLOW_FLOOR).toBeLessThan(0.5)
    expect(main).toContain('col = mix(col, uSkyglow.rgb, sg);')
    expect(main).toMatch(/float hz = mix\([^;]*uVeil\.y\);/)
  })

  it('takes its amounts from the scene (uTex)', () => {
    expect(SKY_FRAGMENT).toContain('uniform vec3 uTex;')
    expect(main).toContain('float sp = uTex.x;')
    expect(main).toContain('float ta = uTex.y;')
    expect(main).toContain('float sa = uTex.z;')
  })
})
