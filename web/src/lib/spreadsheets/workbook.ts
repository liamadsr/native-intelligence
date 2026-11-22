/**
 * What the app asks of a workbook, over the engine's model. No loading here:
 * the caller brings a Model from engine-server.ts or engine-client.ts, so the
 * same functions run in the browser, in routes and in the agents' tools.
 */
import type { Model } from '@ironcalc/wasm'
import { MAX_COLUMNS, MAX_ROWS, type CellRange } from './a1'
import { MAX_DIGEST_CHARS } from './types'

export interface SheetInfo {
  /** Position in the workbook, 0-based: what every engine call takes. */
  index: number
  /** The sheet's own id, which survives renames and reorders. */
  id: number
  name: string
  hidden: boolean
  color: string | null
}

export function listSheets(model: Model): SheetInfo[] {
  return model.getWorksheetsProperties().map((p, index) => ({
    index,
    id: p.sheet_id,
    name: p.name,
    hidden: p.state !== 'visible',
    color: typeof p.color === 'string' ? p.color : null,
  }))
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let out = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(out)
}

export function base64ToBytes(text: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'))
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function saveWorkbook(model: Model): string {
  return bytesToBase64(model.toBytes())
}

/**
 * The rectangle that holds every filled cell of a sheet, or null for an
 * empty sheet. The engine has no call for it, so this asks each row for its
 * filled columns; rows past the grid's limit are not looked at.
 */
export function usedRange(model: Model, sheet: number, maxRows = MAX_ROWS): CellRange | null {
  let r1 = 0
  let r2 = 0
  let c1 = MAX_COLUMNS + 1
  let c2 = 0
  for (let row = 1; row <= maxRows; row++) {
    const columns = model.getColumnsWithData(sheet, row)
    if (!columns.length) continue
    if (!r1) r1 = row
    r2 = row
    // The engine returns them in ascending order.
    if (columns[0] < c1) c1 = columns[0]
    const last = columns[columns.length - 1]
    if (last > c2) c2 = last
  }
  return r1 ? { r1, c1, r2, c2 } : null
}

/**
 * The workbook's words, for search: every sheet's name and the text its
 * cells show, cut at the limit. Numbers alone are left out (they match
 * nothing a person searches for and would crowd the words out).
 */
export function workbookDigest(model: Model, limit = MAX_DIGEST_CHARS): string {
  const parts: string[] = []
  let size = 0
  const push = (text: string) => {
    if (!text) return true
    parts.push(text)
    size += text.length + 1
    return size < limit
  }
  outer: for (const sheet of listSheets(model)) {
    if (!push(sheet.name)) break
    for (let row = 1; row <= MAX_ROWS; row++) {
      const columns = model.getColumnsWithData(sheet.index, row)
      for (const column of columns) {
        const text = model.getFormattedCellValue(sheet.index, row, column).trim()
        if (!text || /^[-+$€£%(),.\d\s]+$/.test(text)) continue
        if (!push(text.length > 500 ? text.slice(0, 500) : text)) break outer
      }
    }
  }
  return parts.join(' ').slice(0, limit)
}

/** The engine's cell kinds (getCellType). */
export const CELL_TYPE = { number: 1, text: 2, boolean: 4, error: 16, array: 64, compound: 128 } as const

export type CellKind = 'empty' | 'number' | 'text' | 'boolean' | 'error'

export interface CellSnapshot {
  /** What was typed: a formula with its `=`, or the raw value. Empty for an empty cell. */
  input: string
  /** What the cell shows. */
  text: string
  kind: CellKind
  formula: boolean
}

export function readCell(model: Model, sheet: number, row: number, column: number): CellSnapshot {
  const input = model.getCellContent(sheet, row, column)
  const text = model.getFormattedCellValue(sheet, row, column)
  if (!input && !text) return { input: '', text: '', kind: 'empty', formula: false }
  const type = model.getCellType(sheet, row, column)
  const kind: CellKind =
    type === CELL_TYPE.error ? 'error' : type === CELL_TYPE.boolean ? 'boolean' : type === CELL_TYPE.number ? 'number' : 'text'
  return { input, text, kind, formula: input.startsWith('=') }
}
