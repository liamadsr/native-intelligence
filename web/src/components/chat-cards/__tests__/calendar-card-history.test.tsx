// @vitest-environment jsdom
/**
 * A calendar card's open event is a step of the card's history, but the card
 * holds only the range on screen: Back to an event outside it (after a move to
 * another week, or once it was deleted) says so once the range has loaded,
 * with a way back to the grid, rather than "Loading…" forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import type { IEvent } from '@/calendar/interfaces'

const grid = vi.hoisted(() => ({
  onEvents: null as null | ((events: unknown[] | null) => void),
  onSelectEvent: null as null | ((event: unknown) => void),
}))
vi.mock('@/app/account/(dashboard)/views/calendar-view', () => ({
  CalendarCardView: (props: { onEvents: (e: unknown[] | null) => void; onSelectEvent: (e: unknown) => void }) => {
    grid.onEvents = props.onEvents
    grid.onSelectEvent = props.onSelectEvent
    return React.createElement('div', { 'data-grid': '' })
  },
}))
vi.mock('@/app/account/(dashboard)/views/calendar-event-detail-panel', () => ({
  CalendarEventDetailPanel: ({ event, onClose, onEventDelete }: { event: { id: string }; onClose: () => void; onEventDelete: () => void }) =>
    React.createElement(
      'div',
      { 'data-event': event.id },
      React.createElement('button', { type: 'button', onClick: onClose }, 'Close event'),
      React.createElement('button', { type: 'button', onClick: onEventDelete }, 'Delete event'),
    ),
}))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => () => ({ [name]: () => null }) }))
vi.mock('@/app/account/(dashboard)/views/action-detail-panel', stub('ActionDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/capture-detail-panel', stub('CaptureDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/document-detail-panel', stub('DocumentDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/contact-detail-panel', stub('ContactDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/company-detail-panel', stub('CompanyDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/project-detail-panel', stub('ProjectDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/initiative-detail-panel', stub('InitiativeDetailPanel'))
vi.mock('@/components/views/unified-view-layout', () => ({
  CardSurfaceContext: React.createContext(null),
  UnifiedViewLayout: () => null,
  WindowFocusProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../pages/page-card', () => ({ PageGate: () => null }))

import { CardHistory, CardHistoryProvider } from '../card-history'
import CalendarCardBody from '../calendar-card-body'
import type { CalendarCardSpec } from '@/lib/chat-cards/kinds'

const nextTask = () => new Promise((r) => setTimeout(r, 0))
const spec: CalendarCardSpec = { kind: 'calendar', title: 'This week', calendar: { from: '2026-10-05', to: '2026-10-11', view: 'week' } }
const standup = { id: 'ev-1', title: 'Standup', startDate: '2026-10-06T10:00:00Z', endDate: '2026-10-06T10:15:00Z' } as IEvent
const review = { id: 'ev-2', title: 'Review', startDate: '2026-10-13T10:00:00Z', endDate: '2026-10-13T11:00:00Z' } as IEvent

describe('Back to a calendar event', () => {
  let mount: ReturnType<typeof mountRoot>
  beforeEach(() => {
    window.localStorage.clear()
    mount = mountRoot()
  })
  afterEach(() => mount.unmount())

  async function render(history: CardHistory) {
    const store = makeStore('cal1', spec)
    await mount.render(React.createElement(CardHistoryProvider, { value: history }, React.createElement(CalendarCardBody, { toolCallId: 'cal1', spec, store, fullScreen: false })))
    return store
  }
  const click = async (text: string) => {
    const b = Array.from(mount.container.querySelectorAll('button')).find((x) => x.textContent === text)!
    await act(async () => b.click())
    await act(nextTask)
  }

  it('outside the range on screen says so, with a way back to the grid', async () => {
    const history = new CardHistory()
    await render(history)
    await act(async () => grid.onEvents!([standup]))
    await act(async () => grid.onSelectEvent!(standup))
    await act(nextTask)
    expect(mount.container.querySelector('[data-event="ev-1"]')).not.toBeNull()
    await click('Close event')
    // Another week (not a step): the range reloads without the event.
    await act(async () => grid.onEvents!(null))
    await act(async () => grid.onEvents!([review]))

    await act(async () => void history.go(-1))
    expect(mount.container.textContent).not.toContain('Loading…')
    expect(mount.container.textContent).toContain('This event isn’t in this range.')
    await click('Show the calendar')
    expect(mount.container.textContent).not.toContain('This event isn’t in this range.')
    expect(mount.container.querySelector('[data-grid]')!.parentElement!.hasAttribute('inert')).toBe(false)
  })

  it('once deleted says so too', async () => {
    const history = new CardHistory()
    await render(history)
    await act(async () => grid.onEvents!([standup]))
    await act(async () => grid.onSelectEvent!(standup))
    await act(nextTask)
    await click('Delete event')
    await act(async () => grid.onEvents!([]))
    await act(async () => void history.go(-1))
    expect(mount.container.textContent).toContain('This event isn’t in this range.')
  })

  it('still loads while the range does', async () => {
    const history = new CardHistory()
    await render(history)
    await act(async () => grid.onEvents!(null))
    await act(async () => grid.onSelectEvent!(standup))
    expect(mount.container.textContent).toContain('Loading…')
    await act(async () => grid.onEvents!([standup]))
    expect(mount.container.querySelector('[data-event="ev-1"]')).not.toBeNull()
  })
})
