/**
 * A table's saved views (Tables, phase 4; migration 529): the views system's
 * own views (src/lib/views), of kind `data_row`, scoped to one table. A view
 * keeps its layout, filters, sorts and grouping in the usual columns, its
 * column order in `display_properties` (column keys), and the rest in
 * `metadata.table` (TableViewSettings): widths, hidden columns, and each
 * layout's pick (the board's totals, the calendar's date, the gallery's cover).
 *
 * The rows a view shows are filtered and sorted on the server
 * (src/lib/tables/store.ts queryRows); this module lays them out: the grid's
 * columns, a board's lanes and totals, a calendar's days, and the one cell
 * edit a drag between lanes or days makes.
 *
 * Client-safe and pure.
 */
import { addDays, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns'
import { isIsoDate, type CurrencyValue } from '@/lib/crm/custom-field-types'
import { customFieldKeyOf } from '@/lib/views/custom-field-columns'
import type { GroupConfig } from '@/lib/views/types'
import type { CellEdit } from './grid-edits'
import type { DataColumn, DataRow } from './types'

export interface TableViewSettings {
  /** Column widths in pixels, by key (the Name column under `title`). */
  widths?: Record<string, number>
  /** The columns this view hides. */
  hidden?: string[]
  /** Board: the number or currency column each lane totals. */
  total_key?: string | null
  /** Calendar: the date column rows sit on (the table's first date column when unset). */
  date_key?: string | null
  /** Gallery: the URL column whose image tops a card (none when unset). */
  cover_key?: string | null
}

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/
const MIN_WIDTH = 60
const MAX_WIDTH = 1200

const keyOrNull = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && KEY_RE.test(v) ? v : undefined)

/** A view's table settings out of its metadata, keeping only well-formed values. */
export function readTableSettings(metadata: unknown): TableViewSettings | undefined {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).table : undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const t = raw as Record<string, unknown>
  const out: TableViewSettings = {}
  if (t.widths && typeof t.widths === 'object' && !Array.isArray(t.widths)) {
    const widths: Record<string, number> = {}
    for (const [k, v] of Object.entries(t.widths as Record<string, unknown>)) {
      if (KEY_RE.test(k) && typeof v === 'number' && Number.isFinite(v)) widths[k] = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)))
    }
    if (Object.keys(widths).length) out.widths = widths
  }
  if (Array.isArray(t.hidden)) {
    const hidden = [...new Set(t.hidden.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)))]
    if (hidden.length) out.hidden = hidden
  }
  for (const k of ['total_key', 'date_key', 'cover_key'] as const) {
    const v = keyOrNull(t[k])
    if (v !== undefined) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** A view's metadata with these table settings in it (the rest of the metadata kept). */
export function withTableSettings(metadata: Record<string, unknown> | null | undefined, settings: TableViewSettings | undefined): Record<string, unknown> {
  const { table: _old, ...rest } = metadata ?? {}
  void _old
  return settings && Object.keys(settings).length ? { ...rest, table: settings } : rest
}

// ── The grid's columns ──────────────────────────────────────────────────────

/**
 * The columns a view shows, in its order: the ones its order names first,
 * then the rest in the table's order (a column added since joins at the
 * end), less the hidden ones.
 */
export function viewColumns(columns: readonly DataColumn[], order: readonly string[] = [], hidden: readonly string[] = []): DataColumn[] {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const out: DataColumn[] = []
  const seen = new Set<string>()
  for (const k of order) {
    const c = byKey.get(k)
    if (c && !seen.has(k)) {
      seen.add(k)
      out.push(c)
    }
  }
  for (const c of columns) if (!seen.has(c.key)) out.push(c)
  const hide = new Set(hidden)
  return out.filter((c) => !hide.has(c.key))
}

/**
 * The view's whole column order after `key` moves to `toIndex` among the
 * shown columns (hidden ones keep their places). Every live column is named,
 * so the order holds whatever the table's own order does later.
 */
export function moveColumn(columns: readonly DataColumn[], order: readonly string[], hidden: readonly string[], key: string, toIndex: number): string[] {
  const all = viewColumns(columns, order).map((c) => c.key)
  const hide = new Set(hidden)
  const shown = all.filter((k) => !hide.has(k) && k !== key)
  const at = Math.max(0, Math.min(toIndex, shown.length))
  const before = shown[at]
  const rest = all.filter((k) => k !== key)
  const i = before === undefined ? rest.length : rest.indexOf(before)
  rest.splice(i, 0, key)
  return rest
}

// ── Cards ───────────────────────────────────────────────────────────────────

/** The most fields a card shows under its title. */
export const CARD_FIELDS = 3

/** A card's fields: the view's first shown columns, less the ones the layout already says (a board's lane, a calendar's day, a gallery's cover). */
export function cardColumns(shown: readonly DataColumn[], except: ReadonlyArray<string | null | undefined> = []): DataColumn[] {
  const skip = new Set(except.filter(Boolean))
  return shown.filter((c) => !skip.has(c.key)).slice(0, CARD_FIELDS)
}

/** A value worth a line on a card (an empty one, or an unticked box, is not). */
export function hasCardValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === false) return false
  return !(Array.isArray(value) && value.length === 0)
}

// ── Board ───────────────────────────────────────────────────────────────────

/** The lane of the rows with no value. */
export const NO_VALUE = '__none__'

/** The columns a board can group by: a select (its options are the lanes) or a person (the members). */
export function isGroupable(c: Pick<DataColumn, 'field_type'>): boolean {
  return c.field_type === 'select' || c.field_type === 'person'
}

/** The columns a board can total. */
export function isTotalable(c: Pick<DataColumn, 'field_type'>): boolean {
  return c.field_type === 'number' || c.field_type === 'currency'
}

/** The column a view's grouping names, when it is one a board can group by. */
export function groupColumnOf(columns: readonly DataColumn[], grouping: GroupConfig | null | undefined): DataColumn | null {
  const key = grouping ? customFieldKeyOf(grouping.field) : null
  const col = key ? columns.find((c) => c.key === key) : undefined
  return col && isGroupable(col) ? col : null
}

/** One total: a number's sum, or a currency's per code. */
export interface LaneTotal {
  amount: number
  currency?: string
}

export interface BoardLane {
  key: string
  label: string
  rows: DataRow[]
  /** Totals of the view's total column over the lane's rows (empty when none is picked). */
  totals: LaneTotal[]
}

/** A sum of a number or currency column's values; a currency's per code, the most common first. */
export function columnTotals(rows: readonly DataRow[], column: Pick<DataColumn, 'key' | 'field_type'> | null | undefined): LaneTotal[] {
  if (!column || !isTotalable(column)) return []
  if (column.field_type === 'number') {
    let sum = 0
    for (const r of rows) {
      const v = r.custom_fields?.[column.key]
      if (typeof v === 'number' && Number.isFinite(v)) sum += v
    }
    return [{ amount: roundMoney(sum) }]
  }
  const by = new Map<string, { amount: number; n: number }>()
  for (const r of rows) {
    const v = r.custom_fields?.[column.key] as CurrencyValue | null | undefined
    if (!v || typeof v !== 'object' || typeof v.amount !== 'number' || !Number.isFinite(v.amount)) continue
    const t = by.get(v.currency) ?? { amount: 0, n: 0 }
    t.amount += v.amount
    t.n++
    by.set(v.currency, t)
  }
  return [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([currency, t]) => ({ amount: roundMoney(t.amount), currency }))
}

const roundMoney = (n: number) => Math.round(n * 100) / 100

/**
 * A board's lanes: every option of a select (in its order) or every member
 * for a person (by name), the empty ones included so a card can go anywhere;
 * then a value no option or member holds any more (by label); then the rows
 * with no value, last and always there, so a card can be taken off a lane.
 * The rows keep the order they came in (the view's sort).
 */
export function boardLanes(
  rows: readonly DataRow[],
  column: DataColumn,
  opts: { members?: ReadonlyArray<{ id: string; name: string }>; labels?: Readonly<Record<string, string>>; totalColumn?: DataColumn | null } = {},
): BoardLane[] {
  const fixed: Array<{ key: string; label: string }> =
    column.field_type === 'person'
      ? [...(opts.members ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ key: m.id, label: m.name }))
      : (column.options ?? []).map((o) => ({ key: o, label: o }))
  const byKey = new Map<string, DataRow[]>()
  for (const r of rows) {
    const v = r.custom_fields?.[column.key]
    const k = typeof v === 'string' && v !== '' ? v : NO_VALUE
    const list = byKey.get(k)
    if (list) list.push(r)
    else byKey.set(k, [r])
  }
  const known = new Set(fixed.map((f) => f.key))
  const stale = [...byKey.keys()]
    .filter((k) => k !== NO_VALUE && !known.has(k))
    .map((k) => ({ key: k, label: column.field_type === 'person' ? (opts.labels?.[k] ?? 'Former member') : k }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const empty = { key: NO_VALUE, label: column.field_type === 'person' ? 'No one' : `No ${column.label}` }
  return [...fixed, ...stale, empty].map((l) => {
    const laneRows = byKey.get(l.key) ?? []
    return { ...l, rows: laneRows, totals: columnTotals(laneRows, opts.totalColumn) }
  })
}

/** The edit a card dropped on a lane makes: that lane's value (none for "No value"), or null when it is already there. */
export function boardMoveEdit(row: DataRow, column: Pick<DataColumn, 'key'>, laneKey: string): CellEdit | null {
  const to = laneKey === NO_VALUE ? null : laneKey
  const from = row.custom_fields?.[column.key] ?? null
  if ((from === '' ? null : from) === to) return null
  return { rowId: row.id, key: column.key, value: to }
}

// ── Calendar ────────────────────────────────────────────────────────────────

/** A day as the date columns store it. */
export const dayKey = (d: Date) => format(d, 'yyyy-MM-dd')

/** The column a calendar lays rows out by: the view's pick, else the table's first date column. */
export function dateColumnOf(columns: readonly DataColumn[], key?: string | null): DataColumn | null {
  const picked = key ? columns.find((c) => c.key === key && c.field_type === 'date') : undefined
  return picked ?? columns.find((c) => c.field_type === 'date') ?? null
}

/** A month as whole weeks (Sunday first): every day from the week the month starts in to the week it ends in. */
export function monthWeeks(anchor: Date): string[][] {
  const first = startOfWeek(startOfMonth(anchor))
  const last = endOfWeek(endOfMonth(anchor))
  const weeks: string[][] = []
  for (let d = first; d <= last; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => dayKey(addDays(d, i))))
  return weeks
}

/** The seven days of the week `anchor` is in. */
export function weekDays(anchor: Date): string[] {
  const first = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => dayKey(addDays(first, i)))
}

/** Rows by the day their date column holds, and the ones with none (the side list). Each keeps the view's order. */
export function rowsByDay(rows: readonly DataRow[], column: Pick<DataColumn, 'key'>): { days: Map<string, DataRow[]>; undated: DataRow[] } {
  const days = new Map<string, DataRow[]>()
  const undated: DataRow[] = []
  for (const r of rows) {
    const v = r.custom_fields?.[column.key]
    if (typeof v !== 'string' || !isIsoDate(v)) {
      undated.push(r)
      continue
    }
    const list = days.get(v)
    if (list) list.push(r)
    else days.set(v, [r])
  }
  return { days, undated }
}

/** The edit a card dropped on a day makes (null: no date, the side list), or null when it is already there. */
export function calendarMoveEdit(row: DataRow, column: Pick<DataColumn, 'key'>, day: string | null): CellEdit | null {
  if (day !== null && !isIsoDate(day)) return null
  const from = row.custom_fields?.[column.key] ?? null
  if (from === day) return null
  return { rowId: row.id, key: column.key, value: day }
}

// ── Gallery ─────────────────────────────────────────────────────────────────

/** The URL column a gallery's cards are topped by, when the view picks one. */
export function coverColumnOf(columns: readonly DataColumn[], key?: string | null): DataColumn | null {
  return (key && columns.find((c) => c.key === key && c.field_type === 'url')) || null
}

/** A cover's image address: an http(s) URL, or nothing. */
export function coverUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^https?:\/\/\S+$/i.test(value.trim()) ? value.trim() : null
}
