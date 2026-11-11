// @vitest-environment jsdom
/**
 * Settings → Availability (../availability-settings-view.tsx): the week
 * Monday first with each day's hours, the dated changes with their remove
 * buttons, the calendars with whether each counts, and the sharing switch;
 * each change goes to its route. Plus the labels and the week's check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AvailabilitySettingsView, clockLabel, datedChangeLabel, weekProblem } from '../availability-settings-view'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NINE_TO_SIX = [{ start: '09:00', end: '18:00' }]
const WEEK = [[], NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, []]

describe('the labels and the check', () => {
  it('clock and dated-change labels', () => {
    expect(clockLabel('09:00')).toBe('9:00 AM')
    expect(clockLabel('12:30')).toBe('12:30 PM')
    expect(clockLabel('00:15')).toBe('12:15 AM')
    expect(clockLabel('24:00')).toBe('12:00 AM')
    expect(datedChangeLabel('2026-11-27', [])).toBe('Fri, Nov 27 · Day off')
    expect(datedChangeLabel('2026-11-28', [{ start: '10:00', end: '13:00' }])).toBe('Sat, Nov 28 · 10:00 AM – 1:00 PM')
  })

  it('a week whose ranges end after they start and never overlap', () => {
    expect(weekProblem(WEEK)).toBeNull()
    expect(weekProblem([[], [{ start: '10:00', end: '09:00' }], [], [], [], [], []])).toBe('Monday: each range ends after it starts.')
    expect(weekProblem([[], [], [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }], [], [], [], []])).toBe('Tuesday: the ranges overlap.')
    expect(weekProblem([[], [], [], [{ start: '', end: '12:00' }], [], [], []])).toBe('Wednesday: fill in both times.')
  })
})

describe('AvailabilitySettingsView', () => {
  let container: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
      if (url === '/api/account/availability' && (!init || !init.method)) {
        return json({ hours: { time_zone: 'America/New_York', follows_you: true, weekly: WEEK, overrides: { '2026-11-27': [] }, saved: true }, sharing: 'busy_only' })
      }
      if (url === '/api/account/availability/calendars' && !init?.method) {
        return json({
          accounts: [
            { id: 'acc-g', provider: 'google', account_email: 'ada.finch@example.com', error: null, calendars: [{ id: 'primary', name: 'Ada Finch', color: '#4285f4', primary: true, counts: true, counts_by_default: true }, { id: 'holidays', name: 'Holidays', color: null, primary: false, counts: false, counts_by_default: false }] },
            { id: 'acc-m', provider: 'microsoft', account_email: 'ada.finch@example.org', error: 'Needs signing in again', calendars: [] },
          ],
        })
      }
      return json({ ok: true, sharing: 'none', hours: { time_zone: 'America/New_York', follows_you: true, weekly: WEEK, overrides: {}, saved: true } })
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

  it('shows the week Monday first, the dated change, the calendars and the sharing switch', async () => {
    act(() => root.render(h(AvailabilitySettingsView)))
    await flush()
    const days = [...container.querySelectorAll('[data-testid="availability-day"]')].map((d) => d.textContent)
    expect(days[0]).toContain('Monday')
    expect(days[6]).toContain('Sunday')
    expect(days[6]).toContain('Off')
    expect(container.querySelector('[data-testid="availability-dated"]')?.textContent).toContain('Fri, Nov 27 · Day off')
    expect([...container.querySelectorAll('[data-testid="availability-calendar"]')].map((c) => c.textContent)).toEqual(['Ada Finch', 'Holidays'])
    expect(container.textContent).toContain('Needs signing in again')
    expect(container.textContent).toContain('In America/New_York, the time zone you’re in.')
    expect(container.querySelector('[aria-label="Share when you’re busy"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('each change goes to its route', async () => {
    act(() => root.render(h(AvailabilitySettingsView)))
    await flush()
    const click = async (selector: string) => {
      const el = container.querySelector(selector) as HTMLElement
      expect(el, selector).not.toBeNull()
      await act(async () => el.click())
      await flush()
    }
    const bodies = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT').map((c) => [c[0], JSON.parse(String((c[1] as RequestInit).body))])

    await click('[aria-label="Share when you’re busy"]')
    await click('[aria-label="Holidays counts as busy"]')
    await click('[aria-label="Remove the change on 2026-11-27"]')
    expect(bodies()).toEqual([
      ['/api/account/availability', { sharing: 'none' }],
      ['/api/account/availability/calendars', { account_id: 'acc-g', calendar_id: 'holidays', counts: true }],
      ['/api/account/availability', { clear_dates: ['2026-11-27'] }],
    ])

    // Turning Saturday on makes the week dirty: Save sends the whole week.
    await click('[aria-label="Work on Saturday"]')
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save hours')!
    await act(async () => save.click())
    await flush()
    expect(bodies().at(-1)).toEqual(['/api/account/availability', { weekly: [[], ...WEEK.slice(1, 6), [{ start: '09:00', end: '17:00' }]] }])
  })
})
