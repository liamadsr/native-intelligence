/**
 * Edge fades — the two independent cuts that stop the map reading as a
 * hairball, pinned without a GL context.
 *
 *   • `edgeLodAlpha(k)`      — zoom: edges are noise when neighbouring claims
 *                              are a pixel apart.
 *   • `edgeLengthAlpha(len)` — LENGTH: about half the claims carry a second
 *                              link to a far-away anchor hub (one real project
 *                              hub has 1,614), and at full ink those cross the
 *                              viewport and drown the short claim → own-hub
 *                              spokes that carry the structure.
 *
 * `edgeLengthAlpha` is a TypeScript mirror of the `mix`/`smoothstep` in
 * EDGE_VS; the GPU does the real work per instance. The shader source is
 * asserted here too, because the one thing a mirror cannot catch is the mirror
 * drifting from the shader it mirrors — in particular that the HIGHLIGHT pass
 * (uHighlight) opts out, which is what makes a hovered hub show all of its long
 * links at full ink.
 */

import { describe, expect, it } from 'vitest'

import { EDGE_FS, EDGE_VS } from '../shaders'
import {
  EDGE_FADE_MAX_NEIGHBOUR_PX,
  EDGE_FADE_MIN_NEIGHBOUR_PX,
  EDGE_LENGTH_FADE_END,
  EDGE_LENGTH_FADE_FLOOR,
  EDGE_LENGTH_FADE_START,
  edgeLengthAlpha,
  edgeLodAlpha,
} from '../renderer'

/** graph-map SPACING: world units between neighbouring claim slots. */
const SPACING = 14

describe('edgeLengthAlpha', () => {
  it('keeps short claim → own-hub spokes at full ink', () => {
    // A spoke inside a hub's own disc is a few SPACING long at most.
    expect(edgeLengthAlpha(0)).toBe(1)
    expect(edgeLengthAlpha(SPACING)).toBe(1)
    expect(edgeLengthAlpha(3 * SPACING)).toBe(1)
    expect(edgeLengthAlpha(EDGE_LENGTH_FADE_START)).toBe(1)
  })

  it('floors the longest anchor links at ~22%', () => {
    expect(edgeLengthAlpha(EDGE_LENGTH_FADE_END)).toBeCloseTo(EDGE_LENGTH_FADE_FLOOR, 12)
    expect(edgeLengthAlpha(EDGE_LENGTH_FADE_END * 10)).toBeCloseTo(EDGE_LENGTH_FADE_FLOOR, 12)
    // The floor is a fade, not a cull: a long link is still legible context.
    expect(EDGE_LENGTH_FADE_FLOOR).toBeGreaterThan(0)
  })

  it('smoothsteps monotonically between the thresholds, with no jump at either end', () => {
    let prev = Infinity
    for (let len = 0; len <= EDGE_LENGTH_FADE_END * 1.2; len += SPACING / 2) {
      const a = edgeLengthAlpha(len)
      expect(a).toBeLessThanOrEqual(prev + 1e-12)
      expect(a).toBeGreaterThanOrEqual(EDGE_LENGTH_FADE_FLOOR - 1e-12)
      expect(a).toBeLessThanOrEqual(1)
      prev = a
    }
    // smoothstep is flat at both ends, so the curve leaves 1 and reaches the
    // floor without a visible crease.
    const eps = 0.01
    expect(edgeLengthAlpha(EDGE_LENGTH_FADE_START + eps)).toBeCloseTo(1, 6)
    expect(edgeLengthAlpha(EDGE_LENGTH_FADE_END - eps)).toBeCloseTo(EDGE_LENGTH_FADE_FLOOR, 6)
    // Halfway is halfway between full ink and the floor.
    const mid = (EDGE_LENGTH_FADE_START + EDGE_LENGTH_FADE_END) / 2
    expect(edgeLengthAlpha(mid)).toBeCloseTo((1 + EDGE_LENGTH_FADE_FLOOR) / 2, 9)
  })

  it('uses the thresholds the design calls for, in world units', () => {
    expect(EDGE_LENGTH_FADE_START).toBe(6 * SPACING)
    expect(EDGE_LENGTH_FADE_END).toBe(40 * SPACING)
    expect(EDGE_LENGTH_FADE_FLOOR).toBeCloseTo(0.22, 12)
  })
})

describe('the edge shader applies the fade the way the constants describe', () => {
  it('computes the length in WORLD units, so a link reads the same at every zoom', () => {
    // len is in CSS px; dividing by uK is what makes the fade zoom-invariant.
    expect(EDGE_VS).toContain('float worldLen = uK > 0.0 ? len / uK : 0.0;')
  })

  it('exempts the highlight pass, so a hovered hub shows its long links in full', () => {
    expect(EDGE_VS).toMatch(/vLenFade\s*=\s*uHighlight == 1\s*\n?\s*\?\s*1\.0/)
    expect(EDGE_VS).toContain('smoothstep(uLenFadeStart, uLenFadeEnd, worldLen)')
  })

  it('carries the factor to the fragment stage as a flat varying, with no new buffers', () => {
    expect(EDGE_VS).toContain('flat out float vLenFade;')
    expect(EDGE_FS).toContain('flat in float vLenFade;')
    expect(EDGE_FS).toContain('uAlpha * vLenFade')
    // Two instanced attributes, exactly as before: the length comes from them.
    const attributes = EDGE_VS.match(/layout\(location = \d+\) in /g) ?? []
    expect(attributes).toHaveLength(3)
  })
})

describe('edgeLodAlpha (zoom cut) is unchanged and independent of length', () => {
  // Asserted through the exported thresholds, not literals: they were retuned
  // after looking at a real 295-node workspace, whose opening zoom puts
  // neighbouring claims ~4 px apart — spokes have to be readable there.
  it('is silent at dust-cloud zoom and full once neighbours are readably apart', () => {
    expect(edgeLodAlpha(EDGE_FADE_MIN_NEIGHBOUR_PX / SPACING)).toBe(0)
    expect(edgeLodAlpha(0.01)).toBe(0)
    expect(edgeLodAlpha(EDGE_FADE_MAX_NEIGHBOUR_PX / SPACING)).toBe(1)
    expect(edgeLodAlpha(12)).toBe(1)
    const mid = edgeLodAlpha((EDGE_FADE_MIN_NEIGHBOUR_PX + EDGE_FADE_MAX_NEIGHBOUR_PX) / 2 / SPACING)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    // The spokes of a small workspace's opening view (~4 px) are fully drawn.
    expect(edgeLodAlpha(4 / SPACING)).toBe(1)
  })
})
