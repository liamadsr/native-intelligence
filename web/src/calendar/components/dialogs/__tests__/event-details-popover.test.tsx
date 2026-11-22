// @vitest-environment jsdom
/**
 * The event card on the calendar (event-details-popover.tsx), in the
 * calendar's own provider: a click on an event opens it beside the block,
 * which reads as selected; Esc, its X or a click outside close it. Its
 * buttons: Join, Start capture (with no call too) or the capture there is,
 * delete with its confirm, edit in place, the .ics, the full panel, and
 * "Going?" for a guest. A task keeps opening its action. People are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { IEvent } from '@/calendar/interfaces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  startMeeting: vi.fn(),
  saveTextFile: vi.fn(async (name: string) => name),
  patchCache: vi.fn(),
  isRecording: false,
}))

vi.mock('@/calendar/hooks/use-start-meeting', () => ({
  useStartMeetingFromEvent: () => ({ startMeeting: mocks.startMeeting, startingId: null, isRecording: mocks.isRecording, isLive: () => false }),
}))
vi.mock('@/calendar/hooks/use-calendar-events', () => ({ patchCalendarEventsCache: mocks.patchCache }))
vi.mock('@/components/meeting-links/join-meeting', () => ({
  useOurMeeting: () => null,
  useJoinOurMeeting: () => ({ join: vi.fn(), joining: false }),
}))
vi.mock('@/lib/download', () => ({ saveTextFile: mocks.saveTextFile }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
// The real picker is a whole popover of its own; a plain input stands in for it.
vi.mock('@/components/ui/datetime-picker', () => ({
  DateTimePicker: ({ placeholder }: { placeholder?: string }) => h('input', { 'aria-label': placeholder }),
}))

import { CalendarProvider } from '@/calendar/contexts/calendar-context'
import { EventDetailsDialog } from '../event-details-dialog'
import { EventDetailsPopover } from '../event-details-popover'

const at = (hh: number, mm = 0) => new Date(2026, 10, 18, hh, mm).toISOString()

const GUEST_EVENT: IEvent = {
  id: 'review',
  title: 'Design review',
  color: 'blue',
  description: 'Bring the mocks',
  startDate: at(8),
  endDate: at(9),
  location: 'Room 4',
  conferenceUrl: 'https://meet.google.com/abc-defg-hij',
  htmlLink: 'https://calendar.google.com/event?eid=abc',
  provider: 'google',
  icalUid: 'review-uid@example.com',
  accountEmail: 'ana@example.com',
  calendarName: 'Work',
  response: 'pending',
  attendeeDetails: [
    { email: 'ben@example.com', name: 'Ben Okafor', isOrganizer: true, responseStatus: 'accepted' },
    { email: 'ana@example.com', name: 'Ana Ruiz', responseStatus: 'needsAction' },
  ],
}

/** Ana's own event, no one invited, no call. */
const OWN_EVENT: IEvent = {
  id: 'focus',
  title: 'Focus time',
  color: 'green',
  description: '',
  startDate: at(10),
  endDate: at(11),
  provider: 'google',
  icalUid: 'focus-uid@example.com',
  accountEmail: 'ana@example.com',
}

const TASK: IEvent = { id: 'task-1', title: 'Ship it', color: 'red', description: '', startDate: at(12), endDate: at(12, 30), isAction: true, actionId: 'act-1' }

let container: HTMLDivElement
let root: Root
const onSelectEvent = vi.fn()
const onSelectAction = vi.fn()
const onOpenCapture = vi.fn()
let fetchMock: ReturnType<typeof vi.fn>

function render(events: IEvent[]) {
  act(() => {
    root.render(
      h(
        CalendarProvider,
        { events, onSelectEvent, onSelectAction, onOpenCapture, children: null },
        ...events.map((e) => h(EventDetailsDialog, { key: e.id, event: e, children: h('div', { role: 'button', 'data-block': e.id }, e.title) })),
        h('div', { 'data-outside': '' }, 'elsewhere'),
        h(EventDetailsPopover),
      ),
    )
  })
}

const block = (id: string) => container.querySelector<HTMLElement>(`[data-block="${id}"]`)!
const card = () => document.querySelector<HTMLElement>('[data-event-card]')
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[data-event-card] button[aria-label="${label}"]`)
const byText = (text: string) => [...document.querySelectorAll<HTMLElement>('[data-event-card] button, [data-event-card] a')].find((b) => b.textContent?.trim() === text) ?? null
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const open = async (id: string) => {
  act(() => block(id).click())
  await flush()
}

beforeEach(() => {
  mocks.startMeeting.mockReset()
  mocks.saveTextFile.mockClear()
  mocks.patchCache.mockClear()
  mocks.isRecording = false
  onSelectEvent.mockReset()
  onSelectAction.mockReset()
  onOpenCapture.mockReset()
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === 'GET') {
      return new Response(JSON.stringify({ found: true, canAnswer: true, response: 'pending' }), { status: 200 })
    }
    return new Response(JSON.stringify({ found: true, canAnswer: true, response: 'accepted' }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the event card', () => {
  it('opens beside the clicked event with its details, and marks the block selected', async () => {
    render([GUEST_EVENT, OWN_EVENT])
    await open('review')

    const c = card()!
    expect(c).not.toBeNull()
    expect(c.getAttribute('role')).toBe('dialog')
    expect(c.textContent).toContain('Design review')
    expect(c.textContent).toContain('Wed, November 18 · 8:00 AM–9:00 AM')
    expect(c.textContent).toContain('Room 4')
    expect(c.textContent).toContain('Bring the mocks')
    expect(c.textContent).toContain('ana@example.com')
    expect(c.textContent).toContain('2 attendees')
    expect(c.querySelector('[data-guest="ana@example.com"]')!.textContent).toContain('Ana Ruiz (you)')
    expect(c.querySelector('[data-guest="ben@example.com"]')!.textContent).toContain('Organizer')

    const join = byText('Join Google Meet') as HTMLAnchorElement
    expect(join.getAttribute('href')).toBe(GUEST_EVENT.conferenceUrl)
    expect(c.querySelector('[data-event-card-capture="start"]')).not.toBeNull()

    expect(container.querySelector('[data-calendar-event-trigger="review"]')!.hasAttribute('data-event-selected')).toBe(true)
    expect(container.querySelector('[data-calendar-event-trigger="focus"]')!.hasAttribute('data-event-selected')).toBe(false)
    // The full panel is not opened: the card is the event's place now.
    expect(onSelectEvent).not.toHaveBeenCalled()
  })

  it('moves to another event on its click, and closes on Esc, its X and a click outside', async () => {
    render([GUEST_EVENT, OWN_EVENT])
    await open('review')
    await open('focus')
    expect(card()!.textContent).toContain('Focus time')

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(card()).toBeNull()

    await open('focus')
    act(() => card()!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(card()).not.toBeNull()
    act(() => button('Close')!.click())
    expect(card()).toBeNull()

    await open('focus')
    act(() => container.querySelector('[data-outside]')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(card()).toBeNull()
    expect(container.querySelector('[data-event-selected]')).toBeNull()
  })

  it('starts a capture, with no video call as well', async () => {
    render([OWN_EVENT])
    await open('focus')
    expect(byText('Join meeting')).toBeNull()
    act(() => card()!.querySelector<HTMLButtonElement>('[data-event-card-capture="start"]')!.click())
    expect(mocks.startMeeting).toHaveBeenCalledWith(OWN_EVENT)
  })

  it('shows the capture there is and opens it', async () => {
    const captured = { ...OWN_EVENT, linkedCapture: { capture_id: 'cap-1', auto_capture_status: 'completed', ai_processed: true, source_action_count: 3 } }
    render([captured])
    await open('focus')
    const view = card()!.querySelector<HTMLButtonElement>('[data-event-card-capture="captured"]')!
    expect(view.textContent).toContain('View capture · 3 actions')
    act(() => view.click())
    expect(onOpenCapture).toHaveBeenCalledWith('cap-1', 'Focus time')
    expect(card()).toBeNull()
  })

  it('opens the full panel from its button', async () => {
    render([GUEST_EVENT])
    await open('review')
    act(() => button('Open full details')!.click())
    expect(onSelectEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'review' }))
    expect(card()).toBeNull()
  })

  it('leaves a task to its action, with no card', async () => {
    render([TASK])
    await open('task-1')
    expect(onSelectAction).toHaveBeenCalledWith('act-1')
    expect(card()).toBeNull()
  })

  it('downloads the event as an .ics', async () => {
    render([GUEST_EVENT])
    await open('review')
    await act(async () => button('Download .ics')!.click())
    expect(mocks.saveTextFile).toHaveBeenCalledWith('design-review.ics', expect.stringContaining('UID:review-uid@example.com'), 'text/calendar')
  })

  it('deletes only after the confirm, then closes', async () => {
    render([OWN_EVENT])
    await open('focus')
    act(() => button('Delete event')!.click())
    expect(fetchMock).not.toHaveBeenCalled()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Delete')!
    // A press in the confirm is not "outside" the card.
    act(() => confirm.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    await act(async () => confirm.click())
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/calendar/events?eventId=focus', { method: 'DELETE' })
    expect(card()).toBeNull()
  })

  it('edits in place and saves through the events route', async () => {
    render([OWN_EVENT])
    await open('focus')
    act(() => button('Edit event')!.click())
    const title = document.querySelector<HTMLInputElement>('[data-event-card-edit] input[aria-label="Title"]')!
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(title, 'Deep work')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => byText('Save')!.click())
    await flush()
    const [url, init] = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')!
    expect(url).toBe('/api/calendar/events')
    expect(JSON.parse(init.body)).toMatchObject({ eventId: 'focus', title: 'Deep work', start: OWN_EVENT.startDate, end: OWN_EVENT.endDate })
    expect(document.querySelector('[data-event-card-edit]')).toBeNull()
  })
})

describe('Going?', () => {
  it('answers for a guest on their calendar, and shows the answer', async () => {
    render([GUEST_EVENT])
    await open('review')
    const footer = card()!.querySelector('[data-event-card-going]')!
    expect(footer).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/calendar/rsvp?uid=review-uid%40example.com', expect.anything())

    const yes = [...footer.querySelectorAll('button')].find((b) => b.textContent === 'Yes')!
    expect(yes.getAttribute('aria-pressed')).toBe('false')
    await act(async () => yes.click())
    await flush()
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!
    expect(post[0]).toBe('/api/calendar/rsvp')
    expect(JSON.parse(post[1].body)).toEqual({ uid: 'review-uid@example.com', response: 'accepted' })
    expect(yes.getAttribute('aria-pressed')).toBe('true')
  })

  it('is not offered on the person’s own event with no one invited', async () => {
    render([OWN_EVENT])
    await open('focus')
    expect(card()!.querySelector('[data-event-card-going]')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('goes away when the calendar says it can’t be answered', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ found: true, canAnswer: false, blocked: 'organizer' }), { status: 200 }))
    render([GUEST_EVENT])
    await open('review')
    await flush()
    expect(card()!.querySelector('[data-event-card-going]')).toBeNull()
  })
})
