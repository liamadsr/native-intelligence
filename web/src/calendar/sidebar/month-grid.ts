/**
 * The sidebar's month picker, as data: six weeks of days for a month (weeks
 * start on Sunday, as the week view's do), and which of them the grid is
 * showing. Pure.
 */
import type { TCalendarView } from '@/calendar/types'

export interface MiniMonthDay {
  date: Date
  inMonth: boolean
}

/** The weeks that cover a month: whole weeks, Sunday first. */
export function monthWeeks(month: Date): MiniMonthDay[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  const weeks: MiniMonthDay[][] = []
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
  while (cursor <= last) {
    const week: MiniMonthDay[] = []
    for (let i = 0; i < 7; i++) {
      week.push({ date: new Date(cursor), inMonth: cursor.getMonth() === month.getMonth() })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

export const isSameDate = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** Is this day inside the week the grid shows? Only the week view shades a range. */
export function inShownWeek(day: Date, selected: Date, view: TCalendarView): boolean {
  if (view !== 'week') return false
  const start = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - selected.getDay())
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999)
  return day >= start && day <= end
}

/** The same day of the month, `by` months away, clamped to that month's last day. */
export function shiftMonth(month: Date, by: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + by, 1)
}
