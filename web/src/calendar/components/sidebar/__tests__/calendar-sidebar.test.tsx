// @vitest-environment jsdom
/**
 * The Calendar page's sidebar, mounted in the calendar's own provider: the
 * month picker moves the grid, an upcoming row opens its event, a calendar's
 * checkbox hides it. Calendars and events are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState } from 'react'
import type { IEvent } from '@/calendar/interfaces'
import { CalendarProvider, useCalendar, useCalendarEventDetails } from '@/calendar/contexts/calendar-context'
import { listCalendars, withoutHiddenCalendars } from '@/calendar/sidebar/calendar-visibility'
import { CalendarSidebar } from '../calendar-sidebar'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm)
const NOW = at(2026, 11, 23, 10, 30)
const event = (id: string, title: string, start: Date, minutes: number, over: Partial<IEvent> = {}): IEvent => ({
  id,
  title,
  startDate: start.toISOString(),
  endDate: new Date(start.getTime() + minutes * 60_000).toISOString(),
  color: 'blue',
  description: '',
  accountId: 'acc-1',
  accountEmail: 'sam@example.com',
  calendarName: 'Work',
  ...over,
})
const EVENTS: IEvent[] = [
  event('standup', 'Standup', at(2026, 11, 23, 10, 15), 30),
  event('review', 'Design review', at(2026, 11, 23, 14), 60, { calendarName: 'Family', color: 'green' }),
  event('dentist', 'Dentist', at(2026, 11, 24, 9), 45, { accountId: 'acc-2', accountEmail: 'sam@example.net', calendarName: 'Calendar', color: 'purple' }),
  event('offsite', 'Offsite', at(2026, 12, 3, 9), 480),
]

let container: HTMLDivElement
let root: Root
let selected: Date
let card: ReturnType<typeof useCalendarEventDetails> = null
const opened = vi.fn()
const closed = vi.fn()

function Probe() {
  selected = useCalendar().selectedDate
  card = useCalendarEventDetails()
  return null
}

function Harness({ view = 'week' as const, events = EVENTS }: { view?: 'day' | 'week' | 'month'; events?: IEvent[] }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  return h(
    CalendarProvider,
    { events: withoutHiddenCalendars(events, hidden), onSelectEvent: opened, initialDate: at(2026, 11, 25), children: null },
    h(Probe),
    h(CalendarSidebar, { view, accounts: listCalendars(events), hidden, onHiddenChange: setHidden, onClose: closed, now: NOW }),
  )
}

beforeEach(() => {
  opened.mockReset()
  closed.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async (props: Parameters<typeof Harness>[0] = {}) => {
  await act(async () => root.render(h(Harness, props)))
}
const day = (iso: string) => container.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`)!
const upcoming = () => [...container.querySelectorAll('[data-upcoming-event]')].map((b) => b.textContent)
const checkbox = (label: string) => [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((c) => c.getAttribute('aria-label') === label)!

describe('CalendarSidebar', () => {
  it('shows the grid’s month with today outlined, the grid’s day filled and, in the week view, its week shaded', async () => {
    await render()
    expect(container.querySelector('[data-mini-month]')!.textContent).toContain('November 2026')
    expect(day('2026-11-23').getAttribute('aria-current')).toBe('date')
    expect(day('2026-11-25').getAttribute('aria-pressed')).toBe('true')
    expect([...container.querySelectorAll('[data-in-week] button')].map((b) => b.getAttribute('data-day'))).toEqual([
      '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28',
    ])
    await render({ view: 'day' })
    expect(container.querySelector('[data-in-week]')).toBeNull()
  })

  it('moves the grid to the day clicked; the arrows page the picker without moving the grid', async () => {
    await render()
    act(() => day('2026-11-12').click())
    expect(selected).toEqual(at(2026, 11, 12))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Go to next month"]')!.click())
    expect(container.querySelector('[data-mini-month]')!.textContent).toContain('December 2026')
    expect(selected).toEqual(at(2026, 11, 12))
    act(() => day('2026-12-09').click())
    expect(selected).toEqual(at(2026, 12, 9))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Go to previous month"]')!.click())
    expect(container.querySelector('[data-mini-month]')!.textContent).toContain('November 2026')
  })

  it('lists what is coming up from now, and opens an event on its day when its row is clicked', async () => {
    await render()
    expect(upcoming()).toEqual(['StandupNow', 'Design review2:00 PM', 'DentistTomorrow · 9:00 AM', 'OffsiteDec 3 · 9:00 AM'])
    act(() => container.querySelector<HTMLButtonElement>('[data-upcoming-event="dentist"]')!.click())
    // Its card, beside the row (not the full panel).
    expect(card).toEqual({ eventId: 'dentist', anchorEl: container.querySelector('[data-upcoming-event="dentist"]') })
    expect(opened).not.toHaveBeenCalled()
    expect(selected).toEqual(at(2026, 11, 24, 9))
  })

  it('says so when nothing is coming up', async () => {
    await render({ events: [event('old', 'Last week', at(2026, 11, 16, 9), 30), event('other', 'Old too', at(2026, 11, 17, 9), 30, { calendarName: 'Family' })] })
    expect(container.querySelector('[data-sidebar-section="upcoming"]')!.textContent).toContain('No upcoming events')
  })

  it('lists the calendars by account; unchecking one takes its events out of the upcoming list, and checking it brings them back', async () => {
    await render()
    expect([...container.querySelectorAll('[data-sidebar-account]')].map((a) => a.textContent)).toEqual(['sam@example.comFamilyWork', 'sam@example.netCalendar'])
    act(() => checkbox('Hide Family').click())
    expect(upcoming()).toEqual(['StandupNow', 'DentistTomorrow · 9:00 AM', 'OffsiteDec 3 · 9:00 AM'])
    // The hidden calendar stays in the list, unchecked; its account reads "some".
    expect(checkbox('Show Family').checked).toBe(false)
    expect(checkbox('Hide every calendar of sam@example.com').indeterminate).toBe(true)
    act(() => checkbox('Show Family').click())
    expect(upcoming()).toHaveLength(4)
  })

  it('hides and shows a whole account from its own checkbox', async () => {
    await render()
    act(() => checkbox('Hide every calendar of sam@example.com').click())
    expect(upcoming()).toEqual(['DentistTomorrow · 9:00 AM'])
    expect(checkbox('Show Work').checked).toBe(false)
    act(() => checkbox('Show every calendar of sam@example.com').click())
    expect(upcoming()).toHaveLength(4)
  })

  it('has no calendar list with a single calendar, and closes from its header', async () => {
    await render({ events: [EVENTS[0], EVENTS[3]] })
    expect(container.querySelector('[data-sidebar-section="calendars"]')).toBeNull()
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Hide the sidebar"]')!.click())
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
