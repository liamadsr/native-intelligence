/**
 * What an agent sees of a canvas and what it may do to one: a plain reading
 * of the items (ids, order, boxes, words, what connects to what) and a batch
 * of operations applied through the same engine the editor uses. No DOM: text
 * boxes are sized by estimate here and take their real size the next time
 * someone opens the canvas.
 */
import type { CanvasItem, CanvasStyle, ConnectorEnd, ConnectorHead, ConnectorItem, ConnectorRoute, StrokeStyle } from './types'
import { isThemeColor, parseHex, THEME_COLORS } from './engine/colors'
import { isBindable, settleConnectors } from './engine/connectors'
import { ARTIFACT_DEFAULT_SIZE, ARTIFACT_LIMITS, artifactTitle } from './engine/artifact'
import { DEFAULT_LABEL_STYLE, DEFAULT_LINE_STYLE, DEFAULT_SHAPE_STYLE, itemText, LIMITS, makeArtifact, makeConnector, makeShape, makeText } from './engine/defaults'
import { round } from './engine/geometry'
import { diffScenes, type Step } from './engine/history'
import { deleteItems, groupItems, moveItems, reorderItems, setPose, setStyle, ungroupItems, type OrderMove } from './engine/ops'
import { frontKey, itemBounds, ordered, patchScene, rootOf, sceneBounds, sceneFromItems, type Scene } from './engine/scene'

export const AGENT_LIMITS = { ops: 100, read: 300, text: 4000 } as const

// ── Reading ─────────────────────────────────────────────────────────────────

export interface AgentItem {
  id: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  rotation_deg?: number
  text?: string
  /** The group it is in. */
  group?: string
  /** A connector's ends: the item each is tied to, or a point. */
  from?: string | { x: number; y: number }
  to?: string | { x: number; y: number }
  route?: string
  heads?: string
  fill?: string
  stroke?: string
  /** A record card's record. */
  record?: { type: string; id: string }
  /** An artifact: how long its page is (its title is `text`). */
  html_chars?: number
}

const colorName = (c: string | undefined): string | undefined => (!c || c === 'transparent' ? undefined : c.startsWith('theme:') ? c.slice(6) : c)

/** The canvas as data: back to front, capped, with what was left out counted. */
export function describeCanvas(items: readonly CanvasItem[]): { items: AgentItem[]; total: number; omitted: number; bounds: { x: number; y: number; w: number; h: number } | null; kinds: Record<string, number> } {
  const scene = settleConnectors(sceneFromItems(items))
  const all = ordered(scene)
  const kinds: Record<string, number> = {}
  for (const it of all) kinds[it.kind] = (kinds[it.kind] ?? 0) + 1
  const out: AgentItem[] = []
  for (const it of all.slice(-AGENT_LIMITS.read)) {
    const box = it.kind === 'group' ? itemBounds(scene, it.id) : it
    const row: AgentItem = { id: it.id, kind: it.kind, x: round(box?.x ?? 0, 0), y: round(box?.y ?? 0, 0), w: round(box?.w ?? 0, 0), h: round(box?.h ?? 0, 0) }
    if (it.rotation) row.rotation_deg = round((it.rotation * 180) / Math.PI, 0)
    const text = itemText(it)
    if (text) row.text = text.length > 400 ? `${text.slice(0, 400)}…` : text
    if (it.parentId && scene.items[it.parentId]) row.group = it.parentId
    if (it.kind === 'connector') {
      const end = (e: ConnectorEnd) => (e.bind && scene.items[e.bind.id] ? e.bind.id : { x: round(e.x, 0), y: round(e.y, 0) })
      row.from = end(it.start)
      row.to = end(it.end)
      row.route = it.route
      row.heads = `${it.startHead}>${it.endHead}`
    }
    if (it.kind === 'record') row.record = { type: it.ref.type, id: it.ref.id }
    if (it.kind === 'artifact') row.html_chars = it.html.length
    const fill = colorName(it.style.fill)
    const stroke = colorName(it.style.stroke)
    if (fill) row.fill = fill
    if (stroke && stroke !== 'ink') row.stroke = stroke
    out.push(row)
  }
  const b = sceneBounds(scene)
  return { items: out, total: all.length, omitted: Math.max(0, all.length - out.length), bounds: b ? { x: round(b.x, 0), y: round(b.y, 0), w: round(b.w, 0), h: round(b.h, 0) } : null, kinds }
}

// ── Writing ─────────────────────────────────────────────────────────────────

export type AgentOp =
  | { op: 'create_shape'; key?: string; shape: 'rectangle' | 'ellipse'; x: number; y: number; w?: number; h?: number; text?: string; fill?: string; stroke?: string; radius?: number }
  | { op: 'create_text'; key?: string; x: number; y: number; text: string; width?: number; font_size?: number; color?: string }
  | { op: 'connect'; key?: string; from: string | { x: number; y: number }; to: string | { x: number; y: number }; route?: ConnectorRoute; start_head?: ConnectorHead; end_head?: ConnectorHead; label?: string; stroke?: string }
  | { op: 'move'; ids: string[]; dx?: number; dy?: number; x?: number; y?: number }
  | { op: 'resize'; id: string; w?: number; h?: number }
  | { op: 'style'; ids: string[]; fill?: string; stroke?: string; stroke_width?: number; stroke_style?: StrokeStyle; opacity?: number; radius?: number; font_size?: number; text_color?: string }
  | { op: 'set_text'; id: string; text: string }
  | { op: 'group'; key?: string; ids: string[] }
  | { op: 'ungroup'; ids: string[] }
  | { op: 'order'; ids: string[]; to: OrderMove }
  | { op: 'delete'; ids: string[] }
  | { op: 'create_artifact'; key?: string; x: number; y: number; w?: number; h?: number; html: string; title?: string }
  | { op: 'set_artifact'; id: string; html?: string; title?: string }

export const AGENT_COLOR_NAMES = THEME_COLORS.map((c) => c.id)

/** A color an agent named: a palette name, a hex, or "none". Null when it is neither. */
export function agentColor(input: string | undefined): string | null | undefined {
  if (input === undefined) return undefined
  let v = input.trim().toLowerCase().replace(/[ _]+/g, '-')
  if (v === 'none' || v === 'transparent') return 'transparent'
  // "soft blue" and "blue soft" are the same swatch.
  const soft = /^(?:theme:)?soft-([a-z]+)$/.exec(v)
  if (soft) v = `${soft[1]}-soft`
  const themed = v.startsWith('theme:') ? v : `theme:${v}`
  if (isThemeColor(themed)) return themed
  return parseHex(v)
}

/** How big words are, near enough, without a browser: for a box that has to hold them. */
export function estimateText(text: string, fontSize: number, wrapWidth?: number): { w: number; h: number } {
  const charW = fontSize * 0.56
  const lineH = fontSize * 1.4
  let lines = 0
  let widest = 0
  for (const raw of text.split('\n')) {
    const len = [...raw].length
    if (wrapWidth && len * charW > wrapWidth) {
      const perLine = Math.max(1, Math.floor(wrapWidth / charW))
      lines += Math.ceil(len / perLine)
      widest = wrapWidth
    } else {
      lines += 1
      widest = Math.max(widest, len * charW)
    }
  }
  return { w: Math.ceil(Math.max(widest, fontSize * 0.5)), h: Math.ceil(Math.max(1, lines) * lineH) }
}

export interface AgentEditResult {
  scene: Scene
  step: Step
  /** key (or op index) to the new item's id. */
  created: Record<string, string>
  done: number
  errors: Array<{ index: number; op: string; error: string }>
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const WORLD = 1_000_000

/**
 * Apply a batch of operations. Each op either applies whole or is refused with
 * a reason; the rest still apply. An id may be a real item id or the `key` an
 * earlier op in the same batch gave what it created.
 */
export function applyAgentOps(items: readonly CanvasItem[], ops: readonly AgentOp[]): AgentEditResult {
  const before = settleConnectors(sceneFromItems(items))
  let scene = before
  const created: Record<string, string> = {}
  const errors: AgentEditResult['errors'] = []
  let done = 0
  const resolve = (ref: string): string | null => (scene.items[ref] ? ref : created[ref] && scene.items[created[ref]] ? created[ref] : null)
  const resolveAll = (refs: unknown): string[] | string => {
    if (!Array.isArray(refs) || !refs.length) return 'ids is a list of item ids'
    const out: string[] = []
    for (const r of refs) {
      const id = typeof r === 'string' ? resolve(r) : null
      if (!id) return `no item ${JSON.stringify(r)} on this canvas`
      out.push(id)
    }
    return out
  }
  const remember = (key: string | undefined, index: number, id: string) => {
    created[key && !scene.items[key] ? key : `op${index}`] = id
  }
  const point = (v: unknown): v is { x: number; y: number } => !!v && typeof v === 'object' && num((v as { x: unknown }).x) && num((v as { y: unknown }).y)
  const inWorld = (...ns: number[]) => ns.every((n) => Math.abs(n) <= WORLD)

  ops.slice(0, AGENT_LIMITS.ops).forEach((op, index) => {
    const fail = (error: string) => void errors.push({ index, op: String((op as { op?: unknown })?.op), error })
    try {
      switch (op.op) {
        case 'create_shape': {
          if (op.shape !== 'rectangle' && op.shape !== 'ellipse') return fail('shape is rectangle or ellipse')
          if (!num(op.x) || !num(op.y) || !inWorld(op.x, op.y)) return fail('x and y are numbers')
          const fill = agentColor(op.fill)
          const stroke = agentColor(op.stroke)
          if (fill === null || stroke === null) return fail(`a color is one of ${AGENT_COLOR_NAMES.join(', ')}, none, or a hex like #2563eb`)
          const text = typeof op.text === 'string' ? op.text.slice(0, AGENT_LIMITS.text).trim() : ''
          let w = clamp(num(op.w) ? op.w : 320, 8, 20000)
          let h = clamp(num(op.h) ? op.h : 80, 8, 20000)
          if (text) {
            // The box grows to hold its words (never the words shrinking out of reading size).
            const inner = op.shape === 'ellipse' ? w * 0.7 : w - 16
            const need = estimateText(text, DEFAULT_LABEL_STYLE.fontSize ?? 16, Math.max(40, inner))
            const pad = op.shape === 'ellipse' ? need.h / 0.7 : need.h + 16
            if (!num(op.h) || h < pad) h = Math.max(h, Math.ceil(pad))
            if (need.w + 16 > w && !num(op.w)) w = Math.ceil(need.w + 32)
          }
          const style: CanvasStyle = { ...DEFAULT_SHAPE_STYLE, ...(fill !== undefined ? { fill } : {}), ...(stroke !== undefined ? { stroke } : {}), ...(num(op.radius) && op.shape === 'rectangle' ? { radius: clamp(op.radius, 0, LIMITS.radiusMax) } : {}) }
          const item = makeShape(op.shape, { x: op.x, y: op.y, w, h }, frontKey(scene), style)
          if (text) item.label = { plain: text }
          scene = patchScene(scene, [item])
          remember(op.key, index, item.id)
          break
        }
        case 'create_text': {
          if (!num(op.x) || !num(op.y) || !inWorld(op.x, op.y)) return fail('x and y are numbers')
          const text = typeof op.text === 'string' ? op.text.slice(0, AGENT_LIMITS.text) : ''
          if (!text.trim()) return fail('text has words in it')
          const color = agentColor(op.color)
          if (color === null) return fail('color is a palette name or a hex')
          const fontSize = clamp(num(op.font_size) ? op.font_size : 20, LIMITS.fontMin, LIMITS.fontMax)
          const width = num(op.width) ? clamp(op.width, 20, 20000) : undefined
          const size = estimateText(text, fontSize, width)
          const item = { ...makeText({ x: op.x, y: op.y }, frontKey(scene), { plain: text, width, text: { fontSize, ...(color ? { color } : {}) } }), w: width ?? size.w, h: size.h }
          scene = patchScene(scene, [item])
          remember(op.key, index, item.id)
          break
        }
        case 'connect': {
          const end = (v: unknown): ConnectorEnd | string => {
            if (typeof v === 'string') {
              const id = resolve(v)
              const target = id ? scene.items[id] : undefined
              if (!id || !target) return `no item ${JSON.stringify(v)} on this canvas`
              if (!isBindable(target)) return `a connector cannot tie to a ${target.kind}`
              return { x: target.x + target.w / 2, y: target.y + target.h / 2, bind: { id, anchor: 'center' } }
            }
            if (point(v) && inWorld(v.x, v.y)) return { x: v.x, y: v.y }
            return 'from and to are an item id or a point { x, y }'
          }
          const start = end(op.from)
          const finish = end(op.to)
          if (typeof start === 'string') return fail(start)
          if (typeof finish === 'string') return fail(finish)
          if (start.bind && finish.bind && start.bind.id === finish.bind.id) return fail('from and to are the same item')
          const stroke = agentColor(op.stroke)
          if (stroke === null) return fail('stroke is a palette name or a hex')
          const routes: ConnectorRoute[] = ['straight', 'elbow', 'smooth']
          const heads: ConnectorHead[] = ['none', 'arrow', 'filled', 'dot', 'small-dot']
          if (op.route !== undefined && !routes.includes(op.route)) return fail(`route is one of ${routes.join(', ')}`)
          if ((op.start_head !== undefined && !heads.includes(op.start_head)) || (op.end_head !== undefined && !heads.includes(op.end_head))) return fail(`a head is one of ${heads.join(', ')}`)
          const item: ConnectorItem = makeConnector(start, finish, frontKey(scene), {
            style: { ...DEFAULT_LINE_STYLE, ...(stroke ? { stroke } : {}) },
            route: op.route ?? 'straight',
            startHead: op.start_head ?? 'none',
            endHead: op.end_head ?? 'arrow',
          })
          const label = typeof op.label === 'string' ? op.label.slice(0, 200).trim() : ''
          if (label) item.label = { plain: label }
          scene = settleConnectors(patchScene(scene, [item]), new Set([item.id]))
          remember(op.key, index, item.id)
          break
        }
        case 'move': {
          const ids = resolveAll(op.ids)
          if (typeof ids === 'string') return fail(ids)
          const roots = [...new Set(ids.map((id) => rootOf(scene, id)))]
          if (num(op.x) || num(op.y)) {
            if (roots.length !== 1) return fail('x and y place one item; use dx and dy for several')
            scene = setPose(scene, roots, { ...(num(op.x) ? { x: op.x } : {}), ...(num(op.y) ? { y: op.y } : {}) })
          } else {
            const dx = num(op.dx) ? op.dx : 0
            const dy = num(op.dy) ? op.dy : 0
            if (!dx && !dy) return fail('give dx and dy, or x and y')
            if (!inWorld(dx, dy)) return fail('that is too far')
            scene = moveItems(scene, roots, dx, dy)
          }
          break
        }
        case 'resize': {
          const id = typeof op.id === 'string' ? resolve(op.id) : null
          if (!id) return fail(`no item ${JSON.stringify(op.id)} on this canvas`)
          if (!num(op.w) && !num(op.h)) return fail('give w, h or both')
          if (scene.items[id].kind === 'connector') return fail('a connector is sized by its ends')
          scene = setPose(scene, [id], { ...(num(op.w) ? { w: clamp(op.w, 1, 20000) } : {}), ...(num(op.h) ? { h: clamp(op.h, 1, 20000) } : {}) })
          break
        }
        case 'style': {
          const ids = resolveAll(op.ids)
          if (typeof ids === 'string') return fail(ids)
          const fill = agentColor(op.fill)
          const stroke = agentColor(op.stroke)
          const textColor = agentColor(op.text_color)
          if (fill === null || stroke === null || textColor === null) return fail(`a color is one of ${AGENT_COLOR_NAMES.join(', ')}, none, or a hex`)
          if (op.stroke_style !== undefined && !['solid', 'dashed', 'dotted'].includes(op.stroke_style)) return fail('stroke_style is solid, dashed or dotted')
          const patch: Partial<CanvasStyle> = {
            ...(fill !== undefined ? { fill } : {}),
            ...(stroke !== undefined ? { stroke } : {}),
            ...(num(op.stroke_width) ? { strokeWidth: clamp(op.stroke_width, 0, LIMITS.strokeMax) } : {}),
            ...(op.stroke_style ? { strokeStyle: op.stroke_style } : {}),
            ...(num(op.opacity) ? { opacity: clamp(op.opacity, 0, 1) } : {}),
            ...(num(op.radius) ? { radius: clamp(op.radius, 0, LIMITS.radiusMax) } : {}),
          }
          if (Object.keys(patch).length) scene = setStyle(scene, ids, patch)
          if (num(op.font_size) || textColor) {
            const put: CanvasItem[] = []
            for (const id of ids) {
              const it = scene.items[id]
              if (it.kind === 'text' || it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector') {
                put.push({ ...it, text: { ...it.text, ...(num(op.font_size) ? { fontSize: clamp(op.font_size, LIMITS.fontMin, LIMITS.fontMax) } : {}), ...(textColor ? { color: textColor } : {}) } } as CanvasItem)
              }
            }
            scene = patchScene(scene, put)
          }
          break
        }
        case 'set_text': {
          const id = typeof op.id === 'string' ? resolve(op.id) : null
          if (!id) return fail(`no item ${JSON.stringify(op.id)} on this canvas`)
          const it = scene.items[id]
          const text = typeof op.text === 'string' ? op.text.slice(0, AGENT_LIMITS.text) : ''
          if (it.kind === 'text') {
            if (!text.trim()) return fail('a text item needs words; delete it instead')
            const size = estimateText(text, it.text.fontSize ?? 20, it.autoWidth ? undefined : it.w)
            scene = patchScene(scene, [{ ...it, content: { plain: text }, w: it.autoWidth ? size.w : it.w, h: size.h }])
          } else if (it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector') {
            const next = { ...it } as typeof it
            if (text.trim()) next.label = { plain: text.trim() }
            else delete next.label
            scene = patchScene(scene, [next as CanvasItem])
          } else return fail(`a ${it.kind} holds no text`)
          break
        }
        case 'group': {
          const ids = resolveAll(op.ids)
          if (typeof ids === 'string') return fail(ids)
          const g = groupItems(scene, ids)
          if (!g.id) return fail('a group needs two or more items')
          scene = g.scene
          remember(op.key, index, g.id)
          break
        }
        case 'ungroup': {
          const ids = resolveAll(op.ids)
          if (typeof ids === 'string') return fail(ids)
          const u = ungroupItems(scene, ids)
          if (!u.ids.length) return fail('none of those is a group')
          scene = u.scene
          break
        }
        case 'order': {
          const ids = resolveAll(op.ids)
          if (typeof ids === 'string') return fail(ids)
          if (!['front', 'back', 'forward', 'backward'].includes(op.to)) return fail('to is front, back, forward or backward')
          scene = reorderItems(scene, ids, op.to)
          break
        }
        case 'delete': {
          const ids = resolveAll(op.ids)
          if (typeof ids === 'string') return fail(ids)
          scene = deleteItems(scene, ids)
          break
        }
        case 'create_artifact': {
          if (!num(op.x) || !num(op.y) || !inWorld(op.x, op.y)) return fail('x and y are numbers')
          if (typeof op.html !== 'string' || !op.html.trim()) return fail('html is the page: markup, with its styles and scripts written in it')
          if (op.html.length > ARTIFACT_LIMITS.html) return fail(`html is at most ${ARTIFACT_LIMITS.html} characters`)
          const w = clamp(num(op.w) ? op.w : ARTIFACT_DEFAULT_SIZE.w, ARTIFACT_LIMITS.minW, 20000)
          const h = clamp(num(op.h) ? op.h : ARTIFACT_DEFAULT_SIZE.h, ARTIFACT_LIMITS.minH, 20000)
          const item = makeArtifact({ x: op.x, y: op.y, w, h }, frontKey(scene), op.html, artifactTitle(op.title))
          scene = patchScene(scene, [item])
          remember(op.key, index, item.id)
          break
        }
        case 'set_artifact': {
          const id = typeof op.id === 'string' ? resolve(op.id) : null
          const it = id ? scene.items[id] : null
          if (!it || it.kind !== 'artifact') return fail(`no artifact ${JSON.stringify(op.id)} on this canvas`)
          if (op.html === undefined && op.title === undefined) return fail('give html, title or both')
          if (op.html !== undefined && (typeof op.html !== 'string' || !op.html.trim())) return fail('html is the page: markup, with its styles and scripts written in it')
          if (typeof op.html === 'string' && op.html.length > ARTIFACT_LIMITS.html) return fail(`html is at most ${ARTIFACT_LIMITS.html} characters`)
          const next = { ...it, ...(op.html !== undefined ? { html: op.html } : {}) }
          if (op.title !== undefined) {
            const title = artifactTitle(op.title)
            if (title) next.title = title
            else delete next.title
          }
          scene = patchScene(scene, [next])
          break
        }
        default:
          return fail('not an operation: use create_shape, create_text, connect, move, resize, style, set_text, group, ungroup, order, delete, create_artifact or set_artifact')
      }
      done++
    } catch (e) {
      fail(e instanceof Error ? e.message : 'could not apply')
    }
  })
  if (ops.length > AGENT_LIMITS.ops) errors.push({ index: AGENT_LIMITS.ops, op: 'batch', error: `only the first ${AGENT_LIMITS.ops} operations were applied` })
  return { scene, step: diffScenes(before, scene), created, done, errors }
}
