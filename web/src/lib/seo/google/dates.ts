/**
 * Report dates for Search Console and Google Analytics: YYYY-MM-DD strings,
 * both ends inclusive. Search Console reads them in Pacific Time and trails
 * by about three days; Analytics reads them in the property's own time zone
 * and is complete up to yesterday there. Pure: `now` is passed in.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { GoogleSeoError } from './errors'
import type { GoogleProduct, GscDateRange } from './view'

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/
/** Search Console's data trails by two or three days: a preset window ends before it. */
export const GSC_DATA_LAG_DAYS = 3
/** Search Console keeps 16 months. */
const GSC_LOOKBACK_MONTHS = 16

export interface DateRange {
  start_date: string
  end_date: string
}

/** A real calendar date in YYYY-MM-DD, or false. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  )
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function shiftDate(value: string, days: number): string {
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(ms)) throw new RangeError('Invalid date.')
  return utcDate(ms + days * DAY_MS)
}

export function inclusiveDays(start: string, end: string): number {
  return (
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        DAY_MS,
    ) + 1
  )
}

/** Calendar months back in UTC, the day clamped to the target month's length. */
function subtractUtcMonths(date: Date, months: number): Date {
  const day = date.getUTCDate()
  const d = new Date(date)
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const daysInTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate()
  d.setUTCDate(Math.min(day, daysInTarget))
  return d
}

function presetStart(end: Date, range: GscDateRange): Date {
  const d = new Date(end)
  switch (range) {
    case 'last_7_days':
      d.setUTCDate(d.getUTCDate() - 6)
      return d
    case 'last_28_days':
      d.setUTCDate(d.getUTCDate() - 27)
      return d
    case 'last_3_months':
      return subtractUtcMonths(d, 3)
    case 'last_6_months':
      return subtractUtcMonths(d, 6)
    case 'last_12_months':
      return subtractUtcMonths(d, 12)
    case 'last_16_months':
      return subtractUtcMonths(d, 16)
  }
}

/** Both dates or neither; real dates; start on or before end. Throws INVALID_REQUEST. */
export function checkDatePair(
  product: GoogleProduct,
  start: string | undefined,
  end: string | undefined,
): DateRange | null {
  if (Boolean(start) !== Boolean(end)) {
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      product,
      'Give both a start and an end date, or neither.',
    )
  }
  if (!start || !end) return null
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) {
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      product,
      'Dates are YYYY-MM-DD, the start on or before the end.',
    )
  }
  return { start_date: start, end_date: end }
}

/**
 * Search Console's window: explicit dates (the start held to the 16 months
 * Google keeps), or a preset ending three days ago (default last 28 days).
 */
export function resolveSearchConsoleRange(
  input: { date_range?: GscDateRange; start_date?: string; end_date?: string },
  now: Date = new Date(),
): DateRange {
  const floor = utcDate(subtractUtcMonths(now, GSC_LOOKBACK_MONTHS).valueOf())
  const explicit = checkDatePair(
    'search_console',
    input.start_date,
    input.end_date,
  )
  if (explicit)
    return {
      start_date: explicit.start_date < floor ? floor : explicit.start_date,
      end_date: explicit.end_date,
    }
  const end = new Date(now)
  end.setUTCDate(end.getUTCDate() - GSC_DATA_LAG_DAYS)
  const start = utcDate(
    presetStart(end, input.date_range ?? 'last_28_days').valueOf(),
  )
  return {
    start_date: start < floor ? floor : start,
    end_date: utcDate(end.valueOf()),
  }
}

/** The same-length window just before. */
export function previousPeriod(range: DateRange): DateRange {
  const days = inclusiveDays(range.start_date, range.end_date)
  const end = shiftDate(range.start_date, -1)
  return { start_date: shiftDate(end, -(days - 1)), end_date: end }
}

/** Today's date in an IANA time zone (UTC when Google gave an unknown one). */
export function dateInTimeZone(now: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
  const by = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return `${by.year}-${by.month}-${by.day}`
}

/**
 * Analytics' window: explicit dates (the end held to the last complete day,
 * with a warning), or the last 28 complete days, in the property's time zone.
 */
export function resolveAnalyticsRange(
  input: { start_date?: string; end_date?: string },
  timeZone: string,
  now: Date = new Date(),
): { requested: DateRange | null; range: DateRange; warnings: string[] } {
  const requested = checkDatePair('analytics', input.start_date, input.end_date)
  const lastComplete = shiftDate(dateInTimeZone(now, timeZone), -1)
  let end = requested?.end_date ?? lastComplete
  const start = requested?.start_date ?? shiftDate(end, -27)
  const warnings: string[] = []
  if (end > lastComplete) {
    end = lastComplete
    warnings.push('end_date_clamped')
  }
  if (start > end)
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      'analytics',
      'That window starts after the last complete day in Google Analytics.',
    )
  return { requested, range: { start_date: start, end_date: end }, warnings }
}
