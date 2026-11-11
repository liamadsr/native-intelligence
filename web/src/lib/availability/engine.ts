/**
 * The availability engine: when a person can meet. Their working hours (a
 * weekly pattern in their zone, a date's override replacing that whole day)
 * minus their busy time, as plain intervals.
 *
 *   - A timed busy block takes its own time, widened by the buffer on both
 *     sides.
 *   - An all-day block (a day off, travel) takes each local day it covers
 *     for at least half the day (./zone.ts allDayTakes): never offered.
 *   - Nothing is offered before `notBefore`, and nothing starts after
 *     `startNotAfter`.
 *
 * Two readings of the same days: {@link openTimes} cuts each working range
 * into a fixed grid from its start (a booking page's slots), and
 * {@link freeWindows} keeps the whole free stretches (a "find a time"
 * answer). Busy time comes in as blocks with no titles
 * (src/lib/guests/free-busy.ts): the engine never sees what an event is.
 *
 * A caller that could not read someone's calendar must not call this with an
 * empty busy list: unread is unknown, never free (./busy.ts reads strictly).
 *
 * Pure.
 */
import type { BusyBlock } from '@/lib/guests/free-busy'
import { addDays, allDayTakes, clockMinutes, dayKey, localDate, minutesClock, zonedTime, type LocalDay } from './zone'

/** A stretch of a local day, HH:MM to HH:MM (the end may be 24:00). */
export interface DayRange {
  start: string
  end: string
}

export interface AvailabilitySchedule {
  timeZone: string
  /** Working ranges per weekday, 0 Sunday to 6 Saturday; an empty day is a day off. */
  weekly: readonly (readonly DayRange[])[]
  /** A date (YYYY-MM-DD) whose ranges replace that whole day; an empty list is a day off. */
  overrides?: Readonly<Record<string, readonly DayRange[]>>
}

/** An interval of instants, [start, end) in ms. */
export interface Span {
  start: number
  end: number
}

const WORKDAY: readonly DayRange[] = [{ start: '09:00', end: '18:00' }]
/** The hours a person who set none gets: weekdays 9 to 6. */
export const DEFAULT_WEEKLY: readonly (readonly DayRange[])[] = [[], WORKDAY, WORKDAY, WORKDAY, WORKDAY, WORKDAY, []]

const MINUTE_MS = 60_000

export interface AvailabilityDays {
  schedule: AvailabilitySchedule
  busy: readonly BusyBlock[]
  /** First local day to look at, in the schedule's zone. */
  firstDay: LocalDay
  days: number
  /** Minutes kept clear on both sides of a timed busy block. */
  bufferMinutes?: number
}

interface WorkingDay {
  day: LocalDay
  ranges: readonly DayRange[]
}

interface Busy {
  timed: Span[]
  allDay: Span[]
}

function readBusy(blocks: readonly BusyBlock[], bufferMinutes: number): Busy {
  const buffer = Math.max(0, bufferMinutes) * MINUTE_MS
  const timed: Span[] = []
  const allDay: Span[] = []
  for (const block of blocks) {
    const start = Date.parse(block.start)
    const end = Date.parse(block.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    if (block.allDay) allDay.push({ start, end })
    else timed.push({ start: start - buffer, end: end + buffer })
  }
  return { timed, allDay }
}

/** The days that have working ranges and no all-day block, in order. */
function workingDays(input: AvailabilityDays, busy: Busy): WorkingDay[] {
  const { schedule } = input
  const out: WorkingDay[] = []
  for (let i = 0; i < input.days; i++) {
    const day = addDays(input.firstDay, i)
    const ranges = schedule.overrides?.[dayKey(day)] ?? schedule.weekly[day.weekday] ?? []
    if (!ranges.length) continue
    const dayStart = zonedTime(day, '00:00', schedule.timeZone)
    const dayEnd = zonedTime(addDays(day, 1), '00:00', schedule.timeZone)
    if (busy.allDay.some((block) => allDayTakes(block, dayStart, dayEnd))) continue
    out.push({ day, ranges })
  }
  return out
}

const overlaps = (spans: readonly Span[], from: number, to: number) => spans.some((s) => s.start < to && s.end > from)

export interface OpenTimesInput extends AvailabilityDays {
  /** How long each offered time is. */
  durationMinutes: number
  /** The grid's step from each working range's start; default the duration. */
  stepMinutes?: number
  /** No offered time starts before this instant. */
  notBefore?: number
  /** No offered time starts after this instant. */
  startNotAfter?: number
  max?: number
}

/**
 * The open times on a fixed grid: each working range cut from its start into
 * steps, a time kept when it fits the range and overlaps no busy block.
 * Soonest first.
 */
export function openTimes(input: OpenTimesInput): Span[] {
  const { timeZone } = input.schedule
  const duration = Math.max(1, Math.round(input.durationMinutes))
  const step = Math.max(1, Math.round(input.stepMinutes ?? duration))
  const max = input.max ?? Number.POSITIVE_INFINITY
  const busy = readBusy(input.busy, input.bufferMinutes ?? 0)
  const out: Span[] = []
  for (const { day, ranges } of workingDays(input, busy)) {
    for (const range of ranges) {
      const last = clockMinutes(range.end)
      for (let m = clockMinutes(range.start); m + duration <= last; m += step) {
        if (out.length >= max) return out
        const start = zonedTime(day, minutesClock(m), timeZone)
        const end = start + duration * MINUTE_MS
        if (input.notBefore !== undefined && start < input.notBefore) continue
        if (input.startNotAfter !== undefined && start > input.startNotAfter) continue
        if (overlaps(busy.timed, start, end)) continue
        out.push({ start, end })
      }
    }
  }
  return out
}

/** `spans` with every part inside `holes` cut out. Both in any order. */
export function subtractSpans(spans: readonly Span[], holes: readonly Span[]): Span[] {
  const cuts = [...holes].sort((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const span of spans) {
    let at = span.start
    for (const cut of cuts) {
      if (cut.end <= at) continue
      if (cut.start >= span.end) break
      if (cut.start > at) out.push({ start: at, end: cut.start })
      at = Math.max(at, cut.end)
      if (at >= span.end) break
    }
    if (at < span.end) out.push({ start: at, end: span.end })
  }
  return out
}

export interface FreeWindowsInput extends AvailabilityDays {
  /** A window shorter than this is dropped. */
  minMinutes: number
  /** Nothing before this instant counts. */
  notBefore?: number
  /** Nothing after this instant counts. */
  notAfter?: number
}

/** The free stretches of the working hours, each at least `minMinutes` long. Soonest first. */
export function freeWindows(input: FreeWindowsInput): Span[] {
  const { timeZone } = input.schedule
  const busy = readBusy(input.busy, input.bufferMinutes ?? 0)
  const working: Span[] = []
  for (const { day, ranges } of workingDays(input, busy)) {
    for (const range of ranges) {
      // 24:00 is the next day's midnight.
      const end = range.end === '24:00' ? zonedTime(addDays(day, 1), '00:00', timeZone) : zonedTime(day, range.end, timeZone)
      const start = Math.max(zonedTime(day, range.start, timeZone), input.notBefore ?? Number.NEGATIVE_INFINITY)
      const stop = Math.min(end, input.notAfter ?? Number.POSITIVE_INFINITY)
      if (stop > start) working.push({ start, end: stop })
    }
  }
  const min = Math.max(1, input.minMinutes) * MINUTE_MS
  return subtractSpans(working, busy.timed)
    .filter((span) => span.end - span.start >= min)
    .sort((a, b) => a.start - b.start)
}

const QUARTER_MS = 15 * MINUTE_MS
/** Local times a suggestion is looked for first: mid-morning, then early afternoon, each up to two hours on. */
const PREFERRED_CLOCKS = ['10:00', '14:00'] as const
const PREFERRED_SPAN_MS = 2 * 60 * MINUTE_MS

/**
 * Up to `max` times to offer out of the free windows, one per local day so
 * the choices differ: on each day the first quarter-hour start from 10:00 to
 * noon, else from 2:00 to 4:00, else the day's earliest. Soonest day first.
 */
export function suggestTimes(windows: readonly Span[], options: { durationMinutes: number; timeZone: string; max?: number }): Span[] {
  const duration = Math.max(1, options.durationMinutes) * MINUTE_MS
  const max = options.max ?? 3
  const byDay = new Map<string, { day: LocalDay; starts: number[] }>()
  for (const window of windows) {
    const first = Math.ceil(window.start / QUARTER_MS) * QUARTER_MS
    for (let start = first; start + duration <= window.end; start += QUARTER_MS) {
      const day = localDate(start, options.timeZone)
      const key = dayKey(day)
      const entry = byDay.get(key) ?? { day, starts: [] }
      entry.starts.push(start)
      byDay.set(key, entry)
    }
  }
  const out: Span[] = []
  for (const key of [...byDay.keys()].sort()) {
    if (out.length >= max) break
    const { day, starts } = byDay.get(key)!
    starts.sort((a, b) => a - b)
    let pick: number | undefined
    for (const clock of PREFERRED_CLOCKS) {
      const from = zonedTime(day, clock, options.timeZone)
      pick = starts.find((s) => s >= from && s < from + PREFERRED_SPAN_MS)
      if (pick !== undefined) break
    }
    const start = pick ?? starts[0]
    out.push({ start, end: start + duration })
  }
  return out
}
