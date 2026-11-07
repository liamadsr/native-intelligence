/**
 * The shader's structure, read as source: no reading column anywhere (the sky
 * mixes over the surface the same everywhere), and the clouds seen close up
 * (lib/sky/cloud-closeup.ts): face on in screen units, two layers drifting
 * with the wind at their own pace.
 */
import { describe, expect, it } from 'vitest'
import {
  CLOSEUP_BACK_SCALE,
  CLOSEUP_BACK_SPEED,
  CLOSEUP_FRONT_SCALE,
  CLOSEUP_FRONT_SPEED,
} from '@/lib/sky/cloud-closeup'
import { SKY_FRAGMENT } from '../sky-shader'

const main = SKY_FRAGMENT.slice(SKY_FRAGMENT.indexOf('void main()'))

describe('sky shader', () => {
  it('has no reading column: the final mix over the surface depends on nothing across the screen', () => {
    expect(SKY_FRAGMENT).not.toMatch(/uScrim|inCol|scrim/i)
    expect(main).toContain('vec3 outc = mix(uBg, col, uStrength);')
    // Nothing after the last colour step reads the pixel's x.
    const tail = main.slice(main.indexOf('col *= 1.0 - uStorm'))
    expect(tail).not.toMatch(/frag\.x|uv\.x|p\.x|gl_FragCoord\.x/)
  })

  it('samples the clouds face on, in screen-height units: no receding layer', () => {
    // The old perspective layer (distance 1 / tan(elevation)) is gone.
    expect(main).not.toMatch(/1\.0 \/ tan\(/)
    expect(main).not.toMatch(/\bplane\b/)
    // p is the pixel in screen heights (x scaled by the aspect).
    expect(main).toContain('vec2 p = vec2(uv.x * aspect, uv.y);')
    expect(main).toContain('vec2 fq = (p + wind * FRONT_SPEED) * stretch * FRONT_SCALE')
    expect(main).toContain('vec2 bq = (p + wind * BACK_SPEED) * stretch * BACK_SCALE')
    expect(SKY_FRAGMENT).toContain(`#define FRONT_SCALE ${CLOSEUP_FRONT_SCALE.toFixed(3)}`)
    expect(SKY_FRAGMENT).toContain(`#define BACK_SCALE ${CLOSEUP_BACK_SCALE.toFixed(3)}`)
  })

  it('draws the farther layer first, smaller and slower (parallax), then the near cloud over it', () => {
    expect(CLOSEUP_BACK_SCALE).toBeGreaterThan(CLOSEUP_FRONT_SCALE)
    expect(CLOSEUP_BACK_SPEED).toBeLessThan(CLOSEUP_FRONT_SPEED)
    expect(main.indexOf('col = mix(col, bcol,')).toBeGreaterThan(0)
    expect(main.indexOf('col = mix(col, bcol,')).toBeLessThan(main.indexOf('col = mix(col, fcol,'))
    // The farther layer is softened toward the sky behind it.
    expect(main).toContain('vec3 bcol = mix(mix(amb, lit, bs), col, BACK_HAZE);')
  })

  it('moves the clouds only by the wind (no fixed slide up or down the screen)', () => {
    expect(main).not.toContain('vec2(0.0, uTime * 0.003)')
    // The drift is the controller's offset (uCloud), mostly sideways.
    expect(main).toContain('vec2 drift = uCloud * CLOUD_DRIFT;')
    expect(main).toContain('vec2 wind = drift * vec2(1.0, 0.3);')
  })
})
