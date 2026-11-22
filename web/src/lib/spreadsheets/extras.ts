/**
 * The part of a workbook the engine does not hold: data validation (dropdowns
 * and number/date/text rules), which cells are checkboxes, and room kept for
 * charts, images and tables. It rides in the record's `extras` jsonb column
 * (migration 675), beside the engine's own saved bytes.
 *
 * Everything here is pure data and pure functions. Ranges are referred to by
 * the engine's stable `sheet_id` (never a sheet's index or name), so they
 * survive a reorder or a rename; when rows or columns move, `shiftExtras`
 * moves the stored ranges with them.
 */
import { MAX_COLUMNS, MAX_ROWS, type CellRange } from './a1'

export const EXTRAS_VERSION = 1

/** How a validation rule compares a cell's number, date serial or text length. */
export type ValidationOperator =
  | 'between'
  | 'notBetween'
  | 'equal'
  | 'notEqual'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual'

export interface ValidationChoice {
  value: string
  /** A hex color from the palette, shown as a chip in the cell. */
  color?: string
}

/** A dropdown: a list of choices typed in, or read live from a range. */
export interface ListValidation {
  type: 'list'
  /** Typed choices; empty when `source` is used instead. */
  choices: ValidationChoice[]
  /** A range the choices are read from, e.g. "Sheet1!A2:A20". */
  source?: string
  /** Refuse a value that is not in the list (the default). */
  reject: boolean
}

/** A number, date serial, or text-length rule (imports need these; the dialog only makes lists). */
export interface BoundValidation {
  type: 'number' | 'date' | 'textLength'
  operator: ValidationOperator
  /** The comparison values, as typed. `max` is used by between / notBetween. */
  min: string
  max?: string
  reject: boolean
}

export type ValidationSpec = ListValidation | BoundValidation

export interface Validation {
  sheetId: number
  range: CellRange
  rule: ValidationSpec
}

export interface CheckboxArea {
  sheetId: number
  range: CellRange
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** A table column's type: what new cells become and how the total aggregates. `people` is treated as text. */
export type TableColumnType = 'text' | 'number' | 'percent' | 'currency' | 'date' | 'datetime' | 'time' | 'checkbox' | 'dropdown' | 'people'

/** The aggregate a total-row cell shows. Written as a SUBTOTAL (or COUNTBLANK / a unique count) so hidden rows drop out. */
export type TotalKind = 'none' | 'sum' | 'average' | 'count' | 'filled' | 'empty' | 'unique' | 'min' | 'max'

export const TABLE_COLUMN_TYPES: readonly TableColumnType[] = ['text', 'number', 'percent', 'currency', 'date', 'datetime', 'time', 'checkbox', 'dropdown', 'people']
export const TOTAL_KINDS: readonly TotalKind[] = ['none', 'sum', 'average', 'count', 'filled', 'empty', 'unique', 'min', 'max']

export interface TableColumn {
  /** The header cell's text. */
  name: string
  type: TableColumnType
  /** The total-row aggregate, when the table has a total row. */
  total?: TotalKind
}

/** A filter on one column: a set of allowed shown values, and/or a condition. */
export type FilterOp = 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan' | 'isEmpty' | 'isNotEmpty'
export const FILTER_OPS: readonly FilterOp[] = ['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'isEmpty', 'isNotEmpty']

export interface TableFilter {
  /** Allowed shown values (the checklist). Absent means every value passes the checklist. */
  values?: string[]
  condition?: { op: FilterOp; value: string }
}

export interface TableStyle {
  /** One of TABLE_COLORS. */
  color: string
  bandedRows: boolean
  bandedColumns: boolean
  boldFirstColumn: boolean
  boldLastColumn: boolean
  totalRow: boolean
}

export interface WorkbookTable {
  id: string
  sheetId: number
  /** Unique in the workbook, a valid identifier (Table1, Table2…). */
  name: string
  /** Header row + data rows [+ total row]. */
  range: CellRange
  columns: TableColumn[]
  style: TableStyle
  /** Per column offset (0-based within the table), a filter. */
  filters: Record<number, TableFilter>
  sort?: { column: number; descending: boolean }
  /** Rows this table's own filter hid, so "clear filters" unhides only those (not ones a person hid). */
  hiddenRows?: number[]
}

/** Ten header colors, theme-safe: strong enough that white header text reads on them in either theme. */
export const TABLE_COLORS: readonly { name: string; hex: string }[] = [
  { name: 'Blue', hex: '#1A73E8' },
  { name: 'Teal', hex: '#0E9384' },
  { name: 'Green', hex: '#1E8E3E' },
  { name: 'Amber', hex: '#B88407' },
  { name: 'Orange', hex: '#E8710A' },
  { name: 'Red', hex: '#D92D20' },
  { name: 'Pink', hex: '#D6336C' },
  { name: 'Purple', hex: '#9334E6' },
  { name: 'Indigo', hex: '#4F46E5' },
  { name: 'Slate', hex: '#475467' },
]

export function defaultTableStyle(color = TABLE_COLORS[0].hex): TableStyle {
  return { color, bandedRows: true, bandedColumns: false, boldFirstColumn: false, boldLastColumn: false, totalRow: false }
}

// ── Charts ─────────────────────────────────────────────────────────────────

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter'
export const CHART_TYPES: readonly ChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter']

/** Where a floating object sits: anchored to a cell, with a pixel offset into it, then a size. */
export interface Anchor {
  row: number
  column: number
  dx: number
  dy: number
}

export interface WorkbookChart {
  id: string
  sheetId: number
  type: ChartType
  title: string
  legend: boolean
  /** The data range on the same sheet (follows the sheet's row/column moves). */
  source: CellRange
  anchor: Anchor
  width: number
  height: number
}

// ── Images ───────────────────────────────────────────────────────────────────

export interface WorkbookImage {
  id: string
  sheetId: number
  /** The content hash; the bytes live once in `imageBlobs` keyed by it (identical images are stored once). */
  hash: string
  anchor: Anchor
  width: number
  height: number
}

/** A versioned bag. New kinds are added as optional arrays so an older reader drops them cleanly. */
export interface WorkbookExtras {
  v: typeof EXTRAS_VERSION
  validations: Validation[]
  checkboxes: CheckboxArea[]
  tables: WorkbookTable[]
  charts: WorkbookChart[]
  images: WorkbookImage[]
  /** Image data URLs by content hash, so identical images are stored once. */
  imageBlobs: Record<string, string>
}

/** Serialized extras (minus the image blobs) larger than this are trimmed: a guard against runaway validation/table data. */
export const MAX_EXTRAS_BYTES = 1_000_000
/** An image is at most 1 MB, and a workbook holds at most 4 MB of images (the lead's decision: a data URL, no bucket). */
export const MAX_IMAGE_BYTES = 1_000_000
export const MAX_WORKBOOK_IMAGE_BYTES = 4_000_000
const MAX_ENTRIES = 5_000

export function emptyExtras(): WorkbookExtras {
  return { v: EXTRAS_VERSION, validations: [], checkboxes: [], tables: [], charts: [], images: [], imageBlobs: {} }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRange(value: unknown): CellRange | null {
  if (!isObject(value)) return null
  const r1 = Number(value.r1)
  const c1 = Number(value.c1)
  const r2 = Number(value.r2)
  const c2 = Number(value.c2)
  if (![r1, c1, r2, c2].every((n) => Number.isInteger(n) && n >= 1)) return null
  const range = {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.min(MAX_ROWS, Math.max(r1, r2)),
    c2: Math.min(MAX_COLUMNS, Math.max(c1, c2)),
  }
  return range.r1 <= range.r2 && range.c1 <= range.c2 ? range : null
}

const OPERATORS: readonly ValidationOperator[] = [
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
]

function readRule(value: unknown): ValidationSpec | null {
  if (!isObject(value)) return null
  if (value.type === 'list') {
    const choices: ValidationChoice[] = []
    if (Array.isArray(value.choices)) {
      for (const c of value.choices) {
        if (isObject(c) && typeof c.value === 'string') {
          choices.push({ value: c.value, ...(typeof c.color === 'string' ? { color: c.color } : {}) })
        }
      }
    }
    const source = typeof value.source === 'string' && value.source.trim() ? value.source.trim() : undefined
    if (!choices.length && !source) return null
    return { type: 'list', choices, ...(source ? { source } : {}), reject: value.reject !== false }
  }
  if (value.type === 'number' || value.type === 'date' || value.type === 'textLength') {
    const operator = OPERATORS.includes(value.operator as ValidationOperator) ? (value.operator as ValidationOperator) : null
    if (!operator) return null
    if (typeof value.min !== 'string') return null
    const max = typeof value.max === 'string' ? value.max : undefined
    if ((operator === 'between' || operator === 'notBetween') && max === undefined) return null
    return { type: value.type, operator, min: value.min, ...(max !== undefined ? { max } : {}), reject: value.reject !== false }
  }
  return null
}

function readAreas<T extends { sheetId: number; range: CellRange }>(value: unknown, extra: (v: Record<string, unknown>) => Partial<T> | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    if (out.length >= MAX_ENTRIES) break
    if (!isObject(item)) continue
    const sheetId = Number(item.sheetId)
    const range = readRange(item.range)
    if (!Number.isInteger(sheetId) || !range) continue
    const rest = extra(item)
    if (rest === null) continue
    out.push({ sheetId, range, ...rest } as T)
  }
  return out
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readColumnType(value: unknown): TableColumnType {
  return TABLE_COLUMN_TYPES.includes(value as TableColumnType) ? (value as TableColumnType) : 'text'
}

function readTotalKind(value: unknown): TotalKind | undefined {
  return TOTAL_KINDS.includes(value as TotalKind) ? (value as TotalKind) : undefined
}

function readFilter(value: unknown): TableFilter | null {
  if (!isObject(value)) return null
  const filter: TableFilter = {}
  if (Array.isArray(value.values)) filter.values = value.values.filter((v): v is string => typeof v === 'string')
  if (isObject(value.condition) && FILTER_OPS.includes(value.condition.op as FilterOp)) {
    filter.condition = { op: value.condition.op as FilterOp, value: readString(value.condition.value) }
  }
  return filter.values || filter.condition ? filter : null
}

function readTable(value: unknown): WorkbookTable | null {
  if (!isObject(value)) return null
  const sheetId = Number(value.sheetId)
  const range = readRange(value.range)
  if (!Number.isInteger(sheetId) || !range || typeof value.id !== 'string') return null
  const columns: TableColumn[] = []
  if (Array.isArray(value.columns)) {
    for (const c of value.columns) {
      if (!isObject(c)) continue
      columns.push({ name: readString(c.name), type: readColumnType(c.type), ...(readTotalKind(c.total) ? { total: readTotalKind(c.total) } : {}) })
    }
  }
  if (!columns.length) return null
  const styleIn = isObject(value.style) ? value.style : {}
  const style: TableStyle = {
    color: typeof styleIn.color === 'string' ? styleIn.color : TABLE_COLORS[0].hex,
    bandedRows: styleIn.bandedRows !== false,
    bandedColumns: styleIn.bandedColumns === true,
    boldFirstColumn: styleIn.boldFirstColumn === true,
    boldLastColumn: styleIn.boldLastColumn === true,
    totalRow: styleIn.totalRow === true,
  }
  const filters: Record<number, TableFilter> = {}
  if (isObject(value.filters)) {
    for (const [key, f] of Object.entries(value.filters)) {
      const offset = Number(key)
      const filter = readFilter(f)
      if (Number.isInteger(offset) && offset >= 0 && filter) filters[offset] = filter
    }
  }
  const sort = isObject(value.sort) && Number.isInteger(Number(value.sort.column)) ? { column: Number(value.sort.column), descending: value.sort.descending === true } : undefined
  const hiddenRows = Array.isArray(value.hiddenRows) ? value.hiddenRows.filter((r): r is number => Number.isInteger(r)) : undefined
  return {
    id: value.id,
    sheetId,
    name: readString(value.name, 'Table'),
    range,
    columns,
    style,
    filters,
    ...(sort ? { sort } : {}),
    ...(hiddenRows && hiddenRows.length ? { hiddenRows } : {}),
  }
}

function readAnchor(value: unknown): Anchor | null {
  if (!isObject(value)) return null
  const row = Number(value.row)
  const column = Number(value.column)
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 1 || column < 1) return null
  return { row, column, dx: Number.isFinite(Number(value.dx)) ? Number(value.dx) : 0, dy: Number.isFinite(Number(value.dy)) ? Number(value.dy) : 0 }
}

function readChart(value: unknown): WorkbookChart | null {
  if (!isObject(value)) return null
  const sheetId = Number(value.sheetId)
  const source = readRange(value.source)
  const anchor = readAnchor(value.anchor)
  if (!Number.isInteger(sheetId) || !source || !anchor || typeof value.id !== 'string') return null
  const type = CHART_TYPES.includes(value.type as ChartType) ? (value.type as ChartType) : 'column'
  const width = Number.isFinite(Number(value.width)) ? Math.max(120, Number(value.width)) : 420
  const height = Number.isFinite(Number(value.height)) ? Math.max(100, Number(value.height)) : 280
  return { id: value.id, sheetId, type, title: readString(value.title), legend: value.legend !== false, source, anchor, width, height }
}

function readImage(value: unknown): WorkbookImage | null {
  if (!isObject(value)) return null
  const sheetId = Number(value.sheetId)
  const anchor = readAnchor(value.anchor)
  if (!Number.isInteger(sheetId) || !anchor || typeof value.id !== 'string' || typeof value.hash !== 'string') return null
  const width = Number.isFinite(Number(value.width)) ? Math.max(16, Number(value.width)) : 200
  const height = Number.isFinite(Number(value.height)) ? Math.max(16, Number(value.height)) : 150
  return { id: value.id, sheetId, hash: value.hash, anchor, width, height }
}

/** Read whatever is in the column, dropping anything this version does not understand. */
export function readExtras(value: unknown): WorkbookExtras {
  const base = emptyExtras()
  if (!isObject(value)) return base
  const validations = readAreas<Validation>(value.validations, (v) => {
    const rule = readRule(v.rule)
    return rule ? { rule } : null
  })
  const checkboxes = readAreas<CheckboxArea>(value.checkboxes, () => ({}))
  const tables: WorkbookTable[] = []
  if (Array.isArray(value.tables)) {
    for (const t of value.tables) {
      if (tables.length >= MAX_ENTRIES) break
      const table = readTable(t)
      if (table) tables.push(table)
    }
  }
  const charts: WorkbookChart[] = []
  if (Array.isArray(value.charts)) {
    for (const c of value.charts) {
      if (charts.length >= MAX_ENTRIES) break
      const chart = readChart(c)
      if (chart) charts.push(chart)
    }
  }
  const images: WorkbookImage[] = []
  if (Array.isArray(value.images)) {
    for (const im of value.images) {
      if (images.length >= MAX_ENTRIES) break
      const image = readImage(im)
      if (image) images.push(image)
    }
  }
  const imageBlobs: Record<string, string> = {}
  if (isObject(value.imageBlobs)) {
    for (const [hash, url] of Object.entries(value.imageBlobs)) {
      if (typeof url === 'string' && url.startsWith('data:')) imageBlobs[hash] = url
    }
  }
  // Keep only blobs an image still points at.
  const used = new Set(images.map((im) => im.hash))
  for (const hash of Object.keys(imageBlobs)) if (!used.has(hash)) delete imageBlobs[hash]
  const result: WorkbookExtras = { v: EXTRAS_VERSION, validations, checkboxes, tables, charts, images, imageBlobs }
  // The size guard counts everything but the image blobs (those have their own caps): trim until it fits.
  const weight = () => JSON.stringify({ ...result, imageBlobs: {} }).length
  while (weight() > MAX_EXTRAS_BYTES && (result.validations.length || result.checkboxes.length)) {
    if (result.validations.length >= result.checkboxes.length) result.validations.pop()
    else result.checkboxes.pop()
  }
  return result
}

/** True when the extras hold nothing worth saving (so a record can keep `{}`). */
export function extrasAreEmpty(extras: WorkbookExtras): boolean {
  return (
    extras.validations.length === 0 &&
    extras.checkboxes.length === 0 &&
    extras.tables.length === 0 &&
    extras.charts.length === 0 &&
    extras.images.length === 0
  )
}

// ── Range arithmetic ─────────────────────────────────────────────────────────

export function rangesOverlap(a: CellRange, b: CellRange): boolean {
  return a.r1 <= b.r2 && a.r2 >= b.r1 && a.c1 <= b.c2 && a.c2 >= b.c1
}

export function rangeContains(range: CellRange, row: number, column: number): boolean {
  return row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2
}

/** The pieces of `a` that `b` does not cover: up to four rectangles, or `[a]` when they do not meet. */
export function subtractRange(a: CellRange, b: CellRange): CellRange[] {
  if (!rangesOverlap(a, b)) return [a]
  const out: CellRange[] = []
  if (b.r1 > a.r1) out.push({ r1: a.r1, c1: a.c1, r2: b.r1 - 1, c2: a.c2 })
  if (b.r2 < a.r2) out.push({ r1: b.r2 + 1, c1: a.c1, r2: a.r2, c2: a.c2 })
  const mr1 = Math.max(a.r1, b.r1)
  const mr2 = Math.min(a.r2, b.r2)
  if (b.c1 > a.c1) out.push({ r1: mr1, c1: a.c1, r2: mr2, c2: b.c1 - 1 })
  if (b.c2 < a.c2) out.push({ r1: mr1, c1: b.c2 + 1, r2: mr2, c2: a.c2 })
  return out
}

/** One index under an insert or a delete on its axis; null when the index is deleted away. */
function shiftIndex(idx: number, change: AxisChange): number | null {
  const { at, count } = change
  if (change.kind === 'insert') return idx >= at ? idx + count : idx
  const hi = at + count - 1
  if (idx < at) return idx
  if (idx > hi) return idx - count
  return null // inside the deleted band
}

type AxisChange = { kind: 'insert' | 'delete'; at: number; count: number }

/** A range after rows or columns are inserted or deleted on its axis; null when it is wholly removed. */
function shiftRange(range: CellRange, axis: 'row' | 'column', change: AxisChange): CellRange | null {
  const [lo, hi] = axis === 'row' ? [range.r1, range.r2] : [range.c1, range.c2]
  if (change.kind === 'insert') {
    const nlo = shiftIndex(lo, change) as number
    const nhi = shiftIndex(hi, change) as number
    return axis === 'row' ? { ...range, r1: nlo, r2: nhi } : { ...range, c1: nlo, c2: nhi }
  }
  const band = change.at + change.count - 1
  const nlo = lo < change.at ? lo : lo > band ? lo - change.count : change.at
  const nhi = hi < change.at ? hi : hi > band ? hi - change.count : change.at - 1
  if (nhi < nlo) return null
  return axis === 'row' ? { ...range, r1: nlo, r2: nhi } : { ...range, c1: nlo, c2: nhi }
}

export type ExtrasChange =
  | { type: 'insertRows'; sheetId: number; at: number; count: number }
  | { type: 'deleteRows'; sheetId: number; at: number; count: number }
  | { type: 'insertColumns'; sheetId: number; at: number; count: number }
  | { type: 'deleteColumns'; sheetId: number; at: number; count: number }
  | { type: 'deleteSheet'; sheetId: number }
  | { type: 'duplicateSheet'; fromId: number; toId: number }

function mapAreas<T extends { sheetId: number; range: CellRange }>(items: T[], change: ExtrasChange): T[] {
  if (change.type === 'deleteSheet') return items.filter((it) => it.sheetId !== change.sheetId)
  if (change.type === 'duplicateSheet') {
    const copies = items.filter((it) => it.sheetId === change.fromId).map((it) => ({ ...it, sheetId: change.toId }))
    return [...items, ...copies]
  }
  const axis: 'row' | 'column' = change.type === 'insertRows' || change.type === 'deleteRows' ? 'row' : 'column'
  const kind: 'insert' | 'delete' = change.type.startsWith('insert') ? 'insert' : 'delete'
  const out: T[] = []
  for (const it of items) {
    if (it.sheetId !== change.sheetId) {
      out.push(it)
      continue
    }
    const next = shiftRange(it.range, axis, { kind, at: change.at, count: change.count })
    if (next) out.push({ ...it, range: next })
  }
  return out
}

/** A cell anchor after a structural change; it never vanishes (a delete clamps it to the cut point). */
function shiftAnchor(anchor: Anchor, change: ExtrasChange): Anchor {
  if (change.type === 'deleteSheet' || change.type === 'duplicateSheet') return anchor
  const axisRow = change.type === 'insertRows' || change.type === 'deleteRows'
  const idx = axisRow ? anchor.row : anchor.column
  let next = idx
  if (change.type === 'insertRows' || change.type === 'insertColumns') {
    if (idx >= change.at) next = idx + change.count
  } else {
    const band = change.at + change.count - 1
    next = idx < change.at ? idx : idx > band ? idx - change.count : change.at
  }
  next = Math.max(1, next)
  return axisRow ? { ...anchor, row: next } : { ...anchor, column: next }
}

/** A chart after a structural change: its source range shifts, its anchor moves; it never vanishes. */
function shiftChart(chart: WorkbookChart, change: ExtrasChange): WorkbookChart | null {
  if (change.type === 'deleteSheet') return chart.sheetId === change.sheetId ? null : chart
  if (change.type === 'duplicateSheet') return chart // the copy is appended separately
  if (chart.sheetId !== change.sheetId) return chart
  const axis: 'row' | 'column' = change.type === 'insertRows' || change.type === 'deleteRows' ? 'row' : 'column'
  const kind: 'insert' | 'delete' = change.type.startsWith('insert') ? 'insert' : 'delete'
  const source = shiftRange(chart.source, axis, { kind, at: change.at, count: change.count }) ?? chart.source
  return { ...chart, source, anchor: shiftAnchor(chart.anchor, change) }
}

/** A table after a structural change: row changes shift/shrink the range; column changes also add or drop columns. */
function shiftTable(table: WorkbookTable, change: ExtrasChange): WorkbookTable | null {
  if (change.type === 'deleteSheet') return table.sheetId === change.sheetId ? null : table
  if (change.type === 'duplicateSheet') return table // the copy is appended separately
  if (table.sheetId !== change.sheetId) return table
  if (change.type === 'insertRows' || change.type === 'deleteRows') {
    const next = shiftRange(table.range, 'row', { kind: change.type === 'insertRows' ? 'insert' : 'delete', at: change.at, count: change.count })
    if (!next) return null
    return { ...table, range: next, ...(table.hiddenRows ? { hiddenRows: table.hiddenRows.map((r) => shiftAnchor({ row: r, column: 1, dx: 0, dy: 0 }, change).row) } : {}) }
  }
  // Column insert or delete: shift the range, and add or drop the columns that fall inside it.
  const nextRange = shiftRange(table.range, 'column', { kind: change.type === 'insertColumns' ? 'insert' : 'delete', at: change.at, count: change.count })
  if (!nextRange) return null
  let columns = table.columns
  let filters = table.filters
  if (change.type === 'insertColumns' && change.at > table.range.c1 && change.at <= table.range.c2) {
    const offset = change.at - table.range.c1
    const added: TableColumn[] = Array.from({ length: change.count }, (_, i) => ({ name: `Column ${columns.length + i + 1}`, type: 'text' }))
    columns = [...columns.slice(0, offset), ...added, ...columns.slice(offset)]
    filters = {}
    for (const [key, f] of Object.entries(table.filters)) filters[Number(key) >= offset ? Number(key) + change.count : Number(key)] = f
  } else if (change.type === 'deleteColumns') {
    const band = { lo: change.at, hi: change.at + change.count - 1 }
    columns = []
    filters = {}
    let newOffset = 0
    for (let i = 0; i < table.columns.length; i++) {
      const col = table.range.c1 + i
      if (col >= band.lo && col <= band.hi) continue
      columns.push(table.columns[i])
      if (table.filters[i]) filters[newOffset] = table.filters[i]
      newOffset += 1
    }
    if (!columns.length) return null
  }
  return { ...table, range: nextRange, columns, filters }
}

/** Move the stored ranges and objects with a structural change to the sheet. Returns new extras (unchanged object when nothing moved). */
export function shiftExtras(extras: WorkbookExtras, change: ExtrasChange): WorkbookExtras {
  const validations = mapAreas(extras.validations, change)
  const checkboxes = mapAreas(extras.checkboxes, change)
  let tables = extras.tables.map((t) => shiftTable(t, change)).filter((t): t is WorkbookTable => t !== null)
  let charts = extras.charts.map((c) => shiftChart(c, change)).filter((c): c is WorkbookChart => c !== null)
  let images = extras.images
  if (change.type === 'duplicateSheet') {
    tables = [...tables, ...extras.tables.filter((t) => t.sheetId === change.fromId).map((t) => ({ ...t, sheetId: change.toId, id: `${t.id}-copy` }))]
    charts = [...charts, ...extras.charts.filter((c) => c.sheetId === change.fromId).map((c) => ({ ...c, sheetId: change.toId, id: `${c.id}-copy` }))]
  }
  if (change.type === 'deleteSheet') images = images.filter((im) => im.sheetId !== change.sheetId)
  else if (change.type === 'duplicateSheet') images = [...images, ...images.filter((im) => im.sheetId === change.fromId).map((im) => ({ ...im, sheetId: change.toId, id: `${im.id}-copy` }))]
  else images = images.map((im) => (im.sheetId === change.sheetId ? { ...im, anchor: shiftAnchor(im.anchor, change) } : im))
  return { ...extras, validations, checkboxes, tables, charts, images }
}

// ── Editing the collections (each returns a new extras) ──────────────────────

/** Add a validation on a range, carving that range out of any rule it overlaps (a cell has one rule). */
export function putValidation(extras: WorkbookExtras, sheetId: number, range: CellRange, rule: ValidationSpec): WorkbookExtras {
  const validations = clearValidationIn(extras, sheetId, range).validations
  return { ...extras, validations: [...validations, { sheetId, range, rule }] }
}

/** Remove validation from a range: each overlapping rule keeps only the pieces outside it. */
export function clearValidationIn(extras: WorkbookExtras, sheetId: number, range: CellRange): WorkbookExtras {
  const validations: Validation[] = []
  for (const v of extras.validations) {
    if (v.sheetId !== sheetId || !rangesOverlap(v.range, range)) {
      validations.push(v)
      continue
    }
    for (const piece of subtractRange(v.range, range)) validations.push({ ...v, range: piece })
  }
  return { ...extras, validations }
}

/** The validation whose range covers a cell, or null. */
export function validationAt(extras: WorkbookExtras, sheetId: number, row: number, column: number): Validation | null {
  // Later rules win, so scan from the end.
  for (let i = extras.validations.length - 1; i >= 0; i--) {
    const v = extras.validations[i]
    if (v.sheetId === sheetId && rangeContains(v.range, row, column)) return v
  }
  return null
}

/** Mark a range's cells as checkboxes, carving it out of nothing (checkboxes may overlap a validation harmlessly). */
export function addCheckboxes(extras: WorkbookExtras, sheetId: number, range: CellRange): WorkbookExtras {
  const kept = removeCheckboxesIn(extras, sheetId, range).checkboxes
  return { ...extras, checkboxes: [...kept, { sheetId, range }] }
}

export function removeCheckboxesIn(extras: WorkbookExtras, sheetId: number, range: CellRange): WorkbookExtras {
  const checkboxes: CheckboxArea[] = []
  for (const b of extras.checkboxes) {
    if (b.sheetId !== sheetId || !rangesOverlap(b.range, range)) {
      checkboxes.push(b)
      continue
    }
    for (const piece of subtractRange(b.range, range)) checkboxes.push({ sheetId, range: piece })
  }
  return { ...extras, checkboxes }
}

export function isCheckbox(extras: WorkbookExtras, sheetId: number, row: number, column: number): boolean {
  return extras.checkboxes.some((b) => b.sheetId === sheetId && rangeContains(b.range, row, column))
}

// ── Checking a value against a rule (pure) ───────────────────────────────────

/** The choices a list rule allows, given a reader for a source range. */
export function listChoiceValues(rule: ListValidation, resolveSource: (source: string) => string[]): string[] {
  const values = rule.source ? resolveSource(rule.source) : rule.choices.map((c) => c.value)
  return values.filter((v) => v !== '')
}

/** Whether a number, date serial or text length passes a bound rule. */
export function passesBound(quantity: number, rule: BoundValidation): boolean {
  const a = Number(rule.min)
  if (!Number.isFinite(a)) return true
  const b = rule.max !== undefined ? Number(rule.max) : NaN
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  switch (rule.operator) {
    case 'between':
      return Number.isFinite(b) ? quantity >= lo && quantity <= hi : true
    case 'notBetween':
      return Number.isFinite(b) ? quantity < lo || quantity > hi : true
    case 'equal':
      return quantity === a
    case 'notEqual':
      return quantity !== a
    case 'greaterThan':
      return quantity > a
    case 'lessThan':
      return quantity < a
    case 'greaterThanOrEqual':
      return quantity >= a
    case 'lessThanOrEqual':
      return quantity <= a
  }
}

// ── Tables: geometry and editing ─────────────────────────────────────────────

/** The header row, the data rows [r1, r2] and the total row of a table (total is null when it has none). */
export function tableParts(table: WorkbookTable): { header: number; dataR1: number; dataR2: number; total: number | null } {
  const header = table.range.r1
  const total = table.style.totalRow ? table.range.r2 : null
  const dataR2 = total !== null ? table.range.r2 - 1 : table.range.r2
  return { header, dataR1: header + 1, dataR2, total }
}

/** The table whose range covers a cell, or null (later tables win, as validations do). */
export function tableAt(extras: WorkbookExtras, sheetId: number, row: number, column: number): WorkbookTable | null {
  for (let i = extras.tables.length - 1; i >= 0; i--) {
    const t = extras.tables[i]
    if (t.sheetId === sheetId && rangeContains(t.range, row, column)) return t
  }
  return null
}

export function tableById(extras: WorkbookExtras, id: string): WorkbookTable | null {
  return extras.tables.find((t) => t.id === id) ?? null
}

/** A table name not already taken (Table1, Table2…), a valid identifier. */
export function nextTableName(extras: WorkbookExtras): string {
  const taken = new Set(extras.tables.map((t) => t.name.toLowerCase()))
  for (let n = 1; ; n++) {
    const name = `Table${n}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

/** Whether a name is a valid, unique table identifier; returns a reason when it is not. */
export function tableNameProblem(name: string, extras: WorkbookExtras, exceptId?: string): string | null {
  const s = name.trim()
  if (!s) return 'A table needs a name.'
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s)) return 'A table name starts with a letter and uses letters, digits, _ or .'
  if (s.length > 255) return 'A table name is 255 characters at most.'
  if (extras.tables.some((t) => t.id !== exceptId && t.name.toLowerCase() === s.toLowerCase())) return 'Another table already has that name.'
  return null
}

/** Add or replace a table (removing any table that overlaps its range, since tables do not nest). */
export function putTable(extras: WorkbookExtras, table: WorkbookTable): WorkbookExtras {
  const tables = extras.tables.filter((t) => t.id === table.id || t.sheetId !== table.sheetId || !rangesOverlap(t.range, table.range))
  const replaced = tables.some((t) => t.id === table.id)
  return { ...extras, tables: replaced ? tables.map((t) => (t.id === table.id ? table : t)) : [...tables, table] }
}

export function removeTable(extras: WorkbookExtras, id: string): WorkbookExtras {
  return { ...extras, tables: extras.tables.filter((t) => t.id !== id) }
}

// ── Charts: editing ──────────────────────────────────────────────────────────

export function addChart(extras: WorkbookExtras, chart: WorkbookChart): WorkbookExtras {
  return { ...extras, charts: [...extras.charts, chart] }
}

export function updateChart(extras: WorkbookExtras, id: string, patch: Partial<WorkbookChart>): WorkbookExtras {
  return { ...extras, charts: extras.charts.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
}

export function removeChart(extras: WorkbookExtras, id: string): WorkbookExtras {
  return { ...extras, charts: extras.charts.filter((c) => c.id !== id) }
}

export function chartById(extras: WorkbookExtras, id: string): WorkbookChart | null {
  return extras.charts.find((c) => c.id === id) ?? null
}

// ── Images: editing (deduped by content hash) ────────────────────────────────

/** The (decoded) bytes a workbook's images take, counting each distinct blob once. */
export function imageBytesUsed(extras: WorkbookExtras): number {
  return Object.values(extras.imageBlobs).reduce((sum, url) => sum + decodedBytes(url), 0)
}

/** The decoded size of a `data:…;base64,…` URL, estimated from its base64 length. */
function decodedBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}

/** Add an image; its data URL is stored once per content hash. */
export function addImage(extras: WorkbookExtras, image: WorkbookImage, dataUrl: string): WorkbookExtras {
  return { ...extras, images: [...extras.images, image], imageBlobs: { ...extras.imageBlobs, [image.hash]: dataUrl } }
}

export function removeImage(extras: WorkbookExtras, id: string): WorkbookExtras {
  const images = extras.images.filter((im) => im.id !== id)
  const used = new Set(images.map((im) => im.hash))
  const imageBlobs: Record<string, string> = {}
  for (const [hash, url] of Object.entries(extras.imageBlobs)) if (used.has(hash)) imageBlobs[hash] = url
  return { ...extras, images, imageBlobs }
}

export function updateImage(extras: WorkbookExtras, id: string, patch: Partial<WorkbookImage>): WorkbookExtras {
  return { ...extras, images: extras.images.map((im) => (im.id === id ? { ...im, ...patch } : im)) }
}

export function imageById(extras: WorkbookExtras, id: string): WorkbookImage | null {
  return extras.images.find((im) => im.id === id) ?? null
}

const OPERATOR_WORDS: Record<ValidationOperator, string> = {
  between: 'between',
  notBetween: 'not between',
  equal: 'equal to',
  notEqual: 'not equal to',
  greaterThan: 'greater than',
  lessThan: 'less than',
  greaterThanOrEqual: 'greater than or equal to',
  lessThanOrEqual: 'less than or equal to',
}

/** A short plain description of what a rule allows, for a refusal or a panel line. */
export function describeValidation(rule: ValidationSpec): string {
  if (rule.type === 'list') return 'one of the values in the list'
  const noun = rule.type === 'textLength' ? 'a text length' : rule.type === 'date' ? 'a date' : 'a number'
  const word = OPERATOR_WORDS[rule.operator]
  const range = rule.operator === 'between' || rule.operator === 'notBetween' ? `${rule.min} and ${rule.max}` : rule.min
  return `${noun} ${word} ${range}`
}
