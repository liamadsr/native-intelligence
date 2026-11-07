// @vitest-environment jsdom
/**
 * A calendar event block, in its two modes.
 *
 * On the calendar page, clicking the block opens the event, and a separate
 * Start button starts the meeting's capture.
 *
 * With `startOnClick` (the dashboard widget), the whole block is the Start
 * button: a click, Enter or Space starts the capture and nothing opens. There's
 * no Start button or Recording pill, which didn't fit a short meeting's block.
 * A capture that's already starting isn't started twice. Actions aren't
 * meetings, so they keep the default click.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { IEvent } from '@/calendar/interfaces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const calendar = vi.hoisted(() => ({
  startMeeting: vi.fn(),
  selectEvent: vi.fn(),
  startingId: null as string | null,
}))

vi.mock('@/calendar/contexts/calendar-context', () => ({
  useCalendarSettings: () => ({ badgeVariant: 'colored' }),
  useCalendarMutators: () => ({ selectEvent: calendar.selectEvent }),
}))
vi.mock('@/calendar/hooks/use-start-meeting', () => ({
  useStartMeetingFromEvent: () => ({
    startMeeting: calendar.startMeeting,
    startingId: calendar.startingId,
    isRecording: false,
    isLive: () => false,
  }),
}))

import { EventBlock } from '../event-block'

/** A 15-minute meeting — the size whose Start button didn't fit. */
const MEETING: IEvent = {
  id: 'standup',
  title: 'Standup',
  color: 'blue',
  description: '',
  startDate: new Date(2026, 8, 23, 9, 0).toISOString(),
  endDate: new Date(2026, 8, 23, 9, 15).toISOString(),
}

let container: HTMLDivElement
let root: Root

function render(event: IEvent, props: { readOnly?: boolean; startOnClick?: boolean } = {}) {
  act(() => {
    root.render(h(EventBlock, { event, ...props }))
  })
}

const card = () => container.querySelector<HTMLElement>('[role="button"]')!
const startButton = () =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Start') ?? null
const press = (key: string) =>
  act(() => {
    card().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })

beforeEach(() => {
  calendar.startMeeting.mockClear()
  calendar.selectEvent.mockClear()
  calendar.startingId = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('an event block on the calendar page', () => {
  it('opens the event on click and starts its capture from the Start button', () => {
    render(MEETING)

    act(() => card().click())
    expect(calendar.selectEvent).toHaveBeenCalledWith(MEETING)
    expect(calendar.startMeeting).not.toHaveBeenCalled()

    act(() => startButton()!.click())
    expect(calendar.startMeeting).toHaveBeenCalledWith(MEETING)
    expect(calendar.selectEvent).toHaveBeenCalledTimes(1)
  })
})

describe('an event block with startOnClick', () => {
  it('starts the capture on click, Enter or Space, and opens nothing', () => {
    render(MEETING, { readOnly: true, startOnClick: true })
    expect(startButton()).toBeNull()

    act(() => card().click())
    press('Enter')
    press(' ')
    press('a')
    expect(calendar.startMeeting).toHaveBeenCalledTimes(3)
    expect(calendar.startMeeting).toHaveBeenCalledWith(MEETING)
    expect(calendar.selectEvent).not.toHaveBeenCalled()
  })

  it('does not start a capture that is already starting, and shows it is busy', () => {
    calendar.startingId = MEETING.id
    render(MEETING, { readOnly: true, startOnClick: true })

    act(() => card().click())
    press('Enter')
    expect(calendar.startMeeting).not.toHaveBeenCalled()
    expect(card().getAttribute('aria-busy')).toBe('true')
    expect(card().querySelector('.animate-spin')).not.toBeNull()
  })

  it('shows a rolling capture as the title-row dot, not a Recording pill', () => {
    render(
      { ...MEETING, linkedCapture: { capture_id: 'c1', auto_capture_status: 'recording', ai_processed: false, source_action_count: 0 } },
      { readOnly: true, startOnClick: true },
    )

    expect(container.textContent).not.toContain('Recording')
    expect(container.querySelector('[title="Recording"]')).not.toBeNull()
  })

  it('leaves an action with the default click — actions are not meetings', () => {
    const action = { ...MEETING, id: 'action-1', isAction: true }
    render(action, { readOnly: true, startOnClick: true })

    act(() => card().click())
    expect(calendar.selectEvent).toHaveBeenCalledWith(action)
    expect(calendar.startMeeting).not.toHaveBeenCalled()
  })
})
