/**
 * The dot-size rule, and the two ways it can silently stop being true.
 *
 * The map is read by its DOTS: a hub is a big disc, a leaf claim a small dot,
 * and that difference is carried entirely by the world radius the server
 * layout assigns. Two things have to hold for it to survive to the screen.
 *
 * 1. The client's floor is CALIBRATED to the server's curve.
 *    `NODE_RADIUS_FLOOR_K = MIN_NODE_SCREEN_RADIUS_PX / BASE_NODE_WORLD_RADIUS`
 *    only produces "the smallest node is exactly MIN px" if
 *    BASE_NODE_WORLD_RADIUS really is the smallest radius `layout.ts` emits.
 *    That constant lives in lod.ts (client) and the curve lives in layout.ts
 *    (server), which are separate files that nothing else forces to agree — so
 *    this runs the real layout and checks.
 *
 * 2. The GLSL and the TypeScript agree.
 *    The shaders paint; the spatial index decides what is clickable and the
 *    label builder decides where a name hangs. A GPU cannot be unit-tested
 *    here, so the guard is the same one `edge-fade.test.ts` uses: assert the
 *    shader source still contains the shape the CPU mirror implements.
 */

import { describe, expect, it } from 'vitest'

import {
  BASE_NODE_WORLD_RADIUS,
  MAX_NODE_SCREEN_RADIUS_PX,
  MIN_NODE_SCREEN_RADIUS_PX,
  NODE_RADIUS_FLOOR_K,
  nodeScreenRadiusPx,
} from '../lod'
import { NODE_VS, RING_VS } from '../shaders'
import { generateSyntheticRows, layoutMap } from '@/lib/knowledge/graph-map'
import { claimRadius, hubRadius } from '@/lib/knowledge/graph-map/layout'

describe('BASE_NODE_WORLD_RADIUS', () => {
  it('is the floor of the real layout, and close enough to it to calibrate', () => {
    const map = layoutMap(generateSyntheticRows({ claims: 4000, seed: 7 }))
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < map.count; i++) {
      if (map.r[i] < min) min = map.r[i]
      if (map.r[i] > max) max = map.r[i]
    }
    // Nothing may fall BELOW the base, or that node is painted smaller than
    // MIN_NODE_SCREEN_RADIUS_PX claims to allow and the clamp starts biting.
    expect(min).toBeGreaterThanOrEqual(BASE_NODE_WORLD_RADIUS)
    // And it must not be far above it either, or the smallest dot on screen is
    // bigger than MIN and the floor is quietly mis-calibrated. In practice the
    // minimum is degree 1 (1.6 + 0.75·log2 3 ≈ 2.79) rather than the curve's
    // degree-0 value of 2.35, because a claim that reaches the map has at
    // least one link — so the base is the true floor, a shade under what is
    // ever seen.
    expect(min).toBeLessThan(BASE_NODE_WORLD_RADIUS * 1.25)
    // The spread is the signal itself: if it ever collapsed toward 1 the floor
    // would still be correct and the map would still be identical dots.
    expect(max / min).toBeGreaterThan(2)
  })
})

describe('degree drives size', () => {
  // The user-visible complaint this pins: "the more connections a node has,
  // the smaller it is, which is backwards". It was never literally inverted
  // within a kind — but the curves saturated so early, and virtual hubs
  // ignored degree so completely, that the map behaved as though it were.
  it('is strictly increasing in degree, for claims and for BOTH kinds of hub', () => {
    const degrees = [0, 1, 3, 10, 50, 200, 400]
    for (const series of [
      degrees.map((d) => claimRadius(d)),
      degrees.map((d) => hubRadius(d, false)),
      degrees.map((d) => hubRadius(d, true)),
    ]) {
      for (let i = 1; i < series.length; i++) {
        expect(series[i]).toBeGreaterThan(series[i - 1])
      }
    }
  })

  it('lets a well-populated unfiled hub outgrow a lone real entity', () => {
    // The actual inversion. `unfiled:<month>` used to be a hard-coded 5 while
    // a degree-0 entity started at 5.4, so a bucket holding 300 claims painted
    // smaller than an entity holding nothing.
    expect(hubRadius(300, true)).toBeGreaterThan(hubRadius(0, false))
  })

  it('keeps a virtual hub recessive against a real one of the same degree', () => {
    // It answers to degree now, but it is still a placeholder for filing that
    // has not happened rather than a thing in the world.
    for (const d of [0, 10, 50, 200]) {
      expect(hubRadius(d, true)).toBeLessThan(hubRadius(d, false))
    }
  })

  it('does not saturate until far past where a real hub lands', () => {
    // `√` capped a hub at degree 51, which is an ordinary project — so the
    // biggest structures on the map were the same size as the middling ones.
    expect(hubRadius(200, false)).toBeGreaterThan(hubRadius(50, false))
    expect(hubRadius(400, false)).toBeGreaterThan(hubRadius(200, false))
  })

  it('spreads the OVERVIEW well past the ~4× it used to', () => {
    // Overview is the view this is all for: below NODE_RADIUS_FLOOR_K every
    // node is drawn at the floor scale, so this ratio is the entire hierarchy
    // a reader gets before they zoom. The old curves gave 14/3.6 ≈ 3.9×.
    const k = 0.1
    const leaf = nodeScreenRadiusPx(claimRadius(0), k)
    const biggestHub = nodeScreenRadiusPx(hubRadius(1614, false), k)
    expect(leaf).toBeCloseTo(MIN_NODE_SCREEN_RADIUS_PX, 6)
    expect(biggestHub / leaf).toBeGreaterThan(6)
  })
})

describe('nodeScreenRadiusPx', () => {
  it('keeps hubs bigger than leaves at overview zoom, which a plain clamp did not', () => {
    // k ≈ 0.1 is the opening view of a real workspace (~7k nodes, ~10k world
    // units wide in a ~1000 px pane), and it is where the old
    // `clamp(r * k, MIN, MAX)` flattened every node onto MIN.
    const k = 0.1
    const leaf = nodeScreenRadiusPx(BASE_NODE_WORLD_RADIUS, k)
    const hub = nodeScreenRadiusPx(14, k)
    expect(leaf).toBeCloseTo(MIN_NODE_SCREEN_RADIUS_PX, 6)
    expect(hub / leaf).toBeCloseTo(14 / BASE_NODE_WORLD_RADIUS, 6)

    const oldWay = (r: number) =>
      Math.min(Math.max(r * k, MIN_NODE_SCREEN_RADIUS_PX), MAX_NODE_SCREEN_RADIUS_PX)
    expect(oldWay(14)).toBe(oldWay(BASE_NODE_WORLD_RADIUS))
  })

  it('is a floor, not a scale: above NODE_RADIUS_FLOOR_K nothing is changed', () => {
    // Every sample must be ≥ NODE_RADIUS_FLOOR_K or it is testing the floor
    // rather than the pass-through above it. That constant moves whenever the
    // radius curve does — it was 0.56 when this list said 0.8, and 0.85 after
    // the curve went logarithmic, which is what caught this.
    for (const k of [NODE_RADIUS_FLOOR_K, 1, 2, 5]) {
      const r = 4
      expect(nodeScreenRadiusPx(r, k)).toBeCloseTo(
        Math.min(r * k, MAX_NODE_SCREEN_RADIUS_PX),
        6,
      )
    }
  })

  it('still clamps at both ends', () => {
    expect(nodeScreenRadiusPx(0.001, 0.0001)).toBe(MIN_NODE_SCREEN_RADIUS_PX)
    expect(nodeScreenRadiusPx(1000, 50)).toBe(MAX_NODE_SCREEN_RADIUS_PX)
  })
})

describe('shader mirror', () => {
  it.each([
    ['NODE_VS', NODE_VS],
    ['RING_VS', RING_VS],
  ])('%s floors the scale, not the radius', (_name, source) => {
    expect(source).toMatch(/clamp\(aRadius \* max\(uK, uFloorK\), uMinRadiusPx, uMaxRadiusPx\)/)
  })
})
