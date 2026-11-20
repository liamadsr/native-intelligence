import type { IEvent } from '@/calendar/interfaces'
import type { TBadgeVariant, TEventColor } from '@/calendar/types'

/**
 * An event's colour classes (the `.cal-*` rules in src/styles/tailwind.css): a
 * soft opaque fill in the calendar's hue with dark ink, the same in the week
 * grid, the all-day row and the month. The "dot" style keeps a neutral block
 * and puts the hue in the dot alone.
 */
export function eventToneClass(color: TEventColor, badgeVariant: TBadgeVariant = 'colored'): string {
  return badgeVariant === 'dot' ? `cal-${color} bg-neutral-50 text-foreground dark:bg-neutral-900` : `cal-${color} cal-fill`
}

/** The colours calendars take, calmest first. Red and gray are left to tasks (urgent, no priority). */
export const CALENDAR_COLORS: readonly TEventColor[] = ['blue', 'green', 'purple', 'teal', 'orange', 'pink', 'yellow']

const calendarKey = (event: Pick<IEvent, 'accountId' | 'calendarName'>) => `${event.accountId ?? ''}|${event.calendarName ?? ''}`

/**
 * Give each calendar among these events its own colour: the calendars in name
 * order take the calendar hues in turn, so two calendars never share one while
 * there are hues left (a hash alone, adapters' calendarColor, can land two on the same).
 * Tasks keep their priority colour. Returns the same array when nothing changes.
 */
export function withCalendarColors(events: IEvent[]): IEvent[] {
  const keys = [...new Set(events.filter((e) => !e.isAction).map(calendarKey))].sort()
  if (keys.length === 0) return events
  const colorOf = new Map(keys.map((key, i) => [key, CALENDAR_COLORS[i % CALENDAR_COLORS.length]]))
  let changed = false
  const next = events.map((event) => {
    if (event.isAction) return event
    const color = colorOf.get(calendarKey(event))!
    if (color === event.color) return event
    changed = true
    return { ...event, color }
  })
  return changed ? next : events
}

