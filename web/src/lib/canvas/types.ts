/**
 * Canvas: the scene model (docs/plans/canvas.md).
 *
 * A canvas is a flat map of items. Every item keeps its pose in world units
 * (x, y is the top-left of its unrotated box; rotation turns it about the
 * box's center), so nothing is nested but membership: an item's `parentId`
 * names the group it belongs to. `sortKey` orders everything on the canvas,
 * lowest at the back.
 *
 * This file is the contract between the editor, the store, the API and the
 * agent tools. It has no React and no browser in it.
 */

export const CANVAS_ITEM_KINDS = [
  'rectangle',
  'ellipse',
  'text',
  'pencil',
  'connector',
  'image',
  'video',
  'record',
  'artifact',
  'group',
] as const
export type CanvasItemKind = (typeof CANVAS_ITEM_KINDS)[number]

export type StrokeStyle = 'solid' | 'dashed' | 'dotted'
export type FontFamily = 'sans' | 'serif' | 'mono'
export type ConnectorRoute = 'straight' | 'elbow' | 'smooth'
export type ConnectorHead = 'none' | 'arrow' | 'filled' | 'dot' | 'small-dot'
export type BindAnchor = 'center' | 'top' | 'right' | 'bottom' | 'left'

/**
 * A color is a CSS color ('#rrggbb', '#rrggbbaa', 'transparent') or a theme
 * reference ('theme:ink', 'theme:blue'…) that follows dark and light.
 */
export type CanvasColor = string

export interface CanvasStyle {
  fill?: CanvasColor
  stroke?: CanvasColor
  strokeWidth?: number
  strokeStyle?: StrokeStyle
  /** 0 to 1. */
  opacity?: number
  /** Rectangles only. */
  radius?: number
}

export interface CanvasTextStyle {
  fontFamily?: FontFamily
  fontSize?: number
  /** Text color. */
  color?: CanvasColor
  align?: 'left' | 'center' | 'right'
}

interface ItemBase {
  id: string
  /** The group this item is in, or null on the canvas itself. */
  parentId: string | null
  sortKey: string
  x: number
  y: number
  w: number
  h: number
  /** Radians, about the box's center. */
  rotation: number
  style: CanvasStyle
}

/** Rich text: the plain words always, and the editor's document when it has marks. */
export interface CanvasText {
  plain: string
  /** A tiptap document, when the text was edited with formatting. */
  rich?: unknown
}

export interface RectangleItem extends ItemBase {
  kind: 'rectangle'
  label?: CanvasText
  text?: CanvasTextStyle
}
export interface EllipseItem extends ItemBase {
  kind: 'ellipse'
  label?: CanvasText
  text?: CanvasTextStyle
}
export interface TextItem extends ItemBase {
  kind: 'text'
  content: CanvasText
  text: CanvasTextStyle
  /** True: the box follows the words. False: the words wrap at `w`. */
  autoWidth: boolean
}
export interface PencilItem extends ItemBase {
  kind: 'pencil'
  /** [x, y, pressure] in the box the stroke was drawn in (`w0` by `h0`). */
  points: Array<[number, number, number]>
  w0: number
  h0: number
  /** True when the pressures came from a pen. */
  pen?: boolean
}
export interface ConnectorEnd {
  /** World point. For a bound end, where it was last drawn. */
  x: number
  y: number
  bind?: { id: string; anchor: BindAnchor }
}
export interface ConnectorItem extends ItemBase {
  kind: 'connector'
  start: ConnectorEnd
  end: ConnectorEnd
  route: ConnectorRoute
  startHead: ConnectorHead
  endHead: ConnectorHead
  label?: CanvasText
  text?: CanvasTextStyle
}
export interface MediaItem extends ItemBase {
  kind: 'image' | 'video'
  /** Where the file is stored, once uploaded (src/lib/canvas/media.ts). */
  path?: string
  /** A local preview while it uploads. Never saved. */
  src?: string
  name?: string
  naturalW: number
  naturalH: number
  flipX?: boolean
  flipY?: boolean
}
export interface RecordItem extends ItemBase {
  kind: 'record'
  /** The record this card shows. */
  ref: { type: string; id: string; label?: string }
}
export interface ArtifactItem extends ItemBase {
  kind: 'artifact'
  html: string
  title?: string
}
export interface GroupItem extends ItemBase {
  kind: 'group'
}

export type CanvasItem =
  | RectangleItem
  | EllipseItem
  | TextItem
  | PencilItem
  | ConnectorItem
  | MediaItem
  | RecordItem
  | ArtifactItem
  | GroupItem

export type CanvasVisibility = 'workspace' | 'private'

/** What a canvas keeps for everyone who opens it. */
export interface CanvasSettings {
  grid?: boolean
}

export interface CanvasRecord {
  id: string
  workspace_id: string
  title: string
  visibility: CanvasVisibility
  project_id: string | null
  owner_member_id: string | null
  settings: CanvasSettings
  version: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** A row of `canvas_item`. `data` is the item without id, parentId, sortKey and kind. */
export interface CanvasItemRow {
  canvas_id: string
  id: string
  parent_id: string | null
  sort_key: string
  kind: CanvasItemKind
  data: Record<string, unknown>
  updated_at?: string
  updated_by?: string | null
}

export function itemToRow(canvasId: string, item: CanvasItem): CanvasItemRow {
  const { id, parentId, sortKey, kind, ...data } = item
  // A preview address means something in one browser tab only.
  if ('src' in data) delete (data as { src?: string }).src
  return { canvas_id: canvasId, id, parent_id: parentId, sort_key: sortKey, kind, data }
}

const KIND_SET = new Set<string>(CANVAS_ITEM_KINDS)
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** A stored row as an item, or null when it is not one this build can draw. */
export function rowToItem(row: Pick<CanvasItemRow, 'id' | 'parent_id' | 'sort_key' | 'kind' | 'data'>): CanvasItem | null {
  if (!row || typeof row.id !== 'string' || !KIND_SET.has(row.kind)) return null
  const data = (row.data && typeof row.data === 'object' ? row.data : {}) as Record<string, unknown>
  return {
    ...data,
    id: row.id,
    parentId: row.parent_id ?? null,
    sortKey: typeof row.sort_key === 'string' ? row.sort_key : 'a0',
    kind: row.kind,
    x: num(data.x),
    y: num(data.y),
    w: num(data.w),
    h: num(data.h),
    rotation: num(data.rotation),
    style: (data.style && typeof data.style === 'object' ? data.style : {}) as CanvasStyle,
  } as CanvasItem
}

/** The body of POST /api/account/canvases/:id/items. */
export interface CanvasItemsWrite {
  upsert?: CanvasItemRow[] | Array<Omit<CanvasItemRow, 'canvas_id'>>
  remove?: string[]
}

export const CANVAS_LIMITS = {
  /** Items on one canvas. */
  items: 20000,
  /** Rows in one write. */
  batch: 2000,
  /** Bytes of one item's `data`, as JSON. */
  itemBytes: 400_000,
  title: 200,
} as const
