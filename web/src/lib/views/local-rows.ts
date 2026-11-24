/**
 * A views list over rows a page reads itself (no query route behind them):
 * the view's filters, sort and grouping applied on the client, the way the
 * shared engine applies them on the server (docs/plans/views-everywhere.md).
 * Folders' rows (lib/drive/folder-view.ts) and Files' use it; Reviews keeps
 * its own (lib/github/reviews-view.ts), whose fields are GitHub's.
 *
 * Client-safe and pure.
 */
import type { GroupedResults, SortConfig, ViewFilter } from '@/lib/views/types'

export type LocalRow = Record<string, unknown> & { id: string }

/** The field's value(s) as lower-case strings (an array field: each). */
function valuesOf(row: LocalRow, field: string): string[] {
  const v = row[field]
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => String(x).toLowerCase())
  return v == null || v === '' ? [] : [String(v).toLowerCase()]
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase())
  if (typeof v === 'boolean' || typeof v === 'number') return [String(v)]
  return typeof v === 'string' && v ? [v.toLowerCase()] : []
}

const DAY = 86_400_000
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 }

function dateMatches(value: unknown, f: ViewFilter, now: number): boolean {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  if (f.operator === 'is_empty') return !Number.isFinite(t)
  if (f.operator === 'is_not_empty') return Number.isFinite(t)
  if (!Number.isFinite(t)) return false
  const v = f.value
  if (f.operator === 'is_relative' && v && typeof v === 'object' && !Array.isArray(v) && 'unit' in v) {
    const r = v as { unit: string; direction: string; count?: number }
    const span = (r.count ?? 1) * (UNIT_DAYS[r.unit] ?? 1) * DAY
    if (r.direction === 'future') return t >= now && t <= now + span
    return t >= now - span && t <= now
  }
  if (f.operator === 'between' && v && typeof v === 'object' && !Array.isArray(v) && 'from' in v) {
    const r = v as { from: string | number; to: string | number }
    const from = Date.parse(String(r.from))
    const to = Date.parse(String(r.to))
    return (!Number.isFinite(from) || t >= from) && (!Number.isFinite(to) || t <= to + DAY)
  }
  const at = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN
  if (!Number.isFinite(at)) return true
  switch (f.operator) {
    case 'is':
      return Math.floor(t / DAY) === Math.floor(at / DAY)
    case 'is_not':
      return Math.floor(t / DAY) !== Math.floor(at / DAY)
    case 'gt':
      return t > at
    case 'gte':
      return t >= at
    case 'lt':
      return t < at
    case 'lte':
      return t <= at
    default:
      return true
  }
}

/** Whether a row passes one filter. `dateFields` are read as dates; an operator this module doesn't know lets the row through. */
export function localRowMatches(row: LocalRow, f: ViewFilter, dateFields: ReadonlySet<string>, now = Date.now()): boolean {
  if (dateFields.has(f.field)) return dateMatches(row[f.field], f, now)
  const have = valuesOf(row, f.field)
  const want = asList(f.value)
  switch (f.operator) {
    case 'is':
    case 'is_any_of':
    case 'includes':
      return want.length === 0 || want.some((w) => have.includes(w))
    case 'is_not':
    case 'is_none_of':
    case 'excludes':
      return !want.some((w) => have.includes(w))
    case 'equals':
      return want.length === have.length && want.every((w) => have.includes(w))
    case 'is_empty':
      return have.length === 0
    case 'is_not_empty':
      return have.length > 0
    case 'contains':
      return want.length === 0 || have.some((h) => want.some((w) => h.includes(w)))
    case 'does_not_contain':
      return !have.some((h) => want.some((w) => h.includes(w)))
    case 'starts_with':
      return want.length === 0 || have.some((h) => want.some((w) => h.startsWith(w)))
    case 'ends_with':
      return want.length === 0 || have.some((h) => want.some((w) => h.endsWith(w)))
    default:
      return true
  }
}

/** A chip the person has not filled in yet: skipped, as the server skips it. */
function isLive(f: ViewFilter): boolean {
  if (f.operator === 'is_empty' || f.operator === 'is_not_empty') return true
  return !(f.value === '' || f.value === null || f.value === undefined || (Array.isArray(f.value) && f.value.length === 0))
}

/** Every filter (an `or` filter joins the one before it, as the shared engine reads them). */
export function filterLocalRows<T extends LocalRow>(rows: readonly T[], filters: readonly ViewFilter[], dateFields: ReadonlySet<string>, now = Date.now()): T[] {
  const live = filters.filter(isLive)
  if (live.length === 0) return [...rows]
  return rows.filter((row) => {
    let ok = localRowMatches(row, live[0], dateFields, now)
    for (const f of live.slice(1)) ok = f.conjunction === 'or' ? ok || localRowMatches(row, f, dateFields, now) : ok && localRowMatches(row, f, dateFields, now)
    return ok
  })
}

/** Sorted by `ordering` (the default when empty), then by `first` ahead of everything (a folder's subfolders). */
export function sortLocalRows<T extends LocalRow>(rows: readonly T[], ordering: readonly SortConfig[], fallback: readonly SortConfig[], first?: (row: T) => boolean): T[] {
  const by = ordering.length ? ordering : fallback
  return [...rows].sort((a, b) => {
    if (first) {
      const fa = first(a)
      const fb = first(b)
      if (fa !== fb) return fa ? -1 : 1
    }
    for (const s of by) {
      const av = a[s.field]
      const bv = b[s.field]
      // A row with no value sinks, whichever way the sort runs (the server's NULLS LAST).
      if (av == null && bv != null) return 1
      if (bv == null && av != null) return -1
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true, sensitivity: 'base' })
      if (c !== 0) return s.direction === 'asc' ? c : -c
    }
    return 0
  })
}

/** The rows grouped by `field`: one group per value seen, in `order` where given, "None" last. */
export function groupLocalRows<T extends LocalRow>(rows: readonly T[], field: string, labels: Readonly<Record<string, string>> = {}, order?: readonly string[]): GroupedResults[] {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const v = row[field]
    const keys = Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]
    for (const k of keys.length ? keys : ['__none']) {
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(row)
    }
  }
  const out = [...groups.entries()].map(([key, items]) => ({ key, label: key === '__none' ? 'None' : (labels[key] ?? key), items }))
  const rank = (k: string) => (k === '__none' ? Number.MAX_SAFE_INTEGER : order ? (order.indexOf(k) === -1 ? order.length : order.indexOf(k)) : 0)
  return out.sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label))
}
