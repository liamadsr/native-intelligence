/**
 * CSV in and out of a table (Tables, phase 6).
 *
 * In: a spreadsheet is read by the contact import's own reader (parseCsv and
 * readXlsx, src/lib/crm/import/sources/spreadsheet.ts: any delimiter, quoted
 * fields, report title rows above the header, Excel's first sheet). Each of
 * its columns maps to the row's name, a column the table has, a new column
 * (its type guessed from the values), or nothing. `importOps` turns the
 * sheet into ONE batch, with source `import`: the new columns, then the rows
 * in inserts of 1000. One batch is one change in the undo log, so one Undo
 * takes the whole import back (the rows archived, the new columns removed).
 * The cap is the batch's: IMPORT_MAX_ROWS rows. A cell that doesn't fit its
 * column (a word in a number column) is left empty and counted, never a
 * refusal of the whole file.
 *
 * Out: `exportCsv` writes a view's rows (its filters, sorts and shown
 * columns) as RFC 4180 CSV, each value as it reads: names for people and
 * linked records, "Yes"/"No", "$1,200.00", dates as YYYY-MM-DD, a formula's
 * result. A text cell that would start a spreadsheet formula (= + - @) gets
 * a leading ' so a spreadsheet shows it rather than running it.
 *
 * Client-safe and pure.
 */
import {
  coerceCustomValue,
  formatFieldValue,
  hasOptions,
  isIsoDate,
  normalizeUrl,
  parseCurrency,
  type CustomFieldConfig,
  type CustomFieldType,
  type CustomFieldValue,
} from '@/lib/crm/custom-field-types'
import { normalizeEmail, normalizePhone } from '@/lib/crm/import/record'
import { cellValueOfRow, resultFieldType } from './computed'
import { lenientDate, pastedValue } from './grid-edits'
import { newColumnKey, type DataOpInput } from './ops'
import { isComputedType, TABLE_LIMITS, type DataColumn, type DataRow } from './types'

/** The most rows one import brings in: one batch (apply_data_ops takes at most 5000 rows). */
export const IMPORT_MAX_ROWS = TABLE_LIMITS.rowsPerBatch
/** The most columns read from a file (the spreadsheet reader's own cap). */
export const IMPORT_MAX_COLUMNS = 60
/** The largest file read. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
/** The most rows one export writes. */
export const EXPORT_MAX_ROWS = 10_000

/** Where one of the file's columns goes. */
export type ImportTarget =
  | { kind: 'title' }
  | { kind: 'column'; key: string }
  | { kind: 'new'; label: string; field_type: CustomFieldType; options?: string[] }
  | { kind: 'skip' }

export interface ImportSheet {
  headers: string[]
  rows: string[][]
}

/** A column a file can write into: a stored one (a formula, a rollup and a relation are not). */
export function importable(c: Pick<DataColumn, 'field_type' | 'deleted_at'>): boolean {
  return !c.deleted_at && !isComputedType(c.field_type) && c.field_type !== 'relation'
}

const CHECK_WORDS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 'x', 'done', 'checked', 'unchecked', '✓'])
const CURRENCY_HINT = /[$€£¥₹]|\b[A-Z]{3}\b/

/**
 * A new column's type from its header and its values: a checkbox, a number,
 * a currency, a date, an email, a web address, a phone, a select (a handful
 * of values that repeat), else text. Every non-empty value must fit.
 */
export function guessColumnType(header: string, values: readonly string[]): { field_type: CustomFieldType; options?: string[] } {
  const vals = values.map((v) => v.trim()).filter(Boolean)
  if (!vals.length) return { field_type: 'text' }
  const all = (f: (v: string) => boolean) => vals.every(f)
  const h = header.toLowerCase()
  if (all((v) => CHECK_WORDS.has(v.toLowerCase())) && new Set(vals.map((v) => v.toLowerCase())).size <= 2) return { field_type: 'checkbox' }
  if (all((v) => /^[-+]?[\d,]*\.?\d+$/.test(v.replace(/\s/g, '')) && !/^0\d/.test(v))) return { field_type: 'number' }
  if (all((v) => CURRENCY_HINT.test(v) && parseCurrency(v, 'USD') !== null)) return { field_type: 'currency' }
  if (all((v) => isIsoDate(lenientDate(v)))) return { field_type: 'date' }
  if (all((v) => normalizeEmail(v) !== null)) return { field_type: 'email' }
  if (all((v) => /^(https?:\/\/|www\.)/i.test(v) && normalizeUrl(v) !== null)) return { field_type: 'url' }
  if ((/phone|mobile|cell|tel/.test(h) || all((v) => /^\+?[\d\s().-]{7,20}$/.test(v))) && all((v) => normalizePhone(v) !== null)) return { field_type: 'phone' }
  const distinct = [...new Map(vals.map((v) => [v.toLowerCase(), v])).values()]
  if (vals.length >= 4 && distinct.length <= 12 && distinct.length <= vals.length / 2 && distinct.every((v) => v.length <= 60 && !v.includes(','))) {
    return { field_type: 'select', options: distinct }
  }
  return { field_type: 'text' }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Each file column's target, as first offered: the row's name for a "Name"
 * or "Title" column (else the first column), a table column of the same
 * name, else a new column of the guessed type.
 */
export function planImport(sheet: ImportSheet, columns: readonly DataColumn[]): ImportTarget[] {
  const live = columns.filter(importable)
  const byName = new Map(live.flatMap((c) => [[norm(c.label), c.key] as const, [c.key, c.key] as const]))
  const titleAt = (() => {
    const named = sheet.headers.findIndex((h) => ['name', 'title', 'full name'].includes(norm(h)) && !byName.has(norm(h)))
    return named >= 0 ? named : sheet.headers.findIndex((h) => !byName.has(norm(h)))
  })()
  const taken = new Set<string>()
  return sheet.headers.map((header, i) => {
    if (i === titleAt) return { kind: 'title' }
    const key = byName.get(norm(header))
    if (key && !taken.has(key)) {
      taken.add(key)
      return { kind: 'column', key }
    }
    const guess = guessColumnType(header, sheet.rows.slice(0, 500).map((r) => r[i] ?? ''))
    return { kind: 'new', label: header.trim().slice(0, TABLE_LIMITS.label) || `Column ${i + 1}`, ...guess }
  })
}

export interface ImportPlan {
  ops: DataOpInput[]
  /** Rows brought in (blank lines dropped). */
  rows: number
  /** Rows past the cap, left out. */
  over: number
  /** Per file column, the cells that didn't fit and were left empty, with one of them. */
  misfits: Array<{ header: string; count: number; example: string }>
  /** The table columns the file fills, in the file's order (a new one with its key). */
  columns: Array<{ key: string; label: string; field_type: CustomFieldType }>
}

/**
 * The batch an import is: the new columns (their keys made here, against
 * every key the table has used, deleted ones too), then the rows. `members`
 * names people for a person column.
 */
export function importOps(
  sheet: ImportSheet,
  targets: readonly ImportTarget[],
  columns: readonly DataColumn[],
  opts: { members?: ReadonlyArray<{ id: string; name: string }>; newId?: () => string } = {},
): { ok: true; plan: ImportPlan } | { ok: false; error: string } {
  if (targets.length !== sheet.headers.length) return { ok: false, error: 'Map every column of the file.' }
  if (sheet.headers.length > IMPORT_MAX_COLUMNS) return { ok: false, error: `A file brings in at most ${IMPORT_MAX_COLUMNS} columns.` }
  const keys = new Set(columns.map((c) => c.key))
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const ops: DataOpInput[] = []
  type Shape = { key: string; label: string; field_type: CustomFieldType; options: string[]; config: CustomFieldConfig }
  const into: Array<Shape | 'title' | null> = []
  let titles = 0
  for (const t of targets) {
    if (t.kind === 'skip') into.push(null)
    else if (t.kind === 'title') {
      if (++titles > 1) return { ok: false, error: 'Only one column of the file can be the row’s name.' }
      into.push('title')
    } else if (t.kind === 'column') {
      const c = byKey.get(t.key)
      if (!c || !importable(c) || isComputedType(c.field_type)) return { ok: false, error: `The table has no column “${t.key}” a file can fill.` }
      if (into.some((x) => x && x !== 'title' && x.key === c.key)) return { ok: false, error: `Two columns of the file go into ${c.label}.` }
      into.push({ key: c.key, label: c.label, field_type: c.field_type, options: c.options ?? [], config: c.config ?? {} })
    } else {
      const key = newColumnKey(t.label, keys)
      if (!key) return { ok: false, error: `“${t.label}” needs a letter or a number in its name.` }
      keys.add(key)
      const options = hasOptions(t.field_type) ? [...new Set((t.options ?? []).map((o) => o.trim()).filter(Boolean))].slice(0, TABLE_LIMITS.options) : []
      const config: CustomFieldConfig = t.field_type === 'currency' ? { currency: 'USD' } : {}
      ops.push({ op: 'create_column', key, label: t.label, field_type: t.field_type, ...(hasOptions(t.field_type) ? { options } : {}), ...(Object.keys(config).length ? { config } : {}) })
      into.push({ key, label: t.label, field_type: t.field_type, options, config })
    }
  }
  const misfit = new Map<number, { count: number; example: string }>()
  const rows: Array<{ id?: string; title?: string; values?: Record<string, CustomFieldValue> }> = []
  let over = 0
  for (const cells of sheet.rows) {
    if (!cells.some((c) => (c ?? '').trim())) continue
    if (rows.length >= IMPORT_MAX_ROWS) {
      over++
      continue
    }
    const row: { id?: string; title?: string; values?: Record<string, CustomFieldValue> } = opts.newId ? { id: opts.newId() } : {}
    const values: Record<string, CustomFieldValue> = {}
    into.forEach((target, i) => {
      const text = (cells[i] ?? '').trim()
      if (!target || !text) return
      if (target === 'title') {
        row.title = text.slice(0, TABLE_LIMITS.title)
        return
      }
      const raw = target.field_type === 'checkbox' && text === '✓' ? 'yes' : pastedValue(target, text, { members: opts.members })
      const c = coerceCustomValue(target, raw)
      if (c.ok && c.value !== null) values[target.key] = c.value
      else if (!c.ok) {
        const m = misfit.get(i) ?? { count: 0, example: text.slice(0, 60) }
        m.count++
        misfit.set(i, m)
      }
    })
    if (Object.keys(values).length) row.values = values
    rows.push(row)
  }
  if (!rows.length) return { ok: false, error: 'The file has no rows to bring in.' }
  for (let i = 0; i < rows.length; i += TABLE_LIMITS.rowsPerOp) ops.push({ op: 'insert_rows', rows: rows.slice(i, i + TABLE_LIMITS.rowsPerOp) })
  return {
    ok: true,
    plan: {
      ops,
      rows: rows.length,
      over,
      misfits: [...misfit].map(([i, m]) => ({ header: sheet.headers[i], count: m.count, example: m.example })),
      columns: into.filter((x): x is Shape => !!x && x !== 'title').map((x) => ({ key: x.key, label: x.label, field_type: x.field_type })),
    },
  }
}

// ── Out ─────────────────────────────────────────────────────────────────────

/** One CSV field, quoted when it must be. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** A text that a spreadsheet would read as a formula, made safe to open. */
function safeText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}

/** A cell as the export writes it. */
export function exportValue(column: DataColumn, row: Pick<DataRow, 'custom_fields' | 'computed'>, labels: Readonly<Record<string, string>>): string {
  if (isComputedType(column.field_type)) {
    const { value, error } = cellValueOfRow(column, row)
    if (error) return '#ERROR'
    const t = resultFieldType(column.computed?.result)
    if (value === null || value === undefined) return ''
    if (t === 'number') return String(value)
    if (t === 'checkbox') return value === true ? 'Yes' : 'No'
    return t === 'text' ? safeText(String(value)) : String(value)
  }
  const raw = row.custom_fields?.[column.key]
  switch (column.field_type) {
    case 'number':
      return typeof raw === 'number' ? String(raw) : ''
    case 'date':
      return typeof raw === 'string' ? raw : ''
    case 'text':
    case 'select':
    case 'multi_select':
    case 'url':
    case 'email':
    case 'phone':
    case 'person':
    case 'relation':
      return safeText(formatFieldValue(column.field_type, raw, { labels }))
    default:
      return formatFieldValue(column.field_type, raw, { labels })
  }
}

/** A view's rows as CSV: a Name column, then the shown columns in the view's order. */
export function exportCsv(rows: readonly DataRow[], shown: readonly DataColumn[], labels: Readonly<Record<string, string>>): string {
  const lines = [['Name', ...shown.map((c) => c.label)].map(csvField).join(',')]
  for (const r of rows) lines.push([safeText(r.title ?? ''), ...shown.map((c) => exportValue(c, r, labels))].map(csvField).join(','))
  return `${lines.join('\r\n')}\r\n`
}

/** A file name for a table's export: its name, safe on every system. */
export function exportFileName(tableName: string, viewName?: string | null): string {
  const base = [tableName, viewName].filter(Boolean).join(' - ')
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
  return `${clean || 'Table'}.csv`
}
