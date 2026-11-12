/**
 * Computed columns (Tables, phase 6): formulas (./formula.ts) and rollups.
 *
 * A rollup reads the records one of the table's relation columns links (a
 * table's rows, or contacts, deals, tasks…) and aggregates them: how many,
 * a field's sum, average, smallest or largest, the earliest or latest date,
 * or a list of them.
 *
 * Both are worked out when rows are READ, never stored: a rollup counts only
 * the linked records the reader can read (./computed-server.ts fences them
 * for that reader), so one person's count must never be written where
 * another reads it. A formula may name a rollup, so formulas are read-time
 * too, and `today()` is the reader's day.
 *
 * This module is the pure half, the same on the server and in the grid:
 *   planComputed   each computed column's result type, or its error (a
 *                  cycle, a column it names gone or of the wrong type), and
 *                  the order formulas run in;
 *   computeRow     one row's cells;
 *   aggregate      one rollup's value from the linked records' values;
 *   cellMatches / compareCells   a view's filter and sort on a computed
 *                  column (the server runs them in memory: store.ts).
 *
 * Client-safe and pure.
 */
import { CUSTOM_FIELD_TYPE_LABELS, isEmptyValue, type CustomFieldType } from '@/lib/crm/custom-field-types'
import type { RangeValue, RelativeDateValue, ViewFilter } from '@/lib/views/types'
import { checkFormula, parseFormula, runFormula, TITLE_REF, type CheckType, type FormulaNode, type FormulaType, type FormulaValue } from './formula'
import type { ComputedCell, ComputedInfo, ComputedResult, DataColumn, DataColumnType } from './types'

export const ROLLUP_FNS = ['count', 'sum', 'avg', 'min', 'max', 'earliest', 'latest', 'list'] as const
export type RollupFn = (typeof ROLLUP_FNS)[number]
export const isRollupFn = (v: unknown): v is RollupFn => typeof v === 'string' && (ROLLUP_FNS as readonly string[]).includes(v)

export const ROLLUP_FN_LABELS: Record<RollupFn, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Smallest',
  max: 'Largest',
  earliest: 'Earliest',
  latest: 'Latest',
  list: 'List',
}

/**
 * A record's own value under a key, never one its prototype lends: a column
 * keyed `constructor` reads as empty, not as Object's function.
 */
export function own(record: Readonly<Record<string, unknown>> | null | undefined, key: string): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

/** What each column type is called in a menu. */
export const COLUMN_TYPE_LABELS: Readonly<Record<DataColumnType, string>> = { ...CUSTOM_FIELD_TYPE_LABELS, formula: 'Formula', rollup: 'Rollup' }

/** The rollups that need a field of the linked records. */
const NEEDS_FIELD = new Set<RollupFn>(['sum', 'avg', 'min', 'max', 'earliest', 'latest'])
export const rollupNeedsField = (fn: RollupFn) => NEEDS_FIELD.has(fn)

/** A linked record's field, as a rollup reads it: a field's type, or `title` (its name). */
export type TargetFieldType = CustomFieldType | 'title'

/** Most linked records one cell's rollup reads. */
export const MAX_ROLLUP_LINKS = 100

type Column = Pick<DataColumn, 'key' | 'label' | 'field_type' | 'config'> & { deleted_at?: string | null }

const live = (c: Column) => !c.deleted_at

/**
 * A rollup's result type for its function and the linked field's type, or
 * why that pair doesn't go. With the field's type unknown (`unknown`: the
 * pure checks can't read another table), the function alone decides where it
 * can.
 */
export function rollupResultType(fn: RollupFn, field: TargetFieldType | 'unknown' | null): { type: CheckType } | { error: string } {
  if (fn === 'count') return { type: 'number' }
  if (NEEDS_FIELD.has(fn) && field === null) return { error: `${ROLLUP_FN_LABELS[fn]} needs a field of the linked records.` }
  if (field === 'unknown') return { type: fn === 'sum' || fn === 'avg' ? 'number' : fn === 'earliest' || fn === 'latest' ? 'date' : fn === 'list' ? 'text' : 'unknown' }
  switch (fn) {
    case 'sum':
    case 'avg':
      return field === 'number' || field === 'currency' ? { type: 'number' } : { error: `${ROLLUP_FN_LABELS[fn]} needs a number or currency field.` }
    case 'min':
    case 'max':
      if (field === 'number' || field === 'currency') return { type: 'number' }
      if (field === 'date') return { type: 'date' }
      return { error: `${ROLLUP_FN_LABELS[fn]} needs a number, currency or date field.` }
    case 'earliest':
    case 'latest':
      return field === 'date' ? { type: 'date' } : { error: `${ROLLUP_FN_LABELS[fn]} needs a date field.` }
    case 'list':
      return field === 'person' || field === 'relation' ? { error: 'A list reads names, text, numbers and dates, not people or links.' } : { type: 'text' }
  }
}

/** A stored column's values, as a formula reads them. Null: a formula can't use it. */
export function formulaTypeOf(t: DataColumnType | 'title'): FormulaType | null {
  switch (t) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case 'select':
    case 'multi_select':
      return 'text'
    case 'number':
    case 'currency':
      return 'number'
    case 'date':
      return 'date'
    case 'checkbox':
      return 'checkbox'
    default:
      return null
  }
}

/** A stored value as a formula reads it: empty as null, an unset checkbox as false. */
export function formulaValueOf(t: DataColumnType | 'title', raw: unknown): FormulaValue {
  if (t === 'checkbox') return { t: 'checkbox', v: raw === true }
  if (isEmptyValue(raw)) return null
  switch (t) {
    case 'number':
      return typeof raw === 'number' ? { t: 'number', v: raw } : null
    case 'currency': {
      const amount = (raw as { amount?: unknown })?.amount
      return typeof amount === 'number' ? { t: 'number', v: amount } : null
    }
    case 'date':
      return typeof raw === 'string' ? { t: 'date', v: raw } : null
    case 'multi_select':
      return Array.isArray(raw) ? { t: 'text', v: raw.join(', ') } : null
    default:
      return typeof raw === 'string' || typeof raw === 'number' ? { t: 'text', v: String(raw) } : null
  }
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface ComputedPlanEntry {
  key: string
  kind: 'formula' | 'rollup'
  /** Its result's type ('unknown': a rollup on a table the check can't read). */
  result: CheckType | null
  error?: string
  /** A formula's tree. */
  ast?: FormulaNode
  /** A rollup: its relation column and the field and function it reads. */
  rollup?: { relation: string; field: string | null; fn: RollupFn }
}

export interface ComputedPlan {
  entries: Map<string, ComputedPlanEntry>
  /** Formulas in the order they run: each after every formula it names. */
  order: string[]
}

/**
 * Each computed column's result type or error. `targetField` says what a
 * rollup's linked field is: its type, `unknown` when that can't be read
 * here, or an error (the table it reads is out of sight).
 */
export function planComputed(
  columns: readonly Column[],
  targetField: (rollup: Column, relation: Column) => TargetFieldType | 'unknown' | null | { error: string } = () => 'unknown',
): ComputedPlan {
  const cols = columns.filter(live)
  const byKey = new Map(cols.map((c) => [c.key, c]))
  const entries = new Map<string, ComputedPlanEntry>()

  for (const c of cols) {
    if (c.field_type !== 'rollup') continue
    const fn = c.config?.fn
    const relationKey = c.config?.relation ?? ''
    const relation = byKey.get(relationKey)
    const base: ComputedPlanEntry = { key: c.key, kind: 'rollup', result: null }
    if (!isRollupFn(fn)) {
      entries.set(c.key, { ...base, error: 'This rollup has no way to aggregate.' })
      continue
    }
    const rollup = { relation: relationKey, field: c.config?.field ?? null, fn }
    if (!relation || relation.field_type !== 'relation' || !relation.config?.target) {
      entries.set(c.key, { ...base, rollup, error: 'The relation column this rollup reads is gone.' })
      continue
    }
    const field = rollup.field === null ? null : targetField(c, relation)
    if (field && typeof field === 'object') {
      entries.set(c.key, { ...base, rollup, error: field.error })
      continue
    }
    const t = rollupResultType(fn, field === null && rollup.field !== null ? 'unknown' : field)
    entries.set(c.key, 'error' in t ? { ...base, rollup, error: t.error } : { ...base, rollup, result: t.type })
  }

  // Formulas: parse each, then type them in dependency order.
  const parsed = new Map<string, { ast: FormulaNode; refs: string[] } | { error: string }>()
  for (const c of cols) {
    if (c.field_type !== 'formula') continue
    const p = parseFormula(c.config?.expression ?? '', cols)
    parsed.set(c.key, p.ok ? { ast: p.ast, refs: p.refs } : { error: p.ok === false ? p.error : '' })
  }
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (key: string, path: string[]): void => {
    if (state.get(key) === 'done') return
    const p = parsed.get(key)!
    if ('error' in p) {
      entries.set(key, { key, kind: 'formula', result: null, error: p.error })
      state.set(key, 'done')
      return
    }
    state.set(key, 'visiting')
    for (const ref of p.refs) {
      if (!parsed.has(ref)) continue
      if (state.get(ref) === 'visiting') {
        // Every formula on the loop is in error.
        const loop = [...path.slice(path.indexOf(ref)), key]
        for (const k of loop) {
          const label = byKey.get(k === key ? ref : k)?.label ?? ref
          entries.set(k, { key: k, kind: 'formula', result: null, error: `This formula refers back to itself through {${label}}.` })
          state.set(k, 'done')
        }
        return
      }
      visit(ref, [...path, key])
    }
    if (state.get(key) === 'done') return
    const checked = checkFormula(p.ast, (ref, name) => {
      if (ref === TITLE_REF) return 'text'
      const col = byKey.get(ref)
      if (!col) return { error: `No column named {${name}}.` }
      if (col.key === key) return { error: 'A formula can not refer to itself.' }
      if (col.field_type === 'formula' || col.field_type === 'rollup') {
        const e = entries.get(ref)
        if (!e || e.error) return { error: `{${name}} has an error.` }
        return e.result ?? 'unknown'
      }
      const t = formulaTypeOf(col.field_type)
      if (!t) return { error: `{${name}} is a ${col.field_type === 'person' ? 'person' : 'relation'} column: read it with a rollup.` }
      return t
    })
    entries.set(key, checked.ok ? { key, kind: 'formula', result: checked.type, ast: p.ast } : { key, kind: 'formula', result: null, error: checked.error })
    state.set(key, 'done')
    if (checked.ok) order.push(key)
  }
  for (const key of parsed.keys()) visit(key, [])
  return { entries, order }
}

/** A computed column's result type and error, as the grid reads them. */
export function computedInfo(entry: ComputedPlanEntry | undefined): ComputedInfo {
  if (!entry) return { result: null, error: 'This column can not be worked out.' }
  if (entry.error) return { result: null, error: entry.error }
  return { result: entry.result === 'unknown' ? null : (entry.result as ComputedResult | null) }
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** A linked record as a rollup reads it: its name, and its field's value. */
export interface LinkedValue {
  name: string
  value: unknown
}

/**
 * One rollup's value. `items` are the linked records the reader can read, in
 * the order the relation links them; `field` is the linked field's type
 * (`title`: their names).
 */
export function aggregate(fn: RollupFn, field: TargetFieldType | null, items: readonly LinkedValue[]): FormulaValue {
  if (fn === 'count') {
    const n = field === null ? items.length : items.filter((i) => !isEmptyValue(field === 'title' ? i.name : i.value) && i.value !== false).length
    return { t: 'number', v: n }
  }
  if (fn === 'list') {
    const words = items.map((i) => (field === null || field === 'title' ? i.name : listText(field, i.value))).filter((s) => !!s)
    const unique = [...new Set(words)]
    return unique.length ? { t: 'text', v: unique.join(', ').slice(0, 2000) } : null
  }
  if (field === 'date') {
    const days = items.map((i) => i.value).filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)).sort()
    if (!days.length) return null
    return { t: 'date', v: fn === 'min' || fn === 'earliest' ? days[0] : days[days.length - 1] }
  }
  const nums = items
    .map((i) => (field === 'currency' ? (i.value as { amount?: unknown } | null)?.amount : i.value))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (fn === 'sum') return { t: 'number', v: nums.reduce((a, b) => a + b, 0) }
  if (!nums.length) return null
  if (fn === 'avg') return { t: 'number', v: nums.reduce((a, b) => a + b, 0) / nums.length }
  if (fn === 'min') return { t: 'number', v: Math.min(...nums) }
  if (fn === 'max') return { t: 'number', v: Math.max(...nums) }
  return null
}

function listText(field: TargetFieldType, value: unknown): string {
  if (isEmptyValue(value)) return ''
  if (field === 'checkbox') return value === true ? 'Yes' : ''
  if (field === 'currency') {
    const v = value as { amount?: number; currency?: string }
    return typeof v?.amount === 'number' ? `${v.amount} ${v.currency ?? ''}`.trim() : ''
  }
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'object' ? '' : String(value)
}

const cellOf = (v: FormulaValue): ComputedCell => ({ value: v === null ? null : v.v })

/**
 * One row's computed cells. `rollups` holds its rollups' values (worked out
 * by the server for the reader); the formulas run here, in plan order. A
 * column whose plan has an error has no cells: the column says why.
 */
export function computeRow(
  row: { title: string; custom_fields: Record<string, unknown> },
  columns: readonly Column[],
  plan: ComputedPlan,
  rollups: Readonly<Record<string, ComputedCell>>,
  opts: { today: string },
): Record<string, ComputedCell> {
  const out: Record<string, ComputedCell> = {}
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const values = new Map<string, FormulaValue | { error: string }>()
  for (const [key, e] of plan.entries) {
    if (e.kind !== 'rollup' || e.error) continue
    const cell = (own(rollups, key) as ComputedCell | undefined) ?? { value: e.rollup?.fn === 'count' ? 0 : null }
    out[key] = cell
    values.set(key, 'error' in cell ? { error: cell.error } : typedCell(cell, e.result))
  }
  const ref = (key: string): FormulaValue | { error: string } => {
    if (key === TITLE_REF) return row.title ? { t: 'text', v: row.title } : null
    if (values.has(key)) return values.get(key)!
    const col = byKey.get(key)
    return col ? formulaValueOf(col.field_type, own(row.custom_fields, key)) : null
  }
  for (const key of plan.order) {
    const e = plan.entries.get(key)!
    const r = runFormula(e.ast!, ref, opts)
    out[key] = r.ok ? cellOf(r.value) : { error: r.error }
    values.set(key, r.ok ? r.value : { error: r.error })
  }
  return out
}

/** A computed cell back as a typed value (a formula reading a rollup). */
function typedCell(cell: { value: number | string | boolean | null }, result: CheckType | null): FormulaValue {
  if (cell.value === null) return null
  const t: FormulaType =
    result && result !== 'unknown' ? result : typeof cell.value === 'number' ? 'number' : typeof cell.value === 'boolean' ? 'checkbox' : 'text'
  return { t, v: cell.value } as FormulaValue
}

/** The reader's day, YYYY-MM-DD, in their zone when known (else this runtime's). */
export function todayIn(timeZone?: string, now: Date = new Date()): string {
  if (timeZone) {
    try {
      // en-CA writes YYYY-MM-DD.
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    } catch {
      // An unknown zone: this runtime's day.
    }
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// ── Filters and sorts on a computed column ──────────────────────────────────

const valueOf = (cell: ComputedCell | undefined) => (cell && 'value' in cell ? cell.value : null)

/** Does a computed cell pass one of a view's filters (the operators its result type's chip offers)? */
export function cellMatches(
  cell: ComputedCell | undefined,
  result: ComputedResult | null,
  filter: Pick<ViewFilter, 'operator' | 'value'>,
  /** A relative window ("next 7 days") as days, YYYY-MM-DD: the server's query engine resolves it, in the reader's zone. */
  opts: { window?: (value: RelativeDateValue) => { from: string; to: string } } = {},
): boolean {
  const v = valueOf(cell)
  const want = filter.value as unknown
  const empty = v === null || v === ''
  switch (filter.operator) {
    case 'is_empty':
      return empty
    case 'is_not_empty':
      return !empty
  }
  if (result === 'checkbox') {
    const on = v === true
    const target = want === true || want === 'true'
    if (filter.operator === 'is') return on === target
    if (filter.operator === 'is_not') return on !== target
    return true
  }
  if (empty) return filter.operator === 'is_not' || filter.operator === 'does_not_contain' || filter.operator === 'is_none_of'
  if (result === 'number') {
    const n = v as number
    const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN)
    switch (filter.operator) {
      case 'is':
        return n === num(want)
      case 'is_not':
        return n !== num(want)
      case 'gt':
        return n > num(want)
      case 'gte':
        return n >= num(want)
      case 'lt':
        return n < num(want)
      case 'lte':
        return n <= num(want)
      case 'between': {
        const r = (want ?? {}) as Partial<RangeValue>
        const lo = num(r.from)
        const hi = num(r.to)
        return (Number.isNaN(lo) || n >= lo) && (Number.isNaN(hi) || n <= hi)
      }
      default:
        return true
    }
  }
  const s = String(v)
  if (result === 'date') {
    const day = (x: unknown) => (typeof x === 'string' ? x.slice(0, 10) : '')
    switch (filter.operator) {
      case 'is':
        return s === day(want)
      case 'is_not':
        return s !== day(want)
      case 'gt':
        return s > day(want)
      case 'gte':
        return s >= day(want)
      case 'lt':
        return s < day(want)
      case 'lte':
        return s <= day(want)
      case 'between': {
        const r = (want ?? {}) as Partial<RangeValue>
        return (!r.from || s >= day(r.from)) && (!r.to || s <= day(r.to))
      }
      case 'is_relative': {
        if (!opts.window) return true
        const w = opts.window(want as RelativeDateValue)
        return s >= w.from && s <= w.to
      }
      default:
        return true
    }
  }
  const text = s.toLowerCase()
  const w = typeof want === 'string' || typeof want === 'number' ? String(want).toLowerCase() : ''
  switch (filter.operator) {
    case 'is':
      return text === w
    case 'is_not':
      return text !== w
    case 'contains':
      return text.includes(w)
    case 'does_not_contain':
      return !text.includes(w)
    case 'starts_with':
      return text.startsWith(w)
    case 'ends_with':
      return text.endsWith(w)
    case 'is_any_of':
    case 'is_none_of': {
      const list = (Array.isArray(want) ? want : [want]).map((x) => String(x).toLowerCase())
      return filter.operator === 'is_any_of' ? list.includes(text) : !list.includes(text)
    }
    default:
      return true
  }
}

/** Orders two values of one kind, empty ones last whichever way. */
export function compareValues(a: unknown, b: unknown, dir: 'asc' | 'desc'): number {
  const ea = a === null || a === undefined || a === ''
  const eb = b === null || b === undefined || b === ''
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1
  let c: number
  if (typeof a === 'number' && typeof b === 'number') c = a - b
  else if (typeof a === 'boolean' && typeof b === 'boolean') c = Number(a) - Number(b)
  else c = String(a).localeCompare(String(b), 'en', { sensitivity: 'base', numeric: true })
  return dir === 'asc' ? c : -c
}

export const cellValue = valueOf

// ── In the page ─────────────────────────────────────────────────────────────

/**
 * The plan as the grid runs it: its own, with each computed column's result
 * and error as the server read them (a rollup's linked field is the
 * server's to know).
 */
export function localPlan(columns: readonly (Column & { computed?: ComputedInfo })[]): ComputedPlan {
  const plan = planComputed(columns)
  for (const c of columns) {
    const e = plan.entries.get(c.key)
    if (!e || !c.computed) continue
    if (c.computed.error) {
      plan.entries.set(c.key, { ...e, result: null, error: c.computed.error })
      plan.order = plan.order.filter((k) => k !== c.key)
    } else if (c.computed.result) plan.entries.set(c.key, { ...e, result: c.computed.result })
  }
  return plan
}

/**
 * A row's formulas worked out again after an edit, here: its rollups stay as
 * the server last read them (they need the linked records).
 */
export function recomputeRow<R extends { title: string; custom_fields: Record<string, unknown>; computed?: Record<string, ComputedCell> }>(
  row: R,
  columns: readonly Column[],
  plan: ComputedPlan,
  today: string,
): R {
  if (!plan.entries.size) return row
  const rollups: Record<string, ComputedCell> = {}
  for (const [key, e] of plan.entries) {
    const cell = own(row.computed, key) as ComputedCell | undefined
    if (e.kind === 'rollup' && cell) rollups[key] = cell
  }
  return { ...row, computed: computeRow(row, columns, plan, rollups, { today }) }
}

/** A computed cell's value as it reads, or its error (the column's own, else the cell's). */
export function cellValueOfRow(
  c: Pick<DataColumn, 'key' | 'computed'>,
  row: { computed?: Record<string, ComputedCell> },
): { value: number | string | boolean | null; error?: string } {
  if (c.computed?.error) return { value: null, error: c.computed.error }
  const cell = own(row.computed, c.key) as ComputedCell | undefined
  if (cell && 'error' in cell) return { value: null, error: cell.error }
  return { value: cell?.value ?? null }
}

/** How a computed column's cells read: as a column of its result's type (text when it is unknown). */
export function resultFieldType(result: ComputedResult | null | undefined): CustomFieldType {
  return result ?? 'text'
}
