/**
 * Shared bits of the .xlsx reader and writer (ECMA-376 SpreadsheetML): XML
 * escaping and a small attribute/tag parser, the unit conversions Excel uses
 * for column widths (characters) and row heights (points), and the set of
 * Excel error strings. Pure and isomorphic (no node: imports), so the reader
 * and writer run in the browser (the editor) and on the server (the route)
 * alike. We write the XML ourselves over a zip container (jszip); none of
 * the reference product's code is used.
 */
import { isDateFormat } from './formats'

/** Thrown when a file is refused outright (not a workbook, or too large). The route turns it into a 400 with this sentence. */
export class XlsxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XlsxError'
  }
}

// ── Limits ──────────────────────────────────────────────────────────────────

/** A file larger than this is refused unread. */
export const MAX_XLSX_BYTES = 50 * 1024 * 1024
/** A zip whose parts expand past this is refused (a zip bomb). */
export const MAX_XLSX_EXPANDED = 400 * 1024 * 1024
/** One part read from the zip is capped here (xl/sharedStrings or a sheet). */
export const MAX_PART_BYTES = 120 * 1024 * 1024

// ── Units ─────────────────────────────────────────────────────────────────--

/** The engine's default column width and row height (pixels), probed from a fresh model. */
export const DEFAULT_COLUMN_WIDTH_PX = 90
export const DEFAULT_ROW_HEIGHT_PX = 25
/** The "maximum digit width" Excel measures column widths in (Calibri 11 ≈ 7px). */
const MDW = 7

/** A width in pixels as the "characters" an .xlsx `<col width>` holds. Inverse of {@link excelCharsToPx}. */
export function pxToExcelChars(px: number): number {
  return Math.round(((px - 5) / MDW) * 100) / 100
}

/** An .xlsx column width (characters) back to pixels. */
export function excelCharsToPx(chars: number): number {
  return Math.max(1, Math.round(chars * MDW + 5))
}

/** A height in pixels as the points an .xlsx `<row ht>` holds. */
export function pxToPoints(px: number): number {
  return Math.round(px * 0.75 * 100) / 100
}

/** An .xlsx row height (points) back to pixels. */
export function pointsToPx(pt: number): number {
  return Math.max(1, Math.round((pt * 4) / 3))
}

/** The 1904 date system's serials sit 1462 days behind the 1900 system the engine uses. */
export const DATE_1904_OFFSET = 1462

export { isDateFormat }

// ── Errors ───────────────────────────────────────────────────────────────---

/** Every Excel error string. `getFormattedCellValue` hands these back for an error cell, and an .xlsx stores them verbatim in `<v>`. */
export const EXCEL_ERRORS = new Set([
  '#REF!',
  '#VALUE!',
  '#N/A',
  '#DIV/0!',
  '#NAME?',
  '#NUM!',
  '#NULL!',
  '#SPILL!',
  '#CALC!',
  '#GETTING_DATA',
])

// ── XML ──────────────────────────────────────────────────────────────────---

/** Escape text for an XML text node or a double-quoted attribute value. */
export function xmlEscape(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '&') out += '&amp;'
    else if (ch === '<') out += '&lt;'
    else if (ch === '>') out += '&gt;'
    else if (ch === '"') out += '&quot;'
    else if (ch === "'") out += '&apos;'
    // XML 1.0 forbids most control characters; drop them rather than write an invalid file.
    else if (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') out += ''
    else out += ch
  }
  return out
}

/** Decode the five predefined entities and numeric character references in XML text. */
export function xmlDecode(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === 'amp') return '&'
    if (body === 'lt') return '<'
    if (body === 'gt') return '>'
    if (body === 'quot') return '"'
    if (body === 'apos') return "'"
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    }
    return whole
  })
}

/** The attributes of an opening tag's inside (`r="A1" t="s"`), decoded. */
export function parseAttrs(inside: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of inside.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = xmlDecode(m[2])
  return out
}

/** A `<v>…</v>`-style child's decoded text, or null when the child is absent. */
export function childText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? xmlDecode(m[1]) : null
}

/** An "FFRRGGBB" / "RRGGBB" rgb (as .xlsx writes a color) to "#RRGGBB"; null when it is not one. */
export function rgbToHex(rgb: string | undefined): string | null {
  if (!rgb) return null
  const s = rgb.trim()
  const six = s.length === 8 ? s.slice(2) : s
  return /^[0-9a-fA-F]{6}$/.test(six) ? `#${six.toUpperCase()}` : null
}

/** A "#RRGGBB" css hex (what the engine resolves a color to) as the "FFRRGGBB" an .xlsx color wants. */
export function hexToArgb(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  return m ? `FF${m[1].toUpperCase()}` : null
}

/** A1 column letters to a 1-based index ("A"→1, "AA"→27). */
export function columnFromLetters(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) {
    const d = ch.charCodeAt(0) - 64
    if (d < 1 || d > 26) return 0
    n = n * 26 + d
  }
  return n
}

/** "B12" to { row, column } (1-based), ignoring any `$`; null when it is not a cell reference. */
export function parseA1(ref: string): { row: number; column: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(ref.trim())
  if (!m) return null
  const column = columnFromLetters(m[1])
  const row = Number(m[2])
  return column && row ? { row, column } : null
}
