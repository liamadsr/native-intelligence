/**
 * The dates of a calendar card (docs/plans/one-agent-and-chat-pages.md, P2).
 *
 * A calendar card shows exactly what the Calendar page's grid draws for one
 * view at one date: a day, a week (Sunday to Saturday, as ClientContainer
 * filters it) or a month. Its range is always that, so the count `show` and
 * `read_card` give is the count on the card, and a card the person moves is
 * described the same way.
 *
 * Dates are local calendar dates (YYYY-MM-DD). The arithmetic here runs on
 * UTC midnights, so it never shifts with the machine's time zone; turning a
 * date into an instant is the caller's (the client's own zone, the server's
 * reading of the person's profile zone).
 *
 * Client-safe and pure.
 */
import type { Checked } from './validate'
import { CALENDAR_CARD_VIEWS, type CalendarCardView, type CalendarQuery } from './kinds'

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function utc(date: string): Date | null {
  const m = ISO_DATE_RE.exec(date)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  // Reject 2026-02-31 and the like: Date.UTC rolls them over.
  return d.getUTCDate() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1 ? d : null
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && utc(value) !== null
}

/** A date `n` days on (or back, for a negative `n`). */
export function addDays(date: string, n: number): string {
  const d = utc(date)
  if (!d) return date
  d.setUTCDate(d.getUTCDate() + n)
  return iso(d)
}

/** What the grid draws for `view` at `date`: its first and last day. */
export function calendarRange(view: CalendarCardView, date: string): { from: string; to: string } {
  const d = utc(date)
  if (!d) return { from: date, to: date }
  if (view === 'day') return { from: date, to: date }
  if (view === 'week') {
    const from = addDays(date, -d.getUTCDay())
    return { from, to: addDays(from, 6) }
  }
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return { from: iso(first), to: iso(last) }
}

/** Days from `from` to `to`, both included (1 for the same day). */
export function spanDays(from: string, to: string): number {
  const a = utc(from)
  const b = utc(to)
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1
}

/**
 * The agent's dates as a card's range, or the one thing to fix. `from` is
 * required; `view` defaults to the smallest that holds `to` (a day when there
 * is no `to`); a `to` past what the view draws widens a day to its week, and
 * a span of more than a week to its month. A span of a week or less that
 * crosses a week's edge is never widened to a whole month: two week cards
 * show it, and the refusal says so. A span no month holds is refused too.
 */
export function fitCalendarRange(rawFrom: unknown, rawTo: unknown, rawView: unknown): Checked<{ from: string; to: string; view: CalendarCardView }> {
  // An ISO date-time's day is what's meant ("2026-10-08T09:00:00Z" → 2026-10-08).
  const day = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 10) : v)
  const from = day(rawFrom)
  if (!isIsoDate(from)) {
    return { ok: false, error: `calendar.from: give the first day as a date, e.g. {"from":"2026-10-05","view":"week"}` }
  }
  let to: string | null = null
  if (rawTo !== undefined && rawTo !== null && rawTo !== '') {
    const t = day(rawTo)
    if (!isIsoDate(t)) return { ok: false, error: `calendar.to: give the last day as a date, e.g. "2026-10-11", or leave it out` }
    if (t < from) return { ok: false, error: `calendar.to (${t}) is before calendar.from (${from}). Swap them` }
    to = t
  }
  let view: CalendarCardView | null = null
  if (rawView !== undefined && rawView !== null && rawView !== '') {
    const v = typeof rawView === 'string' ? rawView.trim().toLowerCase() : ''
    if (!(CALENDAR_CARD_VIEWS as readonly string[]).includes(v)) {
      return { ok: false, error: `calendar.view: use 'day', 'week' or 'month'${v === 'year' || v === 'agenda' ? ' (for a longer span, show month by month)' : ''}` }
    }
    view = v as CalendarCardView
  }

  const short = to !== null && spanDays(from, to) <= 7
  const order: CalendarCardView[] = ['day', 'week', 'month']
  for (const candidate of order.slice(view ? order.indexOf(view) : 0)) {
    // A week or less never becomes a month: it is two weeks.
    if (candidate === 'month' && short && view !== 'month') break
    const range = calendarRange(candidate, from)
    if (!to || to <= range.to) return { ok: true, value: { ...range, view: candidate } }
  }
  const fromWeek = calendarRange('week', from)
  const toWeek = calendarRange('week', to!)
  const suggestion = short
    ? `Show the week of ${from} (${fromWeek.from}..${fromWeek.to}), then the week of ${to} (${toWeek.from}..${toWeek.to}), as two cards`
    : `Show the month of ${from}, then the month of ${to}, as two cards`
  return {
    ok: false,
    error: `calendar: ${from}..${to} doesn't fit one Sunday–Saturday week or one month, which is what a card shows. ${suggestion}`,
  }
}

/** True for a real IANA time zone name ("America/New_York", "UTC"). Client-safe. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** The browser's own IANA zone, or null when it has none to give. */
export function browserTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isTimeZone(tz) ? tz : null
  } catch {
    return null
  }
}

/** A range in short form, for the agent's note: "Thu Oct 9", "week Oct 4–10", "Oct 2026". */
export function describeCalendarRange(query: Pick<CalendarQuery, 'from' | 'to' | 'view'>): string {
  const a = utc(query.from)
  const b = utc(query.to)
  if (!a || !b) return `${query.from}..${query.to}`
  const monthDay = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  if (query.view === 'day') return `${WEEKDAYS[a.getUTCDay()]} ${monthDay(a)}`
  if (query.view === 'month') return `${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`
  const end = a.getUTCMonth() === b.getUTCMonth() ? String(b.getUTCDate()) : monthDay(b)
  return `week ${monthDay(a)}–${end}`
}

/** A local Date's calendar date (the client's own zone). */
export function localIsoDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Local midnight at the start of a calendar date (the client's own zone). */
export function localMidnight(date: string): Date {
  const m = ISO_DATE_RE.exec(date)
  if (!m) return new Date(NaN)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}
