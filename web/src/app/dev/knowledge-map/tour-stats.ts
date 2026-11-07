/**
 * Frame-timing statistics for the synthetic benchmark's scripted camera tour.
 *
 * The acceptance gate in docs/KNOWLEDGE_MAP_ARCHITECTURE.md §7 is "≥ 55 fps
 * sustained pan/zoom with a 50k-node working set", and a MEAN fps hides
 * exactly the failure this architecture is meant to prevent: a mean of 58 fps
 * with four 120 ms stalls is a map that hitches visibly while the average
 * looks fine. So the summary leads with the tail — the 1% low and the worst
 * single frame — and counts frames over the 25 ms budget.
 *
 * Pure functions over an array of frame intervals so the benchmark page's
 * numbers are unit-testable without a GPU.
 */

/** A frame slower than this reads as a hitch at 60 Hz (~1.5 frame budgets). */
export const SLOW_FRAME_MS = 25

export interface TourResult {
  /** Frame intervals measured, in ms. */
  frames: number
  /** Total wall time of the measured window, ms. */
  durationMs: number
  avgFps: number
  /** Mean fps of the slowest 1% of frames — the hitch metric. */
  lowFps1: number
  /** Longest single frame interval, ms. */
  worstFrameMs: number
  /** Median frame interval, ms. */
  medianFrameMs: number
  /** Frames longer than SLOW_FRAME_MS. */
  slowFrames: number
}

/**
 * Summarise frame intervals (ms between consecutive rendered frames).
 *
 * Intervals rather than timestamps because that is what a rAF probe naturally
 * produces, and because it keeps the caller free to drop the first sample
 * (which straddles the tour's start and is always an outlier).
 */
export function summariseTour(intervals: readonly number[]): TourResult {
  const clean = intervals.filter((dt) => Number.isFinite(dt) && dt > 0)
  if (clean.length === 0) {
    return {
      frames: 0,
      durationMs: 0,
      avgFps: 0,
      lowFps1: 0,
      worstFrameMs: 0,
      medianFrameMs: 0,
      slowFrames: 0,
    }
  }

  const sorted = [...clean].sort((a, b) => a - b)
  let total = 0
  for (const dt of clean) total += dt

  // The slowest 1%, but never fewer than one frame — with 200 samples that is
  // two frames, and with 30 it is still the single worst one rather than NaN.
  const tailCount = Math.max(1, Math.round(sorted.length * 0.01))
  let tailSum = 0
  for (let i = sorted.length - tailCount; i < sorted.length; i++) tailSum += sorted[i]
  const tailMean = tailSum / tailCount

  let slow = 0
  for (const dt of clean) if (dt > SLOW_FRAME_MS) slow++

  return {
    frames: clean.length,
    durationMs: total,
    avgFps: (clean.length * 1000) / total,
    lowFps1: tailMean > 0 ? 1000 / tailMean : 0,
    worstFrameMs: sorted[sorted.length - 1],
    medianFrameMs: median(sorted),
    slowFrames: slow,
  }
}

function median(sorted: readonly number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = n >> 1
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Pick `count` well-separated hub positions to fly through.
 *
 * "Well separated" matters: flying between two hubs that happen to sit in the
 * same tile exercises nothing — no tile is loaded or evicted, so the tour
 * would report a flattering number for a streaming path it never touched.
 * Farthest-point sampling over the most important nodes spreads the stops
 * across the world square, which forces real tile churn.
 */
export function pickTourStops(
  map: { count: number; x: Float64Array; y: Float64Array; kind: Uint8Array; importance: Float32Array },
  count: number,
): Array<{ x: number; y: number }> {
  if (count <= 0 || map.count === 0) return []

  // Candidate pool: hubs (kind != 0) by importance, since they are what a user
  // actually navigates between. Fall back to any node in a hub-less map.
  const pool: number[] = []
  for (let i = 0; i < map.count; i++) if (map.kind[i] !== 0) pool.push(i)
  const source = pool.length > 0 ? pool : Array.from({ length: map.count }, (_, i) => i)
  source.sort((a, b) => map.importance[b] - map.importance[a])
  // A few hundred of the most important nodes is plenty to sample from and
  // keeps the O(n·count) farthest-point loop trivial even at 1M nodes.
  const top = source.slice(0, Math.min(source.length, 512))

  const picked: number[] = [top[0]]
  while (picked.length < Math.min(count, top.length)) {
    let best = -1
    let bestDist = -Infinity
    for (const i of top) {
      if (picked.includes(i)) continue
      let nearest = Infinity
      for (const p of picked) {
        const dx = map.x[i] - map.x[p]
        const dy = map.y[i] - map.y[p]
        const d = dx * dx + dy * dy
        if (d < nearest) nearest = d
      }
      if (nearest > bestDist) {
        bestDist = nearest
        best = i
      }
    }
    if (best < 0) break
    picked.push(best)
  }

  return picked.map((i) => ({ x: map.x[i], y: map.y[i] }))
}
