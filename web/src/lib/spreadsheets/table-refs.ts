/**
 * Structured table references in a typed formula, rewritten to plain A1 before
 * the engine (which knows nothing of tables) ever sees them. A missing table or
 * column becomes `#REF!`.
 *
 * Supported, as Macro writes them:
 *   Sales[Amount]              a column's data cells
 *   Sales[[#Totals],[Amount]]  that column's total cell
 *   Sales[[#Headers],[Amount]] that column's header cell
 *   Sales[#All] / Sales[#Data] a whole-table or data-only rectangle
 *   [@Qty] / [@[Unit Price]]   the current row of a column (only inside a table)
 *   Sales                      the table's data body
 *
 * Pure. The cell then stores the A1 form it produces: it does not turn back into
 * a structured reference, and it follows a later table resize only as far as an
 * A1 reference does.
 */
import { cellName, columnName, quoteSheetName, type CellRange } from './a1'

export interface TableRefMeta {
  name: string
  sheetName: string
  /** Header row + data rows [+ total row]. */
  range: CellRange
  /** Header texts, in column order. */
  columns: string[]
  /** Whether the last row of `range` is a total row. */
  hasTotals: boolean
}

export interface RefContext {
  /** The sheet the formula's own cell is on (for a cross-sheet A1 prefix). */
  sheetName: string
  /** The formula cell's row, for `[@…]`. */
  row: number
  /** The table the formula cell sits in, if any (for the implicit `[…]` form). */
  table?: TableRefMeta
}

const REF_ERROR = '#REF!'
type Area = 'all' | 'data' | 'headers' | 'totals' | 'thisRow'

/** Rewrite every structured reference in `input` to A1. Non-formulas are returned unchanged. */
export function rewriteStructuredRefs(input: string, tables: readonly TableRefMeta[], context: RefContext): string {
  if (!input.startsWith('=') || (!input.includes('[') && !tables.some((t) => matchesBareName(input, t.name)))) return input
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
  let out = ''
  let i = 0
  const n = input.length
  const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch)
  const isIdent = (ch: string) => /[A-Za-z0-9_.]/.test(ch)

  while (i < n) {
    const ch = input[i]
    if (ch === '"') {
      // A string literal: copy verbatim ("" is an escaped quote).
      out += ch
      i += 1
      while (i < n) {
        out += input[i]
        if (input[i] === '"' && input[i + 1] !== '"') {
          i += 1
          break
        }
        if (input[i] === '"' && input[i + 1] === '"') {
          out += input[i + 1]
          i += 2
          continue
        }
        i += 1
      }
      continue
    }
    if (ch === "'") {
      // A sheet name in quotes: copy verbatim.
      out += ch
      i += 1
      while (i < n) {
        out += input[i]
        if (input[i] === "'" && input[i + 1] !== "'") {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (isIdentStart(ch)) {
      let j = i
      while (j < n && isIdent(input[j])) j += 1
      const ident = input.slice(i, j)
      if (input[j] === '[') {
        const group = readBrackets(input, j)
        if (group) {
          const table = byName.get(ident.toLowerCase())
          out += table ? resolve(table, group.inner, context) : REF_ERROR
          i = group.end
          continue
        }
      }
      // A bare table name used as a reference (not a function call, not sheet-qualified).
      const table = byName.get(ident.toLowerCase())
      const prev = out[out.length - 1]
      if (table && input[j] !== '(' && input[j] !== '[' && prev !== '!' && !(prev && isIdent(prev))) {
        out += resolve(table, '', { ...context, _bare: true } as RefContext & { _bare?: boolean })
      } else {
        out += ident
      }
      i = j
      continue
    }
    if (ch === '[') {
      // An implicit reference to the table the formula cell sits in.
      const group = readBrackets(input, i)
      if (group && context.table) {
        out += resolve(context.table, group.inner, context)
        i = group.end
        continue
      }
      if (group) {
        out += REF_ERROR
        i = group.end
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/** Read a balanced `[ … ]` group starting at `start` (input[start] === '['). */
function readBrackets(input: string, start: number): { inner: string; end: number } | null {
  if (input[start] !== '[') return null
  let depth = 0
  for (let i = start; i < input.length; i++) {
    if (input[i] === '[') depth += 1
    else if (input[i] === ']') {
      depth -= 1
      if (depth === 0) return { inner: input.slice(start + 1, i), end: i + 1 }
    }
  }
  return null
}

/** Split on top-level commas (commas not inside nested brackets). */
function splitTop(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of text) {
    if (ch === '[') depth += 1
    else if (ch === ']') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(buf)
      buf = ''
    } else buf += ch
  }
  parts.push(buf)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

function unwrap(token: string): string {
  const t = token.trim()
  return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1).trim() : t
}

function areaOf(token: string): Area | null {
  switch (token.replace(/\s+/g, '').toLowerCase()) {
    case '#all':
      return 'all'
    case '#data':
      return 'data'
    case '#headers':
      return 'headers'
    case '#totals':
      return 'totals'
    case '#thisrow':
      return 'thisRow'
    default:
      return null
  }
}

/** Resolve one table reference to an A1 string (or #REF!). `inner` is the bracket content ('' for a bare name). */
function resolve(table: TableRefMeta, inner: string, context: RefContext & { _bare?: boolean }): string {
  let area: Area = context._bare ? 'data' : 'data'
  let column: string | null = null

  const content = inner.trim()
  if (content) {
    if (content.startsWith('@')) {
      area = 'thisRow'
      const rest = content.slice(1).trim()
      if (rest) column = unwrap(rest)
    } else {
      for (const part of splitTop(content)) {
        const maybeArea = areaOf(unwrap(part))
        if (maybeArea) area = maybeArea
        else column = unwrap(part)
      }
      // A single unbracketed column name without any specifier.
      if (!column && !areaOf(unwrap(content))) column = unwrap(content)
    }
  }

  const c1 = table.range.c1
  const header = table.range.r1
  const total = table.hasTotals ? table.range.r2 : null
  const dataR2 = total !== null ? table.range.r2 - 1 : table.range.r2
  const dataR1 = header + 1

  let col1 = c1
  let col2 = table.range.c2
  if (column) {
    const idx = table.columns.findIndex((name) => name.toLowerCase() === column!.toLowerCase())
    if (idx < 0) return REF_ERROR
    col1 = c1 + idx
    col2 = col1
  }

  let r1: number
  let r2: number
  switch (area) {
    case 'all':
      r1 = header
      r2 = table.range.r2
      break
    case 'headers':
      r1 = header
      r2 = header
      break
    case 'totals':
      if (total === null) return REF_ERROR
      r1 = total
      r2 = total
      break
    case 'thisRow': {
      if (!context.table || context.table.name.toLowerCase() !== table.name.toLowerCase()) return REF_ERROR
      if (context.row < dataR1 || context.row > dataR2) return REF_ERROR
      r1 = context.row
      r2 = context.row
      break
    }
    default: // data
      if (dataR2 < dataR1) return REF_ERROR
      r1 = dataR1
      r2 = dataR2
  }

  const prefix = table.sheetName.toLowerCase() !== context.sheetName.toLowerCase() ? `${quoteSheetName(table.sheetName)}!` : ''
  if (r1 === r2 && col1 === col2) return `${prefix}${cellName(r1, col1)}`
  return `${prefix}${columnName(col1)}${r1}:${columnName(col2)}${r2}`
}

function matchesBareName(input: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_.!])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_.([])`, 'i').test(input)
}
