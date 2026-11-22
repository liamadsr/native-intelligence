/**
 * Editing operations. Each takes a scene and returns a new one; none reads
 * the DOM. A gesture (a drag) calls its operation again and again on the
 * scene it started from, so a preview never piles rounding on rounding.
 */
import type { CanvasItem, CanvasStyle, CanvasTextStyle, ConnectorItem, GroupItem } from '../types'
import { settleConnectors } from './connectors'
import { LIMITS } from './defaults'
import {
  aabb,
  centerOf,
  isQuarterTurn,
  normalizeAngle,
  rotate,
  round,
  snapAngle,
  type Box,
  type Point,
  type Pose,
} from './geometry'
import {
  boundsOf,
  frontKey,
  frontKeys,
  backKeys,
  itemBounds,
  leavesOf,
  newId,
  ordered,
  painted,
  patchScene,
  selectionRoots,
  withDescendants,
  type Scene,
} from './scene'
import { keysBetween } from './sort-key'

const r2 = (n: number) => round(n, 2)

// ── Move ────────────────────────────────────────────────────────────────────

function moved(it: CanvasItem, dx: number, dy: number, all: ReadonlySet<string>): CanvasItem {
  if (it.kind === 'connector') {
    // A free end moves with the connector; a tied end stays with its shape
    // (it moves only if that shape is moving too, which settle sees to).
    return {
      ...it,
      x: r2(it.x + dx),
      y: r2(it.y + dy),
      start: it.start.bind && !all.has(it.start.bind.id) ? it.start : { ...it.start, x: r2(it.start.x + dx), y: r2(it.start.y + dy) },
      end: it.end.bind && !all.has(it.end.bind.id) ? it.end : { ...it.end, x: r2(it.end.x + dx), y: r2(it.end.y + dy) },
    }
  }
  return { ...it, x: r2(it.x + dx), y: r2(it.y + dy) }
}

/** Move these items (and what is in them) by a world offset. */
export function moveItems(scene: Scene, ids: readonly string[], dx: number, dy: number): Scene {
  if (!dx && !dy) return scene
  const all = new Set(withDescendants(scene, ids))
  const put: CanvasItem[] = []
  for (const id of all) {
    const it = scene.items[id]
    if (it.kind === 'group') continue
    // A connector tied at both ends to shapes that are not moving does not move.
    if (it.kind === 'connector') {
      const sTied = it.start.bind && scene.items[it.start.bind.id] && !all.has(it.start.bind.id)
      const eTied = it.end.bind && scene.items[it.end.bind.id] && !all.has(it.end.bind.id)
      if (sTied && eTied) continue
    }
    put.push(moved(it, dx, dy, all))
  }
  return settleConnectors(patchScene(scene, put), all)
}

// ── Resize ──────────────────────────────────────────────────────────────────

/** Which handle is held: -1, 0 or 1 on each axis (0: that axis is not dragged). */
export interface Handle {
  hx: -1 | 0 | 1
  hy: -1 | 0 | 1
}

export interface ResizeOptions {
  /** Keep the proportions (Shift). */
  proportional?: boolean
  /** Resize about the center (Alt). */
  fromCenter?: boolean
}

interface AxisMap {
  /** The fixed point on each axis. */
  ax: number
  ay: number
  /** Signed scale on each axis; negative flips. */
  sx: number
  sy: number
}

/** From a box, a held handle and where the pointer is: the scale about the fixed point. */
export function resizeMap(from: Box, handle: Handle, pointer: Point, opts: ResizeOptions = {}): AxisMap {
  const cx = from.x + from.w / 2
  const cy = from.y + from.h / 2
  const center = !!opts.fromCenter
  let ax = handle.hx === 0 || center ? cx : handle.hx > 0 ? from.x : from.x + from.w
  let ay = handle.hy === 0 || center ? cy : handle.hy > 0 ? from.y : from.y + from.h
  const span = (size: number) => (center ? size / 2 : size)
  let sx = handle.hx === 0 || !from.w ? 1 : ((pointer.x - ax) * handle.hx) / span(from.w)
  let sy = handle.hy === 0 || !from.h ? 1 : ((pointer.y - ay) * handle.hy) / span(from.h)
  if (opts.proportional) {
    if (handle.hx !== 0 && handle.hy !== 0) {
      const s = Math.max(Math.abs(sx), Math.abs(sy))
      sx = (sx < 0 ? -1 : 1) * s
      sy = (sy < 0 ? -1 : 1) * s
    } else if (handle.hx !== 0) {
      sy = Math.abs(sx)
      ay = cy
    } else if (handle.hy !== 0) {
      sx = Math.abs(sy)
      ax = cx
    }
  }
  const floor = (s: number, size: number) => {
    const min = size ? 1 / size : 0.01
    return Math.abs(s) < min ? (s < 0 ? -min : min) : s
  }
  return { ax, ay, sx: floor(sx, from.w), sy: floor(sy, from.h) }
}

export type TextResize = 'scale' | 'reflow'

/** An item in a new pose, with what is inside it scaled or flipped to match. */
function reposed(it: CanvasItem, pose: Pose, flipX: boolean, flipY: boolean, kx: number, ky: number, text: TextResize): CanvasItem {
  const next = { ...it, x: r2(pose.x), y: r2(pose.y), w: r2(Math.max(pose.w, 1)), h: r2(Math.max(pose.h, 1)), rotation: pose.rotation } as CanvasItem
  if (next.kind === 'pencil' && (flipX || flipY)) {
    next.points = next.points.map(([x, y, p]) => [flipX ? r2(next.w0 - x) : x, flipY ? r2(next.h0 - y) : y, p] as [number, number, number])
  }
  if ((next.kind === 'image' || next.kind === 'video') && (flipX || flipY)) {
    if (flipX) next.flipX = !next.flipX
    if (flipY) next.flipY = !next.flipY
  }
  if (next.kind === 'text') {
    if (text === 'scale') {
      const k = Math.sqrt(Math.abs(kx * ky)) || 1
      const size = Math.min(LIMITS.fontMax, Math.max(LIMITS.fontMin, (next.text.fontSize ?? 20) * k))
      next.text = { ...next.text, fontSize: r2(size) }
    } else {
      next.autoWidth = false
    }
  }
  if (next.kind === 'rectangle' && next.style.radius) {
    // A radius never outgrows half the short side.
    next.style = { ...next.style, radius: Math.min(next.style.radius, Math.min(next.w, next.h) / 2) }
  }
  return next
}

/**
 * Resize one item by a handle, in its own turned frame: the opposite corner
 * (or the center) stays where it is on the canvas.
 */
export function resizeOne(base: Scene, id: string, handle: Handle, pointer: Point, opts: ResizeOptions = {}): Scene {
  const it = base.items[id]
  if (!it || it.kind === 'group' || it.kind === 'connector') return base
  const c = centerOf(it)
  const local = rotate(pointer, -it.rotation, c)
  const from: Box = { x: it.x, y: it.y, w: it.w, h: it.h }
  const edgeOnly = (handle.hx === 0) !== (handle.hy === 0)
  // Media and pencils keep their shape; text scales from a corner.
  const proportional = opts.proportional || ((it.kind === 'text' || it.kind === 'image' || it.kind === 'video') && !edgeOnly)
  const m = resizeMap(from, handle, local, { ...opts, proportional })
  const w = Math.abs(from.w * m.sx)
  const h = Math.abs(from.h * m.sy)
  // The new center in the unturned frame, then turned back about the old center.
  const ncx = m.ax + (c.x - m.ax) * m.sx
  const ncy = m.ay + (c.y - m.ay) * m.sy
  const nc = rotate({ x: ncx, y: ncy }, it.rotation, c)
  const flipX = m.sx < 0
  const flipY = m.sy < 0
  const text: TextResize = it.kind === 'text' && edgeOnly && handle.hx !== 0 ? 'reflow' : 'scale'
  const next = reposed(it, { x: nc.x - w / 2, y: nc.y - h / 2, w, h, rotation: it.rotation }, flipX, flipY, m.sx, m.sy, text)
  return settleConnectors(patchScene(base, [next]), new Set([id]))
}

/**
 * Resize several items (or a group) by a handle on the upright box around
 * them. When one of them is turned off the axes, both axes scale together:
 * stretching a turned box would shear it.
 */
export function resizeMany(base: Scene, ids: readonly string[], handle: Handle, pointer: Point, opts: ResizeOptions = {}): Scene {
  const from = boundsOf(base, ids)
  if (!from) return base
  const all = new Set(withDescendants(base, ids))
  const leaves = [...all].map((id) => base.items[id]).filter((it) => it.kind !== 'group')
  const turned = leaves.some((it) => it.kind !== 'connector' && !isQuarterTurn(it.rotation))
  const keepShape = leaves.some((it) => it.kind === 'image' || it.kind === 'video' || it.kind === 'text')
  const m = resizeMap(from, handle, pointer, { ...opts, proportional: opts.proportional || turned || keepShape })
  const map = (p: Point): Point => ({ x: m.ax + (p.x - m.ax) * m.sx, y: m.ay + (p.y - m.ay) * m.sy })
  const put: CanvasItem[] = []
  for (const it of leaves) {
    if (it.kind === 'connector') {
      const s = it.start.bind && base.items[it.start.bind.id] ? it.start : { ...it.start, ...roundPoint(map(it.start)) }
      const e = it.end.bind && base.items[it.end.bind.id] ? it.end : { ...it.end, ...roundPoint(map(it.end)) }
      put.push({ ...it, start: s, end: e })
      continue
    }
    const c = map(centerOf(it))
    // A quarter-turned box has its width along the canvas's y.
    const swap = Math.abs(Math.round(normalizeAngle(it.rotation) / (Math.PI / 2))) % 2 === 1
    const kx = swap ? m.sy : m.sx
    const ky = swap ? m.sx : m.sy
    const w = Math.abs(it.w * kx)
    const h = Math.abs(it.h * ky)
    // A mirror turns the other way.
    const mirrored = m.sx < 0 !== m.sy < 0
    const rotation = mirrored ? normalizeAngle(-it.rotation) : it.rotation
    put.push(reposed(it, { x: c.x - w / 2, y: c.y - h / 2, w, h, rotation }, kx < 0, ky < 0, kx, ky, 'scale'))
  }
  return settleConnectors(patchScene(base, put), all)
}

const roundPoint = (p: Point): Point => ({ x: r2(p.x), y: r2(p.y) })

// ── Rotate ──────────────────────────────────────────────────────────────────

/** Turn items by an angle about a point (their shared center when not given). */
export function rotateItems(base: Scene, ids: readonly string[], delta: number, about?: Point): Scene {
  if (!delta) return base
  const all = new Set(withDescendants(base, ids))
  const box = boundsOf(base, ids)
  if (!box) return base
  const pivot = about ?? centerOf(box)
  const put: CanvasItem[] = []
  for (const id of all) {
    const it = base.items[id]
    if (it.kind === 'group') continue
    if (it.kind === 'connector') {
      const s = it.start.bind && base.items[it.start.bind.id] ? it.start : { ...it.start, ...roundPoint(rotate(it.start, delta, pivot)) }
      const e = it.end.bind && base.items[it.end.bind.id] ? it.end : { ...it.end, ...roundPoint(rotate(it.end, delta, pivot)) }
      put.push({ ...it, start: s, end: e })
      continue
    }
    const c = rotate(centerOf(it), delta, pivot)
    put.push({ ...it, x: r2(c.x - it.w / 2), y: r2(c.y - it.h / 2), rotation: round(normalizeAngle(it.rotation + delta), 5) })
  }
  return settleConnectors(patchScene(base, put), all)
}

/** The angle to turn by, from where a rotate drag started and where it is; Shift steps by 15 degrees. */
export function rotationDelta(pivot: Point, from: Point, to: Point, step: boolean, startRotation = 0): number {
  const raw = Math.atan2(to.y - pivot.y, to.x - pivot.x) - Math.atan2(from.y - pivot.y, from.x - pivot.x)
  if (!step) return raw
  return snapAngle(startRotation + raw, Math.PI / 12) - startRotation
}

// ── Style ───────────────────────────────────────────────────────────────────

/** Change the look of items; a group passes it to everything in it. */
export function setStyle(scene: Scene, ids: readonly string[], patch: Partial<CanvasStyle>): Scene {
  const put = leavesOf(scene, ids).map((it) => ({ ...it, style: { ...it.style, ...patch } }) as CanvasItem)
  return settleConnectors(patchScene(scene, put), new Set(put.map((p) => p.id)))
}

export function setTextStyle(scene: Scene, ids: readonly string[], patch: Partial<CanvasTextStyle>): Scene {
  const put: CanvasItem[] = []
  for (const it of leavesOf(scene, ids)) {
    if (it.kind === 'text') put.push({ ...it, text: { ...it.text, ...patch } })
    else if (it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector') put.push({ ...it, text: { ...it.text, ...patch } })
  }
  return patchScene(scene, put)
}

/** Patch any fields of connectors among the items. */
export function setConnector(scene: Scene, ids: readonly string[], patch: Partial<Pick<ConnectorItem, 'route' | 'startHead' | 'endHead'>>): Scene {
  const put = leavesOf(scene, ids)
    .filter((it): it is ConnectorItem => it.kind === 'connector')
    .map((it) => ({ ...it, ...patch }))
  return settleConnectors(patchScene(scene, put), new Set(put.map((p) => p.id)))
}

/** Set a pose field (x, y, w, h, rotation in radians) on each item, as the inspector does. */
export function setPose(scene: Scene, ids: readonly string[], patch: Partial<Pose>): Scene {
  let next = scene
  const roots = selectionRoots(scene, ids)
  if (patch.x !== undefined || patch.y !== undefined) {
    const box = boundsOf(scene, roots)
    if (box) next = moveItems(next, roots, patch.x !== undefined ? patch.x - box.x : 0, patch.y !== undefined ? patch.y - box.y : 0)
  }
  if (patch.w !== undefined || patch.h !== undefined) {
    const single = roots.length === 1 ? next.items[roots[0]] : undefined
    if (single && single.kind !== 'group' && single.kind !== 'connector') {
      // In the item's own frame: the top-left corner stays.
      const w = Math.max(1, patch.w ?? single.w)
      const h = Math.max(1, patch.h ?? single.h)
      const c = centerOf(single)
      const corner = rotate({ x: single.x + w, y: single.y + h }, single.rotation, c)
      next = resizeOne(next, single.id, { hx: 1, hy: 1 }, corner)
      // resizeOne keeps media and text in proportion; say exactly what was typed for the rest.
      const after = next.items[single.id]
      if (after && after.kind !== 'text' && after.kind !== 'image' && after.kind !== 'video') {
        next = settleConnectors(patchScene(next, [{ ...after, w: r2(w), h: r2(h) } as CanvasItem]), new Set([single.id]))
      }
    } else {
      const box = boundsOf(next, roots)
      if (box) next = resizeMany(next, roots, { hx: 1, hy: 1 }, { x: box.x + Math.max(1, patch.w ?? box.w), y: box.y + Math.max(1, patch.h ?? box.h) })
    }
  }
  if (patch.rotation !== undefined) {
    for (const root of roots) {
      const it = next.items[root]
      if (it && it.kind !== 'group' && it.kind !== 'connector') next = rotateItems(next, [root], patch.rotation - it.rotation)
    }
  }
  return next
}

/** Mirror items across the vertical or horizontal middle of the box around them. */
export function flipItems(scene: Scene, ids: readonly string[], axis: 'x' | 'y'): Scene {
  const box = boundsOf(scene, ids)
  if (!box) return scene
  // A resize to the same size on the other side of the far edge.
  return axis === 'x'
    ? resizeManyExact(scene, ids, { ax: box.x + box.w / 2, ay: 0, sx: -1, sy: 1 })
    : resizeManyExact(scene, ids, { ax: 0, ay: box.y + box.h / 2, sx: 1, sy: -1 })
}

function resizeManyExact(base: Scene, ids: readonly string[], m: AxisMap): Scene {
  const all = new Set(withDescendants(base, ids))
  const map = (p: Point): Point => ({ x: m.ax + (p.x - m.ax) * m.sx, y: m.ay + (p.y - m.ay) * m.sy })
  const put: CanvasItem[] = []
  for (const id of all) {
    const it = base.items[id]
    if (it.kind === 'group') continue
    if (it.kind === 'connector') {
      const s = it.start.bind && base.items[it.start.bind.id] ? it.start : { ...it.start, ...roundPoint(map(it.start)) }
      const e = it.end.bind && base.items[it.end.bind.id] ? it.end : { ...it.end, ...roundPoint(map(it.end)) }
      put.push({ ...it, start: s, end: e })
      continue
    }
    const c = map(centerOf(it))
    const swap = Math.abs(Math.round(normalizeAngle(it.rotation) / (Math.PI / 2))) % 2 === 1
    const kx = swap ? m.sy : m.sx
    const ky = swap ? m.sx : m.sy
    put.push(reposed(it, { x: c.x - it.w / 2, y: c.y - it.h / 2, w: it.w, h: it.h, rotation: normalizeAngle(-it.rotation) }, kx < 0, ky < 0, 1, 1, 'scale'))
  }
  return settleConnectors(patchScene(base, put), all)
}

// ── Delete, duplicate ───────────────────────────────────────────────────────

/** Remove items and what is in them. A group left with nothing in it goes too. */
export function deleteItems(scene: Scene, ids: readonly string[]): Scene {
  const gone = new Set(withDescendants(scene, ids))
  if (!gone.size) return scene
  let next = patchScene(scene, [], [...gone])
  for (;;) {
    const withKids = new Set<string>()
    for (const id in next.items) {
      const p = next.items[id].parentId
      if (p) withKids.add(p)
    }
    const empty = Object.values(next.items).filter((it) => it.kind === 'group' && !withKids.has(it.id))
    if (!empty.length) break
    next = patchScene(
      next,
      [],
      empty.map((g) => g.id),
    )
  }
  return settleConnectors(next, gone)
}

export interface Copied {
  scene: Scene
  /** The new items that stand where the given ids stood. */
  ids: string[]
}

/**
 * Put copies of items into a scene, in front, shifted by an offset. `source`
 * is where the originals are read from (another canvas's fragment, or the
 * scene itself). Ties between copied items follow the copies; a tie to
 * something not copied is kept only when that thing is in this scene.
 */
export function insertCopies(scene: Scene, source: Scene, ids: readonly string[], offset: Point = { x: 0, y: 0 }): Copied {
  const roots = selectionRoots(source, ids)
  const all = withDescendants(source, roots)
  const idMap = new Map<string, string>()
  for (const id of all) idMap.set(id, newId())
  const inOrder = ordered(source).filter((it) => idMap.has(it.id))
  const keys = frontKeys(scene, inOrder.length)
  const put: CanvasItem[] = inOrder.map((it, i) => {
    const parentId = it.parentId && idMap.has(it.parentId) ? idMap.get(it.parentId)! : source === scene && it.parentId && scene.items[it.parentId] ? it.parentId : null
    const copy = { ...it, id: idMap.get(it.id)!, parentId, sortKey: keys[i], x: r2(it.x + offset.x), y: r2(it.y + offset.y) } as CanvasItem
    if (copy.kind === 'connector') {
      const end = (e: ConnectorItem['start']): ConnectorItem['start'] => {
        const moved = { x: r2(e.x + offset.x), y: r2(e.y + offset.y) }
        if (!e.bind) return moved
        if (idMap.has(e.bind.id)) return { ...moved, bind: { ...e.bind, id: idMap.get(e.bind.id)! } }
        // Tied to something left behind: stay tied if it is here, and do not shift that end.
        return scene.items[e.bind.id] ? { x: e.x, y: e.y, bind: e.bind } : moved
      }
      copy.start = end(copy.start)
      copy.end = end(copy.end)
    }
    return copy
  })
  const next = settleConnectors(patchScene(scene, put), new Set(put.map((p) => p.id)))
  return { scene: next, ids: roots.map((id) => idMap.get(id)!) }
}

export const duplicateItems = (scene: Scene, ids: readonly string[], offset: Point = { x: LIMITS.pasteStep, y: LIMITS.pasteStep }): Copied =>
  insertCopies(scene, scene, ids, offset)

// ── Groups ──────────────────────────────────────────────────────────────────

/** Put items in a new group. Needs two or more; returns the group's id. */
export function groupItems(scene: Scene, ids: readonly string[]): { scene: Scene; id: string | null } {
  const roots = selectionRoots(scene, ids)
  if (roots.length < 2) return { scene, id: null }
  const parents = new Set(roots.map((id) => scene.items[id].parentId ?? null))
  const parentId = parents.size === 1 ? [...parents][0] : null
  const group: GroupItem = { id: newId(), parentId, sortKey: frontKey(scene), kind: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, style: {} }
  const put: CanvasItem[] = [group, ...roots.map((id) => ({ ...scene.items[id], parentId: group.id }) as CanvasItem)]
  return { scene: patchScene(scene, put), id: group.id }
}

/** Take groups apart; returns what was in them. */
export function ungroupItems(scene: Scene, ids: readonly string[]): { scene: Scene; ids: string[] } {
  const groups = selectionRoots(scene, ids).filter((id) => scene.items[id]?.kind === 'group')
  if (!groups.length) return { scene, ids: [] }
  const put: CanvasItem[] = []
  const freed: string[] = []
  for (const gid of groups) {
    const g = scene.items[gid]
    for (const id in scene.items) {
      const it = scene.items[id]
      if (it.parentId === gid) {
        put.push({ ...it, parentId: g.parentId && scene.items[g.parentId] ? g.parentId : null } as CanvasItem)
        freed.push(id)
      }
    }
  }
  return { scene: patchScene(scene, put, groups), ids: freed }
}

// ── Order ───────────────────────────────────────────────────────────────────

export type OrderMove = 'front' | 'back' | 'forward' | 'backward'

/** Restack items. They keep their order among themselves. */
export function reorderItems(scene: Scene, ids: readonly string[], move: OrderMove): Scene {
  const chosen = new Set(leavesOf(scene, ids).map((it) => it.id))
  if (!chosen.size) return scene
  const list = painted(scene)
  const mine = list.filter((it) => chosen.has(it.id))
  const rest = list.filter((it) => !chosen.has(it.id))
  if (!rest.length) return scene
  let keys: string[]
  if (move === 'front') {
    if (list.slice(-mine.length).every((it) => chosen.has(it.id))) return scene
    keys = frontKeys(scene, mine.length)
  } else if (move === 'back') {
    if (list.slice(0, mine.length).every((it) => chosen.has(it.id))) return scene
    keys = backKeys(scene, mine.length)
  } else if (move === 'forward') {
    // Just above the first item that is over the topmost chosen one.
    const top = list.lastIndexOf(mine[mine.length - 1])
    const over = list.slice(top + 1).find((it) => !chosen.has(it.id))
    if (!over) return scene
    const after = rest[rest.indexOf(over) + 1]
    keys = keysBetween(over.sortKey, after?.sortKey ?? null, mine.length)
  } else {
    const bottom = list.indexOf(mine[0])
    const under = list
      .slice(0, bottom)
      .reverse()
      .find((it) => !chosen.has(it.id))
    if (!under) return scene
    const before = rest[rest.indexOf(under) - 1]
    keys = keysBetween(before?.sortKey ?? null, under.sortKey, mine.length)
  }
  return patchScene(
    scene,
    mine.map((it, i) => ({ ...it, sortKey: keys[i] }) as CanvasItem),
  )
}

// ── Align, distribute ───────────────────────────────────────────────────────

export type AlignTo = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

/** Line items up on an edge or the middle of the box around them. Two or more. */
export function alignItems(scene: Scene, ids: readonly string[], to: AlignTo): Scene {
  const roots = selectionRoots(scene, ids)
  const all = boundsOf(scene, roots)
  if (roots.length < 2 || !all) return scene
  let next = scene
  for (const id of roots) {
    const b = itemBounds(scene, id)
    if (!b) continue
    let dx = 0
    let dy = 0
    if (to === 'left') dx = all.x - b.x
    else if (to === 'right') dx = all.x + all.w - (b.x + b.w)
    else if (to === 'center') dx = all.x + all.w / 2 - (b.x + b.w / 2)
    else if (to === 'top') dy = all.y - b.y
    else if (to === 'bottom') dy = all.y + all.h - (b.y + b.h)
    else dy = all.y + all.h / 2 - (b.y + b.h / 2)
    next = moveItems(next, [id], dx, dy)
  }
  return next
}

/** Space items so the gaps between them are equal. Three or more; the outer two stay. */
export function distributeItems(scene: Scene, ids: readonly string[], axis: 'x' | 'y'): Scene {
  const roots = selectionRoots(scene, ids)
  if (roots.length < 3) return scene
  const boxes = roots
    .map((id) => ({ id, box: itemBounds(scene, id) }))
    .filter((e): e is { id: string; box: Box } => !!e.box)
    .sort((a, b) => (axis === 'x' ? a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2) : a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2)))
  if (boxes.length < 3) return scene
  const size = (b: Box) => (axis === 'x' ? b.w : b.h)
  const start = (b: Box) => (axis === 'x' ? b.x : b.y)
  const first = boxes[0].box
  const last = boxes[boxes.length - 1].box
  const total = boxes.reduce((sum, e) => sum + size(e.box), 0)
  const gap = (start(last) + size(last) - start(first) - total) / (boxes.length - 1)
  let at = start(first)
  let next = scene
  for (const e of boxes) {
    const d = at - start(e.box)
    next = axis === 'x' ? moveItems(next, [e.id], d, 0) : moveItems(next, [e.id], 0, d)
    at += size(e.box) + gap
  }
  return next
}

export { aabb }
