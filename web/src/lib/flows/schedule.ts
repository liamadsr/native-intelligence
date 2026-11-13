/**
 * Pure next-occurrence math for schedule-trigger flows (the loop engine's
 * clock). No new deps: IANA timezone handling goes through
 * Intl.DateTimeFormat part-extraction (the same trick date-fns-tz uses).
 *
 * computeNextRun(config, from) returns the first instant STRICTLY AFTER
 * `from` matching the cadence, evaluated on the flow's own timezone wall
 * clock:
 *   - hourly:    next top-of-hour (timezone-irrelevant)
 *   - daily:     every day at `time`
 *   - weekdays:  Mon-Fri at `time` (weekend skipped in the flow's tz)
 *   - weekly:    every `weekday` (0=Sun..6=Sat) at `time`
 *   - monthly:   every month on `day_of_month` (1-28) at `time`
 *   - cron:      a 5-field cron expression (cron.ts)
 *   - once:      `run_at`, one time; null once it has passed
 *
 * DST behavior (unit-tested both directions in schedule.test.ts):
 *   - A wall time that doesn't exist on a spring-forward day (e.g. 02:30
 *     America/Los_Angeles on the switch date) resolves to the shifted-forward
 *     instant (03:30 local) — cron semantics, never silently skips the day.
 *   - An ambiguous fall-back wall time (occurs twice) resolves to its FIRST
 *     occurrence (the pre-transition offset).
 */
import type { ScheduleTriggerConfig } from './types'
import { computeNextCronRun, parseCron } from './cron'

const HOUR_MS = 3_600_000

interface WallDate {
  year: number
  /** 1-12 */
  month: number
  day: number
}

interface WallClock extends WallDate {
  hour: number
  minute: number
  second: number
}

// Intl.DateTimeFormat construction is expensive; the tick calls this in a
// loop over due flows, so cache one formatter per timezone.
const dtfCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone)
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    dtfCache.set(timeZone, dtf)
  }
  return dtf
}

/** The wall-clock reading of `date` in `timeZone`. */
export function wallClock(date: Date, timeZone: string): WallClock {
  const parts = getFormatter(timeZone).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    return part ? Number(part.value) : 0
  }
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some ICU versions render midnight as "24" with hour12:false; normalize.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  }
}

/** Offset (ms) of `timeZone` at instant `date`: wall-clock minus UTC. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const w = wallClock(date, timeZone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  // The formatter only reads whole seconds; compare against the truncated
  // instant so sub-second input can't skew the offset.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant, DST-aware:
 * nonexistent times (spring-forward gap) resolve to the shifted-forward
 * instant; ambiguous times (fall-back overlap) to their first occurrence.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const base = Date.UTC(year, month - 1, day, hour, minute, 0)
  const offset1 = tzOffsetMs(new Date(base), timeZone)
  const ts1 = base - offset1
  const offset2 = tzOffsetMs(new Date(ts1), timeZone)
  if (offset1 === offset2) return new Date(ts1)
  const ts2 = base - offset2
  // Offsets disagree: we're at a DST boundary. Prefer the candidate whose
  // wall clock round-trips to the requested time (for an ambiguous fall-back
  // time this picks the earlier occurrence); if neither round-trips, the wall
  // time doesn't exist (spring-forward gap) — take the later instant.
  for (const ts of [ts1, ts2]) {
    const w = wallClock(new Date(ts), timeZone)
    if (w.day === day && w.hour === hour && w.minute === minute) return new Date(ts)
  }
  return new Date(Math.max(ts1, ts2))
}

/** Calendar-date shift; Date.UTC normalizes month/year rollover. */
function addDays(date: WallDate, n: number): WallDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + n))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Weekday of a calendar date (0=Sun..6=Sat). Pure calendar math, no tz. */
function weekdayOf(date: WallDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

function isEligibleDay(config: ScheduleTriggerConfig, date: WallDate): boolean {
  const weekday = weekdayOf(date)
  if (config.cadence === 'weekdays') return weekday >= 1 && weekday <= 5
  // Validator requires weekday for weekly; default Monday defensively.
  if (config.cadence === 'weekly') return weekday === (config.weekday ?? 1)
  // Validator holds day_of_month to 1-28; default the 1st defensively.
  if (config.cadence === 'monthly') return date.day === (config.day_of_month ?? 1)
  return true // daily
}

/**
 * Validator (validateScheduleConfig) enforces 'HH:mm'; parse defensively so
 * a hand-edited row degrades to 09:00 rather than a crashed dispatcher.
 */
function parseTime(time: string | undefined): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? '')
  if (!m) return { hour: 9, minute: 0 }
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) }
}

/** 'YYYY-MM-DDTHH:mm' (seconds allowed and ignored): a once-schedule's stored wall time. */
const RUN_AT_WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/

/**
 * A once-schedule's instant: `run_at` as a wall time in `timeZone` (the stored
 * form), or an ISO instant with its own offset. Null when it doesn't parse.
 */
export function runAtInstant(runAt: string | undefined, timeZone: string): Date | null {
  if (typeof runAt !== 'string') return null
  const m = RUN_AT_WALL_RE.exec(runAt.trim())
  if (m) {
    const [year, month, day, hour, minute] = m.slice(1, 6).map(Number)
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
    const check = new Date(Date.UTC(year, month - 1, day))
    if (check.getUTCMonth() !== month - 1) return null // 31 April
    return zonedTimeToUtc(year, month, day, hour, minute, timeZone)
  }
  // With an offset or Z: an absolute instant.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(runAt.trim())) return null
  const t = Date.parse(runAt)
  return Number.isNaN(t) ? null : new Date(t)
}

/** An instant as the 'YYYY-MM-DDTHH:mm' wall time in `timeZone` (how run_at is stored). */
export function toWallTime(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`
}

/**
 * First instant strictly after `from` at which the schedule is due. Pure —
 * the caller persists it to flow.next_run_at. Null when there is none: a
 * once-schedule whose time has passed, or a custom schedule with no run left
 * in the search window.
 */
export function computeNextRun(config: ScheduleTriggerConfig, from: Date): Date | null {
  if (config.cadence === 'hourly') {
    return new Date(Math.floor(from.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS)
  }
  if (config.cadence === 'once') {
    const at = runAtInstant(config.run_at, config.timezone)
    return at && at.getTime() > from.getTime() ? at : null
  }
  if (config.cadence === 'cron') {
    const schedule = parseCron(config.cron ?? '')
    // Validated on write; a hand-edited row that no longer parses never fires.
    if (schedule instanceof Error) return null
    return computeNextCronRun(schedule, config.timezone, from)
  }

  const { hour, minute } = parseTime(config.time)

  // Walk forward one wall-clock day at a time from `from`'s date in the
  // flow's timezone until an eligible day yields an instant strictly after
  // `from`. Bounded: weekly needs at most 8 hops (7 days out, +1 for the
  // time-already-passed-today rollover); monthly at most 62.
  const hops = config.cadence === 'monthly' ? 63 : 9
  let date: WallDate = wallClock(from, config.timezone)
  for (let i = 0; i < hops; i++) {
    if (isEligibleDay(config, date)) {
      const candidate = zonedTimeToUtc(date.year, date.month, date.day, hour, minute, config.timezone)
      if (candidate.getTime() > from.getTime()) return candidate
    }
    date = addDays(date, 1)
  }
  // Unreachable for valid configs — loud beats a silently-never-firing flow.
  throw new Error(`computeNextRun: no occurrence within ${hops} days for cadence "${config.cadence}"`)
}

/**
 * Is this `flow/schedule.due` the one fire of a once-schedule? The tick
 * switches a once loop off as it claims the fire (so it reads as finished),
 * so the dispatcher runs a switched-off loop only when it is a once-schedule
 * and the event is for its own run_at (an edited time is a different fire).
 */
export function isOnceFire(config: unknown, scheduledFor: string | null | undefined): boolean {
  const cfg = (config ?? {}) as Partial<ScheduleTriggerConfig>
  if (cfg.cadence !== 'once' || typeof cfg.timezone !== 'string') return false
  const at = runAtInstant(cfg.run_at, cfg.timezone)
  const due = Date.parse(scheduledFor ?? '')
  return !!at && Number.isFinite(due) && at.getTime() === due
}
