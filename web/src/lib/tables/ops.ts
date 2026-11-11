/**
 * Tables: the pure half of the write path. `validateOps` checks a batch
 * against the table's columns before it goes to `apply_data_ops` (migration
 * 520 checks the types again, as a floor): every value is coerced with the
 * custom fields' own `coerceCustomValue`, so a column takes what a custom
 * field of its type takes, and stores it the same way. `planUndo` turns one
 * logged change back into the ops that take it back.
 *
 * The undo rule is the deals' (src/lib/crm/deals.ts undoDealEvent): each
 * field goes back to its `from` value unless it has changed since, and then
 * the newer value stays and the result says so. A batch that made the table
 * is not undone here: archiving the table is the person's own click.
 *
 * Client-safe: pure functions over plain objects.
 */
import {
  CUSTOM_FIELD_TYPES,
  cleanOptions,
  coerceCustomValue,
  customFieldKey,
  type CustomFieldValue,
} from '@/lib/crm/custom-fields'
import {
  DATA_TABLE_VISIBILITIES,
  TABLE_LIMITS,
  type DataChange,
  type DataColumn,
  type DataColumnType,
  type DataOp,
  type DataTable,
  type NewRow,
} from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** The columns a batch sees: every one the table has, deleted ones too (their keys stay taken). */
type ColumnState = Pick<DataColumn, 'key' | 'label' | 'field_type' | 'options' | 'deleted_at'>

/**
 * A key for a new column: its label's slug, made unique against every key
 * the table has used (a deleted column keeps its key, so its undo can bring
 * it back). Empty when the label has nothing usable.
 */
export function newColumnKey(label: string, taken: Iterable<string>): string {
  const base = customFieldKey(label)
  if (!base) return ''
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`
    const key = `${base.slice(0, 40 - suffix.length).replace(/_+$/, '')}${suffix}`
    if (!used.has(key)) return key
  }
  return ''
}

/** A create_column op as a writer may send it: the key is made here when it isn't given. */
export type DataOpInput =
  | Exclude<DataOp, { op: 'create_column' }>
  | { op: 'create_column'; key?: string; label: string; field_type: DataColumnType; options?: string[] }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isUuid) ? [...new Set(v as string[])] : null)

/** Coerce a values object against the live columns: the stored form of each, null to clear. */
function checkValues(columns: Map<string, ColumnState>, raw: unknown): Checked<Record<string, CustomFieldValue>> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('values must be an object of column keys')
  const out: Record<string, CustomFieldValue> = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const col = columns.get(key)
    if (!col || col.deleted_at) return fail(`No column "${key}" in this table.`)
    const coerced = coerceCustomValue(col, v)
    if (!coerced.ok) return fail(coerced.error)
    out[key] = coerced.value
  }
  return { ok: true, value: out }
}

/**
 * Checks a batch against the table and its columns, in order (a column made
 * earlier in the batch takes values later in it), and returns it in the form
 * the RPC takes: keys made, values coerced, text trimmed. The first problem
 * refuses the whole batch, as the RPC would. An archived table (`archived`)
 * takes nothing but its restore until that op has run.
 */
export function validateOps(columns: readonly ColumnState[], ops: unknown, opts: { archived?: boolean } = {}): Checked<DataOp[]> {
  if (!Array.isArray(ops)) return fail('ops must be a list')
  if (ops.length === 0) return fail('Nothing to change.')
  if (ops.length > TABLE_LIMITS.opsPerBatch) return fail(`At most ${TABLE_LIMITS.opsPerBatch} changes in one batch.`)
  const cols = new Map(columns.map((c) => [c.key, { ...c }]))
  const out: DataOp[] = []
  let archived = !!opts.archived
  // Rows a batch inserts, archives or restores, across all its ops.
  let rowsTotal = 0
  const countRows = (n: number) => (rowsTotal += n) <= TABLE_LIMITS.rowsPerBatch

  for (const raw of ops as unknown[]) {
    if (!raw || typeof raw !== 'object') return fail('Each op must be an object.')
    const op = raw as Record<string, unknown>
    if (op.op === 'restore_table') archived = false
    else if (op.op === 'archive_table') archived = true
    else if (archived) return fail('The table is archived. Restore it first.')
    switch (op.op) {
      case 'update_table': {
        const next: Extract<DataOp, { op: 'update_table' }> = { op: 'update_table' }
        if ('name' in op) {
          const name = str(op.name).trim()
          if (!name) return fail('A table needs a name.')
          if (name.length > TABLE_LIMITS.name) return fail(`A table's name is at most ${TABLE_LIMITS.name} characters.`)
          next.name = name
        }
        if ('icon' in op) {
          const icon = op.icon === null ? null : str(op.icon).trim() || null
          if (icon && icon.length > TABLE_LIMITS.icon) return fail('That icon is too long.')
          next.icon = icon
        }
        if ('description' in op) {
          const description = op.description === null ? null : str(op.description).trim() || null
          if (description && description.length > TABLE_LIMITS.description) return fail(`A description is at most ${TABLE_LIMITS.description} characters.`)
          next.description = description
        }
        if ('visibility' in op) {
          if (!(DATA_TABLE_VISIBILITIES as readonly unknown[]).includes(op.visibility)) return fail('visibility is workspace or private')
          next.visibility = op.visibility as 'workspace' | 'private'
        }
        if (Object.keys(next).length === 1) return fail('update_table changes nothing.')
        out.push(next)
        break
      }
      case 'archive_table':
      case 'restore_table':
        out.push({ op: op.op })
        break
      case 'create_column': {
        const label = str(op.label).trim().slice(0, TABLE_LIMITS.label)
        if (!label) return fail('A column needs a name.')
        if (!(CUSTOM_FIELD_TYPES as readonly unknown[]).includes(op.field_type)) {
          return fail(`A column is one of: ${CUSTOM_FIELD_TYPES.join(', ')}.`)
        }
        const fieldType = op.field_type as DataColumnType
        let key = str(op.key)
        if (key) {
          if (customFieldKey(key) !== key) return fail(`"${key}" is not a column key (lowercase letters, numbers and _).`)
          if (cols.has(key)) return fail(`A column with key "${key}" already exists.`)
        } else {
          key = newColumnKey(label, cols.keys())
          if (!key) return fail('A column needs a name with a letter or number in it.')
        }
        const options = fieldType === 'select' ? cleanOptions(Array.isArray(op.options) ? (op.options as string[]) : []) : []
        cols.set(key, { key, label, field_type: fieldType, options, deleted_at: null })
        out.push({ op: 'create_column', key, label, field_type: fieldType, ...(fieldType === 'select' ? { options } : {}) })
        break
      }
      case 'update_column': {
        const key = str(op.key)
        const col = cols.get(key)
        if (!col || col.deleted_at) return fail(`No column "${key}" in this table.`)
        const next: Extract<DataOp, { op: 'update_column' }> = { op: 'update_column', key }
        if ('label' in op) {
          const label = str(op.label).trim().slice(0, TABLE_LIMITS.label)
          if (!label) return fail('A column needs a name.')
          next.label = label
          col.label = label
        }
        if ('options' in op) {
          if (col.field_type !== 'select') return fail(`${col.label} has no options.`)
          const options = cleanOptions(Array.isArray(op.options) ? (op.options as string[]) : [])
          next.options = options
          col.options = options
        }
        if (Object.keys(next).length === 2) return fail('update_column changes nothing.')
        out.push(next)
        break
      }
      case 'delete_column':
      case 'restore_column': {
        const key = str(op.key)
        const col = cols.get(key)
        if (!col) return fail(`No column "${key}" in this table.`)
        col.deleted_at = op.op === 'delete_column' ? 'now' : null
        out.push({ op: op.op, key })
        break
      }
      case 'reorder_columns': {
        const keys = Array.isArray(op.keys) ? (op.keys as unknown[]).map(str) : null
        if (!keys || new Set(keys).size !== keys.length) return fail('reorder_columns takes each column key once.')
        for (const k of keys) if (!cols.get(k) || cols.get(k)!.deleted_at) return fail(`No column "${k}" in this table.`)
        out.push({ op: 'reorder_columns', keys })
        break
      }
      case 'insert_rows': {
        const rows = op.rows
        if (!Array.isArray(rows) || rows.length === 0) return fail('insert_rows needs at least one row.')
        if (rows.length > TABLE_LIMITS.rowsPerOp) return fail(`At most ${TABLE_LIMITS.rowsPerOp} rows at once.`)
        if (!countRows(rows.length)) return fail(`At most ${TABLE_LIMITS.rowsPerBatch} rows in one batch.`)
        const clean: NewRow[] = []
        for (const r of rows as unknown[]) {
          const row = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
          if (row.id !== undefined && !isUuid(row.id)) return fail('A new row id must be a uuid.')
          const title = str(row.title).trim()
          if (title.length > TABLE_LIMITS.title) return fail(`A row's name is at most ${TABLE_LIMITS.title} characters.`)
          const values = checkValues(cols, row.values)
          if (!values.ok) return values
          // A new row has nothing to clear.
          const set = Object.fromEntries(Object.entries(values.value).filter(([, v]) => v !== null))
          clean.push({ ...(row.id ? { id: row.id as string } : {}), title, ...(Object.keys(set).length ? { values: set } : {}) })
        }
        out.push({ op: 'insert_rows', rows: clean })
        break
      }
      case 'update_row': {
        if (!isUuid(op.row_id)) return fail('update_row needs a row_id.')
        const next: Extract<DataOp, { op: 'update_row' }> = { op: 'update_row', row_id: op.row_id }
        if ('title' in op) {
          const title = op.title === null ? '' : str(op.title).trim()
          if (title.length > TABLE_LIMITS.title) return fail(`A row's name is at most ${TABLE_LIMITS.title} characters.`)
          next.title = title
        }
        if ('values' in op) {
          const values = checkValues(cols, op.values)
          if (!values.ok) return values
          if (Object.keys(values.value).length) next.values = values.value
        }
        if (!('title' in next) && !next.values) return fail('update_row changes nothing.')
        out.push(next)
        break
      }
      case 'archive_rows':
      case 'restore_rows': {
        const rowIds = ids(op.row_ids)
        if (!rowIds || rowIds.length === 0) return fail(`${op.op} needs row_ids.`)
        if (rowIds.length > TABLE_LIMITS.rowsPerOp) return fail(`At most ${TABLE_LIMITS.rowsPerOp} rows at once.`)
        if (!countRows(rowIds.length)) return fail(`At most ${TABLE_LIMITS.rowsPerBatch} rows in one batch.`)
        out.push({ op: op.op, row_ids: rowIds })
        break
      }
      case 'move_row': {
        if (!isUuid(op.row_id)) return fail('move_row needs a row_id.')
        if (typeof op.position === 'string') {
          if (!/^-?[0-9]+(\.[0-9]+)?$/.test(op.position)) return fail('position must be a number.')
          out.push({ op: 'move_row', row_id: op.row_id, position: op.position })
        } else {
          const after = op.after_row_id ?? null
          if (after !== null && !isUuid(after)) return fail('after_row_id must be a row id or null.')
          if (after === op.row_id) return fail('A row can not move after itself.')
          out.push({ op: 'move_row', row_id: op.row_id, after_row_id: after })
        }
        break
      }
      default:
        return fail(`Unknown op "${String(op.op)}".`)
    }
  }
  return { ok: true, value: out }
}

// ── Undo ────────────────────────────────────────────────────────────────────

/** What an undo reads about the table now: the parts the change touched. */
export interface UndoState {
  table: Pick<DataTable, 'name' | 'icon' | 'description' | 'visibility' | 'archived_at'>
  /** The undoer owns the table (only an owner changes who sees it, or archives a private one). */
  isOwner: boolean
  /** Every column, deleted ones too. */
  columns: readonly Pick<DataColumn, 'key' | 'label' | 'field_type' | 'options' | 'deleted_at' | 'position'>[]
  /** The rows the change touched, as they are now (position as exact text). */
  rows: ReadonlyMap<string, UndoRow>
  /**
   * For a column whose options the change set: the rows of the table holding
   * one of the options an undo could drop, with that value
   * (optionsAnUndoCouldDrop). A touched row among them is read from `rows`
   * instead, as the undo leaves it.
   */
  optionUses?: ReadonlyMap<string, ReadonlyArray<{ rowId: string; value: string }>>
}

type UndoRow = { title: string; custom_fields: Record<string, CustomFieldValue>; archived_at: string | null; position: string }

export type UndoPlan =
  | { ok: true; ops: DataOp[]; restored: string[]; kept: string[] }
  | { ok: false; error: string }

const same = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown) => (v === undefined ? null : v)
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'number' || typeof y === 'number') return x !== null && y !== null && Number(x) === Number(y)
  return JSON.stringify(x) === JSON.stringify(y)
}

const quote = (s: string) => `“${s.length > 40 ? `${s.slice(0, 39)}…` : s || 'Untitled'}”`

/** The options going from `now` to `from` would drop. */
const dropped = (now: readonly string[], from: readonly string[]) => now.filter((o) => !from.includes(o))

/**
 * The ops that take `change` back, given the table as it is now: in reverse
 * order, each part only where nothing has changed it since. The walk keeps a
 * working copy of the table, its columns and the touched rows, and applies
 * each planned op to it, so every entry is checked against what the undo so
 * far leaves: a title renamed A→B→C in one batch goes back to A, and an
 * archive then a restore of one row ends where it began. `restored` and
 * `kept` say what, in words.
 */
export function planUndo(change: Pick<DataChange, 'changes' | 'undo_of' | 'undone_at'>, state: UndoState): UndoPlan {
  if (change.undo_of) return { ok: false, error: 'That change was itself an undo.' }
  if (change.undone_at) return { ok: false, error: 'That change was already undone.' }
  const entries = Array.isArray(change.changes) ? change.changes : []
  if (entries.some((e) => e?.op === 'create_table')) {
    return { ok: false, error: 'That change made the table. Archive the table instead if it should not exist.' }
  }
  // The working copy: the table as it is once the ops planned so far run.
  const table = { ...state.table }
  const cols = new Map(state.columns.map((c) => [c.key, { ...c, options: [...(c.options ?? [])] }]))
  const rows = new Map([...state.rows].map(([id, r]) => [id, { ...r, custom_fields: { ...(r.custom_fields ?? {}) } }]))
  const colName = (key: string) => quote(cols.get(key)?.label ?? key)
  const rowName = (id: string) => quote(rows.get(id)?.title ?? '')
  const liveKeys = () => [...cols.values()].filter((c) => !c.deleted_at).sort((a, b) => a.position - b.position).map((c) => c.key)
  const inUse = (key: string, options: readonly string[]) => {
    if (!options.length) return false
    for (const u of state.optionUses?.get(key) ?? []) if (!rows.has(u.rowId) && options.includes(u.value)) return true
    for (const r of rows.values()) {
      const v = r.custom_fields[key]
      if (typeof v === 'string' && options.includes(v)) return true
    }
    return false
  }
  const ops: DataOp[] = []
  const restored: string[] = []
  const kept: string[] = []

  for (const e of [...entries].reverse()) {
    switch (e?.op) {
      case 'update_table': {
        const back: Extract<DataOp, { op: 'update_table' }> = { op: 'update_table' }
        for (const [field, c] of Object.entries(e.fields ?? {})) {
          if (!c) continue
          const f = field as 'name' | 'icon' | 'description' | 'visibility'
          if (f === 'visibility' && !state.isOwner) {
            kept.push('who sees the table (only its owner changes that)')
          } else if (!same(table[f] ?? null, c.to)) {
            kept.push(`the table's ${field} (changed since)`)
          } else {
            ;(back as Record<string, unknown>)[f] = c.from
            ;(table as Record<string, unknown>)[f] = c.from
            restored.push(`the table's ${field}`)
          }
        }
        if (Object.keys(back).length > 1) ops.push(back)
        break
      }
      case 'archive_table':
      case 'restore_table': {
        const archivedNow = !!table.archived_at
        if (table.visibility === 'private' && !state.isOwner) {
          // Where a private table lives is its owner's call (520).
          kept.push('the table’s archive (only its owner archives a private table)')
        } else if (archivedNow === (e.op === 'archive_table')) {
          ops.push({ op: e.op === 'archive_table' ? 'restore_table' : 'archive_table' })
          table.archived_at = e.op === 'archive_table' ? null : 'now'
          restored.push(e.op === 'archive_table' ? 'the table, out of the archive' : 'the table, back in the archive')
        } else {
          kept.push('the table’s archive (changed since)')
        }
        break
      }
      case 'create_column': {
        const col = cols.get(e.key)
        if (col && !col.deleted_at) {
          ops.push({ op: 'delete_column', key: e.key })
          col.deleted_at = 'now'
          restored.push(`column ${colName(e.key)} removed`)
        } else {
          kept.push(`column ${colName(e.key)} (already gone)`)
        }
        break
      }
      case 'update_column': {
        const col = cols.get(e.key)
        if (!col || col.deleted_at) {
          kept.push(`column ${colName(e.key)} (deleted since)`)
          break
        }
        const back: Extract<DataOp, { op: 'update_column' }> = { op: 'update_column', key: e.key }
        if (e.fields?.label) {
          if (same(col.label, e.fields.label.to)) {
            back.label = e.fields.label.from
            restored.push(`column ${quote(e.fields.label.from)}'s name`)
          } else kept.push(`column ${colName(e.key)}'s name (changed since)`)
        }
        if (e.fields?.options) {
          const from = e.fields.options.from ?? []
          if (!same(col.options, e.fields.options.to)) {
            kept.push(`column ${colName(e.key)}'s options (changed since)`)
          } else if (inUse(e.key, dropped(col.options, from))) {
            // The database refuses to drop an option a row still holds (520).
            kept.push(`column ${colName(e.key)}'s options (still in use)`)
          } else {
            back.options = from
            restored.push(`column ${colName(e.key)}'s options`)
          }
        }
        if (back.label !== undefined) col.label = back.label
        if (back.options) col.options = [...back.options]
        if (Object.keys(back).length > 2) ops.push(back)
        break
      }
      case 'delete_column':
      case 'restore_column': {
        const col = cols.get(e.key)
        const deletedNow = !!col?.deleted_at
        if (col && deletedNow === (e.op === 'delete_column')) {
          ops.push({ op: e.op === 'delete_column' ? 'restore_column' : 'delete_column', key: e.key })
          col.deleted_at = e.op === 'delete_column' ? null : 'now'
          restored.push(`column ${colName(e.key)} ${e.op === 'delete_column' ? 'back' : 'removed again'}`)
        } else {
          kept.push(`column ${colName(e.key)} (changed since)`)
        }
        break
      }
      case 'reorder_columns': {
        const live = liveKeys()
        if (same(live, e.to)) {
          const keys = e.from.filter((k) => live.includes(k))
          ops.push({ op: 'reorder_columns', keys })
          // As 520 orders them: the named ones first, the rest after in their order.
          ;[...keys, ...live.filter((k) => !keys.includes(k))].forEach((k, i) => (cols.get(k)!.position = i))
          restored.push('the column order')
        } else {
          kept.push('the column order (changed since)')
        }
        break
      }
      case 'insert_rows': {
        const live = (e.row_ids ?? []).filter((id) => rows.has(id) && !rows.get(id)!.archived_at)
        if (live.length) {
          ops.push({ op: 'archive_rows', row_ids: live })
          for (const id of live) rows.get(id)!.archived_at = 'now'
          restored.push(live.length === 1 ? `row ${rowName(live[0])} archived` : `${live.length} new rows archived`)
        }
        if (live.length < (e.row_ids ?? []).length) kept.push(`${(e.row_ids ?? []).length - live.length} of the new rows (already archived)`)
        break
      }
      case 'update_row': {
        const row = rows.get(e.row_id)
        if (!row) {
          kept.push('a row that is gone')
          break
        }
        const back: Extract<DataOp, { op: 'update_row' }> = { op: 'update_row', row_id: e.row_id }
        const values: Record<string, CustomFieldValue> = {}
        for (const [field, c] of Object.entries(e.fields ?? {})) {
          if (!c) continue
          if (field === 'title') {
            if (same(row.title, c.to)) {
              back.title = String(c.from ?? '')
              restored.push(`the name of ${quote(back.title)}`)
            } else kept.push(`the name of ${rowName(e.row_id)} (changed since)`)
            continue
          }
          if (!field.startsWith('values.')) continue
          const key = field.slice('values.'.length)
          const col = cols.get(key)
          const label = `${colName(key)} on ${rowName(e.row_id)}`
          if (!col || col.deleted_at) {
            kept.push(`${label} (column deleted since)`)
          } else if (!same(row.custom_fields?.[key], c.to)) {
            kept.push(`${label} (changed since)`)
          } else if (c.from !== null && c.from !== undefined && !coerceCustomValue(col, c.from).ok) {
            kept.push(`${label} (its old value no longer fits the column)`)
          } else {
            values[key] = (c.from ?? null) as CustomFieldValue
            restored.push(label)
          }
        }
        if (Object.keys(values).length) back.values = values
        if (back.title !== undefined) row.title = back.title
        for (const [k, v] of Object.entries(values)) {
          if (v === null) delete row.custom_fields[k]
          else row.custom_fields[k] = v
        }
        if ('title' in back || back.values) ops.push(back)
        break
      }
      case 'archive_rows':
      case 'restore_rows': {
        const archived = e.op === 'archive_rows'
        const back = (e.row_ids ?? []).filter((id) => rows.has(id) && !!rows.get(id)!.archived_at === archived)
        if (back.length) {
          ops.push({ op: archived ? 'restore_rows' : 'archive_rows', row_ids: back })
          for (const id of back) rows.get(id)!.archived_at = archived ? null : 'now'
          restored.push(`${back.length} ${back.length === 1 ? 'row' : 'rows'} ${archived ? 'out of the archive' : 'archived again'}`)
        }
        const left = (e.row_ids ?? []).length - back.length
        if (left > 0) kept.push(`${left} ${left === 1 ? 'row' : 'rows'} (changed since)`)
        break
      }
      case 'move_row': {
        const row = rows.get(e.row_id)
        if (row && row.position === e.to) {
          ops.push({ op: 'move_row', row_id: e.row_id, position: e.from })
          row.position = e.from
          restored.push(`the place of ${rowName(e.row_id)}`)
        } else {
          kept.push(`the place of ${rowName(e.row_id)} (moved since)`)
        }
        break
      }
      default:
        break
    }
  }
  if (!ops.length) return { ok: false, error: 'Nothing to restore: everything it changed has changed again since.' }
  // An archived table takes no change but its restore (520): walk the plan as the database will.
  let archived = !!state.table.archived_at
  for (const op of ops) {
    if (op.op === 'restore_table') archived = false
    else if (op.op === 'archive_table') archived = true
    else if (archived) return { ok: false, error: 'The table is archived. Restore it first, then undo.' }
  }
  return { ok: true, ops, restored, kept }
}

/** Per column, the options an undo of `change` could drop: what UndoState.optionUses reads. */
export function optionsAnUndoCouldDrop(change: Pick<DataChange, 'changes'>): Map<string, string[]> {
  const out = new Map<string, Set<string>>()
  for (const e of Array.isArray(change.changes) ? change.changes : []) {
    if (e?.op !== 'update_column' || !e.fields?.options) continue
    const set = out.get(e.key) ?? new Set<string>()
    for (const o of dropped(e.fields.options.to ?? [], e.fields.options.from ?? [])) set.add(o)
    out.set(e.key, set)
  }
  return new Map([...out].filter(([, v]) => v.size > 0).map(([k, v]) => [k, [...v]]))
}

/** The rows and columns a change touched: what an undo must read. */
export function touchedBy(change: Pick<DataChange, 'changes'>): { rowIds: string[] } {
  const rows = new Set<string>()
  for (const e of Array.isArray(change.changes) ? change.changes : []) {
    if (!e) continue
    if ('row_id' in e && isUuid(e.row_id)) rows.add(e.row_id)
    if ('row_ids' in e && Array.isArray(e.row_ids)) for (const id of e.row_ids) if (isUuid(id)) rows.add(id)
  }
  return { rowIds: [...rows] }
}
