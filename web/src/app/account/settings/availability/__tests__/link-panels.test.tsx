// @vitest-environment jsdom
/**
 * Availability › Bookings and Insights (../link-bookings-panel.tsx,
 * ../link-insights-panel.tsx): the bookings listed by day, a view switched,
 * attendance marked and put back when the
 * save fails; the insights' tiles, the charts' table for screen readers, a
 * range picked and the CSV link following it. Made-up people.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

import { byDay, LinkBookingsPanel } from '../link-bookings-panel'
import { hoursLabel, LinkInsightsPanel, rangeQuery } from '../link-insights-panel'
import { valueFor } from '../link-form-gate-editor'
import { nextFreeDate } from '../link-hours-editor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const booking = (id: string, start: string, extra: Record<string, unknown> = {}) => ({
  id,
  link_id: 'l1',
  link_title: 'Intro call',
  title: 'Intro call',
  guest_name: id === 'b1' ? 'Dana Wu' : 'Eli Park',
  guest_email: 'guest@example.com',
  guest_phone: null,
  guest_time_zone: null,
  starts_at: start,
  ends_at: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
  state: 'confirmed',
  attendance: null,
  can_mark: false,
  host_name: 'Ava Lin',
  organizer: true,
  video: true,
  location: null,
  conference_url: null,
  cancelled_by: null,
  answers: [],
  created_at: start,
  ...extra,
})

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

beforeEach(() => {
  vi.useRealTimers()
  toasts.error.mockReset()
  fetchMock.mockReset()
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

describe('the Bookings tab', () => {
  it('lists the bookings by day and switches views', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('view=past')) return json({ bookings: [booking('b1', '2026-11-19T15:00:00Z', { can_mark: true })], more: false, links: [{ id: 'l1', title: 'Intro call', active: true }] })
      return json({ bookings: [booking('b1', '2026-11-25T15:00:00Z'), booking('b2', '2026-11-25T17:00:00Z')], more: false, links: [{ id: 'l1', title: 'Intro call', active: true }] })
    })
    await act(async () => root.render(h(LinkBookingsPanel)))
    await flush()
    expect(container.querySelectorAll('[data-booking-id]')).toHaveLength(2)
    expect(container.querySelectorAll('section')).toHaveLength(1)
    expect(container.textContent).toContain('Dana Wu')
    const past = [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent === 'Past') as HTMLButtonElement
    await act(async () => past.click())
    await flush()
    expect(fetchMock.mock.calls.at(-1)![0]).toContain('view=past')
    expect(container.textContent).toContain('Attended')
  })

  it('marks attendance, and puts it back when the save fails', async () => {
    let fail = false
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return fail ? json({ error: 'That booking changed just now' }, 400) : json({ booking: {} })
      return json({ bookings: [booking('b1', '2026-11-19T15:00:00Z', { can_mark: true })], more: false, links: [] })
    })
    await act(async () => root.render(h(LinkBookingsPanel)))
    await flush()
    const noShow = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('No-show')) as HTMLButtonElement
    await act(async () => noShow().click())
    await flush()
    expect(noShow().getAttribute('aria-pressed')).toBe('true')
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(patch[0]).toBe('/api/account/link-bookings/b1/attendance')
    expect(JSON.parse(patch[1].body)).toEqual({ attendance: 'no_show' })
    fail = true
    await act(async () => noShow().click())
    await flush()
    expect(toasts.error).toHaveBeenCalledWith('That booking changed just now')
    expect(noShow().getAttribute('aria-pressed')).toBe('true')
  })

  it('says so when nothing is booked', async () => {
    fetchMock.mockResolvedValue(json({ bookings: [], more: false, links: [] }))
    await act(async () => root.render(h(LinkBookingsPanel)))
    await flush()
    expect(container.textContent).toContain('Nothing booked yet')
  })

  it('groups by day in order', () => {
    const groups = byDay([booking('a', '2026-11-25T15:00:00Z'), booking('b', '2026-11-25T16:00:00Z'), booking('c', '2026-11-27T15:00:00Z')] as never)
    expect(groups.map((g) => g.bookings.length)).toEqual([2, 1])
  })
})

describe('the Insights tab', () => {
  const insights = {
    from: '2026-10-22T00:00:00.000Z',
    to: '2026-11-21T00:00:00.000Z',
    time_zone: 'UTC',
    bucket: 'day',
    totals: { booked: 12, requested: 1, cancelled: 2, declined: 0, hours: 7.5, attended: 9, no_shows: 1, no_show_rate: 0.1 },
    series: [
      { date: '2026-11-19', booked: 3, cancelled: 1 },
      { date: '2026-11-20', booked: 0, cancelled: 0 },
    ],
    top_links: [{ link_id: 'l1', title: 'Intro call', bookings: 12, hours: 7.5 }],
    truncated: false,
  }

  it('shows the tiles, the charts with a table behind them, and an export that follows the range', async () => {
    fetchMock.mockResolvedValue(json({ insights, links: [{ id: 'l1', title: 'Intro call', active: true }] }))
    await act(async () => root.render(h(LinkInsightsPanel)))
    await flush()
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/account\/link-bookings\/insights\?days=30&tz=/)
    expect(container.textContent).toContain('7.5 h')
    expect(container.textContent).toContain('10% of those marked')
    expect(container.textContent).toContain('1 waiting on you')
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(2)
    expect(container.querySelector('svg[role="img"]')).not.toBeNull()
    const seven = [...container.querySelectorAll('button')].find((b) => b.textContent === '7 days') as HTMLButtonElement
    await act(async () => seven.click())
    await flush()
    expect(fetchMock.mock.calls.at(-1)![0]).toContain('days=7')
    expect((container.querySelector('a[download]') as HTMLAnchorElement).getAttribute('href')).toMatch(/\/api\/account\/link-bookings\/export\?days=7&tz=/)
  })

  it('says why when the read fails', async () => {
    fetchMock.mockResolvedValue(json({ error: 'At most 366 days at once.' }, 400))
    await act(async () => root.render(h(LinkInsightsPanel)))
    await flush()
    expect(container.textContent).toContain('At most 366 days at once.')
  })

  it('its small helpers', () => {
    expect(rangeQuery({ kind: 'custom', from: '2026-11-01', to: '2026-11-07' }, 'UTC', 'l1')).toBe('from=2026-11-01&to=2026-11-07&tz=UTC&link=l1')
    expect(hoursLabel(2)).toBe('2 h')
    expect(hoursLabel(1.25)).toBe('1.3 h')
  })
})

describe('the dialog’s editors', () => {
  it('a condition’s value takes the shape its test wants', () => {
    expect(valueFor('gte', 'currency', '1000')).toBe(1000)
    expect(valueFor('equals', 'text', 'Acme')).toBe('Acme')
    expect(valueFor('in', 'select', 'Business')).toEqual(['Business'])
    expect(valueFor('is_true', 'checkbox', 'x')).toBeUndefined()
  })

  it('a new dated change lands on the next free day', () => {
    const now = new Date(2026, 10, 20, 12).getTime()
    expect(nextFreeDate({}, now)).toBe('2026-11-21')
    expect(nextFreeDate({ '2026-11-21': [] }, now)).toBe('2026-11-22')
  })
})
