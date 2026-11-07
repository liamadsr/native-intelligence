/**
 * The claim filter model — ONE vocabulary, shared by the knowledge map and the
 * claim list/board.
 *
 * WHY THIS EXISTS. A saved claim view can be drawn three ways: as the WebGL
 * knowledge map, as a list, or as a board. The list and board run the filter as
 * SQL through the views query engine; the map runs it as a bitmask over typed
 * arrays held in memory over an already-laid-out graph (tiling.ts), because
 * positions come from the unfiltered layout and re-querying would move nodes.
 * Two engines, one saved view — so the two must agree on every field and every
 * operator, or flipping the layout toggle would silently change which claims
 * you are looking at.
 *
 * This module is the contract that keeps them honest:
 *
 *   - `MAP_FILTER_FIELDS` is the allow-list. It is derived from, and asserted
 *     against, `FILTERABLE_FIELDS.claim` — a field the views UI can offer but
 *     the map cannot answer is a bug, not a degraded mode.
 *   - `toMapFilters` turns the views' `ViewFilter[]` into the canonical
 *     predicate list, dropping nothing silently: an unrepresentable filter is
 *     returned in `rejected`, and the caller must surface it.
 *   - `filtersKey` canonicalises that list into the map's cache identity.
 *
 * NULL IS NEVER A MATCH. For every field and every operator, a null value fails
 * `is`, `is_not`, `is_any_of`, `is_none_of`, the text operators, `gt`/`gte`/
 * `lt`/`lte`, `between` and `is_relative`. It matches `is_empty` alone. This is
 * Postgres's three-valued logic, which the SQL side gets for free and the mask
 * has to be written to reproduce — including for `is_not`, where the intuitive
 * "everything that isn't X" would wrongly sweep in the un-set rows.
 */

import { isUnsetFilterValue, type FilterOperator, type RangeValue, type RelativeDateValue, type ViewFilter } from '@/lib/views/types'
import { CLAIM_TYPES, type ClaimType } from './types'

// ─── The allow-list ───────────────────────────────────────────────────────────

/**
 * Every field a claim view may filter on, with the shape the mask needs.
 *
 * `kind` is what the mask does with it, NOT the views' FilterFieldType — the
 * map does not care that a project is an entity, only that it compares a set of
 * ids against a per-claim id set.
 */
export const MAP_FILTER_FIELDS = {
  type: { kind: 'enum' },
  confirmation: { kind: 'enum' },
  scope: { kind: 'enum' },
  confidence: { kind: 'number' },
  auto_accepted: { kind: 'boolean' },
  created_by: { kind: 'id' },
  /** A claim can sit on several projects, so this compares SET against SET. */
  project_ids: { kind: 'idSet' },
  created_at: { kind: 'date' },
  event_at: { kind: 'date' },
  last_verified_at: { kind: 'date' },
  text: { kind: 'text' },
} as const

export type MapFilterField = keyof typeof MAP_FILTER_FIELDS
export type MapFilterKind = (typeof MAP_FILTER_FIELDS)[MapFilterField]['kind']

export function isMapFilterField(field: string): field is MapFilterField {
  return Object.prototype.hasOwnProperty.call(MAP_FILTER_FIELDS, field)
}

/** Operators the mask implements, per kind. Mirrors OPERATORS_BY_TYPE. */
const OPERATORS_BY_KIND: Record<MapFilterKind, ReadonlySet<FilterOperator>> = {
  enum: new Set<FilterOperator>(['is', 'is_not', 'is_any_of', 'is_none_of']),
  number: new Set<FilterOperator>([
    'is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty',
  ]),
  boolean: new Set<FilterOperator>(['is']),
  id: new Set<FilterOperator>(['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty']),
  idSet: new Set<FilterOperator>(['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty']),
  date: new Set<FilterOperator>([
    'is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'is_relative', 'is_empty', 'is_not_empty',
  ]),
  text: new Set<FilterOperator>([
    'is', 'is_not', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty',
  ]),
}

// ─── The canonical predicate ──────────────────────────────────────────────────

/**
 * A validated, canonicalised filter. `value` is already normalised for its
 * kind: enum/id values are sorted string arrays, numbers are numbers, dates are
 * ISO strings or an unresolved relative descriptor, text is lower-cased.
 *
 * `is_relative` stays UNRESOLVED on the wire, deliberately. Resolving it on the
 * client would let two viewers — or the same viewer's list and canvas — answer
 * one saved view with two different windows, and it is exactly the divergence
 * this module exists to prevent. The server resolves it once, against its own
 * clock, for both engines; `service.ts` already buckets the cache key to the
 * hour whenever a relative filter is present, which is what keeps the key
 * stable without freezing the window.
 */
export interface MapPredicate {
  field: MapFilterField
  op: FilterOperator
  value?: string | number | string[] | RangeValue | RelativeDateValue | boolean
}

export interface MapFilters {
  where?: MapPredicate[]
}

/** A `ViewFilter` the map cannot express, with why. Never silently dropped. */
export interface RejectedFilter {
  filter: ViewFilter
  reason: string
}

// ─── Caps ─────────────────────────────────────────────────────────────────────

/**
 * Bounds on a filter payload. The wire carries a caller-supplied structure, and
 * every distinct payload is a distinct cache key and therefore a re-tile of the
 * whole map, so the shape has to be bounded before it is canonicalised — not
 * after. These are far above any filter set a person builds by hand (the UI's
 * own chip row stops being usable long before 24) and far below anything that
 * would make one request expensive.
 */
export const MAX_PREDICATES = 24
export const MAX_VALUES_PER_PREDICATE = 200
export const MAX_TEXT_LENGTH = 200
export const MAX_FILTER_PAYLOAD_BYTES = 8 * 1024

// ─── Normalisation ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAIM_TYPE_SET: ReadonlySet<string> = new Set(CLAIM_TYPES)
const CONFIRMATIONS: ReadonlySet<string> = new Set(['confirmed', 'suggested'])
const SCOPES: ReadonlySet<string> = new Set(['workspace', 'personal'])
const RELATIVE_UNITS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'quarter', 'year'])
const RELATIVE_DIRECTIONS: ReadonlySet<string> = new Set(['past', 'future', 'this'])

/** Values a given enum field accepts. An unknown value is a rejection, not a
 *  pass-through: the domains are closed, so a typo can only ever match nothing,
 *  and letting it reach the mask would churn a cache key per typo. */
function enumDomain(field: MapFilterField): ReadonlySet<string> {
  switch (field) {
    case 'type': return CLAIM_TYPE_SET
    case 'confirmation': return CONFIRMATIONS
    case 'scope': return SCOPES
    default: return new Set()
  }
}

function asStringArray(value: unknown): string[] | null {
  const raw = Array.isArray(value) ? value : [value]
  if (raw.length === 0 || raw.length > MAX_VALUES_PER_PREDICATE) return null
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || v === '') return null
    out.push(v)
  }
  // Sorted + deduped so click order never changes the cache key.
  return Array.from(new Set(out)).sort()
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && v !== '' && Number.isFinite(Date.parse(v))
}

function normaliseRelative(value: unknown): RelativeDateValue | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<RelativeDateValue>
  if (typeof v.unit !== 'string' || !RELATIVE_UNITS.has(v.unit)) return null
  if (typeof v.direction !== 'string' || !RELATIVE_DIRECTIONS.has(v.direction)) return null
  const count = v.count === undefined ? undefined : Number(v.count)
  if (count !== undefined && (!Number.isFinite(count) || count < 0 || count > 3650)) return null
  return count === undefined
    ? { unit: v.unit, direction: v.direction }
    : { unit: v.unit, direction: v.direction, count: Math.floor(count) }
}

function normaliseRange(value: unknown, numeric: boolean): RangeValue | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<RangeValue>
  if (v.from === undefined || v.to === undefined) return null
  if (numeric) {
    const from = Number(v.from)
    const to = Number(v.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null
    return { from, to }
  }
  if (!isIsoDate(v.from) || !isIsoDate(v.to)) return null
  return { from: v.from, to: v.to }
}

/**
 * Validate and canonicalise ONE filter.
 *
 * Returns the predicate, or a reason string. Every rejection is a real
 * mismatch: an unknown field, an operator the mask does not implement, or a
 * value that cannot be made sense of for the field's kind.
 */
export const UNSET = Symbol('unset filter value')

export function normalisePredicate(filter: ViewFilter): MapPredicate | string | typeof UNSET {
  const { field, operator: op } = filter
  if (!isMapFilterField(field)) return `“${field}” is not a knowledge field`

  const kind = MAP_FILTER_FIELDS[field].kind
  if (!OPERATORS_BY_KIND[kind].has(op)) {
    return `“${op}” cannot be applied to ${field}`
  }

  // Presence operators carry no value at all.
  if (op === 'is_empty' || op === 'is_not_empty') return { field, op }

  const value = filter.value

  // A chip the user has not filled in yet is NOT a predicate. It is dropped,
  // exactly as the SQL engine's `applyFilters` skips it — never coerced
  // (`Number('')` is 0, which would silently apply `confidence >= 0` to the
  // canvas alone) and never rejected (which would warn the reader that a filter
  // is "not applied to the graph" before they had typed a thing).
  if (isUnsetFilterValue(value)) return UNSET

  switch (kind) {
    case 'enum': {
      const values = asStringArray(value)
      if (!values) return `${field} needs a value`
      const domain = enumDomain(field)
      const kept = values.filter((v) => domain.has(v))
      if (kept.length === 0) return `no valid ${field} value`
      return { field, op, value: kept }
    }
    case 'id':
    case 'idSet': {
      const values = asStringArray(value)
      if (!values) return `${field} needs a value`
      // Ids are UUIDs or they are nothing. `@me` must already have been
      // resolved to a concrete member id before it reaches here — the wire
      // carries values, never viewer-relative sentinels, or one cache key
      // would mean different claims for different people.
      const kept = values.filter((v) => UUID_RE.test(v))
      if (kept.length === 0) return `${field} needs an id`
      return { field, op, value: kept }
    }
    case 'boolean': {
      const v = typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null
      if (v === null) return `${field} needs true or false`
      return { field, op, value: v }
    }
    case 'number': {
      if (op === 'between') {
        const range = normaliseRange(value, true)
        if (!range) return `${field} needs a range`
        return { field, op, value: range }
      }
      const n = Number(value)
      if (!Number.isFinite(n)) return `${field} needs a number`
      return { field, op, value: n }
    }
    case 'date': {
      if (op === 'is_relative') {
        const rel = normaliseRelative(value)
        if (!rel) return `${field} needs a relative window`
        return { field, op, value: rel }
      }
      if (op === 'between') {
        const range = normaliseRange(value, false)
        if (!range) return `${field} needs a date range`
        return { field, op, value: range }
      }
      if (!isIsoDate(value)) return `${field} needs a date`
      return { field, op, value }
    }
    case 'text': {
      if (typeof value !== 'string') return 'text needs a string'
      // THE NEEDLE TRAVELS EXACTLY AS TYPED.
      //
      // It used to be lower-cased and whitespace-collapsed here, which made the
      // cache key kinder but made the two engines disagree: SQL runs
      // `contains`/`starts_with`/`ends_with` through `ilike` (case-insensitive,
      // whitespace-literal) and `is`/`is_not` through `eq`/`neq` (case-
      // SENSITIVE). Folding everything made `Text is "budget approved"` match a
      // claim reading "Budget approved" on the canvas and not in the list, and
      // collapsing whitespace made a double space match where `ilike` would not.
      // The mask folds per operator instead, where the distinction belongs.
      //
      // Only the outer trim survives, because a leading or trailing space is
      // never what the user meant and both engines would honour it.
      const text = value.trim()
      if (text === '') return 'text needs a value'
      if (text.length > MAX_TEXT_LENGTH) return 'text is too long'
      return { field, op, value: text }
    }
  }
}

// ─── ViewFilter[] → MapFilters ────────────────────────────────────────────────

/**
 * Translate a saved view's filters into the map's wire filters.
 *
 * `rejected` is the contract that makes this safe: the caller must show what
 * could not be applied rather than drawing a canvas that quietly ignores a
 * chip. With `FILTERABLE_FIELDS.claim` chosen so every field is maskable, it
 * should always be empty — a non-empty `rejected` in production means the two
 * vocabularies have drifted, which is what the registration test guards.
 */
export function toMapFilters(filters: readonly ViewFilter[]): {
  filters: MapFilters
  rejected: RejectedFilter[]
} {
  const where: MapPredicate[] = []
  const rejected: RejectedFilter[] = []

  for (const filter of filters) {
    if (where.length >= MAX_PREDICATES) {
      rejected.push({ filter, reason: 'too many filters' })
      continue
    }
    const result = normalisePredicate(filter)
    if (result === UNSET) continue
    if (typeof result === 'string') rejected.push({ filter, reason: result })
    else where.push(result)
  }

  return { filters: where.length > 0 ? { where } : {}, rejected }
}

// ─── Canonical cache key ──────────────────────────────────────────────────────

/** Stable ordering for predicates: by field, then operator, then value. */
function predicateSortKey(p: MapPredicate): string {
  return `${p.field} ${p.op} ${stableValue(p.value)}`
}

function stableValue(v: MapPredicate['value']): string {
  if (v === undefined) return ''
  if (Array.isArray(v)) return JSON.stringify(v)
  if (typeof v === 'object') {
    // Object values (RangeValue, RelativeDateValue) are serialised with sorted
    // keys so `{from,to}` and `{to,from}` are one key, not two.
    const keys = Object.keys(v).sort()
    return JSON.stringify(v, keys)
  }
  return JSON.stringify(v)
}

/**
 * The map's cache identity for a filter set.
 *
 * Serialised STRUCTURALLY, never by joining values with a delimiter: this
 * string is the only thing keying the built tiling (service.ts), so a value
 * containing the delimiter would otherwise synthesize another filter set's key
 * and serve one viewer's filtered map for another's.
 *
 * Returns '' for "no filters at all", so `isEmptyFilters` stays a string
 * compare.
 */
export function filtersKey(filters: MapFilters): string {
  const where = filters.where ?? []
  if (where.length === 0) return ''
  const canon = where
    .map((p) => [p.field, p.op, p.value === undefined ? null : p.value] as const)
    .sort((a, b) =>
      predicateSortKey({ field: a[0], op: a[1], value: a[2] ?? undefined }) <
      predicateSortKey({ field: b[0], op: b[1], value: b[2] ?? undefined })
        ? -1
        : 1,
    )
  return JSON.stringify(canon)
}

/** True when no predicate is set — the whole map passes. */
export function isEmptyFilters(filters: MapFilters): boolean {
  return filtersKey(filters) === ''
}

/** True when any predicate resolves against the clock, so the cache key has to
 *  carry a time bucket (see service.ts `buildKey`). */
export function hasRelativeFilter(filters: MapFilters): boolean {
  return (filters.where ?? []).some((p) => p.op === 'is_relative')
}
