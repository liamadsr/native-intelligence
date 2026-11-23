/**
 * Booking insights (phase 2): what the Insights tab, its CSV and the agent's
 * get_booking_insights show of the reader's link bookings over a range
 * (./bookings.ts reads them, by its visibility rule).
 *
 * Counted by when each booking starts, in [from, to):
 *
 *   booked      confirmed bookings.
 *   requested   still waiting on the host's yes (or being written).
 *   cancelled   cancelled, by the guest or a host.
 *   declined    a request the host said no to, or that lapsed.
 *   hours       confirmed bookings' length, no-shows left out.
 *   no_shows    confirmed bookings marked a no-show; the rate is of those
 *               marked (attended + no-show), null when none are.
 *
 * Over time: one bucket per local day in the reader's zone, or per seven days
 * from the range's first day when the range is over INSIGHT_DAY_BUCKETS_MAX
 * days. Top links: by confirmed bookings, then hours, at most TOP_LINKS.
 *
 * Pure (the CSV too).
 */
import {
  addDays,
  dayKey,
  localDate,
  parseDayKey,
  zonedTime,
} from '@/lib/availability/zone'
import type { LinkBookingRow } from './bookings'

export const INSIGHT_RANGES = [7, 30, 90] as const
/** The longest custom range, in days. */
export const INSIGHT_DAYS_MAX = 366
/** Past this many days, the buckets are weeks. */
export const INSIGHT_DAY_BUCKETS_MAX = 92
export const TOP_LINKS = 5
/** The most bookings one insights read counts. */
export const INSIGHT_ROWS_MAX = 5000

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

export interface InsightBucket {
  /** The bucket's first local day, YYYY-MM-DD. */
  date: string
  booked: number
  cancelled: number
}

export interface TopLink {
  link_id: string | null
  title: string
  bookings: number
  hours: number
}

export interface BookingInsights {
  from: string
  to: string
  time_zone: string
  bucket: 'day' | 'week'
  totals: {
    booked: number
    requested: number
    cancelled: number
    declined: number
    hours: number
    attended: number
    no_shows: number
    /** No-shows among those marked, 0..1, or null when none are marked. */
    no_show_rate: number | null
  }
  series: InsightBucket[]
  top_links: TopLink[]
  /** The read hit INSIGHT_ROWS_MAX: the numbers count only that many. */
  truncated: boolean
}

export type InsightRows = ReadonlyArray<
  Pick<
    LinkBookingRow,
    'link_id' | 'starts_at' | 'ends_at' | 'state' | 'attendance'
  >
>

/** Rounded to a tenth. Pure. */
const tenth = (n: number) => Math.round(n * 10) / 10

/** Whether a zone name is one this runtime knows. Pure. */
export function knownZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !/^[A-Za-z0-9_+/-]{1,64}$/.test(zone))
    return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export type InsightRange =
  | { ok: true; from: number; to: number; days: number; timeZone: string }
  | { ok: false; error: string }

/**
 * The range asked for, in the reader's zone: `days` (7, 30 or 90) ending
 * today, or `from`/`to` (YYYY-MM-DD, `to` included) of at most
 * INSIGHT_DAYS_MAX days. [from, to) runs from local midnight to the
 * midnight after the last day. Pure.
 */
export function insightRange(
  input: {
    days?: string | number | null
    from?: string | null
    to?: string | null
    tz?: string | null
  },
  now: number,
): InsightRange {
  const timeZone = knownZone(input.tz) ? input.tz : 'UTC'
  if (input.from || input.to) {
    const first = parseDayKey(input.from)
    const last = parseDayKey(input.to)
    if (!first || !last)
      return {
        ok: false,
        error: 'from and to are both dates, like 2026-11-01.',
      }
    // A day that doesn't exist (2026-02-30) reads back as another.
    if (
      dayKey(addDays(first, 0)) !== input.from ||
      dayKey(addDays(last, 0)) !== input.to
    )
      return { ok: false, error: 'That is not a real date.' }
    const from = zonedTime(first, '00:00', timeZone)
    const to = zonedTime(addDays(last, 1), '00:00', timeZone)
    if (to <= from) return { ok: false, error: 'to comes on or after from.' }
    const days =
      Math.round(
        (Date.UTC(last.y, last.m - 1, last.d) -
          Date.UTC(first.y, first.m - 1, first.d)) /
          DAY_MS,
      ) + 1
    if (days > INSIGHT_DAYS_MAX)
      return { ok: false, error: `At most ${INSIGHT_DAYS_MAX} days at once.` }
    return { ok: true, from, to, days, timeZone }
  }
  const days = Number(input.days ?? 30)
  if (!(INSIGHT_RANGES as readonly number[]).includes(days))
    return { ok: false, error: 'days is 7, 30 or 90 (or give from and to).' }
  const today = localDate(now, timeZone)
  const from = zonedTime(addDays(today, 1 - days), '00:00', timeZone)
  const to = zonedTime(addDays(today, 1), '00:00', timeZone)
  return { ok: true, from, to, days, timeZone }
}

/** The insights of `rows` over [from, to) (see the header). Pure. */
export function bookingInsights(
  rows: InsightRows,
  args: {
    from: number
    to: number
    timeZone: string
    titles: ReadonlyMap<string, string>
    truncated?: boolean
  },
): BookingInsights {
  const { from, to, timeZone } = args
  const firstDay = localDate(from, timeZone)
  let days = 0
  while (
    days < INSIGHT_DAYS_MAX + 2 &&
    zonedTime(addDays(firstDay, days), '00:00', timeZone) < to
  )
    days++
  const bucket: 'day' | 'week' = days > INSIGHT_DAY_BUCKETS_MAX ? 'week' : 'day'
  const step = bucket === 'week' ? 7 : 1
  const series: InsightBucket[] = []
  const index = new Map<string, number>()
  for (let d = 0; d < days; d++) {
    const key = dayKey(addDays(firstDay, d))
    if (d % step === 0) series.push({ date: key, booked: 0, cancelled: 0 })
    index.set(key, series.length - 1)
  }

  const totals = {
    booked: 0,
    requested: 0,
    cancelled: 0,
    declined: 0,
    hours: 0,
    attended: 0,
    no_shows: 0,
    no_show_rate: null as number | null,
  }
  const links = new Map<string, TopLink>()
  for (const row of rows) {
    const start = Date.parse(row.starts_at)
    if (!Number.isFinite(start) || start < from || start >= to) continue
    const at = index.get(dayKey(localDate(start, timeZone)))
    const slot = at === undefined ? null : series[at]
    if (row.state === 'confirmed') {
      totals.booked++
      if (slot) slot.booked++
      const hours =
        row.attendance === 'no_show'
          ? 0
          : Math.max(0, Date.parse(row.ends_at) - start) / HOUR_MS
      totals.hours += hours
      if (row.attendance === 'attended') totals.attended++
      if (row.attendance === 'no_show') totals.no_shows++
      const key = row.link_id ?? ''
      const top = links.get(key) ?? {
        link_id: row.link_id,
        title:
          (row.link_id && args.titles.get(row.link_id)) || 'A deleted link',
        bookings: 0,
        hours: 0,
      }
      top.bookings++
      top.hours += hours
      links.set(key, top)
    } else if (row.state === 'requested' || row.state === 'booking') {
      totals.requested++
    } else if (row.state === 'cancelled') {
      totals.cancelled++
      if (slot) slot.cancelled++
    } else if (row.state === 'declined' || row.state === 'expired') {
      totals.declined++
    }
  }
  const marked = totals.attended + totals.no_shows
  totals.no_show_rate = marked
    ? Math.round((totals.no_shows / marked) * 1000) / 1000
    : null
  totals.hours = tenth(totals.hours)
  const top_links = [...links.values()]
    .map((l) => ({ ...l, hours: tenth(l.hours) }))
    .sort(
      (a, b) =>
        b.bookings - a.bookings ||
        b.hours - a.hours ||
        a.title.localeCompare(b.title),
    )
    .slice(0, TOP_LINKS)
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    time_zone: timeZone,
    bucket,
    totals,
    series,
    top_links,
    truncated: args.truncated === true,
  }
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * One cell: quoted when it must be, and a value a spreadsheet would run as a
 * formula (it starts with = + - @, a tab or a return) made text with a
 * leading apostrophe. Guests typed most of these. Pure.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const CSV_COLUMNS = [
  'start',
  'end',
  'title',
  'link',
  'guest',
  'guest_email',
  'guest_phone',
  'state',
  'attendance',
  'host',
  'cancelled_by',
] as const

/** The bookings as CSV, one row each, soonest first, with a header. Pure. */
export function bookingsCsv(
  rows: ReadonlyArray<LinkBookingRow>,
  titles: ReadonlyMap<string, string>,
): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const r of [...rows].sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at),
  )) {
    lines.push(
      [
        r.starts_at,
        r.ends_at,
        r.title,
        r.link_id ? (titles.get(r.link_id) ?? '') : '',
        r.guest_name,
        r.guest_email ?? '',
        r.guest_phone ?? '',
        r.state,
        r.state === 'confirmed' ? (r.attendance ?? '') : '',
        r.host_name,
        r.cancelled_by ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
