/**
 * Cell addresses in A1 form. Rows and columns are 1-based everywhere in the
 * spreadsheet code, as in the engine.
 */

export const MAX_ROWS = 100_000
export const MAX_COLUMNS = 16_384
export const MAX_SHEETS = 300
export const MAX_CELL_CHARS = 10_000

export interface CellRef {
  row: number
  column: number
}

/** A rectangle, inclusive on every side, already ordered (r1 <= r2, c1 <= c2). */
export interface CellRange {
  r1: number
  c1: number
  r2: number
  c2: number
}

/** 1 -> A, 26 -> Z, 27 -> AA, 16384 -> XFD. */
export function columnName(column: number): string {
  let n = Math.floor(column)
  if (!(n >= 1)) return ''
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** A -> 1, XFD -> 16384. 0 when it is not a column name. */
export function columnNumber(name: string): number {
  const s = name.trim().toUpperCase()
  if (!/^[A-Z]{1,3}$/.test(s)) return 0
  let n = 0
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n <= MAX_COLUMNS ? n : 0
}

export function cellName(row: number, column: number): string {
  return `${columnName(column)}${row}`
}

export function orderRange(a: CellRef, b: CellRef): CellRange {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.column, b.column),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.column, b.column),
  }
}

export function rangeName(range: CellRange): string {
  const a = cellName(range.r1, range.c1)
  const b = cellName(range.r2, range.c2)
  return a === b ? a : `${a}:${b}`
}

export function rangeCellCount(range: CellRange): number {
  return (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
}

export function inRange(range: CellRange, row: number, column: number): boolean {
  return row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2
}

/** `B7` or `$B$7`. Null when it is not a cell in the grid. */
export function parseCell(text: string): CellRef | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(text.trim())
  if (!m) return null
  const column = columnNumber(m[1])
  const row = Number(m[2])
  if (!column || row < 1 || row > MAX_ROWS) return null
  return { row, column }
}

/**
 * `A1`, `A1:C9`, `B:D` (whole columns), `2:5` (whole rows). Whole rows and
 * columns run to the grid's edge. Null when it is none of these.
 */
export function parseRange(text: string): CellRange | null {
  const s = text.trim()
  if (!s) return null
  const parts = s.split(':')
  if (parts.length === 1) {
    const cell = parseCell(parts[0])
    return cell ? { r1: cell.row, c1: cell.column, r2: cell.row, c2: cell.column } : null
  }
  if (parts.length !== 2) return null
  const [a, b] = parts.map((p) => p.trim().replace(/\$/g, ''))
  if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b)) {
    const c1 = columnNumber(a)
    const c2 = columnNumber(b)
    if (!c1 || !c2) return null
    return { r1: 1, c1: Math.min(c1, c2), r2: MAX_ROWS, c2: Math.max(c1, c2) }
  }
  if (/^[0-9]{1,7}$/.test(a) && /^[0-9]{1,7}$/.test(b)) {
    const r1 = Number(a)
    const r2 = Number(b)
    if (r1 < 1 || r2 < 1 || r1 > MAX_ROWS || r2 > MAX_ROWS) return null
    return { r1: Math.min(r1, r2), c1: 1, r2: Math.max(r1, r2), c2: MAX_COLUMNS }
  }
  const ca = parseCell(a)
  const cb = parseCell(b)
  if (!ca || !cb) return null
  return orderRange(ca, cb)
}

/**
 * A sheet name as a formula writes it: quoted when it holds anything but
 * letters, digits and underscores, or starts with a digit.
 */
export function quoteSheetName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name
  return `'${name.replace(/'/g, "''")}'`
}

/** `Sheet2!B3:C4`, `'My sheet'!A1`, or a bare range (sheet null). */
export function parseSheetRange(text: string): { sheet: string | null; range: CellRange } | null {
  const s = text.trim()
  const bang = s.lastIndexOf('!')
  if (bang < 0) {
    const range = parseRange(s)
    return range ? { sheet: null, range } : null
  }
  let sheet = s.slice(0, bang).trim()
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) {
    sheet = sheet.slice(1, -1).replace(/''/g, "'")
  }
  const range = parseRange(s.slice(bang + 1))
  if (!range || !sheet) return null
  return { sheet, range }
}

/** Why a sheet name is refused, or null when it is fine (Excel's rules). */
export function sheetNameProblem(name: string, taken: readonly string[] = []): string | null {
  const s = name.trim()
  if (!s) return 'A sheet needs a name.'
  if (s.length > 31) return 'A sheet name is 31 characters at most.'
  if (/[\\/?*[\]:]/.test(s)) return 'A sheet name cannot contain \\ / ? * [ ] or :'
  if (s.startsWith("'") || s.endsWith("'")) return 'A sheet name cannot start or end with an apostrophe.'
  if (taken.some((t) => t.toLowerCase() === s.toLowerCase())) return 'Another sheet already has that name.'
  return null
}
