/**
 * CSV in and out for a workbook. Pure and isomorphic (no node: imports), so
 * the editor runs it in the browser and the route runs it on the server.
 *
 * A CSV holds values, not formulas: {@link sheetToCsv} writes what each cell
 * SHOWS (the calculated, formatted value), never the `=…` behind it, and never
 * styles — that is all a CSV can carry. Values are written verbatim: a cell
 * that begins with `=`, `+`, `-` or `@` is NOT altered (no anti-"CSV injection"
 * apostrophe is added), so the file round-trips a person's data exactly as it
 * reads on screen. The quoting is RFC 4180 and the line ending is CRLF, which
 * Excel, LibreOffice and Google Sheets all read.
 */
import type { Model } from '@ironcalc/wasm'
import { usedRange } from './workbook'

/** The active sheet's shown values as RFC 4180 CSV (CRLF rows, values only — no formulas, no styles). */
export function sheetToCsv(model: Model, sheet: number): string {
  const used = usedRange(model, sheet)
  if (!used) return ''
  const rows: string[] = []
  for (let r = 1; r <= used.r2; r++) {
    const cells: string[] = []
    for (let c = 1; c <= used.c2; c++) cells.push(quoteField(model.getFormattedCellValue(sheet, r, c)))
    rows.push(cells.join(','))
  }
  return rows.join('\r\n')
}

/** Wrap a field in quotes when RFC 4180 needs it (a comma, a quote or a line break), doubling any quote inside. */
function quoteField(value: string): string {
  if (value === '') return ''
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/**
 * Parse CSV into rows of text: quoted fields with doubled quotes and line
 * breaks inside them, either line ending, a leading BOM stripped, and the
 * delimiter (comma, semicolon or tab) sniffed from the first lines. Returns the
 * rows as typed, for pasting at the active cell.
 */
export function csvToRows(input: string): string[][] {
  const text = input.replace(/^﻿/, '')
  if (text === '') return []
  const delimiter = sniffDelimiter(text)
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  let sawField = false
  const endField = () => {
    row.push(field)
    field = ''
    sawField = true
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
    sawField = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) endField()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else field += ch
  }
  // A final field or row that was being built (no trailing newline).
  if (field !== '' || sawField || row.length) endRow()
  // A trailing newline leaves one empty record; drop it.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
  return rows
}

/** The delimiter that splits the first few lines most: comma, semicolon or tab. */
function sniffDelimiter(text: string): string {
  const sample = text.split(/\r\n|\r|\n/).slice(0, 5)
  let best = ','
  let bestCount = 0
  for (const d of [',', ';', '\t']) {
    let count = 0
    for (const line of sample) {
      let quoted = false
      for (const ch of line) {
        if (ch === '"') quoted = !quoted
        else if (ch === d && !quoted) count++
      }
    }
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}
