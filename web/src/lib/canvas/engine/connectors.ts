/**
 * Connectors: where a bound end sits on its shape, the path between the two
 * ends (straight, elbow, smooth), and keeping every connector's stored ends
 * and box in step with the shapes it is tied to.
 */
import type { BindAnchor, CanvasItem, ConnectorEnd, ConnectorItem } from '../types'
import { aabb, boundsOfPoints, centerOf, corners, dist, lerp, rotate, round, type Point, type Pose } from './geometry'
import { patchScene, type Scene } from './scene'

export const BIND_ANCHORS: readonly BindAnchor[] = ['center', 'top', 'right', 'bottom', 'left']

/** Can a connector end tie to this item? */
export function isBindable(it: CanvasItem | undefined): boolean {
  return !!it && it.kind !== 'connector' && it.kind !== 'group' && it.kind !== 'pencil'
}

/** The world point of an anchor on a shape. */
export function anchorPoint(target: Pose, anchor: BindAnchor): Point {
  const c = centerOf(target)
  switch (anchor) {
    case 'top':
      return rotate({ x: c.x, y: target.y }, target.rotation, c)
    case 'bottom':
      return rotate({ x: c.x, y: target.y + target.h }, target.rotation, c)
    case 'left':
      return rotate({ x: target.x, y: c.y }, target.rotation, c)
    case 'right':
      return rotate({ x: target.x + target.w, y: c.y }, target.rotation, c)
    default:
      return c
  }
}

/** The way an anchor faces, as a unit vector. A center has none. */
export function anchorNormal(target: Pose, anchor: BindAnchor): Point | null {
  const base: Record<BindAnchor, Point | null> = {
    center: null,
    top: { x: 0, y: -1 },
    bottom: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  }
  const n = base[anchor]
  return n ? rotate(n, target.rotation) : null
}

/** Where the ray from a shape's center toward `toward` leaves its outline. */
export function outlinePoint(target: CanvasItem, toward: Point): Point {
  const c = centerOf(target)
  const local = rotate({ x: toward.x - c.x, y: toward.y - c.y }, -target.rotation)
  const hw = target.w / 2
  const hh = target.h / 2
  if ((!local.x && !local.y) || hw <= 0 || hh <= 0) return c
  let t: number
  if (target.kind === 'ellipse') {
    t = 1 / Math.sqrt((local.x * local.x) / (hw * hw) + (local.y * local.y) / (hh * hh))
  } else {
    t = Math.min(local.x ? hw / Math.abs(local.x) : Infinity, local.y ? hh / Math.abs(local.y) : Infinity)
  }
  // The other end is inside the shape: stay at the center.
  if (t >= 1) return c
  const p = rotate({ x: local.x * t, y: local.y * t }, target.rotation)
  return { x: c.x + p.x, y: c.y + p.y }
}

/** The resolved world points of a connector's two ends. */
export function resolveEnds(scene: Scene, c: ConnectorItem): { start: Point; end: Point } {
  const sT = c.start.bind ? scene.items[c.start.bind.id] : undefined
  const eT = c.end.bind ? scene.items[c.end.bind.id] : undefined
  const sBound = sT && isBindable(sT)
  const eBound = eT && isBindable(eT)
  // What each end aims at: the other end's fixed point, or the other shape's center.
  const sAim = eBound ? (c.end.bind!.anchor === 'center' ? centerOf(eT!) : anchorPoint(eT!, c.end.bind!.anchor)) : { x: c.end.x, y: c.end.y }
  const eAim = sBound ? (c.start.bind!.anchor === 'center' ? centerOf(sT!) : anchorPoint(sT!, c.start.bind!.anchor)) : { x: c.start.x, y: c.start.y }
  const start = sBound
    ? c.start.bind!.anchor === 'center'
      ? outlinePoint(sT!, sAim)
      : anchorPoint(sT!, c.start.bind!.anchor)
    : { x: c.start.x, y: c.start.y }
  const end = eBound
    ? c.end.bind!.anchor === 'center'
      ? outlinePoint(eT!, eAim)
      : anchorPoint(eT!, c.end.bind!.anchor)
    : { x: c.end.x, y: c.end.y }
  return { start, end }
}

function endDirection(scene: Scene, e: ConnectorEnd, from: Point, to: Point): Point {
  const target = e.bind ? scene.items[e.bind.id] : undefined
  if (target && isBindable(target) && e.bind!.anchor !== 'center') {
    const n = anchorNormal(target, e.bind!.anchor)
    if (n) return n
  }
  // No edge to leave by: head along the longer axis toward the other end.
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 }
}

const axisOf = (d: Point): 'h' | 'v' => (Math.abs(d.x) >= Math.abs(d.y) ? 'h' : 'v')

export interface RoutePath {
  /** The points the path runs through (for a smooth route: start, two controls, end). */
  points: Point[]
  /** An SVG path, in world units. */
  d: string
  /** A polyline close to the path, for hit tests and bounds. */
  poly: Point[]
  /** The path's middle, where a label sits. */
  mid: Point
  /** The way the path runs into each end, as an angle in radians. */
  startAngle: number
  endAngle: number
}

const f = (n: number) => round(n, 2)
const cubicAt = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
  const ab = lerp(a, b, t)
  const bc = lerp(b, c, t)
  const cd = lerp(c, d, t)
  return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t)
}

function polyMid(poly: Point[]): Point {
  let total = 0
  for (let i = 1; i < poly.length; i++) total += dist(poly[i - 1], poly[i])
  let left = total / 2
  for (let i = 1; i < poly.length; i++) {
    const d = dist(poly[i - 1], poly[i])
    if (left <= d) return d ? lerp(poly[i - 1], poly[i], left / d) : poly[i]
    left -= d
  }
  return poly[poly.length - 1] ?? { x: 0, y: 0 }
}

/** The path a connector draws, from its resolved ends. */
export function routePath(scene: Scene, c: ConnectorItem, ends = resolveEnds(scene, c)): RoutePath {
  const a = ends.start
  const b = ends.end
  if (c.route === 'smooth') {
    const d1 = endDirection(scene, c.start, a, b)
    const d2 = endDirection(scene, c.end, b, a)
    const reach = Math.max(24, Math.min(240, dist(a, b) * 0.4))
    const c1 = { x: a.x + d1.x * reach, y: a.y + d1.y * reach }
    const c2 = { x: b.x + d2.x * reach, y: b.y + d2.y * reach }
    const poly: Point[] = []
    for (let i = 0; i <= 24; i++) poly.push(cubicAt(a, c1, c2, b, i / 24))
    return {
      points: [a, c1, c2, b],
      d: `M${f(a.x)},${f(a.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(b.x)},${f(b.y)}`,
      poly,
      mid: cubicAt(a, c1, c2, b, 0.5),
      startAngle: Math.atan2(a.y - c1.y, a.x - c1.x),
      endAngle: Math.atan2(b.y - c2.y, b.x - c2.x),
    }
  }
  let points: Point[]
  if (c.route === 'elbow') {
    const s = axisOf(endDirection(scene, c.start, a, b))
    const e = axisOf(endDirection(scene, c.end, b, a))
    if (s === 'h' && e === 'h') {
      const mx = (a.x + b.x) / 2
      points = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]
    } else if (s === 'v' && e === 'v') {
      const my = (a.y + b.y) / 2
      points = [a, { x: a.x, y: my }, { x: b.x, y: my }, b]
    } else if (s === 'h') {
      points = [a, { x: b.x, y: a.y }, b]
    } else {
      points = [a, { x: a.x, y: b.y }, b]
    }
    // Drop corners that sit on a neighbour (a straight run).
    points = points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > 0.01)
    if (points.length < 2) points = [a, b]
  } else {
    points = [a, b]
  }
  const last = points.length - 1
  return {
    points,
    d: points.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)},${f(p.y)}`).join(' '),
    poly: points,
    mid: polyMid(points),
    startAngle: Math.atan2(points[0].y - points[1].y, points[0].x - points[1].x),
    endAngle: Math.atan2(points[last].y - points[last - 1].y, points[last].x - points[last - 1].x),
  }
}

/** A connector with its stored ends and box brought up to date. The same object when nothing moved. */
export function settleConnector(scene: Scene, c: ConnectorItem): ConnectorItem {
  const ends = resolveEnds(scene, c)
  const path = routePath(scene, c, ends)
  const box = boundsOfPoints(path.poly)
  const next = {
    sx: f(ends.start.x),
    sy: f(ends.start.y),
    ex: f(ends.end.x),
    ey: f(ends.end.y),
    x: f(box.x),
    y: f(box.y),
    w: f(box.w),
    h: f(box.h),
  }
  if (
    c.start.x === next.sx &&
    c.start.y === next.sy &&
    c.end.x === next.ex &&
    c.end.y === next.ey &&
    c.x === next.x &&
    c.y === next.y &&
    c.w === next.w &&
    c.h === next.h &&
    c.rotation === 0
  )
    return c
  return {
    ...c,
    start: { ...c.start, x: next.sx, y: next.sy },
    end: { ...c.end, x: next.ex, y: next.ey },
    x: next.x,
    y: next.y,
    w: next.w,
    h: next.h,
    rotation: 0,
  }
}

/**
 * Bring connectors up to date. With `touched`, only connectors in it or tied
 * to an item in it; without, all of them. Ties to items that are gone stay in
 * the data (an undo brings the shape back and the tie with it) and the end
 * rests where it last was.
 */
export function settleConnectors(scene: Scene, touched?: ReadonlySet<string>): Scene {
  const put: CanvasItem[] = []
  for (const id in scene.items) {
    const it = scene.items[id]
    if (it.kind !== 'connector') continue
    if (touched && !touched.has(id) && !(it.start.bind && touched.has(it.start.bind.id)) && !(it.end.bind && touched.has(it.end.bind.id))) continue
    const next = settleConnector(scene, it)
    if (next !== it) put.push(next)
  }
  return patchScene(scene, put)
}

/** The anchor of `target` nearest a world point, and how far it is. */
export function nearestAnchor(target: Pose, p: Point): { anchor: BindAnchor; point: Point; distance: number } {
  let best = { anchor: 'center' as BindAnchor, point: centerOf(target), distance: Infinity }
  for (const anchor of BIND_ANCHORS) {
    const point = anchorPoint(target, anchor)
    const distance = dist(point, p)
    if (distance < best.distance) best = { anchor, point, distance }
  }
  return best
}

/** The polygon of an arrowhead at `tip`, pointing along `angle`. Empty for heads that are not polygons. */
export function headShape(
  head: ConnectorItem['startHead'],
  tip: Point,
  angle: number,
  strokeWidth: number,
): { kind: 'none' } | { kind: 'open' | 'filled'; points: Point[] } | { kind: 'dot'; center: Point; r: number } {
  if (head === 'none') return { kind: 'none' }
  const size = Math.max(8, strokeWidth * 4)
  if (head === 'dot' || head === 'small-dot') {
    return { kind: 'dot', center: tip, r: head === 'dot' ? size * 0.42 : size * 0.26 }
  }
  const back = { x: tip.x - Math.cos(angle) * size, y: tip.y - Math.sin(angle) * size }
  const nx = -Math.sin(angle) * size * 0.45
  const ny = Math.cos(angle) * size * 0.45
  const points = [{ x: back.x + nx, y: back.y + ny }, tip, { x: back.x - nx, y: back.y - ny }]
  return { kind: head === 'filled' ? 'filled' : 'open', points }
}

export { aabb, corners }
