import { describe, expect, it } from 'vitest'
import {
  pickTourStops,
  SLOW_FRAME_MS,
  summariseTour,
} from '@/app/dev/knowledge-map/tour-stats'

describe('summariseTour', () => {
  it('returns an all-zero result for no samples', () => {
    const r = summariseTour([])
    expect(r).toEqual({
      frames: 0,
      durationMs: 0,
      avgFps: 0,
      lowFps1: 0,
      worstFrameMs: 0,
      medianFrameMs: 0,
      slowFrames: 0,
    })
  })

  it('computes average fps from steady intervals', () => {
    const r = summariseTour(new Array(100).fill(16))
    expect(r.frames).toBe(100)
    expect(r.avgFps).toBeCloseTo(62.5, 1)
    expect(r.medianFrameMs).toBe(16)
    expect(r.worstFrameMs).toBe(16)
    expect(r.slowFrames).toBe(0)
  })

  it('surfaces a hitch in the 1% low and the worst frame while the mean stays healthy', () => {
    // 199 good frames plus one 120 ms stall: the mean barely moves, which is
    // exactly why the summary leads with the tail.
    const intervals = [...new Array(199).fill(16), 120]
    const r = summariseTour(intervals)
    expect(r.avgFps).toBeGreaterThan(55)
    expect(r.worstFrameMs).toBe(120)
    // 1% of 200 samples = 2 frames: the 120 ms stall and one 16 ms frame.
    expect(r.lowFps1).toBeLessThan(20)
    expect(r.slowFrames).toBe(1)
  })

  it('counts frames over the slow-frame budget', () => {
    const r = summariseTour([10, 10, SLOW_FRAME_MS, SLOW_FRAME_MS + 0.1, 100])
    // Strictly greater than the budget, so an exactly-25 ms frame is not slow.
    expect(r.slowFrames).toBe(2)
  })

  it('never takes fewer than one frame for the 1% tail', () => {
    // With 10 samples, 1% rounds to 0 — the tail must still be the worst frame.
    const r = summariseTour([10, 10, 10, 10, 10, 10, 10, 10, 10, 200])
    expect(r.lowFps1).toBeCloseTo(5, 1)
  })

  it('handles a single sample', () => {
    const r = summariseTour([20])
    expect(r.frames).toBe(1)
    expect(r.avgFps).toBeCloseTo(50, 5)
    expect(r.lowFps1).toBeCloseTo(50, 5)
    expect(r.medianFrameMs).toBe(20)
  })

  it('takes the mean of the two middle values for an even sample count', () => {
    expect(summariseTour([10, 20, 30, 40]).medianFrameMs).toBe(25)
  })

  it('discards non-finite and non-positive samples', () => {
    const r = summariseTour([16, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 16])
    expect(r.frames).toBe(2)
    expect(r.durationMs).toBe(32)
  })

  it('reports duration as the sum of the intervals', () => {
    expect(summariseTour([100, 200, 700]).durationMs).toBe(1000)
  })
})

/** A tiny laid-out-map shape: four hubs at the corners plus a claim cluster. */
function makeMap(points: Array<{ x: number; y: number; kind: number; importance: number }>) {
  return {
    count: points.length,
    x: Float64Array.from(points.map((p) => p.x)),
    y: Float64Array.from(points.map((p) => p.y)),
    kind: Uint8Array.from(points.map((p) => p.kind)),
    importance: Float32Array.from(points.map((p) => p.importance)),
  }
}

describe('pickTourStops', () => {
  it('returns nothing for a zero count or an empty map', () => {
    const map = makeMap([{ x: 0, y: 0, kind: 1, importance: 1 }])
    expect(pickTourStops(map, 0)).toEqual([])
    expect(pickTourStops(makeMap([]), 4)).toEqual([])
  })

  it('spreads stops across the world instead of clustering them', () => {
    // Three hubs bunched at the origin and one far away: a naive
    // "top N by importance" pick would take all three near ones and the tour
    // would never load a second tile.
    const map = makeMap([
      { x: 0, y: 0, kind: 1, importance: 10 },
      { x: 1, y: 0, kind: 1, importance: 9 },
      { x: 0, y: 1, kind: 1, importance: 8 },
      { x: 5000, y: 5000, kind: 1, importance: 1 },
    ])
    const stops = pickTourStops(map, 2)
    expect(stops).toHaveLength(2)
    // The second stop must be the far one, not a neighbour of the first.
    expect(stops[1]).toEqual({ x: 5000, y: 5000 })
  })

  it('prefers hubs over claims', () => {
    const map = makeMap([
      { x: 0, y: 0, kind: 0, importance: 100 }, // a very important claim
      { x: 10, y: 10, kind: 1, importance: 1 }, // an unimportant hub
    ])
    expect(pickTourStops(map, 1)).toEqual([{ x: 10, y: 10 }])
  })

  it('falls back to claims when the map has no hubs at all', () => {
    const map = makeMap([
      { x: 3, y: 4, kind: 0, importance: 5 },
      { x: 7, y: 8, kind: 0, importance: 9 },
    ])
    const stops = pickTourStops(map, 2)
    expect(stops).toHaveLength(2)
    // Most important first.
    expect(stops[0]).toEqual({ x: 7, y: 8 })
  })

  it('never returns more stops than there are candidates', () => {
    const map = makeMap([
      { x: 0, y: 0, kind: 1, importance: 2 },
      { x: 100, y: 100, kind: 1, importance: 1 },
    ])
    expect(pickTourStops(map, 10)).toHaveLength(2)
  })

  it('returns distinct positions', () => {
    const map = makeMap([
      { x: 0, y: 0, kind: 1, importance: 4 },
      { x: 500, y: 0, kind: 1, importance: 3 },
      { x: 0, y: 500, kind: 1, importance: 2 },
      { x: 500, y: 500, kind: 1, importance: 1 },
    ])
    const stops = pickTourStops(map, 4)
    const seen = new Set(stops.map((s) => `${s.x},${s.y}`))
    expect(seen.size).toBe(4)
  })

  it('stays fast on a large map by sampling only the most important nodes', () => {
    const points: Array<{ x: number; y: number; kind: number; importance: number }> = []
    for (let i = 0; i < 200_000; i++) {
      points.push({ x: (i * 37) % 10_000, y: (i * 91) % 10_000, kind: 1, importance: i })
    }
    const map = makeMap(points)
    const started = performance.now()
    const stops = pickTourStops(map, 4)
    expect(performance.now() - started).toBeLessThan(500)
    expect(stops).toHaveLength(4)
  })
})
