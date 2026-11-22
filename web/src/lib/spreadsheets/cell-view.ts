/**
 * How a cell is drawn: the engine's style as plain values a component turns
 * into CSS. Pure, so it is tested without a browser.
 */
import type { BorderStyle, CellStyle, Color, Model } from '@ironcalc/wasm'
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
  /** Nothing to draw: no text, no fill, no border. */
  blank: boolean
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
    color: textColor(resolve(font?.color), fill),
    fill,
    // The engine's default face stands for "the app's font".
    fontFamily: !name || name === 'Inter' || name === 'Calibri' ? null : name,
    borderTop: border(style.border?.top, resolve),
    borderRight: border(style.border?.right, resolve),
    borderBottom: border(style.border?.bottom, resolve),
    borderLeft: border(style.border?.left, resolve),
    error: type === CELL_TYPE.error,
    blank: false,
  }
  view.blank = !text && !fill && !view.borderTop && !view.borderRight && !view.borderBottom && !view.borderLeft
  return view
}

export function readCellView(model: Model, sheet: number, row: number, column: number): CellView {
  const text = model.getFormattedCellValue(sheet, row, column)
  const style = model.getCellStyle(sheet, row, column).style
  const type = text ? model.getCellType(sheet, row, column) : 0
  return cellView(text, type, style, (c) => (c === undefined || c === null ? '' : model.resolveColor(c)))
}
