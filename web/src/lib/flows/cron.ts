/**
 * Custom schedules: a 5-field cron expression (minute hour day-of-month month
 * day-of-week), parsed and searched here with no dependency, evaluated on the
 * flow's own timezone wall clock (schedule.ts's wallClock / zonedTimeToUtc, so
 * DST behaves as every other cadence: a wall time the clocks skip runs at the
 * shifted-forward instant, a repeated one at its first occurrence).
 *
 * Each field takes `*`, a number, a range `a-b`, a step `*\/n`, `a-b/n` or
 * `a/n` (a to the field's end), and comma lists of those. Month and weekday
 * names (JAN-DEC, SUN-SAT) are accepted. Day-of-week is 0-7 (0 and 7 are
 * Sunday). Every field's values always apply. Only a bare `*` leaves a day
 * field unrestricted (`*\/2` restricts it to every other day); when BOTH day
 * fields are restricted a day matches if EITHER does (classic cron), otherwise
 * it must match both. No seconds, no `?`, `L`, `W` or `#`.
 *
 * The loop engine's tick runs every 5 minutes, so an expression that can fire
 * more often than every CRON_MIN_INTERVAL_MINUTES is refused, as is one with
 * no occurrence within CRON_HORIZON_DAYS (a 31st of February).
 *
 * Pure: safe in the browser (the editor's live preview) and on the server.
 */
import { wallClock, zonedTimeToUtc } from './schedule'

/** The shortest gap a custom schedule may leave between two runs. */
export const CRON_MIN_INTERVAL_MINUTES = 15
/** A custom schedule must run at least once within this many days of being saved. */
export const CRON_HORIZON_DAYS = 366
/**
 * How far computeNextCronRun looks. Saving needs a run within
 * CRON_HORIZON_DAYS, so a 29th-of-February schedule is only accepted when
 * that leap day is less than a year away; after it runs, the next one is
 * four years out, and this window still reaches it.
 */
const SEARCH_DAYS = 366 * 5

export interface CronSchedule {
  /** Sorted, 0-59. */
  minutes: number[]
  /** Sorted, 0-23. */
  hours: number[]
  daysOfMonth: ReadonlySet<number>
  /** 1-12. */
  months: ReadonlySet<number>
  /** 0 (Sunday) - 6 (Saturday); a 7 is folded onto 0. */
  daysOfWeek: ReadonlySet<number>
  /** The day-of-month field was restricted (anything but a bare `*`). */
  domRestricted: boolean
  /** The day-of-week field was restricted (anything but a bare `*`). */
  dowRestricted: boolean
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

interface FieldSpec {
  name: string
  min: number
  max: number
  /** Names for the field's values, the first naming `min`. */
  names?: string[]
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day of week', min: 0, max: 7, names: DOW_NAMES },
]

function parseValue(raw: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n >= spec.min && n <= spec.max ? n : null
  }
  if (spec.names) {
    const i = spec.names.indexOf(raw.toUpperCase())
    if (i >= 0) return spec.min + i
  }
  return null
}

/** One field's values, or an Error naming the field. */
function parseField(text: string, spec: FieldSpec): Set<number> | Error {
  const out = new Set<number>()
  const bad = (why: string) => new Error(`the ${spec.name} field "${text}" ${why}`)
  for (const item of text.split(',')) {
    if (!item) return bad('has an empty list item')
    const [rangePart, stepPart, extra] = item.split('/')
    if (extra !== undefined) return bad('has more than one "/"')
    let step = 1
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) return bad('has a step that is not a positive whole number')
      step = Number(stepPart)
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = spec.min
      // `*` in day-of-week is 0-6 (7 would repeat Sunday).
      hi = spec.name === 'day of week' ? 6 : spec.max
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-')
      if (more !== undefined) return bad('has a range with more than one "-"')
      const x = parseValue(a, spec)
      const y = parseValue(b, spec)
      if (x === null || y === null) return bad(`must be within ${spec.min}-${spec.max}`)
      if (x > y) return bad(`has a range that runs backwards (${a}-${b})`)
      lo = x
      hi = y
    } else {
      const x = parseValue(rangePart, spec)
      if (x === null) return bad(`must be within ${spec.min}-${spec.max}`)
      lo = x
      // `a/n` runs from a to the field's end; a bare value is itself.
      hi = stepPart !== undefined ? (spec.name === 'day of week' ? 6 : spec.max) : x
    }
    for (let v = lo; v <= hi; v += step) out.add(spec.name === 'day of week' && v === 7 ? 0 : v)
  }
  return out
}

/** Parse a 5-field cron expression. Pure; an Error says what is wrong in plain words. */
export function parseCron(expression: string): CronSchedule | Error {
  if (typeof expression !== 'string') return new Error('a custom schedule needs a cron expression')
  const fields = expression.trim().split(/\s+/).filter(Boolean)
  if (fields.length !== 5) {
    return new Error(`a cron expression has 5 fields (minute hour day-of-month month day-of-week); this one has ${fields.length}`)
  }
  const parsed: Set<number>[] = []
  for (let i = 0; i < 5; i++) {
    const values = parseField(fields[i], FIELDS[i])
    if (values instanceof Error) return values
    parsed.push(values)
  }
  return {
    minutes: [...parsed[0]].sort((a, b) => a - b),
    hours: [...parsed[1]].sort((a, b) => a - b),
    daysOfMonth: parsed[2],
    months: parsed[3],
    daysOfWeek: parsed[4],
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
}

/** The expression with its fields separated by single spaces (how it is stored). */
export function normalizeCron(expression: string): string {
  return expression.trim().split(/\s+/).join(' ')
}

function dayMatches(s: CronSchedule, year: number, month: number, day: number): boolean {
  if (!s.months.has(month)) return false
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const dom = s.daysOfMonth.has(day)
  const wd = s.daysOfWeek.has(dow)
  // Both restricted: either matches. Otherwise both sets apply (a bare `*`
  // holds every value, so it never narrows the other field).
  if (s.domRestricted && s.dowRestricted) return dom || wd
  return dom && wd
}

/**
 * The shortest gap, in minutes, between two runs of a day's times, counting
 * the wrap from a day's last run to the next day's first (conservatively, as
 * if the next day ran too). 1440 for a single time a day.
 */
export function cronMinIntervalMinutes(s: CronSchedule): number {
  const times = s.hours.flatMap((h) => s.minutes.map((m) => h * 60 + m)).sort((a, b) => a - b)
  if (times.length <= 1) return 1440
  let min = 1440 - times[times.length - 1] + times[0]
  for (let i = 1; i < times.length; i++) min = Math.min(min, times[i] - times[i - 1])
  return min
}

/**
 * First instant STRICTLY after `from` at which the schedule runs, on the
 * `timeZone` wall clock; null when none within `searchDays` days.
 */
export function computeNextCronRun(s: CronSchedule, timeZone: string, from: Date, searchDays: number = SEARCH_DAYS): Date | null {
  const start = wallClock(from, timeZone)
  const fromMs = from.getTime()
  for (let i = 0; i <= searchDays; i++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i))
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    if (!dayMatches(s, year, month, day)) continue
    // Every time of the day, the smallest one after `from`: around a DST
    // switch the wall order and the instant order can differ.
    let best: number | null = null
    for (const h of s.hours) {
      for (const m of s.minutes) {
        const t = zonedTimeToUtc(year, month, day, h, m, timeZone).getTime()
        if (t > fromMs && (best === null || t < best)) best = t
      }
    }
    if (best !== null) return new Date(best)
  }
  return null
}

/** The next `count` runs after `from` (fewer when the schedule runs out). */
export function nextCronRuns(s: CronSchedule, timeZone: string, from: Date, count: number): Date[] {
  const out: Date[] = []
  let cursor = from
  for (let i = 0; i < count; i++) {
    const next = computeNextCronRun(s, timeZone, cursor)
    if (!next) break
    out.push(next)
    cursor = next
  }
  return out
}

/**
 * Validate a custom schedule as a loop can store it: it parses, never runs
 * more often than every CRON_MIN_INTERVAL_MINUTES, and runs at least once in
 * the CRON_HORIZON_DAYS after `now`. Returns the stored form or an Error.
 */
export function validateCronExpression(expression: unknown, timeZone: string, now: Date = new Date()): { cron: string; schedule: CronSchedule } | Error {
  if (typeof expression !== 'string' || !expression.trim()) return new Error('a custom schedule needs a cron expression, e.g. "0 9 * * 1-5"')
  const schedule = parseCron(expression)
  if (schedule instanceof Error) return schedule
  if (cronMinIntervalMinutes(schedule) < CRON_MIN_INTERVAL_MINUTES) {
    return new Error(`a custom schedule can run at most every ${CRON_MIN_INTERVAL_MINUTES} minutes`)
  }
  if (!computeNextCronRun(schedule, timeZone, now, CRON_HORIZON_DAYS)) {
    return new Error(`this cron expression never runs in the next ${CRON_HORIZON_DAYS} days`)
  }
  return { cron: normalizeCron(expression), schedule }
}
