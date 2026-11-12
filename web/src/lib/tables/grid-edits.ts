/**
 * Tables, phase 3: the grid's edits as write batches, and the table kept up
 * to date in the page (src/components/tables/table-grid.tsx).
 *
 *   planEdits         cell edits and new rows → one batch of ops, each value
 *                     in its stored form (coerceCustomValue, as the server
 *                     does), and the cells that don't fit, with why
 *   applyOpsToRows    a batch applied to the rows in hand: the optimistic
 *                     write, shown before the server answers
 *   applyChanges      someone's logged changes (data_change) applied to the
 *                     rows in hand: realtime, and the catch-up after a 409
 *   rebaseOps         a refused batch's ops minus what someone else changed
 *                     since, so it can go again on the new version
 *   pastedValue       pasted text read for a column: a member's name, a
 *                     linked record's name, a date as spreadsheets write it
 *   clipboardText     a value as the clipboard takes it
 *
 * Client-safe and pure.
 */
import { coerceCustomValue, formatFieldValue, isIsoDate, type CustomFieldValue } from '@/lib/crm/custom-field-types'
import { requiredWhenProblem, validateOps } from './ops'
import { isComputedType, TABLE_LIMITS, type DataChange, type DataColumn, type DataOp, type DataRow, type NewRow } from './types'

/** The title column's key in the grid (a row's title is not a custom field). */
export const TITLE_KEY = 'title' as const

/** One cell's new value as a person gave it (typed text, a picker's choice, a pasted cell). */
export interface CellEdit {
  rowId: string
  /** A column key, or TITLE_KEY. */
  key: string
  value: unknown
}

export interface CellError {
  rowId: string
  key: string
  error: string
}

type Columns = readonly Pick<DataColumn, 'key' | 'label' | 'field_type' | 'options' | 'config' | 'deleted_at'>[]

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The column a row's required-when rule names as missing (requiredWhenProblem
 * reads all columns; asked one rule at a time, the first that fails is the cell).
 */
export function requiredWhenCell(columns: Columns, row: { title: string; values: Record<string, unknown> }, changed: ReadonlySet<string> | 'all'): CellError | null {
  for (const col of columns) {
    const rule = col.config?.required_when
    if (!rule || col.deleted_at) continue
    const on = columns.find((c) => c.key === rule.key)
    if (!on) continue
    const problem = requiredWhenProblem([col, on], row, changed)
    if (problem) return { rowId: '', key: col.key, error: problem }
  }
  return null
}

/**
 * Cell edits on rows in hand, and new rows, as one batch: one update_row per
 * row (only what changed), one insert_rows for the new ones. A cell whose
 * value doesn't fit its column is left out with its error; a row that would
 * break a required-when rule is left out whole, its error on the cell it
 * needs. `ops` is what validateOps returns: the server stores exactly it.
 */
export function planEdits(
  columns: Columns,
  rowsById: ReadonlyMap<string, Pick<DataRow, 'id' | 'title' | 'custom_fields'>>,
  edits: readonly CellEdit[],
  newRows: ReadonlyArray<{ id: string; title?: string; values?: Record<string, unknown> }> = [],
): { ops: DataOp[]; errors: CellError[] } {
  const live = columns.filter((c) => !c.deleted_at)
  const byKey = new Map(live.map((c) => [c.key, c]))
  const errors: CellError[] = []
  const coerce = (rowId: string, key: string, raw: unknown): { ok: true; value: CustomFieldValue | string } | { ok: false } => {
    if (key === TITLE_KEY) {
      const title = raw === null || raw === undefined ? '' : String(raw).trim()
      if (title.length > TABLE_LIMITS.title) {
        errors.push({ rowId, key, error: `A row's name is at most ${TABLE_LIMITS.title} characters.` })
        return { ok: false }
      }
      return { ok: true, value: title }
    }
    const col = byKey.get(key)
    if (!col) {
      errors.push({ rowId, key, error: 'That column is gone.' })
      return { ok: false }
    }
    if (isComputedType(col.field_type)) {
      errors.push({ rowId, key, error: `${col.label} is worked out from other columns, so it can't be set.` })
      return { ok: false }
    }
    const c = coerceCustomValue({ ...col, field_type: col.field_type }, raw)
    if (!c.ok) {
      errors.push({ rowId, key, error: c.error })
      return { ok: false }
    }
    return { ok: true, value: c.value }
  }

  // Per row, in the order first edited.
  const perRow = new Map<string, { title?: string; values: Record<string, CustomFieldValue> }>()
  for (const e of edits) {
    const row = rowsById.get(e.rowId)
    if (!row) continue
    const c = coerce(e.rowId, e.key, e.value)
    if (!c.ok) continue
    const entry = perRow.get(e.rowId) ?? perRow.set(e.rowId, { values: {} }).get(e.rowId)!
    if (e.key === TITLE_KEY) {
      if (c.value === (row.title ?? '')) delete entry.title
      else entry.title = c.value as string
    } else if (same(row.custom_fields?.[e.key], c.value)) {
      delete entry.values[e.key]
    } else {
      entry.values[e.key] = c.value as CustomFieldValue
    }
  }

  const ops: DataOp[] = []
  const inserts: NewRow[] = []
  for (const nr of newRows) {
    const values: Record<string, CustomFieldValue> = {}
    let title = ''
    if (nr.title !== undefined) {
      const c = coerce(nr.id, TITLE_KEY, nr.title)
      if (c.ok) title = c.value as string
    }
    for (const [key, raw] of Object.entries(nr.values ?? {})) {
      const c = coerce(nr.id, key, raw)
      if (c.ok && c.value !== null) values[key] = c.value as CustomFieldValue
    }
    const problem = requiredWhenCell(live, { title, values }, 'all')
    if (problem) {
      errors.push({ ...problem, rowId: nr.id })
      continue
    }
    inserts.push({ id: nr.id, title, ...(Object.keys(values).length ? { values } : {}) })
  }
  if (inserts.length) ops.push({ op: 'insert_rows', rows: inserts })

  for (const [rowId, entry] of perRow) {
    const changed = Object.keys(entry.values)
    if (entry.title === undefined && !changed.length) continue
    const row = rowsById.get(rowId)!
    const merged: Record<string, unknown> = { ...(row.custom_fields ?? {}) }
    for (const [k, v] of Object.entries(entry.values)) {
      if (v === null) delete merged[k]
      else merged[k] = v
    }
    const problem = requiredWhenCell(live, { title: entry.title ?? row.title ?? '', values: merged }, new Set(changed))
    if (problem) {
      errors.push({ ...problem, rowId })
      continue
    }
    ops.push({ op: 'update_row', row_id: rowId, ...(entry.title !== undefined ? { title: entry.title } : {}), ...(changed.length ? { values: entry.values } : {}) })
  }
  if (!ops.length) return { ops, errors }
  const checked = validateOps(columns, ops)
  if (!checked.ok) return { ops: [], errors: [...errors, { rowId: '', key: '', error: checked.error }] }
  return { ops: checked.value, errors }
}

/**
 * Ops as the batches the server takes: at most opsPerBatch ops, rowsPerOp
 * rows an op and rowsPerBatch rows a batch (a huge paste goes as several,
 * in order).
 */
export function chunkOps(ops: readonly DataOp[], limits: { ops: number; rowsPerOp: number; rowsPerBatch: number } = { ops: TABLE_LIMITS.opsPerBatch, rowsPerOp: TABLE_LIMITS.rowsPerOp, rowsPerBatch: TABLE_LIMITS.rowsPerBatch }): DataOp[][] {
  const split: DataOp[] = []
  for (const op of ops) {
    if (op.op === 'insert_rows' && op.rows.length > limits.rowsPerOp) {
      for (let i = 0; i < op.rows.length; i += limits.rowsPerOp) split.push({ op: 'insert_rows', rows: op.rows.slice(i, i + limits.rowsPerOp) })
    } else if ((op.op === 'archive_rows' || op.op === 'restore_rows') && op.row_ids.length > limits.rowsPerOp) {
      for (let i = 0; i < op.row_ids.length; i += limits.rowsPerOp) split.push({ op: op.op, row_ids: op.row_ids.slice(i, i + limits.rowsPerOp) })
    } else split.push(op)
  }
  const rowsOf = (op: DataOp) => (op.op === 'insert_rows' ? op.rows.length : op.op === 'archive_rows' || op.op === 'restore_rows' ? op.row_ids.length : 0)
  const out: DataOp[][] = []
  let batch: DataOp[] = []
  let rows = 0
  for (const op of split) {
    const n = rowsOf(op)
    if (batch.length && (batch.length >= limits.ops || rows + n > limits.rowsPerBatch)) {
      out.push(batch)
      batch = []
      rows = 0
    }
    batch.push(op)
    rows += n
  }
  if (batch.length) out.push(batch)
  return out
}

/** The row ids a batch's ops name. */
export function opRowIds(ops: readonly DataOp[]): Set<string> {
  const ids = new Set<string>()
  for (const op of ops) {
    if (op.op === 'update_row' || op.op === 'move_row') {
      ids.add(op.row_id)
    } else if (op.op === 'insert_rows') {
      for (const r of op.rows) if (r.id) ids.add(r.id)
    } else if (op.op === 'archive_rows' || op.op === 'restore_rows') {
      for (const id of op.row_ids) ids.add(id)
    }
  }
  return ids
}

const nowIso = () => new Date().toISOString()

function withValues(row: DataRow, title: string | undefined, values: Record<string, unknown> | undefined): DataRow {
  if (title === undefined && !values) return row
  const custom = { ...(row.custom_fields ?? {}) }
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v === null || v === undefined) delete custom[k]
    else custom[k] = v as CustomFieldValue
  }
  return { ...row, ...(title !== undefined ? { title } : {}), custom_fields: custom, updated_at: nowIso() }
}

/**
 * A batch applied to the rows in hand, as the server will apply it: edits
 * merged (null clears), new rows at the end, archived rows gone. Column ops
 * are the caller's (they change the table, not the rows), except a deleted
 * column's values, which stay in the rows as the database keeps them.
 */
export function applyOpsToRows(rows: readonly DataRow[], ops: readonly DataOp[], tableId: string): DataRow[] {
  let out = rows as DataRow[]
  let copied = false
  const copy = () => {
    if (!copied) {
      out = [...out]
      copied = true
    }
  }
  const index = () => new Map(out.map((r, i) => [r.id, i]))
  let at = index()
  for (const op of ops) {
    if (op.op === 'update_row') {
      const i = at.get(op.row_id)
      if (i === undefined) continue
      copy()
      out[i] = withValues(out[i], op.title, op.values)
    } else if (op.op === 'insert_rows') {
      copy()
      const last = out.length ? Number(out[out.length - 1].position) || out.length : 0
      op.rows.forEach((r, n) => {
        const id = r.id ?? `local-${out.length}-${n}`
        out.push({ id, table_id: tableId, title: r.title ?? '', custom_fields: { ...(r.values ?? {}) }, position: last + n + 1, archived_at: null, created_at: nowIso(), updated_at: nowIso() })
      })
      at = index()
    } else if (op.op === 'archive_rows') {
      const gone = new Set(op.row_ids)
      if (!out.some((r) => gone.has(r.id))) continue
      out = out.filter((r) => !gone.has(r.id))
      copied = true
      at = index()
    }
  }
  return out
}

/** What applying someone's changes needs read from the server. */
export interface ChangeNeeds {
  /** Rows to read (made, brought back or moved). */
  rowIds: string[]
  /** The columns changed: read the table again. */
  columns: boolean
  /** The table's own fields changed (name, who sees it). */
  table: boolean
  /** A type change the log summarised (its values stay on the server): read the rows again. */
  allRows: boolean
}

/**
 * Logged changes (oldest first) applied to the rows in hand: edits and type
 * changes take their `to` values, archived rows go, and what the log can't
 * carry (a new row's values, a moved row's place, a column's definition) is
 * listed to read. A row not in hand is skipped: it's read when it's reached.
 */
export function applyChanges(rows: readonly DataRow[], changes: readonly Pick<DataChange, 'changes'>[]): { rows: DataRow[]; needs: ChangeNeeds } {
  let out = [...rows]
  const at = () => new Map(out.map((r, i) => [r.id, i]))
  let index = at()
  const needs: ChangeNeeds = { rowIds: [], columns: false, table: false, allRows: false }
  const want = (id: string) => {
    if (!needs.rowIds.includes(id)) needs.rowIds.push(id)
  }
  for (const change of changes) {
    for (const e of Array.isArray(change.changes) ? change.changes : []) {
      switch (e?.op) {
        case 'update_row': {
          const i = index.get(e.row_id)
          if (i === undefined) break
          let title: string | undefined
          const values: Record<string, unknown> = {}
          for (const [field, c] of Object.entries(e.fields ?? {})) {
            if (!c) continue
            if (field === TITLE_KEY) title = String(c.to ?? '')
            else if (field.startsWith('values.')) values[field.slice('values.'.length)] = c.to ?? null
          }
          out[i] = withValues(out[i], title, Object.keys(values).length ? values : undefined)
          break
        }
        case 'change_column_type': {
          if (!Object.keys(e.values ?? {}).length && (e.value_count ?? 0) > 0) needs.allRows = true
          for (const [rowId, c] of Object.entries(e.values ?? {})) {
            const i = index.get(rowId)
            if (i !== undefined && c) out[i] = withValues(out[i], undefined, { [e.key]: c.to ?? null })
          }
          needs.columns = true
          break
        }
        case 'archive_rows': {
          const gone = new Set(e.row_ids ?? [])
          out = out.filter((r) => !gone.has(r.id))
          index = at()
          break
        }
        case 'insert_rows':
        case 'restore_rows':
          for (const id of e.row_ids ?? []) want(id)
          break
        case 'move_row':
          want(e.row_id)
          break
        case 'create_column':
        case 'update_column':
        case 'delete_column':
        case 'restore_column':
        case 'reorder_columns':
          needs.columns = true
          break
        case 'update_table':
        case 'archive_table':
        case 'restore_table':
          needs.table = true
          break
        default:
          break
      }
    }
  }
  return { rows: out, needs }
}

/** Rows read from the server merged into the rows in hand: replaced by id, new ones placed by position. */
export function mergeRows(rows: readonly DataRow[], fresh: readonly DataRow[]): DataRow[] {
  if (!fresh.length) return rows as DataRow[]
  const byId = new Map(fresh.map((r) => [r.id, r]))
  const kept = rows.filter((r) => !byId.has(r.id))
  const live = fresh.filter((r) => !r.archived_at)
  if (!live.length) return kept
  const all = [...kept, ...live]
  return all.sort((a, b) => Number(a.position) - Number(b.position) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * A refused batch's ops minus what someone else changed meanwhile (their
 * changes, oldest first): a cell they edited keeps their value, a row they
 * archived takes nothing, a column whose type they changed takes nothing.
 * `dropped` counts the cells left out, to tell the person.
 */
export function rebaseOps(ops: readonly DataOp[], theirs: readonly Pick<DataChange, 'changes'>[]): { ops: DataOp[]; dropped: number } {
  const touched = new Map<string, Set<string>>()
  const archived = new Set<string>()
  const retyped = new Set<string>()
  const deleted = new Set<string>()
  for (const ch of theirs) {
    for (const e of Array.isArray(ch.changes) ? ch.changes : []) {
      if (e?.op === 'update_row') {
        const set = touched.get(e.row_id) ?? touched.set(e.row_id, new Set()).get(e.row_id)!
        for (const f of Object.keys(e.fields ?? {})) set.add(f)
      } else if (e?.op === 'archive_rows') for (const id of e.row_ids ?? []) archived.add(id)
      else if (e?.op === 'restore_rows') for (const id of e.row_ids ?? []) archived.delete(id)
      else if (e?.op === 'change_column_type') retyped.add(e.key)
      else if (e?.op === 'delete_column') deleted.add(e.key)
      else if (e?.op === 'restore_column') deleted.delete(e.key)
    }
  }
  let dropped = 0
  const out: DataOp[] = []
  for (const op of ops) {
    if (op.op === 'update_row') {
      const fields = touched.get(op.row_id)
      const cells = (op.title !== undefined ? 1 : 0) + Object.keys(op.values ?? {}).length
      if (archived.has(op.row_id)) {
        dropped += cells
        continue
      }
      const next: Extract<DataOp, { op: 'update_row' }> = { op: 'update_row', row_id: op.row_id }
      if (op.title !== undefined) {
        if (fields?.has(TITLE_KEY)) dropped += 1
        else next.title = op.title
      }
      const values: Record<string, CustomFieldValue> = {}
      for (const [k, v] of Object.entries(op.values ?? {})) {
        if (fields?.has(`values.${k}`) || retyped.has(k) || deleted.has(k)) dropped += 1
        else values[k] = v
      }
      if (Object.keys(values).length) next.values = values
      if (next.title !== undefined || next.values) out.push(next)
    } else if (op.op === 'archive_rows') {
      const ids = op.row_ids.filter((id) => !archived.has(id))
      if (ids.length) out.push({ ...op, row_ids: ids })
    } else if (op.op === 'insert_rows') {
      // New rows: their values in a retyped or deleted column don't go.
      const rows = op.rows.map((r): NewRow => {
        if (!r.values) return r
        const values = Object.fromEntries(Object.entries(r.values).filter(([k]) => !retyped.has(k) && !deleted.has(k)))
        dropped += Object.keys(r.values).length - Object.keys(values).length
        return { ...(r.id ? { id: r.id } : {}), ...(r.title !== undefined ? { title: r.title } : {}), ...(Object.keys(values).length ? { values } : {}) }
      })
      out.push({ op: 'insert_rows', rows })
    } else {
      out.push(op)
    }
  }
  return { ops: out, dropped }
}

/** "3/4/2026", "Mar 4, 2026", "2026-03-04T10:00" → "2026-03-04"; anything else as given. */
export function lenientDate(text: string): string {
  const s = text.trim()
  if (!s || isIsoDate(s)) return s
  const iso = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(s)?.[1]
  if (iso && isIsoDate(iso)) return iso
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (us) {
    const v = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
    return isIsoDate(v) ? v : s
  }
  const t = Date.parse(s)
  if (!Number.isNaN(t) && /[a-z]/i.test(s)) {
    const d = new Date(t)
    const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return isIsoDate(v) ? v : s
  }
  return s
}

/**
 * Pasted (or typed) text read for a column before coercion: a person by a
 * member's name, a linked record by a name `labels` knows, a date as
 * spreadsheets write it. Anything else goes as the text, and coercion says
 * whether it fits.
 */
export function pastedValue(
  col: Pick<DataColumn, 'field_type' | 'config'>,
  text: string,
  ctx: { members?: ReadonlyArray<{ id: string; name: string }>; labels?: Readonly<Record<string, string>> } = {},
): unknown {
  const s = text.trim()
  if (!s) return null
  const lower = s.toLowerCase()
  switch (col.field_type) {
    case 'person': {
      const m = ctx.members?.find((x) => x.name.trim().toLowerCase() === lower || x.id === s)
      return m ? m.id : s
    }
    case 'relation': {
      const parts = col.config?.multiple ? s.split(',').map((p) => p.trim()).filter(Boolean) : [s]
      const entries = Object.entries(ctx.labels ?? {})
      return parts.map((p) => entries.find(([id, label]) => id === p || label.trim().toLowerCase() === p.toLowerCase())?.[0] ?? p)
    }
    case 'date':
      return lenientDate(s)
    default:
      return s
  }
}

/** A value as the clipboard takes it: dates as YYYY-MM-DD (spreadsheets read that), the rest as the cell reads. */
export function clipboardText(fieldType: DataColumn['field_type'], value: unknown, labels?: Readonly<Record<string, string>>): string {
  if (fieldType === 'date' && typeof value === 'string') return value
  return formatFieldValue(isComputedType(fieldType) ? 'text' : fieldType, value, { labels })
}
