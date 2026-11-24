// ============================================================
// Roadmap layout — the pure parts
// ============================================================
//
// The roadmap draws a view's rows on a time axis: each row's left cell is the
// record, its timeline cell a bar from the record's start to its end. This
// module is everything about that picture that is not React: which kinds have
// dates and in which columns, how a day becomes a pixel at each zoom, the axis
// ticks, what a drag on a bar changes, and the rows a grouped result flattens
// into. `components/views/view-roadmap.tsx` draws it.
//
// Days are LOCAL calendar days throughout. A project's `start_date` and
// `target_date` are `date` columns ('YYYY-MM-DD', no zone); an action's
// `due_at` is a timestamp whose local day is the day the list shows. Day
// arithmetic goes through date-fns on local dates, so a move across a daylight
// saving change keeps the action's time of day rather than shifting an hour.

import { addDays, differenceInCalendarDays, format, parseISO, startOfDay, startOfMonth, startOfQuarter, addMonths, addQuarters, startOfISOWeek } from 'date-fns'
import type { GroupedResults, ViewEntityType } from './types'
import { groupCount, isLazyGroup } from './lazy-done-groups'

// ── Which kinds get a roadmap ───────────────────────────────

/**
 * Where a kind keeps its dates. `start` is null for a kind with one date: it
 * is drawn as a marker on that day, moved by dragging, never stretched.
 *
 * - action: `due_at` only (timestamptz). There is no start column, and none
 *   was added: a new column in the action list's select would break every
 *   action list on a server whose database lacks it, for a date nothing else
 *   in the app sets or reads. An action is a marker on its due day.
 * - project: `start_date` and `target_date` (date).
 * - initiative: `target_date` only (date).
 *
 * Cycles and milestones have dates too, but neither is a view kind — they have
 * no list, filters or saved views to draw a roadmap from.
 */
export interface RoadmapDateFields {
  start: { field: string; type: 'date' | 'timestamp' } | null
  end: { field: string; type: 'date' | 'timestamp' }
}

export const ROADMAP_DATE_FIELDS: Partial<Record<ViewEntityType, RoadmapDateFields>> = {
  action: { start: null, end: { field: 'due_at', type: 'timestamp' } },
  project: { start: { field: 'start_date', type: 'date' }, end: { field: 'target_date', type: 'date' } },
  initiative: { start: null, end: { field: 'target_date', type: 'date' } },
}

export function supportsRoadmap(entityType: ViewEntityType): boolean {
  return entityType in ROADMAP_DATE_FIELDS
}

// ── Zoom ────────────────────────────────────────────────────

export type RoadmapZoom = 'day' | 'week' | 'month' | 'quarter'

/** Closest first. Day: one day wide enough for its weekday (Liam, 11-23: "lets add a day view"). */
export const ROADMAP_ZOOMS: readonly RoadmapZoom[] = ['day', 'week', 'month', 'quarter']

/** Pixels one day takes at each zoom. */
export const PX_PER_DAY: Record<RoadmapZoom, number> = {
  day: 96,
  week: 36,
  month: 12,
  quarter: 4,
}

export const ROADMAP_ZOOM_LABELS: Record<RoadmapZoom, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
}

export function isRoadmapZoom(v: unknown): v is RoadmapZoom {
  return typeof v === 'string' && (ROADMAP_ZOOMS as readonly string[]).includes(v)
}

// ── Dates ↔ pixels ──────────────────────────────────────────

/** A value from a row's date column, as the local day it names, or null. */
export function parseDay(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null
  // A bare date names a calendar day; parseISO reads it as local midnight.
  const d = parseISO(value)
  return Number.isNaN(d.getTime()) ? null : startOfDay(d)
}

/** Whole days from `origin` to `day` (both local days). */
export function dayIndex(day: Date, origin: Date): number {
  return differenceInCalendarDays(day, origin)
}

/** The x of a day's left edge on the timeline. */
export function dateToX(day: Date, origin: Date, zoom: RoadmapZoom): number {
  return dayIndex(day, origin) * PX_PER_DAY[zoom]
}

/** The day under an x on the timeline (floor: x inside a day is that day). */
export function xToDate(x: number, origin: Date, zoom: RoadmapZoom): Date {
  return addDays(origin, Math.floor(x / PX_PER_DAY[zoom]))
}

/** A pixel delta as a whole number of days, rounded to the nearest day. */
export function pxToDays(dx: number, zoom: RoadmapZoom): number {
  const d = Math.round(dx / PX_PER_DAY[zoom])
  return d === 0 ? 0 : d // never -0
}

// ── A row's span ────────────────────────────────────────────

/**
 * What a row draws. `kind`:
 * - `bar`: both days known (start ≤ end), stretched over them.
 * - `open-end`: a start and no end: a bar of DEFAULT_SPAN_DAYS, faded at the end.
 * - `open-start`: an end and no start, on a kind that has a start column.
 * - `marker`: a one-date kind (an action's due day, an initiative's target).
 * - `none`: no date at all — the row is listed, its timeline empty.
 */
export interface RoadmapSpan {
  kind: 'bar' | 'open-end' | 'open-start' | 'marker' | 'none'
  start: Date | null
  end: Date | null
}

/** How many days a bar with only one of its two dates is drawn over. */
export const DEFAULT_SPAN_DAYS = 14

export function itemSpan(entityType: ViewEntityType, item: Record<string, unknown>): RoadmapSpan {
  const f = ROADMAP_DATE_FIELDS[entityType]
  if (!f) return { kind: 'none', start: null, end: null }
  const end = parseDay(item[f.end.field])
  if (!f.start) return end ? { kind: 'marker', start: end, end } : { kind: 'none', start: null, end: null }
  const start = parseDay(item[f.start.field])
  if (start && end) {
    // A target before its start is bad data, not a reason to draw nothing:
    // draw it over the two days in order.
    return start <= end ? { kind: 'bar', start, end } : { kind: 'bar', start: end, end: start }
  }
  if (start) return { kind: 'open-end', start, end: addDays(start, DEFAULT_SPAN_DAYS - 1) }
  if (end) return { kind: 'open-start', start: addDays(end, -(DEFAULT_SPAN_DAYS - 1)), end }
  return { kind: 'none', start: null, end: null }
}

/** The pixel box a span is drawn in: left edge of its first day to the right edge of its last. */
export function spanBox(span: RoadmapSpan, origin: Date, zoom: RoadmapZoom): { left: number; width: number } | null {
  if (!span.start || !span.end) return null
  const left = dateToX(span.start, origin, zoom)
  const width = (dayIndex(span.end, span.start) + 1) * PX_PER_DAY[zoom]
  return { left, width }
}

// ── Dragging a bar ──────────────────────────────────────────

export type RoadmapDragMode = 'move' | 'start' | 'end'

/** A day in the form its column stores: 'YYYY-MM-DD' for a date column. */
function formatDateColumn(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/**
 * Shift a stored value by whole days. A timestamp keeps its local time of day
 * (an all-day action stays at the time the app stores all-day dues at).
 */
function shiftValue(value: unknown, days: number, type: 'date' | 'timestamp'): string | null {
  if (typeof value !== 'string' || !value) return null
  const d = parseISO(value)
  if (Number.isNaN(d.getTime())) return null
  const moved = addDays(d, days)
  return type === 'date' ? formatDateColumn(moved) : moved.toISOString()
}

/**
 * The span while a drag is under way: what the bar looks like with `days`
 * applied in `mode`. A resize never crosses the other end (a bar is at least
 * one day long).
 */
export function previewSpan(span: RoadmapSpan, mode: RoadmapDragMode, days: number): RoadmapSpan {
  if (!span.start || !span.end || days === 0) return span
  if (mode === 'move') return { ...span, start: addDays(span.start, days), end: addDays(span.end, days) }
  if (mode === 'start') {
    const start = addDays(span.start, days)
    return { ...span, start: start > span.end ? span.end : start }
  }
  const end = addDays(span.end, days)
  return { ...span, end: end < span.start ? span.start : end }
}

/**
 * The fields a finished drag writes, or null when it changes nothing.
 *
 * - A move shifts every date the row HAS (an open-ended project moves its one
 *   date; the drawn default length is not written).
 * - Dragging an end writes that end. On an open-ended bar that is how the
 *   missing date gets set: drag the faded end to where it should be.
 * - A marker only moves.
 */
export function dragPatch(
  entityType: ViewEntityType,
  item: Record<string, unknown>,
  mode: RoadmapDragMode,
  days: number,
): Record<string, string | null> | null {
  const f = ROADMAP_DATE_FIELDS[entityType]
  if (!f || days === 0) return null
  const span = itemSpan(entityType, item)
  if (span.kind === 'none') return null
  if (span.kind === 'marker' || mode === 'move') {
    const patch: Record<string, string | null> = {}
    const end = shiftValue(item[f.end.field], days, f.end.type)
    if (end) patch[f.end.field] = end
    if (f.start) {
      const start = shiftValue(item[f.start.field], days, f.start.type)
      if (start) patch[f.start.field] = start
    }
    return Object.keys(patch).length ? patch : null
  }
  if (!f.start) return null
  const next = previewSpan(span, mode, days)
  if (mode === 'start') {
    if (!next.start || (span.start && dayIndex(next.start, span.start) === 0)) return null
    return { [f.start.field]: formatDateColumn(next.start) }
  }
  if (!next.end || (span.end && dayIndex(next.end, span.end) === 0)) return null
  return { [f.end.field]: f.end.type === 'date' ? formatDateColumn(next.end) : next.end.toISOString() }
}

/**
 * The fields that schedule a row with no dates on `day`: a one-date kind gets
 * that date; a two-date kind starts that day and runs DEFAULT_SPAN_DAYS.
 * An action's due time is local noon, so its day reads the same in every
 * zone a teammate might be in a few hours off.
 */
export function schedulePatch(entityType: ViewEntityType, day: Date): Record<string, string> | null {
  const f = ROADMAP_DATE_FIELDS[entityType]
  if (!f) return null
  const asValue = (d: Date, type: 'date' | 'timestamp') => {
    if (type === 'date') return formatDateColumn(d)
    const noon = new Date(d)
    noon.setHours(12, 0, 0, 0)
    return noon.toISOString()
  }
  if (!f.start) return { [f.end.field]: asValue(day, f.end.type) }
  return {
    [f.start.field]: asValue(day, f.start.type),
    [f.end.field]: asValue(addDays(day, DEFAULT_SPAN_DAYS - 1), f.end.type),
  }
}

/** The values a patch replaces, to undo it with. */
export function undoPatch(item: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const prior: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) prior[k] = item[k] ?? null
  return prior
}

// ── The range drawn ─────────────────────────────────────────

/**
 * The first and last day the timeline draws: whole months around today and
 * every dated row, with room on both sides to drag into. At least three months
 * before today and nine after, so an empty roadmap still has a year to schedule
 * on.
 */
export function timelineRange(spans: readonly RoadmapSpan[], today: Date): { start: Date; end: Date } {
  let min = addMonths(today, -3)
  let max = addMonths(today, 9)
  for (const s of spans) {
    if (s.start && s.start < min) min = s.start
    if (s.end && s.end > max) max = s.end
  }
  const start = startOfMonth(addMonths(min, -1))
  const end = addDays(startOfMonth(addMonths(max, 2)), -1)
  return { start, end }
}

// ── Axis ────────────────────────────────────────────────────

export interface AxisTick {
  x: number
  label: string
  /** The day it marks. */
  date: Date
}

/**
 * The header's two rows. Top: months ("October 2026" on the first shown and
 * on each January, the month name otherwise), or quarters at quarter zoom.
 * Bottom: each day with its weekday at day zoom ("Mon 24"; the month's name
 * on its 1st, "Tue Dec 1", as the month above may be off screen), each day at
 * week zoom, each week's Monday at month zoom (its day number), each month at
 * quarter zoom. `lines` are where the grid draws its
 * faint verticals: the bottom row's ticks.
 */
export function axisTicks(start: Date, end: Date, zoom: RoadmapZoom): { major: AxisTick[]; minor: AxisTick[] } {
  const major: AxisTick[] = []
  const minor: AxisTick[] = []
  const x = (d: Date) => dateToX(d, start, zoom)
  if (zoom === 'quarter') {
    for (let q = startOfQuarter(start); q <= end; q = addQuarters(q, 1)) {
      const at = q < start ? start : q
      major.push({ x: x(at), date: at, label: `Q${Math.floor(q.getMonth() / 3) + 1} ${q.getFullYear()}` })
    }
    for (let m = startOfMonth(start); m <= end; m = addMonths(m, 1)) {
      if (m >= start) minor.push({ x: x(m), date: m, label: format(m, 'MMM') })
    }
    return { major, minor }
  }
  let first = true
  for (let m = startOfMonth(start); m <= end; m = addMonths(m, 1)) {
    const at = m < start ? start : m
    major.push({ x: x(at), date: at, label: first || m.getMonth() === 0 ? format(m, 'MMMM yyyy') : format(m, 'MMMM') })
    first = false
  }
  if (zoom === 'day') {
    for (let d = start; d <= end; d = addDays(d, 1)) minor.push({ x: x(d), date: d, label: format(d, d.getDate() === 1 ? 'EEE MMM d' : 'EEE d') })
  } else if (zoom === 'week') {
    for (let d = start; d <= end; d = addDays(d, 1)) minor.push({ x: x(d), date: d, label: format(d, 'd') })
  } else {
    let w = startOfISOWeek(start)
    if (w < start) w = addDays(w, 7)
    for (; w <= end; w = addDays(w, 7)) minor.push({ x: x(w), date: w, label: format(w, 'd') })
  }
  return { major, minor }
}

// ── Rows ────────────────────────────────────────────────────

export type RoadmapRow =
  | { type: 'group'; key: string; label: string; count: number; depth: number; collapsed: boolean; group: GroupedResults; lazy: boolean }
  | { type: 'item'; key: string; item: Record<string, unknown>; depth: number }
  | { type: 'empty'; key: string; depth: number; label: string; groupKey: string }

/**
 * A view's result as the roadmap's rows, top to bottom. A grouped result is a
 * header per group (and per sub-group) followed, unless collapsed, by its rows.
 * A finished group whose rows load on demand (lazy-done-groups) starts
 * collapsed, the way the list draws it; `collapsed` holds the keys the person
 * toggled AWAY from their default.
 */
export function flattenRoadmapRows(
  data: Record<string, unknown>[] | GroupedResults[],
  toggled: ReadonlySet<string>,
): RoadmapRow[] {
  const isGrouped = data.length > 0 && typeof (data[0] as GroupedResults).key === 'string'
    && Array.isArray((data[0] as GroupedResults).items ?? (data[0] as GroupedResults).subGroups)
  if (!isGrouped) {
    return (data as Record<string, unknown>[]).map((item, i) => ({
      type: 'item' as const, key: String(item.id ?? i), item, depth: 0,
    }))
  }
  const rows: RoadmapRow[] = []
  const walk = (groups: GroupedResults[], depth: number, prefix: string) => {
    for (const g of groups) {
      const key = `${prefix}${g.key}`
      const lazy = isLazyGroup(g)
      const collapsed = lazy !== toggled.has(key)
      rows.push({ type: 'group', key, label: g.label, count: groupCount(g), depth, collapsed, group: g, lazy })
      if (collapsed) continue
      if (g.subGroups?.length) {
        walk(g.subGroups, depth + 1, `${key}/`)
      } else {
        const items = g.items ?? []
        for (const item of items) rows.push({ type: 'item', key: `${key}:${String(item.id)}`, item, depth })
        if (lazy && items.length === 0) rows.push({ type: 'empty', key: `${key}:empty`, depth, label: 'Loading…', groupKey: g.key })
      }
    }
  }
  walk(data as GroupedResults[], 0, '')
  return rows
}
