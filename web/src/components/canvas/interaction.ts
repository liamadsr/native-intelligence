/**
 * What the pointer and the keys do on the canvas. No React and no DOM events:
 * the surface hands in plain inputs, and this drives the store. A press
 * starts a gesture; moves preview it; the release commits it as one undo
 * step; Escape puts everything back.
 */
import type { BindAnchor, CanvasItem, ConnectorEnd, ConnectorItem } from '@/lib/canvas/types'
import { toWorld, viewBox } from '@/lib/canvas/engine/camera'
import { isBindable, nearestAnchor, settleConnectors } from '@/lib/canvas/engine/connectors'
import { makeConnector, makePencil, makeShape, makeText, visibleStroke, LIMITS } from '@/lib/canvas/engine/defaults'
import { aabb, boxFromPoints, boxesIntersect, centerOf, dist, pointInPose, type Box, type Point } from '@/lib/canvas/engine/geometry'
import { itemsInBox, itemsOnSegment, pick, pickBox } from '@/lib/canvas/engine/hit'
import { deleteItems, duplicateItems, moveItems, resizeMany, resizeOne, rotateItems, rotationDelta, type Handle } from '@/lib/canvas/engine/ops'
import { boundsOf, frontKey, newId, painted, patchScene, rootOf, withDescendants, type Scene } from '@/lib/canvas/engine/scene'
import { axisLock, snap45, snapMove, snapPoint, snapPointTo, snapTo, type Guide } from '@/lib/canvas/engine/snap'
import { grabAt, resizeCursor, selectionFrame, type Frame } from './selection-frame'
import { DRAWING_TOOLS, type CanvasStore, type ToolId } from './store'

export interface PointerInput {
  /** Screen pixels, from the surface's top-left. */
  x: number
  y: number
  button: number
  shift: boolean
  alt: boolean
  /** Cmd on a Mac, Ctrl elsewhere. */
  mod: boolean
  pressure: number
  pointerType: string
}

export interface KeyInput {
  key: string
  shift: boolean
  alt: boolean
  mod: boolean
  repeat?: boolean
}

const DRAG_START = 3
const SNAP_PX = 6
const SNAP_REACH_PX = 160
const ANCHOR_PX = 14

type Gesture =
  | { type: 'pan'; last: Point }
  | { type: 'marquee'; start: Point; initial: readonly string[]; moved: boolean }
  | {
      type: 'move'
      start: Point
      startScreen: Point
      ids: readonly string[]
      base: Scene
      box: Box | null
      others: Box[]
      started: boolean
      /** On a release without a drag: what the click means. */
      click: { toggle?: string; only?: string; clear?: boolean }
      copyIds: string[] | null
    }
  | { type: 'resize'; ids: readonly string[]; single: string | null; handle: Handle; base: Scene; others: Box[]; upright: boolean; started: boolean; startScreen: Point }
  | { type: 'rotate'; ids: readonly string[]; base: Scene; pivot: Point; start: Point; startRotation: number; started: boolean; startScreen: Point }
  | { type: 'shape'; kind: 'rectangle' | 'ellipse'; id: string; sortKey: string; start: Point }
  | { type: 'connect'; id: string; sortKey: string; start: ConnectorEnd; tool: 'arrow' | 'line' | 'connector'; startScreen: Point }
  | { type: 'end'; id: string; which: 'start' | 'end'; base: Scene }
  | { type: 'pencil'; id: string; sortKey: string; points: Array<[number, number, number]>; pen: boolean }
  | { type: 'eraser'; last: Point; ids: Set<string>; trail: Point[] }
  | { type: 'text'; start: Point; startScreen: Point }

export class Interaction {
  private gesture: Gesture | null = null
  private last: PointerInput | null = null
  spaceHeld = false

  constructor(private store: CanvasStore) {}

  get active(): boolean {
    return this.gesture !== null
  }
  get panning(): boolean {
    return this.gesture?.type === 'pan'
  }

  private world(e: { x: number; y: number }): Point {
    return toWorld(this.store.camera, e)
  }
  private tol(px: number): number {
    return px / this.store.camera.scale
  }
  private pickTol(e: PointerInput): number {
    return this.tol(e.pointerType === 'touch' ? 10 : 3)
  }

  /** The boxes of what is in view and not being dragged: what a drag can snap to. */
  private snapTargets(scene: Scene, moving: ReadonlySet<string>): Box[] {
    if (!this.store.getState().prefs.snapObjects) return []
    const view = viewBox(this.store.camera, this.store.viewport.w, this.store.viewport.h)
    const out: Box[] = []
    for (const it of painted(scene)) {
      if (moving.has(it.id) || it.kind === 'connector') continue
      const b = aabb(it)
      if (boxesIntersect(view, b)) out.push(b)
      if (out.length >= 600) break
    }
    return out
  }

  /** The shape and anchor a connector end would take at this point. */
  private bindAt(scene: Scene, p: Point, skip?: string): { id: string; anchor: BindAnchor; point: Point } | null {
    const list = painted(scene)
    const reach = this.tol(ANCHOR_PX)
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i]
      if (it.id === skip || !isBindable(it)) continue
      if (!pointInPose(p, it, reach)) continue
      const near = nearestAnchor(it, p)
      // Near an edge's middle: that edge. Anywhere else on the shape: its center.
      if (near.anchor !== 'center' && near.distance <= reach) return { id: it.id, anchor: near.anchor, point: near.point }
      if (pointInPose(p, it, 0)) return { id: it.id, anchor: 'center', point: centerOf(it) }
    }
    return null
  }

  // ── Press ─────────────────────────────────────────────────────────────────

  pointerDown(e: PointerInput): void {
    if (this.gesture) return
    this.last = e
    const store = this.store
    const state = store.getState()
    const world = this.world(e)
    const tool: ToolId = state.tool

    if (e.button === 1 || this.spaceHeld || (tool === 'hand' && e.button === 0)) {
      this.gesture = { type: 'pan', last: { x: e.x, y: e.y } }
      return
    }
    if (e.button === 2) {
      this.contextAt(e)
      return
    }
    if (e.button !== 0) return
    if (state.editing) return
    // A press on the canvas takes the pointer back from an open artifact.
    if (state.opened) store.setOpened(null)

    if (tool === 'select') return this.selectDown(e, world)
    if (state.readOnly) return
    return this.toolDown(e, world, tool)
  }

  /** A right-click or a long press takes what is under it before its menu opens. */
  contextAt(e: PointerInput): void {
    const store = this.store
    const state = store.getState()
    const world = this.world(e)
    const tool = state.tool
    {
      if (!state.editing && tool === 'select') {
        const hit = pick(state.scene, world, this.pickTol(e))
        const target = hit ? store.targetOf(hit.id, e.mod) : null
        if (target && !state.selection.includes(target)) store.select([target])
        else if (!target) {
          const frame = selectionFrame(state.scene, state.selection)
          if (!frame || grabAt(frame, store.camera, e, { handles: false })?.type !== 'inside') store.select([])
        }
      }
    }
  }

  private toolDown(e: PointerInput, world: Point, tool: ToolId): void {
    const store = this.store
    const state = store.getState()
    const step = store.snapStep()
    const snapped = snapPointTo(world, step)
    if (tool === 'rectangle' || tool === 'ellipse') {
      this.gesture = { type: 'shape', kind: tool, id: newId(), sortKey: frontKey(state.base), start: snapped }
      return
    }
    if (tool === 'arrow' || tool === 'line' || tool === 'connector') {
      const bind = this.bindAt(state.base, world)
      const start: ConnectorEnd = bind ? { x: bind.point.x, y: bind.point.y, bind: { id: bind.id, anchor: bind.anchor } } : { x: snapped.x, y: snapped.y }
      this.gesture = { type: 'connect', id: newId(), sortKey: frontKey(state.base), start, tool, startScreen: { x: e.x, y: e.y } }
      return
    }
    if (tool === 'pencil') {
      const pen = e.pointerType === 'pen'
      this.gesture = { type: 'pencil', id: newId(), sortKey: frontKey(state.base), points: [[world.x, world.y, pen ? e.pressure || 0.5 : 0.5]], pen }
      this.drawPencil()
      return
    }
    if (tool === 'eraser') {
      this.gesture = { type: 'eraser', last: world, ids: new Set(), trail: [world] }
      this.erase(world)
      return
    }
    if (tool === 'text') {
      this.gesture = { type: 'text', start: snapped, startScreen: { x: e.x, y: e.y } }
    }
  }

  private selectDown(e: PointerInput, world: Point): void {
    const store = this.store
    const state = store.getState()
    const { scene, selection, readOnly } = state
    const frame = selectionFrame(scene, selection)
    const touch = e.pointerType === 'touch'
    const grab = frame ? grabAt(frame, store.camera, e, { handles: !readOnly, scaleHit: touch ? 1.6 : 1 }) : null

    if (grab && frame && grab.type === 'end' && frame.kind === 'connector') {
      this.gesture = { type: 'end', id: frame.id, which: grab.which, base: state.base }
      return
    }
    if (grab && frame && frame.kind !== 'connector' && grab.type === 'rotate') {
      const all = new Set(withDescendants(scene, selection))
      void all
      this.gesture = {
        type: 'rotate',
        ids: selection,
        base: state.base,
        pivot: centerOf(frame.pose),
        start: world,
        startRotation: frame.kind === 'single' ? frame.pose.rotation : 0,
        started: false,
        startScreen: { x: e.x, y: e.y },
      }
      return
    }
    if (grab && frame && frame.kind !== 'connector' && grab.type === 'resize') {
      const moving = new Set(withDescendants(scene, selection))
      this.gesture = {
        type: 'resize',
        ids: selection,
        single: frame.kind === 'single' ? frame.id : null,
        handle: grab.handle,
        base: state.base,
        others: this.snapTargets(scene, moving),
        upright: frame.pose.rotation === 0,
        started: false,
        startScreen: { x: e.x, y: e.y },
      }
      return
    }

    const hit = pick(scene, world, this.pickTol(e))
    if (hit) {
      const target = store.targetOf(hit.id, e.mod)
      const inSelection = selection.includes(target)
      let ids: readonly string[] = selection
      const click: { toggle?: string; only?: string } = {}
      if (e.shift) {
        if (inSelection) click.toggle = target
        else ids = [...selection, target]
      } else if (!inSelection) {
        ids = [target]
      } else if (selection.length > 1) {
        click.only = target
      }
      if (ids !== selection) store.select(ids)
      this.startMove(e, world, store.getState().selection, click)
      return
    }
    if (grab?.type === 'inside' && selection.length) {
      // In the frame but on nothing: a drag moves the selection, a click lets go of it.
      this.startMove(e, world, selection, e.shift ? {} : { clear: true })
      return
    }
    if (!e.shift && selection.length) store.select([])
    this.gesture = { type: 'marquee', start: world, initial: e.shift ? selection : [], moved: false }
  }

  private startMove(e: PointerInput, world: Point, ids: readonly string[], click: { toggle?: string; only?: string; clear?: boolean }): void {
    const state = this.store.getState()
    const moving = new Set(withDescendants(state.scene, ids))
    this.gesture = {
      type: 'move',
      start: world,
      startScreen: { x: e.x, y: e.y },
      ids,
      base: state.base,
      box: boundsOf(state.base, ids),
      others: this.snapTargets(state.scene, moving),
      started: false,
      click,
      copyIds: null,
    }
  }

  // ── Move ──────────────────────────────────────────────────────────────────

  pointerMove(e: PointerInput): void {
    this.last = e
    const g = this.gesture
    if (!g) return
    const store = this.store
    const world = this.world(e)
    const step = store.snapStep()

    switch (g.type) {
      case 'pan':
        store.pan(e.x - g.last.x, e.y - g.last.y)
        g.last = { x: e.x, y: e.y }
        return

      case 'marquee': {
        if (!g.moved && dist(this.world(e), g.start) * store.camera.scale < DRAG_START) return
        g.moved = true
        const box = boxFromPoints(g.start, world)
        const scene = store.getState().scene
        const hit = new Set<string>(g.initial)
        for (const it of itemsInBox(scene, box)) hit.add(rootOf(scene, it.id))
        store.select([...hit])
        store.setOverlay({ marquee: box })
        return
      }

      case 'move': {
        if (store.getState().readOnly) return
        if (!g.started) {
          if (dist(e, g.startScreen) < DRAG_START) return
          g.started = true
          if (e.alt) {
            // Alt-drag: the copies are what moves; the originals stay.
            const copy = duplicateItems(g.base, g.ids, { x: 0, y: 0 })
            g.base = copy.scene
            g.copyIds = copy.ids
            g.ids = copy.ids
          }
        }
        let dx = world.x - g.start.x
        let dy = world.y - g.start.y
        if (e.shift) ({ dx, dy } = axisLock(dx, dy))
        let guides: Guide[] = []
        if (g.box) {
          if (step) {
            dx = snapTo(g.box.x + dx, step) - g.box.x
            dy = snapTo(g.box.y + dy, step) - g.box.y
          }
          if (g.others.length) {
            const snap = snapMove({ x: g.box.x + dx, y: g.box.y + dy, w: g.box.w, h: g.box.h }, g.others, this.tol(SNAP_PX), this.tol(SNAP_REACH_PX))
            if (!(e.shift && dx === 0)) dx += snap.dx
            if (!(e.shift && dy === 0)) dy += snap.dy
            guides = snap.guides.filter((gd) => !e.shift || (gd.axis === 'x' ? dx !== 0 : dy !== 0) || true)
          }
        }
        store.preview(moveItems(g.base, g.ids, dx, dy))
        if (g.copyIds) store.select(g.copyIds)
        store.setOverlay({ guides })
        return
      }

      case 'resize': {
        if (!g.started) {
          if (dist(e, g.startScreen) < DRAG_START) return
          g.started = true
        }
        let p = snapPointTo(world, step)
        let guides: Guide[] = []
        if (g.upright && g.others.length) {
          const s = snapPoint(p, g.others, this.tol(SNAP_PX), { x: g.handle.hx !== 0, y: g.handle.hy !== 0 })
          p = s.point
          guides = s.guides
        }
        const opts = { proportional: e.shift, fromCenter: e.alt }
        store.preview(g.single ? resizeOne(g.base, g.single, g.handle, p, opts) : resizeMany(g.base, g.ids, g.handle, p, opts))
        store.setOverlay({ guides })
        return
      }

      case 'rotate': {
        if (!g.started) {
          if (dist(e, g.startScreen) < DRAG_START) return
          g.started = true
        }
        store.preview(rotateItems(g.base, g.ids, rotationDelta(g.pivot, g.start, world, e.shift, g.startRotation), g.pivot))
        return
      }

      case 'shape': {
        let end = snapPointTo(world, step)
        if (e.shift) {
          const side = Math.max(Math.abs(end.x - g.start.x), Math.abs(end.y - g.start.y))
          end = { x: g.start.x + Math.sign(end.x - g.start.x || 1) * side, y: g.start.y + Math.sign(end.y - g.start.y || 1) * side }
        }
        let box = boxFromPoints(g.start, end)
        if (e.alt) box = { x: g.start.x - box.w, y: g.start.y - box.h, w: box.w * 2, h: box.h * 2 }
        const state = store.getState()
        const item = { ...makeShape(g.kind, box, g.sortKey, visibleStrokeOrFill(state.defaults.shape)), id: g.id }
        store.preview(patchScene(state.base, [item]))
        return
      }

      case 'connect': {
        const state = store.getState()
        const bind = this.bindAt(state.base, world, undefined)
        const sameShape = bind && g.start.bind && bind.id === g.start.bind.id
        let end: ConnectorEnd
        if (bind && !sameShape) end = { x: bind.point.x, y: bind.point.y, bind: { id: bind.id, anchor: bind.anchor } }
        else {
          let p = snapPointTo(world, step)
          if (e.shift) p = snap45(g.start, p)
          end = { x: p.x, y: p.y }
        }
        const style = visibleStroke(state.defaults.line)
        const item: ConnectorItem = {
          ...makeConnector(g.start, end, g.sortKey, {
            style,
            route: g.tool === 'connector' ? (state.defaults.route === 'straight' ? 'elbow' : state.defaults.route) : state.defaults.route,
            endHead: g.tool === 'line' ? 'none' : 'arrow',
          }),
          id: g.id,
        }
        store.preview(settleConnectors(patchScene(state.base, [item]), new Set([g.id])))
        store.setOverlay({ bind: bind && !sameShape ? { id: bind.id, anchor: bind.anchor } : null })
        return
      }

      case 'end': {
        const it = g.base.items[g.id] as ConnectorItem | undefined
        if (!it) return
        const other = g.which === 'start' ? it.end : it.start
        const bind = this.bindAt(g.base, world, g.id)
        const sameShape = bind && other.bind && bind.id === other.bind.id
        let end: ConnectorEnd
        if (bind && !sameShape) end = { x: bind.point.x, y: bind.point.y, bind: { id: bind.id, anchor: bind.anchor } }
        else {
          let p = snapPointTo(world, step)
          if (e.shift) p = snap45(other, p)
          end = { x: p.x, y: p.y }
        }
        const next: ConnectorItem = { ...it, [g.which]: end }
        store.preview(settleConnectors(patchScene(g.base, [next]), new Set([g.id])))
        store.setOverlay({ bind: bind && !sameShape ? { id: bind.id, anchor: bind.anchor } : null })
        return
      }

      case 'pencil': {
        const lastPt = g.points[g.points.length - 1]
        if (Math.hypot(world.x - lastPt[0], world.y - lastPt[1]) * store.camera.scale < 1) return
        g.points.push([world.x, world.y, g.pen ? e.pressure || 0.5 : 0.5])
        this.drawPencil()
        return
      }

      case 'eraser':
        this.erase(world)
        return

      case 'text':
        return
    }
  }

  private drawPencil(): void {
    const g = this.gesture
    if (g?.type !== 'pencil') return
    const state = this.store.getState()
    const item = { ...makePencil(g.points, g.sortKey, visibleStroke(state.defaults.pencil, 4), g.pen), id: g.id }
    this.store.preview(patchScene(state.base, [item]))
  }

  private erase(world: Point): void {
    const g = this.gesture
    if (g?.type !== 'eraser') return
    const scene = this.store.getState().base
    for (const it of itemsOnSegment(scene, g.last, world, this.tol(6))) g.ids.add(it.id)
    g.last = world
    g.trail.push(world)
    if (g.trail.length > 24) g.trail.shift()
    this.store.setOverlay({ eraser: [...g.trail], erasing: [...g.ids] })
  }

  // ── Release ───────────────────────────────────────────────────────────────

  pointerUp(e: PointerInput): void {
    const g = this.gesture
    if (!g) return
    this.gesture = null
    const store = this.store
    const state = store.getState()

    switch (g.type) {
      case 'pan':
        return
      case 'marquee':
        store.clearOverlay()
        return
      case 'move':
        if (g.started) {
          store.commit(state.scene, g.copyIds ? { selection: g.copyIds } : {})
        } else {
          store.cancelPreview()
          if (g.click.toggle) store.select(state.selection.filter((id) => id !== g.click.toggle))
          else if (g.click.only) store.select([g.click.only])
          else if (g.click.clear) {
            // A click in the frame on nothing: take what is under the pointer in any box, or let go.
            store.select([])
          }
        }
        return
      case 'resize':
      case 'rotate':
        if (g.started) store.commit()
        else store.cancelPreview()
        return
      case 'end':
        store.commit()
        return
      case 'shape': {
        const it = state.scene.items[g.id]
        if (!it || (it.w < LIMITS.minShape && it.h < LIMITS.minShape)) {
          store.cancelPreview()
          return
        }
        store.commit()
        store.toolDone([g.id])
        return
      }
      case 'connect': {
        const it = state.scene.items[g.id] as ConnectorItem | undefined
        if (!it || dist(e, g.startScreen) < DRAG_START * 2) {
          store.cancelPreview()
          return
        }
        store.commit()
        store.toolDone([g.id])
        return
      }
      case 'pencil':
        // Each stroke is its own step; the pencil stays in hand.
        store.commit()
        return
      case 'eraser': {
        const ids = [...g.ids]
        if (ids.length) store.apply((s) => deleteItems(s, ids))
        else store.clearOverlay()
        return
      }
      case 'text': {
        const world = this.world(e)
        const wide = Math.abs(e.x - g.startScreen.x) > 8
        const at = wide ? { x: Math.min(g.start.x, world.x), y: g.start.y } : g.start
        this.newText(at, wide ? Math.abs(world.x - g.start.x) : undefined)
        return
      }
    }
  }

  /** Put an empty text box down and open it for typing. It is not committed until it has words. */
  newText(at: Point, width?: number): void {
    const store = this.store
    const state = store.getState()
    if (state.readOnly) return
    const item = makeText(at, frontKey(state.base), { width, text: state.defaults.text })
    store.preview(patchScene(state.base, [item]))
    store.select([])
    store.setEditing(item.id)
  }

  /** The pointer left, the window lost focus, or Escape: drop the gesture. */
  cancel(): void {
    if (!this.gesture) return
    const wasPan = this.gesture.type === 'pan'
    this.gesture = null
    if (!wasPan) this.store.cancelPreview()
  }

  /** A modifier went down or up mid-drag: redo the last move with it. */
  private replay(patch: Partial<PointerInput>): void {
    if (this.gesture && this.last && this.gesture.type !== 'pan') this.pointerMove({ ...this.last, ...patch })
  }

  // ── Double-click ──────────────────────────────────────────────────────────

  doubleClick(e: PointerInput): void {
    const store = this.store
    const state = store.getState()
    if (state.tool !== 'select' || state.editing) return
    const world = this.world(e)
    const hit = pick(state.scene, world, this.pickTol(e)) ?? pickBox(state.scene, world)
    if (hit?.kind === 'artifact') {
      // Its page takes the pointer (looking only, too: a page is there to be used).
      store.select([store.targetOf(hit.id, true)])
      store.setOpened(hit.id)
      return
    }
    if (state.readOnly) {
      // Looking only: a card still opens its record.
      if (hit?.kind === 'record') store.openRecord?.(hit.ref)
      return
    }
    if (!hit) {
      this.newText(snapPointTo(world, store.snapStep()))
      return
    }
    if (hit.kind === 'text' || hit.kind === 'rectangle' || hit.kind === 'ellipse' || hit.kind === 'connector') {
      store.select([hit.id])
      store.setEditing(hit.id)
    } else if (hit.kind === 'record') {
      store.openRecord?.(hit.ref)
    }
  }

  /**
   * Typing is over. `text` is what the box holds: its words, and its
   * formatting when it has any (null: nothing to save). A new box with no
   * words vanishes and leaves no undo step; an old one emptied is removed; a
   * label emptied is taken off its shape.
   */
  finishEditing(input: string | { plain: string; rich?: unknown } | null): void {
    const store = this.store
    const state = store.getState()
    const id = state.editing
    if (!id) return
    const it = state.scene.items[id]
    const isNew = !state.base.items[id]
    const given = typeof input === 'string' ? { plain: input } : input
    const words = (given?.plain ?? '').replace(/\u00a0/g, ' ')
    const empty = !words.trim()
    const text = { plain: words, ...(given?.rich && !empty ? { rich: given.rich } : {}) }
    if (!it) {
      store.setEditing(null)
      return
    }
    if (it.kind === 'text') {
      if (empty) {
        if (isNew) {
          store.cancelPreview()
          store.setEditing(null)
          if (!state.toolLock && state.tool === 'text') store.setTool('select')
        } else store.apply((s) => deleteItems(s, [id]), { editing: null, selection: [] })
        return
      }
      const next = { ...it, content: text }
      store.commit(patchScene(state.scene, [next]), { editing: null })
      if (isNew) store.toolDone([id])
      return
    }
    if (it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector') {
      const had = it.label
      const same = (had?.plain ?? '') === words && JSON.stringify(had?.rich ?? null) === JSON.stringify(text.rich ?? null)
      if (same || (empty && !had?.plain)) {
        store.setEditing(null)
        return
      }
      const next = { ...it } as typeof it
      if (empty) delete next.label
      else next.label = text
      store.commit(patchScene(state.base, [next as CanvasItem]), { editing: null })
      return
    }
    store.setEditing(null)
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  /** Returns true when the key was used (the caller then stops it). Off while typing. */
  keyDown(e: KeyInput): boolean {
    const store = this.store
    const state = store.getState()
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

    if (key === 'Shift') {
      this.replay({ shift: true })
      return false
    }
    if (key === 'Alt') {
      this.replay({ alt: true })
      return false
    }
    if (key === ' ') {
      this.spaceHeld = true
      return true
    }
    if (key === 'Escape') {
      if (state.opened) store.setOpened(null)
      else if (this.gesture) this.cancel()
      else if (state.tool !== 'select') store.setTool('select')
      else store.select([])
      return true
    }
    if (this.gesture) return false

    if (e.mod) {
      switch (key) {
        case 'z':
          if (e.shift) store.redo()
          else store.undo()
          return true
        case 'y':
          store.redo()
          return true
        case 'a':
          store.selectAll()
          return true
        case 'd':
          store.duplicateSelection()
          return true
        case 'g':
          if (e.shift) store.ungroup()
          else store.group()
          return true
        case '=':
        case '+':
          store.zoomIn()
          return true
        case '-':
        case '_':
          store.zoomOut()
          return true
        case '0':
          store.zoomTo(1)
          return true
      }
      return false
    }

    if (!e.alt && key === 'i' && !state.readOnly) {
      const at = this.last ? { x: this.last.x, y: this.last.y } : { x: store.viewport.w / 2, y: store.viewport.h / 2 }
      store.openInsert?.(at)
      return true
    }
    const tools: Record<string, ToolId> = { v: 'select', h: 'hand', r: 'rectangle', o: 'ellipse', a: 'arrow', l: 'line', p: 'pencil', e: 'eraser', t: 'text' }
    if (!e.alt && tools[key]) {
      store.setTool(tools[key])
      return true
    }
    switch (key) {
      case 'Backspace':
      case 'Delete':
        store.deleteSelection()
        return true
      case 'Enter': {
        if (state.selection.length !== 1 || state.readOnly) return false
        const it = state.scene.items[state.selection[0]]
        if (it && (it.kind === 'text' || it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector')) {
          store.setEditing(it.id)
          return true
        }
        return false
      }
      case 'ArrowLeft':
        store.nudge(-1, 0, e.shift)
        return true
      case 'ArrowRight':
        store.nudge(1, 0, e.shift)
        return true
      case 'ArrowUp':
        store.nudge(0, -1, e.shift)
        return true
      case 'ArrowDown':
        store.nudge(0, 1, e.shift)
        return true
      case ']':
        store.reorder(e.alt ? 'forward' : 'front')
        return true
      case '[':
        store.reorder(e.alt ? 'backward' : 'back')
        return true
      case '‘': // Alt+] on a Mac keyboard
        store.reorder('forward')
        return true
      case '“': // Alt+[ on a Mac keyboard
        store.reorder('backward')
        return true
      case '.':
        store.zoomToFit(state.selection.length > 0)
        return true
    }
    return false
  }

  keyUp(e: KeyInput): void {
    if (e.key === ' ') this.spaceHeld = false
    else if (e.key === 'Shift') this.replay({ shift: false })
    else if (e.key === 'Alt') this.replay({ alt: false })
  }

  /** The pointer moved with nothing pressed: show where a connector would tie. */
  hover(e: PointerInput): void {
    this.last = e
    const store = this.store
    const state = store.getState()
    const tool = state.tool
    const cur = state.overlay.bind
    if (state.readOnly || (tool !== 'arrow' && tool !== 'line' && tool !== 'connector')) {
      if (cur) store.setOverlay({ bind: null })
      return
    }
    const bind = this.bindAt(state.scene, this.world(e))
    if ((bind?.id ?? null) === (cur?.id ?? null) && (bind?.anchor ?? null) === (cur?.anchor ?? null)) return
    store.setOverlay({ bind: bind ? { id: bind.id, anchor: bind.anchor } : null })
  }

  // ── Cursor ────────────────────────────────────────────────────────────────

  /** The cursor for where the pointer is. */
  cursor(e: { x: number; y: number }): string {
    const store = this.store
    const state = store.getState()
    if (this.gesture?.type === 'pan') return 'grabbing'
    if (this.spaceHeld || state.tool === 'hand') return 'grab'
    if (state.tool === 'text') return 'text'
    if (state.tool !== 'select') return 'crosshair'
    const frame: Frame | null = selectionFrame(state.scene, state.selection)
    if (frame && !state.readOnly) {
      const grab = grabAt(frame, store.camera, e)
      if (grab?.type === 'rotate') return 'grab'
      if (grab?.type === 'end') return 'move'
      if (grab?.type === 'resize' && frame.kind !== 'connector') return resizeCursor(grab.handle, frame.pose.rotation)
      if (grab?.type === 'inside') return 'move'
    }
    if (pick(state.scene, this.world(e), this.tol(3))) return state.readOnly ? 'default' : 'move'
    return 'default'
  }
}

/** A shape's style with a stroke you can see, unless it has a fill to be seen by. */
function visibleStrokeOrFill<T extends { fill?: string; stroke?: string; strokeWidth?: number; opacity?: number }>(style: T): T {
  const hasFill = !!style.fill && style.fill !== 'transparent'
  if (hasFill && (!style.stroke || style.stroke === 'transparent' || !style.strokeWidth)) return style.opacity === 0 ? { ...style, opacity: 1 } : style
  return visibleStroke(style) as T
}

export { DRAWING_TOOLS }
