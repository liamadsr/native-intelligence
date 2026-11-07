// @vitest-environment jsdom
/**
 * The calendar that pours out of the Capture button is an at-a-glance view of
 * TODAY with no controls of its own: no day paging and no account picker (it
 * shows whatever accounts the workspace's calendar does). With no "Today"
 * button to catch up with, one left open overnight moves on to the new day by
 * itself.
 *
 * Clicking a meeting starts its capture. There's no Start button (a short
 * meeting's block is too small to hold one) and nothing opens. All-day events
 * are plain labels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { IEvent } from '@/calendar/interfaces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const calendar = vi.hoisted(() => ({
  events: [] as IEvent[],
  startMeeting: vi.fn(),
  selectEvent: vi.fn(),
}))

vi.mock('@/calendar/hooks/use-calendar-events', () => ({
  useCalendarEvents: () => ({
    events: calendar.events,
    loading: false,
    error: null,
    refetch: async () => {},
    filterAccountIds: null,
    setFilterAccountIds: () => {},
  }),
}))
vi.mock('@/calendar/contexts/calendar-context', () => ({
  CalendarProvider: ({ children }: { children: ReactNode }) => children,
  useCalendarSettings: () => ({ badgeVariant: 'colored' }),
  useCalendarMutators: () => ({ selectEvent: calendar.selectEvent }),
}))
vi.mock('@/calendar/hooks/use-start-meeting', () => ({
  useStartMeetingFromEvent: () => ({
    startMeeting: calendar.startMeeting,
    startingId: null,
    isRecording: false,
    isLive: () => false,
  }),
}))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

import { CaptureCalendar } from '../capture-calendar'

/** An event on 2026-09-(day), local time. */
function event(title: string, day: number, from: [number, number], to: [number, number], isAllDay = false): IEvent {
  return {
    id: title,
    title,
    color: 'blue',
    description: '',
    startDate: new Date(2026, 8, day, ...from).toISOString(),
    endDate: new Date(2026, 8, day, ...to).toISOString(),
    isAllDay,
  }
}

let container: HTMLDivElement
let root: Root

function render() {
  act(() => {
    root.render(h(CaptureCalendar, { hint: h('span', { 'data-hint': '' }, 'Capture now') }))
  })
}

/** The meetings on the grid, by id. */
const blocks = () => [...container.querySelectorAll('[data-event-block]')].map((el) => el.getAttribute('data-event-id'))
const block = (id: string) => container.querySelector<HTMLElement>(`[data-event-id="${id}"] [role="button"]`)!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  calendar.startMeeting.mockClear()
  calendar.selectEvent.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the Capture button’s calendar', () => {
  it("shows today's meetings under a Today header, with no paging, account picker or Start buttons", () => {
    vi.setSystemTime(new Date(2026, 8, 23, 10, 0))
    calendar.events = [
      event('Yesterday review', 22, [9, 0], [10, 0]),
      event('Standup', 23, [9, 0], [9, 15]),
      event('Design sync', 23, [14, 0], [15, 0]),
      event('Tomorrow planning', 24, [9, 0], [10, 0]),
      event('Offsite', 23, [0, 0], [23, 0], true),
    ]
    render()

    expect(blocks()).toEqual(['Standup', 'Design sync'])
    expect(container.textContent).toContain('Offsite')
    expect(container.textContent).toContain('TodayWed, Sep 23')
    expect(container.querySelector('[data-hint]')).not.toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/All accounts|Start/)
  })

  it('starts a meeting’s capture when it is clicked, and opens nothing', () => {
    vi.setSystemTime(new Date(2026, 8, 23, 10, 0))
    const standup = event('Standup', 23, [9, 0], [9, 15])
    calendar.events = [standup, event('Offsite', 23, [0, 0], [23, 0], true)]
    render()

    act(() => block('Standup').click())
    expect(calendar.startMeeting).toHaveBeenCalledTimes(1)
    expect(calendar.startMeeting).toHaveBeenCalledWith(standup)
    expect(calendar.selectEvent).not.toHaveBeenCalled()
    expect(blocks()).toEqual(['Standup'])
  })

  it('leaves all-day events as labels that start nothing', () => {
    vi.setSystemTime(new Date(2026, 8, 23, 10, 0))
    calendar.events = [event('Offsite', 23, [0, 0], [23, 0], true)]
    render()

    const label = [...container.querySelectorAll('span')].find((el) => el.textContent === 'Offsite')!
    act(() => label.click())
    expect(calendar.startMeeting).not.toHaveBeenCalled()
    expect(calendar.selectEvent).not.toHaveBeenCalled()
    expect(container.querySelector('[role="button"]')).toBeNull()
  })

  it('moves on to the new day by itself after midnight', () => {
    vi.setSystemTime(new Date(2026, 8, 23, 23, 59, 30))
    calendar.events = [event('Late call', 23, [22, 0], [23, 0]), event('Tomorrow planning', 24, [9, 0], [10, 0])]
    render()
    expect(blocks()).toEqual(['Late call'])

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(blocks()).toEqual(['Tomorrow planning'])
    expect(container.textContent).toContain('Thu, Sep 24')
  })

  it('opens centred on now, worked out from the clock — its card is still collapsed when it mounts', () => {
    vi.setSystemTime(new Date(2026, 8, 23, 10, 30))
    calendar.events = [event('Standup', 23, [9, 0], [9, 15])]
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300)
    const scrollTop = vi.spyOn(Element.prototype, 'scrollTop', 'set')
    render()

    // 10:30 is 10.5 hours down a 96px-an-hour grid, with half the 300px
    // viewport above it.
    expect(scrollTop).toHaveBeenCalledWith(10.5 * 96 - 150)
  })

  it('says so when nothing is on today', () => {
    vi.setSystemTime(new Date(2026, 8, 23, 10, 0))
    calendar.events = [event('Tomorrow planning', 24, [9, 0], [10, 0])]
    render()

    expect(container.textContent).toContain('Nothing scheduled today.')
  })
})
