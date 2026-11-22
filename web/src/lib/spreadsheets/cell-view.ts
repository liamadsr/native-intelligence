/**
 * How a cell is drawn: the engine's style as plain values a component turns
 * into CSS. Pure, so it is tested without a browser.
 */
import type { BorderStyle, CellStyle, CfDataBar, CfIcon, Color, Model } from '@ironcalc/wasm'
import { CELL_TYPE } from './workbook'

/** The engine's default font size (points) and what the grid draws it at (pixels). */
export const DEFAULT_FONT_POINTS = 12
export const DEFAULT_FONT_PX = 13

export interface CellBorder {
  width: number
  style: 'solid' | 'dashed' | 'dotted' | 'double'
  color: string
}

export interface CellView {
  text: string
  /** Where the text sits when the cell's own alignment is "general": numbers right, text left, the rest centered. */
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  wrap: boolean
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  fontPx: number
  /** Null: the app's own text color. */
  color: string | null
  fill: string | null
  /** Null: the app's own font. */
  fontFamily: string | null
  borderTop: CellBorder | null
  borderRight: CellBorder | null
  borderBottom: CellBorder | null
  borderLeft: CellBorder | null
  error: boolean
  /** A conditional-formatting data bar behind the value, or null. */
  dataBar: CellDataBar | null
  /** A conditional-formatting icon drawn before the value, or null. */
  icon: CellIcon | null
  /** Nothing to draw: no text, no fill, no border. */
  blank: boolean
}

export interface CellDataBar {
  /** How far the bar reaches, 0 to 1 of the cell's width. */
  fraction: number
  color: string
  negative: boolean
  /** Where zero sits, 0 to 1 across the cell (the bar grows left of it for a negative value). */
  axis: number
  /** False: the number itself is hidden, only the bar shows. */
  showValue: boolean
}

export interface CellIcon {
  kind: string
  color: string
  showValue: boolean
}

const FONT_SCALE = DEFAULT_FONT_PX / DEFAULT_FONT_POINTS

function border(item: { style: BorderStyle; color?: Color } | undefined, resolve: (c: Color) => string): CellBorder | null {
  if (!item) return null
  const style = String(item.style)
  const color = resolve(item.color) || 'currentColor'
  if (style === 'medium') return { width: 2, style: 'solid', color }
  if (style === 'thick') return { width: 3, style: 'solid', color }
  if (style === 'double') return { width: 3, style: 'double', color }
  if (style === 'dotted') return { width: 1, style: 'dotted', color }
  if (style.includes('dash')) return { width: style.startsWith('medium') ? 2 : 1, style: 'dashed', color }
  return { width: 1, style: 'solid', color }
}

/**
 * Black on no fill is "no color chosen" in most files (Excel writes it
 * out); drawn as the app's own text color it stays readable in the dark.
 */
function textColor(color: string, fill: string | null): string | null {
  if (!color) return null
  const c = color.toUpperCase()
  if (!fill && (c === '#000000' || c === '#000')) return null
  return color
}

/**
 * Text on a fill that has no color of its own: near-black on a light fill,
 * white on a dark one, whatever the app's theme. The app's own text color
 * is light in the dark theme and would vanish on a pale fill.
 */
export function contrastOn(fill: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(fill.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const channel = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  return luminance > 0.4 ? '#111111' : '#FFFFFF'
}

export function cellView(text: string, type: number, style: CellStyle, resolve: (c: Color) => string): CellView {
  const fill = resolve(style.fill?.color) || null
  const horizontal = style.alignment?.horizontal ?? 'general'
  const general: CellView['align'] =
    type === CELL_TYPE.number ? 'right' : type === CELL_TYPE.boolean || type === CELL_TYPE.error ? 'center' : 'left'
  const align: CellView['align'] =
    horizontal === 'left' || horizontal === 'right' || horizontal === 'center'
      ? horizontal
      : horizontal === 'centerContinuous'
        ? 'center'
        : general
  const vertical = style.alignment?.vertical ?? 'bottom'
  const font = style.font
  const name = font?.name ?? ''
  const view: CellView = {
    text,
    align,
    valign: vertical === 'top' ? 'top' : vertical === 'center' ? 'middle' : 'bottom',
    wrap: style.alignment?.wrap_text ?? false,
    bold: font?.b ?? false,
    italic: font?.i ?? false,
    underline: font?.u ?? false,
    strike: font?.strike ?? false,
    fontPx: Math.max(6, Math.round((font?.sz ?? DEFAULT_FONT_POINTS) * FONT_SCALE * 10) / 10),
    color: textColor(resolve(font?.color), fill) ?? (fill ? contrastOn(fill) : null),
    fill,
    // The engine's default face stands for "the app's font".
    fontFamily: !name || name === 'Inter' || name === 'Calibri' ? null : name,
    borderTop: border(style.border?.top, resolve),
    borderRight: border(style.border?.right, resolve),
    borderBottom: border(style.border?.bottom, resolve),
    borderLeft: border(style.border?.left, resolve),
    error: type === CELL_TYPE.error,
    dataBar: null,
    icon: null,
    blank: false,
  }
  view.blank = !text && !fill && !view.borderTop && !view.borderRight && !view.borderBottom && !view.borderLeft
  return view
}

/** A data bar from the engine's conditional-formatting result, as the grid draws it. */
function dataBarOf(bar: CfDataBar, resolve: (c: Color) => string): CellDataBar {
  const value = typeof bar.value === 'number' ? bar.value : 0
  const negative = value < 0
  return {
    fraction: Math.max(0, Math.min(1, Math.abs(value))),
    color: resolve(negative ? bar.negative_color : bar.positive_color) || '#638EC6',
    negative,
    axis: typeof bar.axis_position === 'number' ? Math.max(0, Math.min(1, bar.axis_position)) : 0,
    showValue: bar.show_value !== false,
  }
}

function iconOf(icon: CfIcon, resolve: (c: Color) => string): CellIcon {
  return { kind: String(icon.icon), color: resolve(icon.color) || 'currentColor', showValue: icon.show_value !== false }
}

export function readCellView(model: Model, sheet: number, row: number, column: number): CellView {
  const text = model.getFormattedCellValue(sheet, row, column)
  const ext = model.getCellStyle(sheet, row, column)
  const type = text ? model.getCellType(sheet, row, column) : 0
  const resolve = (c: Color) => (c === undefined || c === null ? '' : model.resolveColor(c))
  const view = cellView(text, type, ext.style, resolve)
  if (ext.data_bar) view.dataBar = dataBarOf(ext.data_bar, resolve)
  if (ext.icon) view.icon = iconOf(ext.icon, resolve)
  // A data bar or an icon makes a cell worth drawing even if it had no fill or border.
  if (view.dataBar || view.icon) view.blank = false
  return view
}
