// @vitest-environment jsdom
/**
 * The guest's manage page (../manage-view.tsx): the meeting in their zone,
 * cancel behind a confirm step, "Pick another time" over /times and the
 * move, the moves left only once one is used, and the final states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { ManageView } from '../manage-view'
import type { PageLoad, PublicBookingData } from '@/lib/time-offers/display'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TOKEN = 'ZyXwVuTsRqPoNmLkJiHgFeDc'
const BOOKING: PublicBookingData = {
  state: 'confirmed',
  title: 'Intro call',
  start: '2030-11-19T15:00:00.000Z',
  end: '2030-11-19T15:30:00.000Z',
  host_name: 'Ava Lin',
  guest_name: 'Dana Reyes',
  time_zone: 'America/Chicago',
  video: true,
  conference_url: 'https://meet.example/abc-defg-hij',
  location: null,
  can_cancel: true,
  can_reschedule: true,
  reschedules_left: 3,
}
const TIMES = [
  { start: '2030-11-19T15:00:00.000Z', end: '2030-11-19T15:30:00.000Z' },
  { start: '2030-11-21T20:00:00.000Z', end: '2030-11-21T20:30:00.000Z' },
  { start: '2030-11-22T14:30:00.000Z', end: '2030-11-22T15:00:00.000Z' },
]
const found = (b: Partial<PublicBookingData> = {}): PageLoad<PublicBookingData> => ({ kind: 'found', data: { ...BOOKING, ...b } })

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'America/Chicago' } as Intl.ResolvedDateTimeFormatOptions)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const draw = (load: PageLoad<PublicBookingData>) => act(() => root.render(h(ManageView, { token: TOKEN, load })))
const fresh = (load: PageLoad<PublicBookingData>) => {
  act(() => root.unmount())
  root = createRoot(container)
  draw(load)
}
const q = (sel: string) => container.querySelector(sel)
const state = () => q('[data-manage-state]')?.getAttribute('data-manage-state')
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text) ?? null
async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  await act(async () => (el as HTMLElement).click())
}

describe('ManageView', () => {
  it('the meeting in the guest zone, its video link, both actions, no moves-left line before a move', () => {
    draw(found())
    expect(state()).toBe('upcoming')
    expect(q('[data-manage-when]')?.textContent).toBe('Tuesday, November 19 · 9:00 AM – 9:30 AM CST')
    expect(q('[data-manage-video]')?.getAttribute('href')).toBe('https://meet.example/abc-defg-hij')
    expect(q('[data-manage-move]')).not.toBeNull()
    expect(q('[data-manage-cancel]')).not.toBeNull()
    expect(container.textContent).not.toContain('more time')
  })

  it('cancel asks first; "Keep it" goes back; yes cancels and says the host was told', async () => {
    draw(found())
    await click(q('[data-manage-cancel]'))
    expect(q('[data-manage-confirm-cancel]')?.textContent).toContain("Ava Lin will be told, and you can't undo it from here.")
    expect(fetchMock).not.toHaveBeenCalled()
    await click(button('Keep it'))
    expect(q('[data-manage-confirm-cancel]')).toBeNull()
    await click(q('[data-manage-cancel]'))
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, booking: { ...BOOKING, state: 'cancelled', can_cancel: false, can_reschedule: false } }))
    await click(button('Yes, cancel it'))
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/public/bookings/${TOKEN}/cancel`)
    expect(state()).toBe('cancelled')
    expect(container.textContent).toContain('Ava Lin has been told.')
  })

  it('pick another time: the open times but the current one, grouped by day; the move updates the meeting', async () => {
    draw(found())
    fetchMock.mockResolvedValueOnce(reply(200, { time_zone: 'America/New_York', slots: TIMES }))
    await click(q('[data-manage-move]'))
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/public/bookings/${TOKEN}/times`)
    const slotButtons = () => [...container.querySelectorAll('[data-manage-slots] button')] as HTMLButtonElement[]
    expect(slotButtons().map((b) => b.textContent)).toEqual(['2:00 PM', '8:30 AM'])
    await click(slotButtons()[0])
    expect(q('[data-manage-confirm-move]')?.textContent).toBe('Move to Thu, Nov 21 at 2:00 PM')
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, booking: { ...BOOKING, start: TIMES[1].start, end: TIMES[1].end, reschedules_left: 2 } }))
    await click(q('[data-manage-confirm-move]'))
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ start: TIMES[1].start })
    expect(q('[data-manage-when]')?.textContent).toBe('Thursday, November 21 · 2:00 PM – 2:30 PM CST')
    expect(q('[data-manage-news]')?.textContent).toContain('Moved to Thursday, November 21, 2:00 PM.')
    expect(container.textContent).toContain('You can move it 2 more times.')
    expect(q('[data-manage-pick]')).toBeNull()
  })

  it('a time taken while picking: says so and re-reads the times', async () => {
    draw(found())
    fetchMock.mockResolvedValueOnce(reply(200, { time_zone: 'America/New_York', slots: TIMES }))
    await click(q('[data-manage-move]'))
    await click(container.querySelector('[data-manage-slots] button'))
    fetchMock.mockResolvedValueOnce(reply(409, { error: 'That time was just taken. Pick another.', code: 'SLOT_TAKEN' }))
    fetchMock.mockResolvedValueOnce(reply(200, { time_zone: 'America/New_York', slots: [TIMES[2]] }))
    await click(q('[data-manage-confirm-move]'))
    expect(q('[data-manage-error]')?.textContent).toBe('That time was just taken. Pick another.')
    expect([...container.querySelectorAll('[data-manage-slots] button')].map((b) => b.textContent)).toEqual(['8:30 AM'])
  })

  it('no other times open: says so', async () => {
    draw(found())
    fetchMock.mockResolvedValueOnce(reply(200, { time_zone: 'America/New_York', slots: [TIMES[0]] }))
    await click(q('[data-manage-move]'))
    expect(q('[data-manage-empty]')?.textContent).toContain('No other times are open in the next two weeks.')
  })

  it("the calendar can't be read for the times: back to the meeting with the reason", async () => {
    draw(found())
    fetchMock.mockResolvedValueOnce(reply(503, { error: 'x', code: 'UNAVAILABLE' }))
    await click(q('[data-manage-move]'))
    expect(q('[data-manage-pick]')).toBeNull()
    expect(q('[data-manage-error]')?.textContent).toBe("The calendar couldn't be checked just now. Try again in a minute.")
  })

  it('moves used up: no "Pick another time", and no count', () => {
    draw(found({ can_reschedule: false, reschedules_left: 0 }))
    expect(q('[data-manage-move]')).toBeNull()
    expect(q('[data-manage-cancel]')).not.toBeNull()
    expect(container.textContent).not.toContain('more time')
  })

  it('one move left says so', () => {
    draw(found({ reschedules_left: 1 }))
    expect(container.textContent).toContain('You can move it one more time.')
  })

  it('final states: cancelled, failed, past, under way, missing, unavailable', () => {
    draw(found({ state: 'cancelled', can_cancel: false, can_reschedule: false }))
    expect(state()).toBe('cancelled')
    expect(container.textContent).toContain('To meet another time, reach out to Ava Lin.')
    fresh(found({ state: 'failed', can_cancel: false, can_reschedule: false }))
    expect(state()).toBe('failed')
    fresh(found({ start: '2020-01-07T15:00:00.000Z', end: '2020-01-07T15:30:00.000Z', can_cancel: false, can_reschedule: false }))
    expect(state()).toBe('past')
    const now = Date.now()
    fresh(found({ start: new Date(now - 60_000).toISOString(), end: new Date(now + 60 * 60_000).toISOString(), can_cancel: false, can_reschedule: false }))
    expect(state()).toBe('live')
    expect(q('[data-manage-video]')).not.toBeNull()
    expect(q('[data-manage-cancel]')).toBeNull()
    fresh({ kind: 'missing' })
    expect(state()).toBe('missing')
    fresh({ kind: 'error' })
    expect(state()).toBe('error')
  })
})
