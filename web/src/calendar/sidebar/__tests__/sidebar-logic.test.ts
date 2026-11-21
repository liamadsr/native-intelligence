/**
 * The sidebar's data: which calendars the page has, which are hidden, what is
 * coming up and how its time reads, and the month picker's weeks. Calendars
 * and events are made up.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { IEvent } from '@/calendar/interfaces'
import {
  accountVisibility,
  listCalendars,
  readHiddenCalendars,
  toggleAccount,
  toggleCalendar,
  withoutHiddenCalendars,
  writeHiddenCalendars,
} from '../calendar-visibility'
import { eventEnd, upcomingEvents, upcomingLabel } from '../upcoming'
import { inShownWeek, monthWeeks, shiftMonth } from '../month-grid'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)
const event = (over: Partial<IEvent> & { id: string }): IEvent => ({
  title: over.id,
  startDate: at(2026, 11, 23, 10).toISOString(),
  endDate: at(2026, 11, 23, 11).toISOString(),
  color: 'blue',
  description: '',
  accountId: 'acc-1',
  accountEmail: 'sam@example.com',
  calendarName: 'Work',
  ...over,
})

describe('listCalendars', () => {
  const events = [
    event({ id: 'a', calendarName: 'Work', color: 'green' }),
    event({ id: 'b', calendarName: 'Family', color: 'blue' }),
    event({ id: 'c', calendarName: 'Work', color: 'green' }),
    event({ id: 'd', accountId: 'acc-2', accountEmail: 'sam@example.net', calendarName: 'Calendar', color: 'purple' }),
    event({ id: 'e', accountId: undefined, accountEmail: undefined, calendarName: 'Exchange (Local)', color: 'teal' }),
    event({ id: 'task', isAction: true, accountId: undefined, calendarName: undefined, color: 'red' }),
  ]

  it('lists each calendar once, by account, with the grid’s own colour; tasks are not a calendar', () => {
    expect(listCalendars(events)).toEqual([
      { id: 'acc-1', label: 'sam@example.com', calendars: [{ key: 'acc-1|Family', name: 'Family', color: 'blue' }, { key: 'acc-1|Work', name: 'Work', color: 'green' }] },
      { id: 'acc-2', label: 'sam@example.net', calendars: [{ key: 'acc-2|Calendar', name: 'Calendar', color: 'purple' }] },
      { id: '', label: 'On this Mac', calendars: [{ key: '|Exchange (Local)', name: 'Exchange (Local)', color: 'teal' }] },
    ])
  })

  it('hides a calendar’s events and nothing else; tasks stay; nothing hidden is the same array', () => {
    expect(withoutHiddenCalendars(events, new Set())).toBe(events)
    expect(withoutHiddenCalendars(events, new Set(['acc-9|Gone']))).toBe(events)
    expect(withoutHiddenCalendars(events, new Set(['acc-1|Work', '|'])).map((e) => e.id)).toEqual(['b', 'd', 'e', 'task'])
  })

  it('shows or hides one calendar, or a whole account, and says what an account’s checkbox reads', () => {
    const [first] = listCalendars(events)
    let hidden = toggleCalendar(new Set(), 'acc-1|Work', false)
    expect(accountVisibility(first, hidden)).toBe('some')
    hidden = toggleAccount(hidden, first, false)
    expect([...hidden].sort()).toEqual(['acc-1|Family', 'acc-1|Work'])
    expect(accountVisibility(first, hidden)).toBe('none')
    hidden = toggleAccount(hidden, first, true)
    expect(accountVisibility(first, hidden)).toBe('all')
    expect(toggleCalendar(new Set(['x']), 'x', true).size).toBe(0)
  })
})

describe('hidden calendars in the browser', () => {
  const store = new Map<string, string>()
  const original = (globalThis as { localStorage?: Storage }).localStorage
  const install = (setItem?: () => void) => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: setItem ?? ((k: string, v: string) => void store.set(k, v)),
      removeItem: (k: string) => void store.delete(k),
    }
  }
  afterEach(() => {
    store.clear()
    ;(globalThis as { localStorage?: unknown }).localStorage = original
  })

  it('keeps the set, and keeps nothing at all once every calendar is shown again', () => {
    install()
    writeHiddenCalendars(new Set(['acc-1|Work', 'acc-2|Calendar']))
    expect([...readHiddenCalendars()]).toEqual(['acc-1|Work', 'acc-2|Calendar'])
    writeHiddenCalendars(new Set())
    expect(store.size).toBe(0)
    expect(readHiddenCalendars().size).toBe(0)
  })

  it('reads anything unexpected as nothing hidden, and survives a full or missing store', () => {
    install()
    store.set('ni:calendar-hidden:v1', '{"not":"a list"}')
    expect(readHiddenCalendars().size).toBe(0)
    store.set('ni:calendar-hidden:v1', 'not json')
    expect(readHiddenCalendars().size).toBe(0)
    store.set('ni:calendar-hidden:v1', JSON.stringify(['a', 7, null, 'b']))
    expect([...readHiddenCalendars()]).toEqual(['a', 'b'])
    install(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => writeHiddenCalendars(new Set(['a']))).not.toThrow()
  })
})

describe('upcomingEvents', () => {
  const now = at(2026, 11, 23, 10, 30)
  const timed = (id: string, d: number, h: number, extra: Partial<IEvent> = {}) =>
    event({ id, startDate: at(2026, 11, d, h).toISOString(), endDate: at(2026, 11, d, h + 1).toISOString(), ...extra })

  it('is the next five that haven’t ended, soonest first: one under way stays, a finished one goes', () => {
    const events = [timed('later', 25, 9), timed('over', 23, 8), timed('now', 23, 10), timed('soon', 23, 14), timed('t1', 24, 9), timed('t2', 26, 9), timed('t3', 27, 9), timed('t4', 28, 9)]
    expect(upcomingEvents(events, now).map((e) => e.id)).toEqual(['now', 'soon', 't1', 'later', 't2'])
  })

  it('leaves out what the person declined, and tasks; keeps all-day events until their last day is over', () => {
    const events = [
      timed('declined', 23, 15, { response: 'declined' }),
      timed('maybe', 23, 16, { response: 'tentative' }),
      event({ id: 'task', isAction: true, startDate: at(2026, 11, 23, 12).toISOString(), endDate: at(2026, 11, 23, 12).toISOString() }),
      event({ id: 'offsite', isAllDay: true, startDate: '2026-11-22', endDate: '2026-11-23' }),
      event({ id: 'yesterday', isAllDay: true, startDate: '2026-11-22', endDate: '2026-11-22' }),
    ]
    expect(upcomingEvents(events, now).map((e) => e.id)).toEqual(['offsite', 'maybe'])
    expect(eventEnd({ isAllDay: true, endDate: '2026-11-23' })).toEqual(at(2026, 11, 24))
  })

  it('says when each is: Now, a time today, Tomorrow, a date; an all-day event by its day', () => {
    expect(upcomingLabel(timed('a', 23, 10), now)).toBe('Now')
    expect(upcomingLabel(timed('b', 23, 14), now)).toBe('2:00 PM')
    expect(upcomingLabel(timed('c', 24, 9), now)).toBe('Tomorrow · 9:00 AM')
    expect(upcomingLabel(timed('d', 27, 9), now)).toBe('Nov 27 · 9:00 AM')
    expect(upcomingLabel(event({ id: 'e', isAllDay: true, startDate: '2026-11-22', endDate: '2026-11-23' }), now)).toBe('Today · All day')
    expect(upcomingLabel(event({ id: 'f', isAllDay: true, startDate: '2026-11-24', endDate: '2026-11-24' }), now)).toBe('Tomorrow · All day')
    expect(upcomingLabel(event({ id: 'g', isAllDay: true, startDate: '2026-12-03', endDate: '2026-12-03' }), now)).toBe('Dec 3 · All day')
  })
})

describe('the month picker’s weeks', () => {
  it('covers the month in whole weeks from Sunday', () => {
    const weeks = monthWeeks(at(2026, 11, 15))
    expect(weeks).toHaveLength(5)
    expect(weeks[0][0].date).toEqual(at(2026, 11, 1)) // November 2026 starts on a Sunday
    expect(weeks[4][6].date).toEqual(at(2026, 12, 5))
    expect(weeks[4].map((d) => d.inMonth)).toEqual([true, true, false, false, false, false, false])
    const december = monthWeeks(at(2026, 12, 1))
    expect(december[0][0].date).toEqual(at(2026, 11, 29))
    expect(december[0].filter((d) => d.inMonth)).toHaveLength(5)
    for (const week of [...weeks, ...december]) expect(week).toHaveLength(7)
  })

  it('shades the week on screen in the week view only, and pages by whole months', () => {
    const selected = at(2026, 11, 25) // a Wednesday
    expect(inShownWeek(at(2026, 11, 22), selected, 'week')).toBe(true)
    expect(inShownWeek(at(2026, 11, 28), selected, 'week')).toBe(true)
    expect(inShownWeek(at(2026, 11, 29), selected, 'week')).toBe(false)
    expect(inShownWeek(at(2026, 11, 25), selected, 'day')).toBe(false)
    expect(inShownWeek(at(2026, 11, 25), selected, 'month')).toBe(false)
    expect(shiftMonth(at(2026, 1, 31), 1)).toEqual(at(2026, 2, 1))
    expect(shiftMonth(at(2026, 1, 31), -1)).toEqual(at(2025, 12, 1))
  })
})
