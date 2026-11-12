// @vitest-environment jsdom
/**
 * The Availability page card (../pages/availability-card.tsx; Liam, 11-11:
 * "Availability (Right now it's in the settings but it needs to be it's own
 * page under Calendar)"): the real Availability view, the same reads and
 * sections, drawn for a card (the card's header names it, so no heading of
 * its own), and the page kind it is the body of.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import AvailabilityCard from '../pages/availability-card'
import { PAGE_KINDS, SHOW_PAGE_KIND_NAMES, isPageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NINE_TO_SIX = [{ start: '09:00', end: '18:00' }]
const WEEK = [[], NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, []]

describe('the availability page kind', () => {
  it('is a page the person opens, gated with the calendar, with no target', () => {
    expect(PAGE_KINDS.availability).toMatchObject({ label: 'Availability', view: 'calendar', personOnly: true })
    expect(isPageCardSpec({ kind: 'availability', title: 'Availability' })).toBe(true)
    expect(isPageCardSpec({ kind: 'availability', title: 'Availability', target: { type: 'team', id: 't1' } })).toBe(false)
    // `show` doesn't offer it: the agent's tools don't change.
    expect(SHOW_PAGE_KIND_NAMES as readonly string[]).not.toContain('availability')
  })
})

describe('AvailabilityCard', () => {
  let container: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
      if (url === '/api/account/availability') {
        return json({ hours: { time_zone: 'America/New_York', follows_you: true, weekly: WEEK, overrides: {}, saved: true }, sharing: 'busy_only' })
      }
      if (url === '/api/account/availability/calendars') return json({ accounts: [] })
      if (url === '/api/account/booking-links') return json({ links: [], handles: { me: 'ada-finch', workspace: null }, can_manage: true, user_id: 'u-ada' })
      return json({ members: [] })
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

  const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => {})
  }

  it('draws the Availability view in the card: its reads, its sections, no heading of its own', async () => {
    const props = { toolCallId: 'tc-1', spec: { kind: 'availability' as const, title: 'Availability' }, store: {} as ChatCardStore, fullScreen: false }
    act(() => root.render(h(AvailabilityCard, props)))
    await flush()
    expect(container.querySelector('[data-availability-card] [data-availability-view]')).not.toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    expect(container.textContent).toContain('When you can meet.')
    expect(container.querySelectorAll('[data-testid="availability-day"]')).toHaveLength(7)
    expect(container.querySelector('[aria-labelledby="availability-hours"]')).not.toBeNull()
    expect(container.querySelector('[aria-labelledby="availability-sharing"]')).not.toBeNull()
    expect(container.querySelector('[data-booking-links]')).not.toBeNull()
    const urls = fetchMock.mock.calls.map((c) => c[0])
    expect(urls).toContain('/api/account/availability')
    expect(urls).toContain('/api/account/availability/calendars')
  })
})
