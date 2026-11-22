/** Pencil ink: the outline of a stroke as an SVG path, from its points and pressures. */
import { getStroke } from 'perfect-freehand'
import type { PencilItem } from '../types'

const cache = new WeakMap<PencilItem['points'], Map<string, string>>()

/** A closed path through outline points, smoothed with quadratic curves. */
export function outlineToPath(outline: number[][]): string {
  if (!outline.length) return ''
  if (outline.length < 3) {
    const [x, y] = outline[0]
    return `M${x.toFixed(2)},${y.toFixed(2)}Z`
  }
  let d = `M${outline[0][0].toFixed(2)},${outline[0][1].toFixed(2)} Q`
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]
    const [x1, y1] = outline[(i + 1) % outline.length]
    d += `${x0.toFixed(2)},${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)},${((y0 + y1) / 2).toFixed(2)} `
  }
  return `${d}Z`
}

/**
 * The ink of a pencil item in its own box (0,0 to w,h), filled, no stroke.
 * Scaling the box scales where the points are, not how thick the ink is.
 * Cached on the points array: panning, selecting and moving never recompute it.
 */
export function inkPath(it: Pick<PencilItem, 'points' | 'w' | 'h' | 'w0' | 'h0' | 'pen'>, size: number): string {
  const kx = it.w0 ? it.w / it.w0 : 1
  const ky = it.h0 ? it.h / it.h0 : 1
  const key = `${size}|${kx.toFixed(4)}|${ky.toFixed(4)}`
  let byKey = cache.get(it.points)
  if (!byKey) {
    byKey = new Map()
    cache.set(it.points, byKey)
  }
  const hit = byKey.get(key)
  if (hit !== undefined) return hit
  const pts = it.points.map(([x, y, p]) => [x * kx, y * ky, p])
  const outline = getStroke(pts, {
    size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: !it.pen,
    last: true,
  })
  const d = outlineToPath(outline)
  if (byKey.size > 4) byKey.clear()
  byKey.set(key, d)
  return d
}
