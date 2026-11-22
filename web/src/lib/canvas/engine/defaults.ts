/** What a new item looks like, and the makers of each kind. */
import type {
  CanvasItem,
  CanvasStyle,
  CanvasTextStyle,
  ConnectorEnd,
  ConnectorHead,
  ConnectorItem,
  ConnectorRoute,
  EllipseItem,
  MediaItem,
  PencilItem,
  ArtifactItem,
  RecordItem,
  RectangleItem,
  TextItem,
} from '../types'
import { boundsOfPoints, round, type Box, type Point } from './geometry'
import { newId } from './scene'

/** The ink color: near-black in light, near-white in dark. */
export const INK = 'theme:ink'

export const DEFAULT_SHAPE_STYLE: CanvasStyle = { fill: 'transparent', stroke: INK, strokeWidth: 2, strokeStyle: 'solid', opacity: 1, radius: 0 }
export const DEFAULT_LINE_STYLE: CanvasStyle = { stroke: INK, strokeWidth: 2, strokeStyle: 'solid', opacity: 1 }
export const DEFAULT_PENCIL_STYLE: CanvasStyle = { stroke: INK, strokeWidth: 4, opacity: 1 }
export const DEFAULT_TEXT_STYLE: CanvasTextStyle = { fontFamily: 'sans', fontSize: 20, color: INK, align: 'left' }
export const DEFAULT_LABEL_STYLE: CanvasTextStyle = { fontFamily: 'sans', fontSize: 16, color: INK, align: 'center' }

export const LIMITS = {
  minScale: 0.01,
  maxScale: 8,
  /** A drawn shape smaller than this (world units, both sides) is thrown away. */
  minShape: 4,
  strokeMax: 40,
  radiusMax: 500,
  fontMin: 4,
  fontMax: 512,
  /** Media is fitted inside this box when placed. */
  mediaW: 640,
  mediaH: 480,
  recordW: 340,
  recordH: 136,
  /** How far a paste on the same canvas steps each time. */
  pasteStep: 24,
} as const

/** The styles the next drawn item takes: the last ones the person chose. */
export interface StyleDefaults {
  shape: CanvasStyle
  line: CanvasStyle
  pencil: CanvasStyle
  text: CanvasTextStyle
  route: ConnectorRoute
}
export const INITIAL_DEFAULTS: StyleDefaults = {
  shape: DEFAULT_SHAPE_STYLE,
  line: DEFAULT_LINE_STYLE,
  pencil: DEFAULT_PENCIL_STYLE,
  text: DEFAULT_TEXT_STYLE,
  route: 'straight',
}

/** A stroke nobody could see is put right before a stroke tool draws with it. */
export function visibleStroke(style: CanvasStyle, fallbackWidth = 2): CanvasStyle {
  const next = { ...style }
  if (!next.stroke || next.stroke === 'transparent') next.stroke = INK
  if (!next.strokeWidth || next.strokeWidth <= 0) next.strokeWidth = fallbackWidth
  if (next.opacity !== undefined && next.opacity <= 0) next.opacity = 1
  return next
}

const base = (box: Box, sortKey: string) => ({
  id: newId(),
  parentId: null,
  sortKey,
  x: round(box.x),
  y: round(box.y),
  w: round(box.w),
  h: round(box.h),
  rotation: 0,
})

export function makeShape(kind: 'rectangle' | 'ellipse', box: Box, sortKey: string, style: CanvasStyle = DEFAULT_SHAPE_STYLE): RectangleItem | EllipseItem {
  return { ...base(box, sortKey), kind, style: { ...style } }
}

export function makeText(at: Point, sortKey: string, opts: { width?: number; plain?: string; text?: CanvasTextStyle } = {}): TextItem {
  const text = { ...DEFAULT_TEXT_STYLE, ...opts.text }
  const size = text.fontSize ?? 20
  return {
    ...base({ x: at.x, y: at.y, w: opts.width ?? Math.max(8, size * 0.5), h: round(size * 1.4) }, sortKey),
    kind: 'text',
    style: { opacity: 1 },
    content: { plain: opts.plain ?? '' },
    text,
    autoWidth: opts.width === undefined,
  }
}

/** A stroke from world points with pressures. The box is the points' own, padded by nothing: the ink overhangs it. */
export function makePencil(points: ReadonlyArray<readonly [number, number, number]>, sortKey: string, style: CanvasStyle = DEFAULT_PENCIL_STYLE, pen = false): PencilItem {
  const box = boundsOfPoints(points.map(([x, y]) => ({ x, y })))
  const w = Math.max(box.w, 0.01)
  const h = Math.max(box.h, 0.01)
  return {
    ...base({ x: box.x, y: box.y, w, h }, sortKey),
    kind: 'pencil',
    style: { ...style },
    points: points.map(([x, y, p]) => [round(x - box.x), round(y - box.y), round(p, 3)] as [number, number, number]),
    w0: round(w),
    h0: round(h),
    ...(pen ? { pen: true } : {}),
  }
}

export function makeConnector(
  start: ConnectorEnd,
  end: ConnectorEnd,
  sortKey: string,
  opts: { style?: CanvasStyle; route?: ConnectorRoute; startHead?: ConnectorHead; endHead?: ConnectorHead } = {},
): ConnectorItem {
  const box = boundsOfPoints([start, end])
  return {
    ...base(box, sortKey),
    kind: 'connector',
    style: { ...(opts.style ?? DEFAULT_LINE_STYLE) },
    start: { ...start },
    end: { ...end },
    route: opts.route ?? 'straight',
    startHead: opts.startHead ?? 'none',
    endHead: opts.endHead ?? 'none',
  }
}

/** Fit a natural size inside the media box, never enlarging. */
export function fitMedia(naturalW: number, naturalH: number): { w: number; h: number } {
  const nw = Math.max(1, naturalW || LIMITS.mediaW)
  const nh = Math.max(1, naturalH || LIMITS.mediaH)
  const k = Math.min(1, LIMITS.mediaW / nw, LIMITS.mediaH / nh)
  return { w: round(nw * k), h: round(nh * k) }
}

export function makeMedia(
  kind: 'image' | 'video',
  center: Point,
  sortKey: string,
  media: { naturalW: number; naturalH: number; src?: string; path?: string; name?: string },
): MediaItem {
  const { w, h } = fitMedia(media.naturalW, media.naturalH)
  return {
    ...base({ x: center.x - w / 2, y: center.y - h / 2, w, h }, sortKey),
    kind,
    style: { opacity: 1 },
    naturalW: media.naturalW,
    naturalH: media.naturalH,
    ...(media.src ? { src: media.src } : {}),
    ...(media.path ? { path: media.path } : {}),
    ...(media.name ? { name: media.name } : {}),
  }
}

export function makeArtifact(box: Box, sortKey: string, html: string, title?: string): ArtifactItem {
  return { ...base(box, sortKey), kind: 'artifact', style: { opacity: 1 }, html, ...(title ? { title } : {}) }
}

export function makeRecord(center: Point, sortKey: string, ref: RecordItem['ref']): RecordItem {
  return {
    ...base({ x: center.x - LIMITS.recordW / 2, y: center.y - LIMITS.recordH / 2, w: LIMITS.recordW, h: LIMITS.recordH }, sortKey),
    kind: 'record',
    style: { opacity: 1 },
    ref,
  }
}

/** The words on an item, for search, agents and labels. */
export function itemText(it: CanvasItem): string {
  if (it.kind === 'text') return it.content.plain
  if (it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector') return it.label?.plain ?? ''
  if (it.kind === 'record') return it.ref.label ?? ''
  if (it.kind === 'artifact') return it.title ?? ''
  if (it.kind === 'image' || it.kind === 'video') return it.name ?? ''
  return ''
}
