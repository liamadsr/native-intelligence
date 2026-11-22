/**
 * Pasting from Excalidraw (import only). Its clipboard and file JSON carry a
 * flat list of elements; this turns the ones a canvas can hold into items:
 * rectangles, ellipses, text, freehand, lines and arrows. A diamond becomes a
 * rectangle. Text bound to a shape becomes that shape's label. Images, frames
 * and embeds are left out, as are fill patterns and roughness.
 *
 * Written from Excalidraw's published element format (MIT), not from its code.
 */
import type { CanvasItem, CanvasStyle, ConnectorHead, ConnectorItem, FontFamily, GroupItem, StrokeStyle } from '../types'
import { makeConnector, makePencil, makeShape, makeText } from './defaults'
import { newId } from './scene'
import { keysAfter } from './sort-key'

interface XElement {
  id?: string
  type?: string
  x?: number
  y?: number
  width?: number
  height?: number
  angle?: number
  strokeColor?: string
  backgroundColor?: string
  strokeWidth?: number
  strokeStyle?: string
  opacity?: number
  roundness?: unknown
  isDeleted?: boolean
  groupIds?: string[]
  text?: string
  originalText?: string
  fontSize?: number
  fontFamily?: number
  textAlign?: string
  containerId?: string | null
  points?: Array<[number, number]>
  pressures?: number[]
  simulatePressure?: boolean
  startBinding?: { elementId?: string } | null
  endBinding?: { elementId?: string } | null
  startArrowhead?: string | null
  endArrowhead?: string | null
  elbowed?: boolean
}

/** The elements in pasted text or a dropped file, or null when it is not Excalidraw's. */
export function parseExcalidraw(text: string): XElement[] | null {
  if (!text || text.length < 20 || !text.includes('excalidraw')) return null
  try {
    const data = JSON.parse(text) as { type?: string; elements?: unknown }
    if ((data?.type !== 'excalidraw' && data?.type !== 'excalidraw/clipboard') || !Array.isArray(data.elements)) return null
    return data.elements.filter((e): e is XElement => !!e && typeof e === 'object')
  } catch {
    return null
  }
}

const n = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function color(c: string | undefined, fallback: string): string {
  if (!c || c === 'transparent') return 'transparent'
  // Excalidraw's default ink follows the theme here.
  if (c === '#1e1e1e' || c === '#000000' || c === '#000') return 'theme:ink'
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c.toLowerCase() : fallback
}

function style(e: XElement): CanvasStyle {
  const dash: StrokeStyle = e.strokeStyle === 'dashed' ? 'dashed' : e.strokeStyle === 'dotted' ? 'dotted' : 'solid'
  return {
    fill: color(e.backgroundColor, 'transparent'),
    stroke: color(e.strokeColor, 'theme:ink'),
    strokeWidth: Math.max(0.5, n(e.strokeWidth, 2)),
    strokeStyle: dash,
    opacity: Math.max(0, Math.min(1, n(e.opacity, 100) / 100)),
  }
}

const font = (f: number | undefined): FontFamily => (f === 3 ? 'mono' : 'sans')
const head = (h: string | null | undefined): ConnectorHead => (!h ? 'none' : h === 'triangle' || h === 'triangle_outline' ? 'filled' : h === 'dot' || h === 'circle' ? 'dot' : h === 'circle_outline' ? 'small-dot' : 'arrow')
const align = (a: string | undefined): 'left' | 'center' | 'right' => (a === 'center' || a === 'right' ? a : 'left')

/** Excalidraw elements as canvas items, in their stacking order, with fresh ids. */
export function fromExcalidraw(elements: readonly XElement[]): CanvasItem[] {
  const live = elements.filter((e) => !e.isDeleted && typeof e.type === 'string')
  const idMap = new Map<string, string>()
  const items: CanvasItem[] = []
  const keys = keysAfter(null, live.length * 2 + 4)
  let k = 0
  // Text that sits in a shape (or on an arrow) is that element's label.
  const labels = new Map<string, XElement>()
  for (const e of live) if (e.type === 'text' && e.containerId) labels.set(e.containerId, e)
  const groupOf = new Map<string, string[]>()

  for (const e of live) {
    const box = { x: n(e.x), y: n(e.y), w: Math.max(1, n(e.width, 1)), h: Math.max(1, n(e.height, 1)) }
    let item: CanvasItem | null = null
    if (e.type === 'rectangle' || e.type === 'diamond' || e.type === 'ellipse') {
      const shape = makeShape(e.type === 'ellipse' ? 'ellipse' : 'rectangle', box, keys[k++], style(e))
      if (e.type === 'rectangle' && e.roundness) shape.style.radius = Math.min(16, box.w / 4, box.h / 4)
      const label = e.id ? labels.get(e.id) : undefined
      const words = label ? (label.originalText ?? label.text ?? '').trim() : ''
      if (words) {
        shape.label = { plain: words }
        shape.text = { fontFamily: font(label!.fontFamily), fontSize: n(label!.fontSize, 16), color: color(label!.strokeColor, 'theme:ink'), align: 'center' }
      }
      item = { ...shape, rotation: n(e.angle) }
    } else if (e.type === 'text') {
      if (e.containerId) continue
      const words = e.originalText ?? e.text ?? ''
      if (!words.trim()) continue
      const t = makeText({ x: box.x, y: box.y }, keys[k++], { plain: words, text: { fontFamily: font(e.fontFamily), fontSize: n(e.fontSize, 20), color: color(e.strokeColor, 'theme:ink'), align: align(e.textAlign) } })
      item = { ...t, w: box.w, h: box.h, rotation: n(e.angle), style: { opacity: Math.max(0, Math.min(1, n(e.opacity, 100) / 100)) } }
    } else if (e.type === 'freedraw') {
      const pts = (e.points ?? []).filter((p) => Array.isArray(p) && p.length >= 2)
      if (!pts.length) continue
      const real = !e.simulatePressure && Array.isArray(e.pressures) && e.pressures.length === pts.length
      const s = style(e)
      const pencil = makePencil(
        pts.map((p, i) => [box.x + n(p[0]), box.y + n(p[1]), real ? n(e.pressures![i], 0.5) : 0.5] as const),
        keys[k++],
        { stroke: s.stroke === 'transparent' ? 'theme:ink' : s.stroke, strokeWidth: Math.max(2, (s.strokeWidth ?? 2) * 2), opacity: s.opacity },
        real,
      )
      item = { ...pencil, rotation: n(e.angle) }
    } else if (e.type === 'line' || e.type === 'arrow') {
      const pts = (e.points ?? []).filter((p) => Array.isArray(p) && p.length >= 2)
      if (pts.length < 2) continue
      const first = pts[0]
      const last = pts[pts.length - 1]
      const s = style(e)
      const c: ConnectorItem = makeConnector(
        { x: box.x + n(first[0]), y: box.y + n(first[1]) },
        { x: box.x + n(last[0]), y: box.y + n(last[1]) },
        keys[k++],
        {
          style: { stroke: s.stroke === 'transparent' ? 'theme:ink' : s.stroke, strokeWidth: s.strokeWidth, strokeStyle: s.strokeStyle, opacity: s.opacity },
          // Bends are not kept: an elbowed arrow stays an elbow, anything else runs straight.
          route: e.elbowed ? 'elbow' : 'straight',
          startHead: head(e.startArrowhead),
          endHead: e.type === 'arrow' ? head(e.endArrowhead === undefined ? 'arrow' : e.endArrowhead) : head(e.endArrowhead),
        },
      )
      const label = e.id ? labels.get(e.id) : undefined
      const words = label ? (label.originalText ?? label.text ?? '').trim() : ''
      if (words) c.label = { plain: words }
      // Ties are put in once every id is known.
      ;(c as ConnectorItem & { _s?: string; _e?: string })._s = e.startBinding?.elementId
      ;(c as ConnectorItem & { _s?: string; _e?: string })._e = e.endBinding?.elementId
      item = c
    }
    if (!item) continue
    if (e.id) idMap.set(e.id, item.id)
    if (Array.isArray(e.groupIds) && e.groupIds.length) groupOf.set(item.id, e.groupIds.filter((g) => typeof g === 'string'))
    items.push(item)
  }

  // Ties that point at something that came across.
  for (const it of items) {
    if (it.kind !== 'connector') continue
    const raw = it as ConnectorItem & { _s?: string; _e?: string }
    const s = raw._s ? idMap.get(raw._s) : undefined
    const e = raw._e ? idMap.get(raw._e) : undefined
    delete raw._s
    delete raw._e
    if (s) it.start = { ...it.start, bind: { id: s, anchor: 'center' } }
    if (e) it.end = { ...it.end, bind: { id: e, anchor: 'center' } }
  }

  // Groups: an element lists its groups innermost first; build the nest from the outside in.
  const groupIds = new Map<string, string>()
  const groups: GroupItem[] = []
  const groupItem = (xid: string, parentId: string | null): string => {
    let id = groupIds.get(xid)
    if (!id) {
      id = newId()
      groupIds.set(xid, id)
      groups.push({ id, parentId, sortKey: keys[k++] ?? `z${groups.length}`, kind: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, style: {} })
    }
    return id
  }
  for (const it of items) {
    const chain = groupOf.get(it.id)
    if (!chain?.length) continue
    let parent: string | null = null
    for (let i = chain.length - 1; i >= 0; i--) parent = groupItem(chain[i], parent)
    it.parentId = parent
  }
  return [...items, ...groups]
}
