/**
 * Reminder time math — pure, no React, no network.
 *
 * Everything here works on BROWSER-LOCAL wall clock and returns absolute
 * `Date` instants. That is deliberate: the picker resolves a preset (or a
 * chrono-parsed phrase) to one instant at pick time and the server stores it
 * as a plain `timestamptz`. There is no per-user timezone column to consult
 * (`profiles.preferences.timezone` is effectively never written), and no
 * date-only column to slip against.
 *
 * The relative formatter is FUTURE-tense ("13 hours from now"). The dozen
 * hand-rolled `formatRelativeTime` helpers scattered around the detail panels
 * are all past-tense ("13h ago") and none of them fit the header pill.
 */
import { format } from 'date-fns'

export interface ReminderPresetOption {
  id: 'hour' | 'tomorrow' | 'next_week' | 'month'
  label: string
  date: Date
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Same calendar day at 09:00:00.000 local. */
export function atNine(d: Date): Date {
  const out = new Date(d)
  out.setHours(9, 0, 0, 0)
  return out
}

/**
 * The four fixed rows under the free-text input, in display order. Every
 * date is strictly in the future relative to `now`.
 *
 *   hour       now + 1h exactly (keeps seconds/ms — it is a true offset)
 *   tomorrow   next calendar day, 09:00 local
 *   next_week  next Monday, 09:00 local (today-is-Monday → +7d, never today)
 *   month      +1 calendar month, 09:00 local, day clamped to the target
 *              month's length (Aug 31 → Sep 30, Jan 31 → Feb 28/29)
 */
export function reminderPresets(now: Date = new Date()): ReminderPresetOption[] {
  const hour = new Date(now.getTime() + HOUR_MS)

  const tomorrow = atNine(new Date(now))
  tomorrow.setDate(tomorrow.getDate() + 1)

  // getDay(): 0=Sun..6=Sat. Days until the NEXT Monday, always 1-7 so the
  // result can never land on today.
  const nextWeek = atNine(new Date(now))
  const daysUntilMonday = ((8 - now.getDay()) % 7) || 7
  nextWeek.setDate(nextWeek.getDate() + daysUntilMonday)

  // Date.setMonth overflows (Jan 31 + 1mo → Mar 2/3), so clamp the day to the
  // target month's last day first.
  const month = atNine(new Date(now))
  const day = month.getDate()
  month.setDate(1)
  month.setMonth(month.getMonth() + 1)
  month.setDate(Math.min(day, daysInMonth(month.getFullYear(), month.getMonth())))

  return [
    { id: 'hour', label: 'An hour from now', date: hour },
    { id: 'tomorrow', label: 'Tomorrow', date: tomorrow },
    { id: 'next_week', label: 'Next week', date: nextWeek },
    { id: 'month', label: 'A month from now', date: month },
  ]
}

/** Number of days in a local month. `month` is 0-indexed. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(year, month + 1, 0).getDate()
}

/** Absolute display used on every picker row: "Thu, 6 Aug, 8:36 PM". */
export function formatReminderDate(d: Date): string {
  return format(d, 'EEE, d MMM, h:mm a')
}

/**
 * Future-tense relative label for the header pill: "13 hours from now".
 *
 * A target in the past means the cron sweep hasn't run yet (it ticks every
 * 5 minutes) — show "now" rather than a negative or past-tense string.
 */
export function formatFromNow(target: Date | string, now: Date = new Date()): string {
  const date = typeof target === 'string' ? new Date(target) : target
  const diffMs = date.getTime() - now.getTime()

  if (diffMs <= 45_000) return 'now'

  // Round FIRST, then compare — testing the unrounded ratio against its own
  // ceiling lets the top half of a bucket round up INTO the threshold the
  // branch just excluded ("60 minutes from now", "12 months from now"). A
  // rounded 60/24/30/12 has to fall through and be said in the next unit up.
  const minutes = Math.round(diffMs / MINUTE_MS)
  if (minutes < 60) return plural(minutes, 'minute')

  const hours = Math.round(diffMs / HOUR_MS)
  if (hours < 24) return plural(hours, 'hour')

  const days = Math.round(diffMs / DAY_MS)
  if (days < 30) return plural(days, 'day')

  // Approximate months/years (30-day months) — the pill is a glance, not a
  // countdown, and the exact instant is one click away in the picker.
  const months = Math.round(diffMs / (30 * DAY_MS))
  if (months < 12) return plural(months, 'month')

  return plural(Math.round(diffMs / (365 * DAY_MS)), 'year')
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} from now`
}
