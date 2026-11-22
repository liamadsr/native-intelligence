/**
 * Snapping. To objects: a moving box's edges and middles catch on the edges
 * and middles of what is near, and a dashed guide shows the line they share.
 * To the grid: positions round to a step.
 */
import type { Box, Point } from './geometry'

export interface Guide {
  axis: 'x' | 'y'
  /** Where the line is (an x for a vertical guide, a y for a horizontal one). */
  at: number
  /** How far it runs along the other axis. */
  from: number
  to: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
}

const anchorsX = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w]
const anchorsY = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h]

/**
 * How far to nudge a moving box so it lines up with one of the others.
 * `tol` is the catch distance in world units; `reach` is how far away, across
 * the axis, another box may be and still count.
 */
export function snapMove(moving: Box, others: readonly Box[], tol: number, reach = Infinity): SnapResult {
  let bestX: { d: number; at: number } | null = null
  let bestY: { d: number; at: number } | null = null
  for (const o of others) {
    const farX = o.x > moving.x + moving.w + reach || o.x + o.w < moving.x - reach
    const farY = o.y > moving.y + moving.h + reach || o.y + o.h < moving.y - reach
    if (!farY) {
      for (const m of anchorsX(moving))
        for (const a of anchorsX(o)) {
          const d = a - m
          if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: a }
        }
    }
    if (!farX) {
      for (const m of anchorsY(moving))
        for (const a of anchorsY(o)) {
          const d = a - m
          if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: a }
        }
    }
  }
  const dx = bestX?.d ?? 0
  const dy = bestY?.d ?? 0
  const placed: Box = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h }
  return { dx, dy, guides: guidesFor(placed, others, bestX !== null, bestY !== null) }
}

const EPS = 0.01

/** Every line a placed box shares with the others, stretched to cover them all. */
export function guidesFor(placed: Box, others: readonly Box[], wantX = true, wantY = true): Guide[] {
  const guides: Guide[] = []
  if (wantX) {
    for (const m of anchorsX(placed)) {
      let from = placed.y
      let to = placed.y + placed.h
      let any = false
      for (const o of others) {
        if (anchorsX(o).some((a) => Math.abs(a - m) < EPS)) {
          any = true
          from = Math.min(from, o.y)
          to = Math.max(to, o.y + o.h)
        }
      }
      if (any) guides.push({ axis: 'x', at: m, from, to })
    }
  }
  if (wantY) {
    for (const m of anchorsY(placed)) {
      let from = placed.x
      let to = placed.x + placed.w
      let any = false
      for (const o of others) {
        if (anchorsY(o).some((a) => Math.abs(a - m) < EPS)) {
          any = true
          from = Math.min(from, o.x)
          to = Math.max(to, o.x + o.w)
        }
      }
      if (any) guides.push({ axis: 'y', at: m, from, to })
    }
  }
  return guides
}

/** Snap one point (a resize handle, a connector's free end) to the others' edges and middles. */
export function snapPoint(p: Point, others: readonly Box[], tol: number, axes: { x: boolean; y: boolean } = { x: true, y: true }): { point: Point; guides: Guide[] } {
  let bx: number | null = null
  let by: number | null = null
  for (const o of others) {
    if (axes.x) for (const a of anchorsX(o)) if (Math.abs(a - p.x) <= tol && (bx === null || Math.abs(a - p.x) < Math.abs(bx - p.x))) bx = a
    if (axes.y) for (const a of anchorsY(o)) if (Math.abs(a - p.y) <= tol && (by === null || Math.abs(a - p.y) < Math.abs(by - p.y))) by = a
  }
  const point = { x: bx ?? p.x, y: by ?? p.y }
  const guides: Guide[] = []
  if (bx !== null) {
    let from = point.y
    let to = point.y
    for (const o of others)
      if (anchorsX(o).some((a) => Math.abs(a - bx!) < EPS)) {
        from = Math.min(from, o.y)
        to = Math.max(to, o.y + o.h)
      }
    guides.push({ axis: 'x', at: bx, from, to })
  }
  if (by !== null) {
    let from = point.x
    let to = point.x
    for (const o of others)
      if (anchorsY(o).some((a) => Math.abs(a - by!) < EPS)) {
        from = Math.min(from, o.x)
        to = Math.max(to, o.x + o.w)
      }
    guides.push({ axis: 'y', at: by, from, to })
  }
  return { point, guides }
}

export type GridSnap = 'none' | 'pixel' | 'auto'

/** The step grid snapping rounds to: nothing, one unit, or the finest dot spacing showing. */
export function gridStep(mode: GridSnap, visibleStep: number): number {
  return mode === 'none' ? 0 : mode === 'pixel' ? 1 : visibleStep
}

export const snapTo = (n: number, step: number): number => (step > 0 ? Math.round(n / step) * step : n)
export const snapPointTo = (p: Point, step: number): Point => (step > 0 ? { x: snapTo(p.x, step), y: snapTo(p.y, step) } : p)

/** Keep a drag on the axis it has moved furthest along. */
export function axisLock(dx: number, dy: number): { dx: number; dy: number } {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy }
}

/** Snap the line from `from` to `to` to the nearest 45 degrees, keeping its length along that direction. */
export function snap45(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const len = Math.hypot(dx, dy) * Math.cos(Math.atan2(dy, dx) - angle)
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len }
}
