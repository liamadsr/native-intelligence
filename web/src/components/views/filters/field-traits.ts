/**
 * Per-FIELD presentation traits for the generic filter chip.
 *
 * The chip is built entirely out of a field's TYPE — number, date, enum — and
 * that is most of what it needs. But a type is not a unit and not an intent: a
 * `number` field can be a count, a dollar amount or a fraction rendered as a
 * percentage, and the operator a user most often wants differs with which one
 * it is. Without the distinction, adding a Confidence filter and typing the
 * number the row itself shows you ("95%") builds `confidence is 95` — a filter
 * against a column whose whole range is 0..1, which is wrong twice over and
 * returns nothing.
 *
 * Keyed by field NAME rather than carried on FilterFieldDefinition because the
 * definitions live in @/lib/views/types, which is owned elsewhere while the
 * views rebuild is in flight (see the note in this PR's report — these belong
 * folded into the definitions once that file is free). A name is the right key
 * regardless: `confidence` means one thing across the whole filter vocabulary,
 * and a second entity that grows a confidence column should get the same chip
 * without anyone remembering to say so.
 */

import {
  OPERATORS_BY_TYPE,
  type FilterFieldDefinition,
  type FilterOperator,
} from '@/lib/views/types'

/** The unit a number field is STORED in, when that differs from what a person
 *  reads and types. Only `percent` so far; money would be the next one. */
export type NumberUnit = 'percent'

interface FilterFieldTrait {
  /**
   * The operator a NEW chip for this field starts on. Without it the chip
   * starts on `OPERATORS_BY_TYPE[type][0]`, which for a number is `is` —
   * exact equality against a continuous value, i.e. a filter that is almost
   * never what was meant and almost always returns an empty list.
   */
  defaultOperator?: FilterOperator
  /** Applies to `number` fields only — see `numberUnitFor`. */
  unit?: NumberUnit
}

const FIELD_TRAITS: Record<string, FilterFieldTrait> = {
  // claim.confidence: a REAL in 0..1 that every product surface renders as a
  // percentage (knowledge-library's "· 95%"). A threshold is the only thing
  // anyone asks of it — the old bespoke knowledge filter bar offered exactly
  // three buttons, "≥ 50%", "≥ 70%", "≥ 85%" — so the generic chip opens on
  // the same question rather than on equality.
  confidence: { defaultOperator: 'gte', unit: 'percent' },
}

/**
 * The operator a newly added chip for this field starts on.
 *
 * The preference is checked against the field type's own operator list rather
 * than trusted: a trait naming an operator the type does not offer would put
 * the chip in a state its own dropdown cannot show, and the query engine would
 * be handed a pair it has no branch for.
 */
export function defaultOperatorFor(fieldDef: FilterFieldDefinition): FilterOperator {
  const operators = OPERATORS_BY_TYPE[fieldDef.type] ?? []
  const preferred = FIELD_TRAITS[fieldDef.field]?.defaultOperator
  if (preferred && operators.includes(preferred)) return preferred
  return operators[0] ?? 'is'
}

/**
 * The display unit for a number field, or undefined for a bare number.
 *
 * Gated on the type because the table is keyed by name alone: an entity whose
 * `confidence` were a text column must not inherit a percent input.
 */
export function numberUnitFor(fieldDef: FilterFieldDefinition): NumberUnit | undefined {
  if (fieldDef.type !== 'number') return undefined
  return FIELD_TRAITS[fieldDef.field]?.unit
}

// ─── Percent ↔ fraction ───────────────────────────────────────────────────────
//
// One decimal place of percent is the resolution of the round trip, and that is
// a deliberate floor, not an accident of float maths: it is finer than anything
// a confidence score means and coarse enough that the value a user typed is the
// value the chip shows them again when the saved view re-opens.

/** 0.7 → 70. Rounded BEFORE the float error surfaces — `0.29 * 100` is
 *  28.999999999999996, and a chip must never render a number that could not
 *  have been typed into it. */
export function storedToPercent(stored: number): number {
  return Math.round(stored * 1000) / 10
}

/** 70 → 0.7, clamped to the 0..100 the input advertises. Clamping here rather
 *  than only via the input's `max` because `max` on a number input is advice a
 *  browser does not enforce, and an unclamped 700 would silently store 7.0 —
 *  outside the column's range, so it matches nothing and says nothing. */
export function percentToStored(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent))
  return Math.round(clamped * 10) / 1000
}
