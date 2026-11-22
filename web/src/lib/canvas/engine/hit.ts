/** What is under a point, what a box covers, what an eraser stroke crosses. */
import type { CanvasItem } from '../types'
import { routePath } from './connectors'
import {
  aabb,
  boxesIntersect,
  centerOf,
  distToPolyline,
  pointInPose,
  rotate,
  segmentHitsBox,
  toLocal,
  type Box,
  type Point,
} from './geometry'
import { painted, type Scene } from './scene'

const isPaint = (color: string | undefined): boolean => !!color && color !== 'transparent' && !/^#[0-9a-f]{6}00$/i.test(color)

/** A pencil's points on the canvas. */
export function pencilWorldPoints(it: Extract<CanvasItem, { kind: 'pencil' }>): Point[] {
  const kx = it.w0 ? it.w / it.w0 : 1
  const ky = it.h0 ? it.h / it.h0 : 1
  const c = centerOf(it)
  return it.points.map(([x, y]) => rotate({ x: it.x + x * kx, y: it.y + y * ky }, it.rotation, c))
}

/**
 * Is the point on the item? `tol` is the slack in world units (a few screen
 * pixels). A shape with no fill and no label is picked by its outline only,
 * so what is behind an empty frame can still be reached.
 */
export function hitItem(scene: Scene, it: CanvasItem, p: Point, tol: number): boolean {
  if (it.kind === 'group') return false
  const stroke = (it.style.strokeWidth ?? 0) / 2
  if (it.kind === 'connector') {
    const box = aabb(it)
    if (p.x < box.x - tol - stroke - 12 || p.x > box.x + box.w + tol + stroke + 12 || p.y < box.y - tol - stroke - 12 || p.y > box.y + box.h + tol + stroke + 12) return false
    return distToPolyline(p, routePath(scene, it).poly) <= stroke + tol
  }
  if (it.kind === 'pencil') {
    if (!pointInPose(p, it, tol + stroke)) return false
    return distToPolyline(p, pencilWorldPoints(it)) <= stroke + tol
  }
  if (it.kind === 'rectangle' || it.kind === 'ellipse') {
    const l = toLocal(p, it)
    const hw = it.w / 2
    const hh = it.h / 2
    const solid = isPaint(it.style.fill) || !!it.label?.plain
    if (it.kind === 'rectangle') {
      const inOuter = Math.abs(l.x) <= hw + stroke + tol && Math.abs(l.y) <= hh + stroke + tol
      if (!inOuter) return false
      if (solid) return true
      return Math.abs(l.x) >= hw - stroke - tol || Math.abs(l.y) >= hh - stroke - tol
    }
    const norm = (rx: number, ry: number) => (rx <= 0 || ry <= 0 ? Infinity : (l.x * l.x) / (rx * rx) + (l.y * l.y) / (ry * ry))
    if (norm(hw + stroke + tol, hh + stroke + tol) > 1) return false
    if (solid) return true
    return norm(hw - stroke - tol, hh - stroke - tol) >= 1
  }
  return pointInPose(p, it, tol)
}

/** The frontmost item under a point, or null. */
export function pick(scene: Scene, p: Point, tol: number, skip?: (it: CanvasItem) => boolean): CanvasItem | null {
  const list = painted(scene)
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i]
    if (skip?.(it)) continue
    if (hitItem(scene, it, p, tol)) return it
  }
  return null
}

/** The frontmost shape whose box holds the point: where a double-click lands, fill or none. */
export function pickBox(scene: Scene, p: Point, tol = 0): CanvasItem | null {
  const list = painted(scene)
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i]
    if (it.kind === 'connector' || it.kind === 'pencil') continue
    if (pointInPose(p, it, tol)) return it
  }
  return null
}

/** The painted items a marquee touches. */
export function itemsInBox(scene: Scene, box: Box): CanvasItem[] {
  const out: CanvasItem[] = []
  for (const it of painted(scene)) {
    const b = aabb(it)
    if (!boxesIntersect(box, b)) continue
    if (it.kind === 'connector') {
      const poly = routePath(scene, it).poly
      let hit = false
      for (let i = 1; i < poly.length && !hit; i++) hit = segmentHitsBox(poly[i - 1], poly[i], box)
      if (hit) out.push(it)
    } else if (it.kind === 'pencil') {
      const pts = pencilWorldPoints(it)
      let hit = pts.length === 1 && pts[0].x >= box.x && pts[0].x <= box.x + box.w && pts[0].y >= box.y && pts[0].y <= box.y + box.h
      for (let i = 1; i < pts.length && !hit; i++) hit = segmentHitsBox(pts[i - 1], pts[i], box)
      if (hit) out.push(it)
    } else {
      out.push(it)
    }
  }
  return out
}

/** The items the eraser's last move (a to b) passed over. */
export function itemsOnSegment(scene: Scene, a: Point, b: Point, tol: number): CanvasItem[] {
  const out: CanvasItem[] = []
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(tol, 1)))
  const seg: Box = { x: Math.min(a.x, b.x) - tol, y: Math.min(a.y, b.y) - tol, w: Math.abs(a.x - b.x) + tol * 2, h: Math.abs(a.y - b.y) + tol * 2 }
  for (const it of painted(scene)) {
    const box = aabb(it)
    const pad = (it.style.strokeWidth ?? 0) / 2 + 12
    if (!boxesIntersect(seg, { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 })) continue
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      if (hitItem(scene, it, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, tol)) {
        out.push(it)
        break
      }
    }
  }
  return out
}
