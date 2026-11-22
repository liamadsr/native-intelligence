/** Canvas geometry: points, boxes that turn about their center, distances. No DOM. */

export interface Point {
  x: number
  y: number
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface Pose extends Box {
  rotation: number
}

export const pt = (x: number, y: number): Point => ({ x, y })
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k })
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
export const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

export function rotate(p: Point, angle: number, about: Point = { x: 0, y: 0 }): Point {
  if (!angle) return p
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const dx = p.x - about.x
  const dy = p.y - about.y
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c }
}

export const centerOf = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** The four corners of a turned box, clockwise from its own top-left. */
export function corners(p: Pose): [Point, Point, Point, Point] {
  const c = centerOf(p)
  return [
    rotate({ x: p.x, y: p.y }, p.rotation, c),
    rotate({ x: p.x + p.w, y: p.y }, p.rotation, c),
    rotate({ x: p.x + p.w, y: p.y + p.h }, p.rotation, c),
    rotate({ x: p.x, y: p.y + p.h }, p.rotation, c),
  ]
}

export function boundsOfPoints(points: readonly Point[]): Box {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** The upright box around a turned one. */
export function aabb(p: Pose): Box {
  if (!p.rotation) return { x: p.x, y: p.y, w: p.w, h: p.h }
  return boundsOfPoints(corners(p))
}

export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export const boxesIntersect = (a: Box, b: Box): boolean =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y

export const boxContains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h

export const expandBox = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 })

/** A box from two corners in any order. */
export function boxFromPoints(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** A world point in a pose's own frame: origin at its center, axes along its sides. */
export function toLocal(p: Point, pose: Pose): Point {
  const c = centerOf(pose)
  return sub(rotate(p, -pose.rotation, c), c)
}

export function pointInPose(p: Point, pose: Pose, pad = 0): boolean {
  const l = toLocal(p, pose)
  return Math.abs(l.x) <= pose.w / 2 + pad && Math.abs(l.y) <= pose.h / 2 + pad
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (!len2) return dist(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

export function distToPolyline(p: Point, line: readonly Point[]): number {
  if (!line.length) return Infinity
  if (line.length === 1) return dist(p, line[0])
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const d = distToSegment(p, line[i - 1], line[i])
    if (d < best) best = d
  }
  return best
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  const on = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y)
  if (d1 === 0 && on(c, d, a)) return true
  if (d2 === 0 && on(c, d, b)) return true
  if (d3 === 0 && on(a, b, c)) return true
  if (d4 === 0 && on(a, b, d)) return true
  return false
}

/** Does the segment a-b touch the upright box? */
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  const inside = (p: Point) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
  if (inside(a) || inside(b)) return true
  const tl = { x: box.x, y: box.y }
  const tr = { x: box.x + box.w, y: box.y }
  const br = { x: box.x + box.w, y: box.y + box.h }
  const bl = { x: box.x, y: box.y + box.h }
  return segmentsIntersect(a, b, tl, tr) || segmentsIntersect(a, b, tr, br) || segmentsIntersect(a, b, br, bl) || segmentsIntersect(a, b, bl, tl)
}

/** Snap an angle to the nearest multiple of `step` radians. */
export const snapAngle = (angle: number, step: number): number => Math.round(angle / step) * step

/** Keep an angle in (-PI, PI]. */
export function normalizeAngle(a: number): number {
  let r = a % (Math.PI * 2)
  if (r > Math.PI) r -= Math.PI * 2
  if (r <= -Math.PI) r += Math.PI * 2
  return r
}

/** Is the angle a quarter turn (so the box's sides still run along the axes)? */
export function isQuarterTurn(a: number): boolean {
  const q = Math.abs(normalizeAngle(a)) / (Math.PI / 2)
  return Math.abs(q - Math.round(q)) < 1e-6
}

/** Round to a sane number of decimals so stored poses stay short. */
export const round = (n: number, places = 2): number => {
  const k = 10 ** places
  return Math.round(n * k) / k
}
