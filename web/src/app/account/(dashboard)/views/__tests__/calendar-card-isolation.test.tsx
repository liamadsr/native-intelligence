// @vitest-environment jsdom
/**
 * A calendar card in the chat never touches the Calendar page's state
 * (docs/plans/one-agent-and-chat-pages.md, P2). The page and a card are
 * mounted together, as they are when a Calendar window is open over a chat
 * with a calendar card:
 *   - the card fetches its own range and accounts, the page its own window;
 *   - moving the card's date, view or accounts never refetches or refilters
 *     the page (the shared account filter and cache are the page's and the
 *     Capture button's alone), and the page's filter never moves the card;
 *   - an optimistic edit reaches both, each on its own events.
 * The real CalendarView, CalendarCardView, provider, container and header
 * are mounted; only the grids, dialogs and data edges are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => null }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/integrations/calendar-local', () => ({ mergeWithLocalExchangeEvents: async (events: unknown[]) => events }))
vi.mock('@/calendar/adapters', () => ({
  calendarEventToIEvent: (e: { id: string; start: string; end: string; title: string; accountId?: string }) => ({
    id: e.id,
    title: e.title,
    startDate: e.start,
    endDate: e.end,
    color: 'blue',
    description: '',
    ...(e.accountId ? { accountId: e.accountId } : {}),
  }),
  actionToIEvent: (a: unknown) => a,
}))
vi.mock('@/calendar/persisted-events', () => ({ readPersistedEvents: () => null, writePersistedEvents: () => {} }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }))
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('@/calendar/components/week-and-day-view/calendar-day-view', () => ({ CalendarDayView: () => null }))
vi.mock('@/calendar/components/week-and-day-view/calendar-week-view', () => ({ CalendarWeekView: () => null }))
vi.mock('@/calendar/components/month-view/calendar-month-view', () => ({ CalendarMonthView: () => null }))
vi.mock('@/calendar/components/year-view/calendar-year-view', () => ({ CalendarYearView: () => null }))
vi.mock('@/calendar/components/agenda-view/calendar-agenda-view', () => ({ CalendarAgendaView: () => null }))
vi.mock('@/calendar/components/dialogs/add-event-dialog', () => ({ AddEventDialog: ({ children }: { children: unknown }) => children, AddEventPopover: () => null }))
vi.mock('@/components/views/page-title', () => ({ PageTitle: () => null }))
// The account picker: a button that picks one account.
vi.mock('@/components/account-filter-dropdown', () => ({
  AccountFilterDropdown: ({ onSelectionChange }: { onSelectionChange: (ids: string[] | null) => void }) =>
    h('button', { 'data-pick-account': '', onClick: () => onSelectionChange(['acct-picked']) }, 'accounts'),
  // Copy availability (the toolbar's): not what this test is about, so no calendar reads as connected.
  useHasConnectedAccount: () => false,
}))

const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/calendar/events')) {
    return { ok: true, status: 200, json: async () => ({ events: [{ id: 'e1', title: 'Standup', start: '2026-10-08T14:00:00Z', end: '2026-10-08T14:30:00Z', accountId: 'acct-gmail' }] }) }
  }
  return { ok: true, status: 200, json: async () => ({ actions: [] }) }
})

const { CalendarView, CalendarCardView } = await import('../calendar-view')
const { patchCalendarEventsCache } = await import('@/calendar/hooks/use-calendar-events')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const eventFetches = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/calendar/events'))
const params = (url: string) => new URL(url, 'http://x').searchParams

async function mountBoth(onEvents = vi.fn(), onStateChange = vi.fn()) {
  await act(async () => {
    root.render(
      h('div', null,
        h('div', { 'data-page': '' }, h(CalendarView)),
        h('div', { 'data-card': '' },
          h(CalendarCardView, { initial: { view: 'week', date: '2026-10-04', accounts: ['acct-gmail'] }, onEvents, onStateChange }),
        ),
      ),
    )
  })
  await act(async () => {})
  return { onEvents, onStateChange }
}

const inCard = (selector: string) => container.querySelector(`[data-card] ${selector}`) as HTMLElement
const inPage = (selector: string) => container.querySelector(`[data-page] ${selector}`) as HTMLElement

describe('a calendar card beside the Calendar page', () => {
  it('fetches its own week and accounts; the page keeps its own window and no filter', async () => {
    await mountBoth()
    const urls = eventFetches()
    const card = urls.find((u) => params(u).get('accountIds') === 'acct-gmail')!
    const page = urls.find((u) => !params(u).get('accountIds'))!
    expect(card).toBeDefined()
    expect(page).toBeDefined()
    expect(new Date(params(card).get('timeMin')!).getDate()).toBe(4)
    expect(new Date(params(card).get('timeMax')!).getDate()).toBe(11)
    expect(params(page).get('maxResults')).toBe('200')
  })

  it('moving the card (next week, a new account) never refetches or refilters the page', async () => {
    const { onStateChange } = await mountBoth()
    const pageFetchesBefore = eventFetches().filter((u) => params(u).get('maxResults') === '200').length

    const next = inCard('button svg.lucide-chevron-right')!.closest('button')!
    await act(async () => next.click())
    await act(async () => inCard('[data-pick-account]').click())
    await act(async () => {})

    expect(onStateChange).toHaveBeenLastCalledWith({ view: 'week', date: '2026-10-11', accounts: ['acct-picked'] })
    const cardFetches = eventFetches().filter((u) => params(u).get('maxResults') === '250')
    const last = cardFetches[cardFetches.length - 1]
    expect(params(last).get('accountIds')).toBe('acct-picked')
    expect(new Date(params(last).get('timeMin')!).getDate()).toBe(11)
    // The page: not one more fetch, and still no account filter.
    const pageFetches = eventFetches().filter((u) => params(u).get('maxResults') === '200')
    expect(pageFetches.length).toBe(pageFetchesBefore)
    expect(pageFetches.every((u) => !params(u).get('accountIds'))).toBe(true)
  })

  it('the page’s account filter never reaches the card', async () => {
    await mountBoth()
    const cardBefore = eventFetches().filter((u) => params(u).get('maxResults') === '250').length
    await act(async () => inPage('[data-pick-account]').click())
    await act(async () => {})
    const pageLast = eventFetches().filter((u) => params(u).get('maxResults') === '200').pop()!
    expect(params(pageLast).get('accountIds')).toBe('acct-picked')
    expect(eventFetches().filter((u) => params(u).get('maxResults') === '250').length).toBe(cardBefore)
  })

  it('an optimistic edit reaches the card’s own events too', async () => {
    const { onEvents } = await mountBoth()
    expect(onEvents).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'e1', title: 'Standup' })])
    await act(async () => patchCalendarEventsCache((events) => events.map((e) => ({ ...e, title: 'Standup (moved)' }))))
    expect(onEvents).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'e1', title: 'Standup (moved)' })])
  })

  it('an optimistic add lands on a card only when it is in its range and on its accounts', async () => {
    const { onEvents } = await mountBoth()
    const ev = (id: string, start: string, accountId?: string) => ({
      id, title: id, startDate: start, endDate: start.replace('T14', 'T15'), color: 'blue' as const, description: '', ...(accountId ? { accountId } : {}),
    })
    await act(async () =>
      patchCalendarEventsCache((events) => [
        ...events,
        ev('next-month', '2026-11-12T14:00:00Z', 'acct-gmail'),
        ev('other-account', '2026-10-07T14:00:00Z', 'acct-other'),
        ev('in-range', '2026-10-07T14:00:00Z', 'acct-gmail'),
      ]),
    )
    const ids = (onEvents.mock.calls.at(-1)![0] as Array<{ id: string }>).map((e) => e.id)
    expect(ids.sort()).toEqual(['e1', 'in-range'])
  })

  it('a card offers only day, week and month', async () => {
    await mountBoth()
    const labels = [...container.querySelectorAll('[data-card] button')].map((b) => b.querySelector('svg')?.getAttribute('class') ?? '')
    expect(labels.some((c) => c.includes('lucide-grid3x3') || c.includes('lucide-grid-3x3'))).toBe(false)
    const pageLabels = [...container.querySelectorAll('[data-page] button')].map((b) => b.querySelector('svg')?.getAttribute('class') ?? '')
    expect(pageLabels.some((c) => c.includes('grid-3x3') || c.includes('grid3x3'))).toBe(true)
  })
})
