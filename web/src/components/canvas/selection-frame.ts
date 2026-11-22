/**
 * The frame drawn around a selection and the handles on it, in screen pixels,
 * so the overlay that draws them and the pointer code that grabs them agree.
 */
import type { ConnectorItem } from '@/lib/canvas/types'
import { toScreen, type Camera } from '@/lib/canvas/engine/camera'
import { resolveEnds } from '@/lib/canvas/engine/connectors'
import { centerOf, dist, distToSegment, rotate, type Point, type Pose } from '@/lib/canvas/engine/geometry'
import type { Handle } from '@/lib/canvas/engine/ops'
import { boundsOf, type Scene } from '@/lib/canvas/engine/scene'

export type Frame =
  /** One item: the box turns with it. */
  | { kind: 'single'; id: string; pose: Pose }
  /** Several items or a group: an upright dashed box. */
  | { kind: 'box'; pose: Pose }
  /** One connector: its two ends. */
  | { kind: 'connector'; id: string; start: Point; end: Point }

export function selectionFrame(scene: Scene, selection: readonly string[]): Frame | null {
  if (!selection.length) return null
  if (selection.length === 1) {
    const it = scene.items[selection[0]]
    if (!it) return null
    if (it.kind === 'connector') {
      const ends = resolveEnds(scene, it as ConnectorItem)
      return { kind: 'connector', id: it.id, start: ends.start, end: ends.end }
    }
    if (it.kind !== 'group') return { kind: 'single', id: it.id, pose: { x: it.x, y: it.y, w: it.w, h: it.h, rotation: it.rotation } }
  }
  const box = boundsOf(scene, selection)
  return box ? { kind: 'box', pose: { ...box, rotation: 0 } } : null
}

export const KNOB_OFFSET = 26
const CORNER_HIT = 9
const EDGE_HIT = 6
const KNOB_HIT = 11
const END_HIT = 11

export interface FrameScreen {
  /** Corners in screen pixels, clockwise from the frame's own top-left. */
  corners: [Point, Point, Point, Point]
  center: Point
  knob: Point
  rotation: number
}

export function frameScreen(pose: Pose, cam: Camera): FrameScreen {
  const c = centerOf(pose)
  const at = (x: number, y: number) => toScreen(cam, rotate({ x, y }, pose.rotation, c))
  const corners: [Point, Point, Point, Point] = [at(pose.x, pose.y), at(pose.x + pose.w, pose.y), at(pose.x + pose.w, pose.y + pose.h), at(pose.x, pose.y + pose.h)]
  const top = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 }
  const up = rotate({ x: 0, y: -1 }, pose.rotation)
  return { corners, center: toScreen(cam, c), knob: { x: top.x + up.x * KNOB_OFFSET, y: top.y + up.y * KNOB_OFFSET }, rotation: pose.rotation }
}

export type Grab =
  | { type: 'resize'; handle: Handle }
  | { type: 'rotate' }
  | { type: 'end'; which: 'start' | 'end' }
  | { type: 'inside' }

const CORNER_HANDLES: Handle[] = [
  { hx: -1, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 1 },
  { hx: -1, hy: 1 },
]
const EDGE_HANDLES: Handle[] = [
  { hx: 0, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 0 },
]

/** What part of the frame a screen point is on, if any. `scaleHit` widens the reach (for a finger). */
export function grabAt(frame: Frame, cam: Camera, p: Point, opts: { handles: boolean; scaleHit?: number } = { handles: true }): Grab | null {
  const k = opts.scaleHit ?? 1
  if (frame.kind === 'connector') {
    if (!opts.handles) return null
    if (dist(p, toScreen(cam, frame.end)) <= END_HIT * k) return { type: 'end', which: 'end' }
    if (dist(p, toScreen(cam, frame.start)) <= END_HIT * k) return { type: 'end', which: 'start' }
    return null
  }
  const fs = frameScreen(frame.pose, cam)
  if (opts.handles) {
    if (dist(p, fs.knob) <= KNOB_HIT * k) return { type: 'rotate' }
    for (let i = 0; i < 4; i++) if (dist(p, fs.corners[i]) <= CORNER_HIT * k) return { type: 'resize', handle: CORNER_HANDLES[i] }
    for (let i = 0; i < 4; i++) if (distToSegment(p, fs.corners[i], fs.corners[(i + 1) % 4]) <= EDGE_HIT * k) return { type: 'resize', handle: EDGE_HANDLES[i] }
  }
  // Inside the frame: its own (turned) box.
  const local = rotate({ x: p.x - fs.center.x, y: p.y - fs.center.y }, -fs.rotation)
  if (Math.abs(local.x) <= (frame.pose.w * cam.scale) / 2 && Math.abs(local.y) <= (frame.pose.h * cam.scale) / 2) return { type: 'inside' }
  return null
}

/** The cursor for a resize handle on a frame turned by `rotation`. */
export function resizeCursor(handle: Handle, rotation: number): string {
  const base = Math.atan2(handle.hy, handle.hx) + rotation
  const step = ((Math.round(base / (Math.PI / 4)) % 4) + 4) % 4
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][step]
}
