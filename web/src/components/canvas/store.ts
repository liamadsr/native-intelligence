/**
 * The canvas editor's state, outside React: the scene, the selection, the
 * camera, the tool, undo. Components subscribe to the slices they draw.
 *
 * Two scenes are kept. `base` is what is committed (and what is saved);
 * `scene` is what is drawn. A drag previews into `scene` and commits once on
 * release, so a gesture is one undo step and Escape puts everything back.
 */
import type { CanvasItem, CanvasStyle, CanvasTextStyle, ConnectorItem } from '@/lib/canvas/types'
import {
  clampScale,
  fitBox,
  INITIAL_CAMERA,
  panBy,
  toWorld,
  viewBox,
  visibleGridStep,
  zoomAt,
  ZOOM_STEP,
  type Camera,
} from '@/lib/canvas/engine/camera'
import { settleConnectors } from '@/lib/canvas/engine/connectors'
import { INITIAL_DEFAULTS, LIMITS, type StyleDefaults } from '@/lib/canvas/engine/defaults'
import { boxContains, expandBox, type Box, type Point } from '@/lib/canvas/engine/geometry'
import { diffScenes, EMPTY_HISTORY, record, redo, undo, type History, type Step } from '@/lib/canvas/engine/history'
import {
  alignItems,
  deleteItems,
  distributeItems,
  duplicateItems,
  flipItems,
  groupItems,
  insertCopies,
  moveItems,
  reorderItems,
  setConnector,
  setPose,
  setStyle,
  setTextStyle,
  ungroupItems,
  type AlignTo,
  type OrderMove,
} from '@/lib/canvas/engine/ops'
import {
  boundsOf,
  EMPTY_SCENE,
  leavesOf,
  ordered,
  patchScene,
  rootOf,
  sceneBounds,
  sceneFromItems,
  selectionRoots,
  withDescendants,
  type Scene,
} from '@/lib/canvas/engine/scene'
import { gridStep, type GridSnap, type Guide } from '@/lib/canvas/engine/snap'
import type { BindAnchor } from '@/lib/canvas/types'

export type ToolId = 'select' | 'hand' | 'rectangle' | 'ellipse' | 'arrow' | 'line' | 'connector' | 'pencil' | 'eraser' | 'text'
export const DRAWING_TOOLS: readonly ToolId[] = ['rectangle', 'ellipse', 'arrow', 'line', 'connector', 'text']

export interface Overlay {
  guides: readonly Guide[]
  marquee: Box | null
  /** The shape a connector end is over, and the anchor it would take. */
  bind: { id: string; anchor: BindAnchor | null } | null
  /** The eraser's recent path, in world units. */
  eraser: readonly Point[]
  /** Items the eraser has marked in this stroke. */
  erasing: readonly string[]
}
const NO_OVERLAY: Overlay = { guides: [], marquee: null, bind: null, eraser: [], erasing: [] }

export interface Prefs {
  grid: boolean
  snapObjects: boolean
  gridSnap: GridSnap
}

export interface CanvasState {
  scene: Scene
  base: Scene
  selection: readonly string[]
  tool: ToolId
  toolLock: boolean
  /** The item whose text is being edited. */
  editing: string | null
  history: History
  defaults: StyleDefaults
  prefs: Prefs
  overlay: Overlay
  readOnly: boolean
  /** The part of the canvas whose items are mounted (the view and a margin). */
  cull: Box | null
}

/** A copied fragment: the items, and where they came from. */
export interface Fragment {
  kind: 'ni-canvas-fragment'
  source: string
  items: CanvasItem[]
}

export type ChangeListener = (step: Step) => void

export class CanvasStore {
  readonly canvasId: string
  private state: CanvasState
  private listeners = new Set<() => void>()
  private cameraListeners = new Set<() => void>()
  private changeListeners = new Set<ChangeListener>()
  camera: Camera = INITIAL_CAMERA
  viewport = { w: 0, h: 0 }
  /** True once the person has moved the camera, so a late first fit does not yank it. */
  cameraTouched = false
  private fragment: Fragment | null = null
  private pasteCount = 0

  constructor(canvasId: string, items: readonly CanvasItem[] = [], opts: { readOnly?: boolean; grid?: boolean } = {}) {
    this.canvasId = canvasId
    const scene = items.length ? settleConnectors(sceneFromItems(items)) : EMPTY_SCENE
    this.state = {
      scene,
      base: scene,
      selection: [],
      tool: 'select',
      toolLock: false,
      editing: null,
      history: EMPTY_HISTORY,
      defaults: INITIAL_DEFAULTS,
      prefs: { grid: opts.grid ?? true, snapObjects: true, gridSnap: 'none' },
      overlay: NO_OVERLAY,
      readOnly: !!opts.readOnly,
      cull: null,
    }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  getState = (): CanvasState => this.state
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  subscribeCamera = (fn: () => void): (() => void) => {
    this.cameraListeners.add(fn)
    return () => this.cameraListeners.delete(fn)
  }
  /** Called with each committed step (what to save, what to tell others). */
  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  private set(patch: Partial<CanvasState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of [...this.listeners]) fn()
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  setCamera(cam: Camera, byPerson = true): void {
    const next = { x: cam.x, y: cam.y, scale: clampScale(cam.scale) }
    if (next.x === this.camera.x && next.y === this.camera.y && next.scale === this.camera.scale) return
    this.camera = next
    if (byPerson) this.cameraTouched = true
    this.refreshCull()
    for (const fn of [...this.cameraListeners]) fn()
  }
  setViewport(w: number, h: number): void {
    if (w === this.viewport.w && h === this.viewport.h) return
    this.viewport = { w, h }
    this.refreshCull(true)
    for (const fn of [...this.cameraListeners]) fn()
  }
  private cullScale = 1
  private refreshCull(force = false): void {
    const { w, h } = this.viewport
    if (!w || !h) return
    const view = viewBox(this.camera, w, h)
    const cur = this.state.cull
    const ratio = this.camera.scale / this.cullScale
    if (!force && cur && boxContains(cur, view) && ratio > 0.5 && ratio < 2) return
    this.cullScale = this.camera.scale
    // A view's worth of margin each way, so a pan mounts nothing until it has gone a long way.
    this.set({ cull: expandBox(view, Math.max(view.w, view.h)) })
  }
  pan(dx: number, dy: number): void {
    this.setCamera(panBy(this.camera, dx, dy))
  }
  zoomTo(scale: number, at?: Point): void {
    this.setCamera(zoomAt(this.camera, at ?? { x: this.viewport.w / 2, y: this.viewport.h / 2 }, scale))
  }
  zoomIn = (): void => this.zoomTo(this.camera.scale * ZOOM_STEP)
  zoomOut = (): void => this.zoomTo(this.camera.scale / ZOOM_STEP)
  /** Show everything (or the selection, when asked and there is one). */
  zoomToFit(selectionOnly = false, byPerson = true): void {
    const { scene, selection } = this.state
    const box = selectionOnly && selection.length ? boundsOf(scene, selection) : sceneBounds(scene)
    this.setCamera(fitBox(box, this.viewport.w, this.viewport.h, selectionOnly ? 2 : 1), byPerson)
  }
  /** The world point at the middle of the view. */
  viewCenter(): Point {
    return toWorld(this.camera, { x: this.viewport.w / 2, y: this.viewport.h / 2 })
  }
  /** The step positions snap to right now (0: none). */
  snapStep(): number {
    return gridStep(this.state.prefs.gridSnap, visibleGridStep(this.camera.scale))
  }

  // ── Scene: preview, commit, undo ──────────────────────────────────────────

  /** Draw a scene without committing it (a drag in progress). */
  preview(scene: Scene): void {
    if (scene !== this.state.scene) this.set({ scene })
  }
  /** Drop the preview. */
  cancelPreview(): void {
    if (this.state.scene !== this.state.base || this.state.overlay !== NO_OVERLAY) this.set({ scene: this.state.base, overlay: NO_OVERLAY })
  }
  /** Make a scene the committed one: one undo step, one save. */
  commit(next: Scene = this.state.scene, extra: Partial<CanvasState> = {}): void {
    if (this.state.readOnly) {
      this.set({ scene: this.state.base, overlay: NO_OVERLAY })
      return
    }
    const step = diffScenes(this.state.base, next)
    if (!step.length) {
      this.set({ scene: this.state.base, overlay: NO_OVERLAY, ...extra })
      return
    }
    const selection = (extra.selection ?? this.state.selection).filter((id) => next.items[id])
    this.set({ scene: next, base: next, history: record(this.state.history, step), overlay: NO_OVERLAY, ...extra, selection })
    for (const fn of [...this.changeListeners]) fn(step)
  }
  /** Run an operation on the committed scene and commit the result. */
  apply(op: (scene: Scene) => Scene, extra: Partial<CanvasState> = {}): void {
    this.commit(op(this.state.base), extra)
  }
  /**
   * Change items without an undo step: a text box taking its measured size.
   * It is still saved.
   */
  adjust(put: readonly CanvasItem[]): void {
    if (this.state.readOnly || !put.length) return
    const committed = put.filter((it) => this.state.base.items[it.id])
    const base = settleConnectors(patchScene(this.state.base, committed), new Set(committed.map((p) => p.id)))
    const scene = this.state.scene === this.state.base ? base : settleConnectors(patchScene(this.state.scene, put), new Set(put.map((p) => p.id)))
    const step = diffScenes(this.state.base, base)
    this.set({ base, scene })
    if (step.length) for (const fn of [...this.changeListeners]) fn(step)
  }
  /** Take in what someone else changed: no undo step here, nothing to save. */
  applyRemote(put: readonly CanvasItem[], remove: readonly string[]): void {
    if (!put.length && !remove.length) return
    const touched = new Set([...put.map((p) => p.id), ...remove])
    const patch = (s: Scene) => settleConnectors(patchScene(s, put, remove), touched)
    const base = patch(this.state.base)
    const scene = this.state.scene === this.state.base ? base : patch(this.state.scene)
    const editing = this.state.editing && !scene.items[this.state.editing] ? null : this.state.editing
    this.set({ base, scene, editing, selection: this.state.selection.filter((id) => scene.items[id]) })
  }

  undo = (): void => {
    if (this.state.readOnly) return
    const r = undo(this.state.history, this.state.base)
    if (!r.step) return
    const step = diffScenes(this.state.base, r.scene)
    this.set({ history: r.history, base: r.scene, scene: r.scene, overlay: NO_OVERLAY, editing: null, selection: this.state.selection.filter((id) => r.scene.items[id]) })
    for (const fn of [...this.changeListeners]) fn(step)
  }
  redo = (): void => {
    if (this.state.readOnly) return
    const r = redo(this.state.history, this.state.base)
    if (!r.step) return
    const step = diffScenes(this.state.base, r.scene)
    this.set({ history: r.history, base: r.scene, scene: r.scene, overlay: NO_OVERLAY, editing: null, selection: this.state.selection.filter((id) => r.scene.items[id]) })
    for (const fn of [...this.changeListeners]) fn(step)
  }

  // ── Selection, tool, overlay ──────────────────────────────────────────────

  select(ids: readonly string[]): void {
    const next = selectionRoots(this.state.scene, ids)
    const cur = this.state.selection
    if (next.length === cur.length && next.every((id, i) => id === cur[i])) return
    this.set({ selection: next })
  }
  /** What clicking an item selects: the group it is in, or the item itself with `deep`. */
  targetOf(id: string, deep = false): string {
    return deep ? id : rootOf(this.state.scene, id)
  }
  selectAll = (): void => {
    const roots = new Set<string>()
    for (const it of ordered(this.state.scene)) roots.add(rootOf(this.state.scene, it.id))
    this.set({ selection: [...roots], tool: 'select' })
  }
  setTool(tool: ToolId): void {
    if (this.state.readOnly && tool !== 'select' && tool !== 'hand') return
    if (tool === this.state.tool) return
    this.set({ tool, ...(tool !== 'select' ? { selection: [], editing: null } : {}) })
  }
  /** After a drawing tool has drawn: back to Select, unless the tool is kept. */
  toolDone(created: readonly string[]): void {
    if (this.state.toolLock) this.set({ selection: [] })
    else this.set({ tool: 'select', selection: selectionRoots(this.state.scene, created) })
  }
  setToolLock = (toolLock: boolean): void => this.set({ toolLock })
  setEditing(editing: string | null): void {
    if (editing !== this.state.editing) this.set({ editing })
  }
  setOverlay(patch: Partial<Overlay>): void {
    this.set({ overlay: { ...this.state.overlay, ...patch } })
  }
  clearOverlay(): void {
    if (this.state.overlay !== NO_OVERLAY) this.set({ overlay: NO_OVERLAY })
  }
  setPrefs(patch: Partial<Prefs>): void {
    this.set({ prefs: { ...this.state.prefs, ...patch } })
  }
  setReadOnly(readOnly: boolean): void {
    if (readOnly !== this.state.readOnly) this.set({ readOnly, ...(readOnly ? { tool: 'select' as ToolId, editing: null } : {}) })
  }
  setDefaults(patch: Partial<StyleDefaults>): void {
    this.set({ defaults: { ...this.state.defaults, ...patch } })
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  deleteSelection = (): void => {
    const { selection } = this.state
    if (!selection.length) return
    this.apply((s) => deleteItems(s, selection), { selection: [], editing: null })
  }
  duplicateSelection = (): void => {
    const { selection, base } = this.state
    if (!selection.length) return
    const copy = duplicateItems(base, selection)
    this.commit(copy.scene, { selection: copy.ids })
  }
  group = (): void => {
    const g = groupItems(this.state.base, this.state.selection)
    if (g.id) this.commit(g.scene, { selection: [g.id] })
  }
  ungroup = (): void => {
    const u = ungroupItems(this.state.base, this.state.selection)
    if (u.ids.length) this.commit(u.scene, { selection: selectionRoots(u.scene, u.ids) })
  }
  reorder(move: OrderMove): void {
    const { selection } = this.state
    if (selection.length) this.apply((s) => reorderItems(s, selection, move))
  }
  align(to: AlignTo): void {
    const { selection } = this.state
    this.apply((s) => alignItems(s, selection, to))
  }
  distribute(axis: 'x' | 'y'): void {
    const { selection } = this.state
    this.apply((s) => distributeItems(s, selection, axis))
  }
  flip(axis: 'x' | 'y'): void {
    const { selection } = this.state
    if (selection.length) this.apply((s) => flipItems(s, selection, axis))
  }
  nudge(dx: number, dy: number, big: boolean): void {
    const { selection } = this.state
    if (!selection.length) return
    const unit = (this.snapStep() || 1) * (big ? 10 : 1)
    this.apply((s) => moveItems(s, selection, dx * unit, dy * unit))
  }

  /** Change the look of the selection, and of what is drawn next. */
  style(patch: Partial<CanvasStyle>, preview = false): void {
    const { selection, base, defaults } = this.state
    if (selection.length) {
      const next = setStyle(base, selection, patch)
      if (preview) this.preview(next)
      else this.commit(next)
    }
    if (preview) return
    const kinds = new Set(leavesOf(base, selection).map((it) => it.kind))
    const d: Partial<StyleDefaults> = {}
    if (!selection.length || kinds.has('rectangle') || kinds.has('ellipse')) d.shape = { ...defaults.shape, ...patch }
    if (!selection.length || kinds.has('connector')) d.line = { ...defaults.line, ...pick(patch, ['stroke', 'strokeWidth', 'strokeStyle', 'opacity']) }
    if (!selection.length || kinds.has('pencil')) d.pencil = { ...defaults.pencil, ...pick(patch, ['stroke', 'strokeWidth', 'opacity']) }
    this.setDefaults(d)
  }
  textStyle(patch: Partial<CanvasTextStyle>): void {
    const { selection, defaults } = this.state
    if (selection.length) this.apply((s) => setTextStyle(s, selection, patch))
    this.setDefaults({ text: { ...defaults.text, ...patch } })
  }
  connectorStyle(patch: Partial<Pick<ConnectorItem, 'route' | 'startHead' | 'endHead'>>): void {
    const { selection } = this.state
    if (selection.length) this.apply((s) => setConnector(s, selection, patch))
    if (patch.route) this.setDefaults({ route: patch.route })
  }
  pose(patch: Partial<{ x: number; y: number; w: number; h: number; rotation: number }>): void {
    const { selection } = this.state
    if (selection.length) this.apply((s) => setPose(s, selection, patch))
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────

  /** The selection as a fragment to copy, or null with nothing selected. */
  copyFragment(): Fragment | null {
    const { base, selection } = this.state
    if (!selection.length) return null
    const ids = new Set(withDescendants(base, selection))
    const fragment: Fragment = { kind: 'ni-canvas-fragment', source: this.canvasId, items: ordered(base).filter((it) => ids.has(it.id)) }
    this.fragment = fragment
    this.pasteCount = 0
    return fragment
  }
  /** The last fragment copied in this editor (for a paste the browser's clipboard cannot serve). */
  lastFragment = (): Fragment | null => this.fragment
  /**
   * Paste a fragment. From this canvas, each paste steps a little further
   * from the original; from anywhere else it lands in the middle of the view.
   * In place: exactly where it was.
   */
  pasteFragment(fragment: Fragment, inPlace = false): void {
    if (this.state.readOnly || !fragment.items.length) return
    const source = sceneFromItems(fragment.items)
    const roots = selectionRoots(
      source,
      fragment.items.filter((it) => !it.parentId || !source.items[it.parentId]).map((it) => it.id),
    )
    let offset: Point = { x: 0, y: 0 }
    if (!inPlace) {
      if (fragment.source === this.canvasId) {
        this.pasteCount = this.fragment === fragment || sameItems(this.fragment, fragment) ? this.pasteCount + 1 : 1
        offset = { x: LIMITS.pasteStep * this.pasteCount, y: LIMITS.pasteStep * this.pasteCount }
      } else {
        const box = boundsOf(source, roots)
        const c = this.viewCenter()
        if (box) offset = { x: c.x - (box.x + box.w / 2), y: c.y - (box.y + box.h / 2) }
      }
      const step = this.snapStep()
      if (step) offset = { x: Math.round(offset.x / step) * step, y: Math.round(offset.y / step) * step }
    }
    const copy = insertCopies(this.state.base, source, roots, offset)
    this.commit(copy.scene, { selection: copy.ids, tool: 'select' })
  }
}

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

function sameItems(a: Fragment | null, b: Fragment): boolean {
  if (!a || a.source !== b.source || a.items.length !== b.items.length) return false
  return a.items.every((it, i) => it.id === b.items[i].id)
}

/** Read a fragment out of pasted text, or null when the text is not one. */
export function parseFragment(text: string): Fragment | null {
  if (!text || text.length < 30 || !text.includes('ni-canvas-fragment')) return null
  try {
    const data = JSON.parse(text) as Fragment
    if (data?.kind !== 'ni-canvas-fragment' || !Array.isArray(data.items)) return null
    const items = data.items.filter((it) => it && typeof it.id === 'string' && typeof it.kind === 'string' && typeof it.x === 'number')
    return { kind: 'ni-canvas-fragment', source: typeof data.source === 'string' ? data.source : '', items }
  } catch {
    return null
  }
}
