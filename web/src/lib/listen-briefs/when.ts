/**
 * Times, the way a person says them out loud: "last Tuesday", "in about 25
 * minutes", "tomorrow at 10 AM", worked out on the wall clock of the user's
 * own time zone (the client sends it with the request). A Listen brief says
 * these words as they are.
 *
 * Pure: `now` is always passed in.
 */

import { TZDate } from '@date-fns/tz'
import { differenceInCalendarDays, differenceInMinutes, format, isValid, startOfISOWeek } from 'date-fns'

export interface Clock {
  now: Date
  /** IANA zone, e.g. "America/Los_Angeles". Unknown → UTC. */
  timeZone: string
}

/** The zone if the runtime knows it, else UTC. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return timeZone
  } catch {
    return 'UTC'
  }
}

/** "2 PM", "2:30 PM". */
function clockTime(d: TZDate): string {
  return format(d, d.getMinutes() === 0 ? 'h a' : 'h:mm a')
}

/** "September 22", or "December 3, 2025" in another year. */
function calendarDate(d: TZDate, now: TZDate): string {
  return format(d, d.getFullYear() === now.getFullYear() ? 'MMMM d' : 'MMMM d, yyyy')
}

/** Minutes to the nearest five, the way people say them ("about 25 minutes"). */
function fiveMinutes(minutes: number): number {
  return Math.min(55, Math.max(5, Math.round(minutes / 5) * 5))
}

function sameWeek(a: TZDate, b: TZDate): boolean {
  return startOfISOWeek(a).getTime() === startOfISOWeek(b).getTime()
}

/**
 * When a moment was or will be. Past: "just now", "a few minutes ago", "about
 * 25 minutes ago", "today at 9 AM", "yesterday at 3 PM", "on Tuesday" (this
 * week), "last Friday", "10 days ago", "3 weeks ago", "on June 1". Ahead: "in
 * a few minutes", "in about 25 minutes", "today at 6 PM", "tomorrow at 10 AM",
 * "on Thursday at 2 PM", "on October 12 at 2 PM". Null for a missing or
 * unreadable time.
 */
export function describeWhen(value: string | Date | null | undefined, clock: Clock): string | null {
  if (!value) return null
  const at = new Date(value)
  if (!isValid(at)) return null
  const zone = safeTimeZone(clock.timeZone)
  const d = new TZDate(at, zone)
  const now = new TZDate(clock.now, zone)
  const minutes = differenceInMinutes(d, now)
  const days = differenceInCalendarDays(d, now)
  const time = clockTime(d)

  if (minutes <= 0) {
    const ago = -minutes
    if (ago < 1) return 'just now'
    if (ago < 5) return 'a few minutes ago'
    if (ago < 60) return `about ${fiveMinutes(ago)} minutes ago`
    if (days === 0) return `today at ${time}`
    if (days === -1) return `yesterday at ${time}`
    if (days >= -6) return `${sameWeek(d, now) ? 'on' : 'last'} ${format(d, 'EEEE')}`
    if (days >= -13) return `${-days} days ago`
    if (days >= -59) return `${Math.round(-days / 7)} weeks ago`
    return `on ${calendarDate(d, now)}`
  }

  if (minutes < 5) return 'in a few minutes'
  if (minutes < 60) return `in about ${fiveMinutes(minutes)} minutes`
  if (days === 0) return `today at ${time}`
  if (days === 1) return `tomorrow at ${time}`
  if (days <= 6) return `on ${format(d, 'EEEE')} at ${time}`
  return `on ${calendarDate(d, now)} at ${time}`
}

/** The day "2026-10-02" names, in the user's zone (a bare date, or a
 *  timestamp's date part). */
function dayOf(value: string, zone: string): TZDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  const d = new TZDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]), zone)
  return isValid(d) ? d : null
}

/**
 * A calendar day with no time (a due date, a target date): "today",
 * "tomorrow", "yesterday", "on Friday", "on Thursday" (earlier this week),
 * "last Thursday", "on September 10", "on November 2". Null for a missing or
 * unreadable day.
 */
export function describeDay(value: string | null | undefined, clock: Clock): string | null {
  if (!value) return null
  const zone = safeTimeZone(clock.timeZone)
  const d = dayOf(value, zone)
  if (!d) return null
  const now = new TZDate(clock.now, zone)
  const days = differenceInCalendarDays(d, now)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 1 && days <= 6) return `on ${format(d, 'EEEE')}`
  if (days < -1 && days >= -6) return `${sameWeek(d, now) ? 'on' : 'last'} ${format(d, 'EEEE')}`
  return `on ${calendarDate(d, now)}`
}

/** A due date with no time of its own: a bare date, or midnight or the last
 *  second of the day in UTC, how all-day dates are stored, or exactly noon UTC,
 *  how a bare-day due date is written to `due_at` (dueAtFromDate; read back
 *  from Postgres it is `…T12:00:00+00:00`, not the `.000Z` that was written). */
function isDayOnly(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /T(?:00:00(?::00(?:\.0+)?)?|12:00(?::00(?:\.0+)?)?|23:59:59(?:\.9+)?)(?:Z|[+-]00(?::?00)?)$/.test(value)
  )
}

/** A due date: a day ("tomorrow", "on Friday") when it carries no time of its
 *  own, else a moment ("tomorrow at 5 PM"). Null for nothing. */
export function describeDue(value: string | null | undefined, clock: Clock): string | null {
  if (!value) return null
  return isDayOnly(value) ? describeDay(value, clock) : describeWhen(value, clock)
}

/** Today's date in the user's zone: "2026-09-27". */
function today(clock: Clock): string {
  return format(new TZDate(clock.now, safeTimeZone(clock.timeZone)), 'yyyy-MM-dd')
}

/** A calendar day ("2026-09-25", or a timestamp's date part) that is over,
 *  in the user's zone. */
export function isPastDay(value: string | null | undefined, clock: Clock): boolean {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value ?? '')?.[0]
  return !!day && day < today(clock)
}

/** A due date that has passed, read the way describeDue reads it: a day once
 *  the day is over (so due today is never overdue), else a moment once past. */
export function isPastDue(value: string | null | undefined, clock: Clock): boolean {
  if (!value) return false
  if (isDayOnly(value)) return isPastDay(value, clock)
  const at = Date.parse(value)
  return Number.isFinite(at) && at < clock.now.getTime()
}

/** How long, roughly: "under a minute", "about 12 minutes", "about an hour",
 *  "about an hour and a half", "about 2 hours". Null for nothing. */
export function describeDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return 'under a minute'
  if (minutes < 55) {
    const said = minutes < 10 ? minutes : Math.round(minutes / 5) * 5
    return `about ${said} minute${said === 1 ? '' : 's'}`
  }
  const halfHours = Math.round(minutes / 30)
  if (halfHours <= 2) return 'about an hour'
  if (halfHours === 3) return 'about an hour and a half'
  return halfHours % 2 === 0 ? `about ${halfHours / 2} hours` : `about ${Math.floor(halfHours / 2)} and a half hours`
}
