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

/** A versioned bag. New kinds are added as optional arrays so an older reader drops them cleanly. */
export interface WorkbookExtras {
  v: typeof EXTRAS_VERSION
  validations: Validation[]
  checkboxes: CheckboxArea[]
  /** Reserved for later phases; carried through untouched. */
  charts: unknown[]
  images: unknown[]
  tables: unknown[]
}

/** Serialized extras larger than this are refused (the arrays are trimmed): a guard against a runaway workbook. */
export const MAX_EXTRAS_BYTES = 1_000_000
const MAX_ENTRIES = 5_000

export function emptyExtras(): WorkbookExtras {
  return { v: EXTRAS_VERSION, validations: [], checkboxes: [], charts: [], images: [], tables: [] }
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

/** Read whatever is in the column, dropping anything this version does not understand. */
export function readExtras(value: unknown): WorkbookExtras {
  const base = emptyExtras()
  if (!isObject(value)) return base
  const validations = readAreas<Validation>(value.validations, (v) => {
    const rule = readRule(v.rule)
    return rule ? { rule } : null
  })
  const checkboxes = readAreas<CheckboxArea>(value.checkboxes, () => ({}))
  const result: WorkbookExtras = {
    v: EXTRAS_VERSION,
    validations,
    checkboxes,
    charts: Array.isArray(value.charts) ? (value.charts as unknown[]) : [],
    images: Array.isArray(value.images) ? (value.images as unknown[]) : [],
    tables: Array.isArray(value.tables) ? (value.tables as unknown[]) : [],
  }
  // The size guard: trim the large collections until it fits.
  while (JSON.stringify(result).length > MAX_EXTRAS_BYTES && (result.validations.length || result.checkboxes.length)) {
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
    extras.charts.length === 0 &&
    extras.images.length === 0 &&
    extras.tables.length === 0
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

/** Move the stored ranges with a structural change to the sheet. Returns new extras (unchanged object when nothing moved). */
export function shiftExtras(extras: WorkbookExtras, change: ExtrasChange): WorkbookExtras {
  const validations = mapAreas(extras.validations, change)
  const checkboxes = mapAreas(extras.checkboxes, change)
  if (validations === extras.validations && checkboxes === extras.checkboxes) return extras
  return { ...extras, validations, checkboxes }
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
