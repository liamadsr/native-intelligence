// @vitest-environment jsdom
/**
 * A poll guest's page (../poll-view.tsx, availability phase 5): every time
 * that works marked (or none, with a note), saved through POST /answer; the
 * saved answer with "Change my answer" and how many are still to answer
 * (counts only); an answer filled in from their calendar; the booked
 * meeting with their own manage link, or a booking without them; and every
 * failure of the save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, createElement as h } from 'react'
import { PollView } from '../poll-view'
import type { PublicPollData } from '@/lib/time-offers/display'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx'
const SLOTS = [
  { start: '2030-11-19T15:00:00.000Z', end: '2030-11-19T15:30:00.000Z' },
  { start: '2030-11-19T19:00:00.000Z', end: '2030-11-19T19:30:00.000Z' },
  { start: '2030-11-20T16:00:00.000Z', end: '2030-11-20T16:30:00.000Z' },
]
const POLL: PublicPollData = {
  state: 'open',
  host_name: 'Ava Lin',
  title: 'Planning session',
  duration_minutes: 45,
  video: true,
  location: null,
  message: null,
  time_zone: 'America/New_York',
  expires_at: SLOTS[2].start,
  recipient_name: 'Dana Reyes',
  slots: SLOTS,
  answer: null,
  guests: 3,
  waiting: 3,
  booked: null,
}
const poll = (p: Partial<PublicPollData> = {}): PublicPollData => ({ ...POLL, ...p })

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

const draw = (initial: PublicPollData) => act(() => root.render(h(PollView, { token: TOKEN, initial })))
const q = (sel: string) => container.querySelector(sel)
const state = () => q('[data-poll-state]')?.getAttribute('data-poll-state')
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const timeButtons = () => [...container.querySelectorAll('[data-poll-slots] button')] as HTMLButtonElement[]
const saveButton = () => q('[data-poll-form] button[type="submit"]') as HTMLButtonElement
const noneBox = () => q('[data-poll-none] input') as HTMLInputElement

function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  act(() => (el as HTMLElement).click())
}

function type(el: Element | null, value: string) {
  const input = el as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function save() {
  await act(async () => {
    ;(q('[data-poll-form]') as HTMLFormElement).requestSubmit()
  })
}

const saved = (works: string[], extra: Partial<PublicPollData> = {}) =>
  reply(200, { ok: true, poll: poll({ answer: { works, none: works.length === 0, note: null, answered_at: '2030-11-15T12:00:00.000Z', from_calendar: false }, waiting: 2, ...extra }) })

describe('PollView', () => {
  it("the server renders the host's zone; the browser shows the guest's, and only counts of the others", () => {
    const html = renderToString(h(PollView, { token: TOKEN, initial: poll() })).replace(/<!-- -->/g, '')
    expect(html).toContain('Times in EST</p>')
    draw(poll())
    expect(state()).toBe('open')
    expect(q('[data-poll-zone]')?.textContent).toBe('Times in CST (Ava Lin is on EST)')
    expect(timeButtons().map((b) => b.textContent)).toEqual(['9:00 AM', '1:00 PM', '10:00 AM'])
    expect(container.textContent).toContain('Ava Lin is finding a time for 3 people. Mark every time that works.')
    expect(saveButton().disabled).toBe(true)
  })

  it('marks several times, saves them, and shows the answer with how many are still to answer', async () => {
    draw(poll())
    click(timeButtons()[0])
    click(timeButtons()[2])
    expect(timeButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true'])
    click(timeButtons()[0])
    click(timeButtons()[0])
    expect((q('input[name="website"]') as HTMLInputElement).className).toContain('hidden')
    fetchMock.mockResolvedValueOnce(saved([SLOTS[0].start, SLOTS[2].start]))
    await save()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/public/time-offers/${TOKEN}/answer`)
    expect(JSON.parse(String(init.body))).toEqual({ works: [SLOTS[2].start, SLOTS[0].start], none: false, website: '' })
    expect(state()).toBe('answered')
    expect([...container.querySelectorAll('[data-poll-answer] li')].map((li) => li.textContent)).toEqual(['Tue, Nov 19, 9:00 AM', 'Wed, Nov 20, 10:00 AM'])
    expect(q('[data-poll-waiting]')?.textContent).toBe('2 people still to answer.')
    expect(container.textContent).not.toContain('Sam')
    click(q('[data-poll-change]'))
    expect(state()).toBe('open')
    expect(timeButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true'])
  })

  it('none of these work, with a note', async () => {
    draw(poll())
    click(timeButtons()[1])
    act(() => noneBox().click())
    expect(timeButtons().every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(saveButton().disabled).toBe(false)
    type(q('#poll-note'), 'Next week is better')
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, poll: poll({ answer: { works: [], none: true, note: 'Next week is better', answered_at: '2030-11-15T12:00:00.000Z', from_calendar: false }, waiting: 1 }) }))
    await save()
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ works: [], none: true, note: 'Next week is better', website: '' })
    expect(q('[data-poll-answer]')?.textContent).toContain('None of these times work for you.')
    expect(q('[data-poll-answer]')?.textContent).toContain('Next week is better')
    expect(q('[data-poll-waiting]')?.textContent).toBe('1 person still to answer.')
  })

  it('an answer from their calendar is shown prefilled, and can be changed', () => {
    draw(poll({ answer: { works: [SLOTS[1].start], none: false, note: null, answered_at: '2030-11-15T12:00:00.000Z', from_calendar: true }, waiting: 1 }))
    expect(state()).toBe('answered')
    expect(q('[data-poll-calendar]')?.textContent).toContain('filled in from your calendar')
    expect(q('[data-poll-saved]')).toBeNull()
    click(q('[data-poll-change]'))
    expect(timeButtons()[1].getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('Keep my answer')
  })

  it('booked: the time, the video link and their own manage link; booked without them: reply to the host', () => {
    draw(poll({ state: 'booked', slots: [], booked: { start: SLOTS[1].start, end: SLOTS[1].end, attending: true, video: true, conference_url: 'https://meet.example/abc-defg-hij', location: null, manage_url: 'https://app.example/b/ZyXwVuTsRqPoNmLkJiHgFeDc' } }))
    expect(state()).toBe('booked')
    expect(q('[data-poll-when]')?.textContent).toBe('Tuesday, November 19 · 1:00 PM – 1:30 PM CST')
    expect(q('[data-poll-video]')?.getAttribute('href')).toBe('https://meet.example/abc-defg-hij')
    expect(q('[data-poll-manage]')?.getAttribute('href')).toBe('https://app.example/b/ZyXwVuTsRqPoNmLkJiHgFeDc')
    act(() => root.unmount())
    root = createRoot(container)
    draw(poll({ state: 'booked', slots: [], booked: { start: SLOTS[1].start, end: SLOTS[1].end, attending: false, video: true, conference_url: null, location: null, manage_url: null } }))
    expect(state()).toBe('left-out')
    expect(container.textContent).toContain('reply to Ava Lin')
  })

  it('every failure of the save: booked or expired meanwhile, missing, too many changes, a bad time, the network', async () => {
    draw(poll())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(429, { error: 'Too many changes today. Reply to the host instead.', code: 'RATE_LIMITED' }))
    await save()
    expect(q('[data-poll-error]')?.textContent).toBe('Too many changes today. Reply to the host instead.')
    fetchMock.mockResolvedValueOnce(reply(400, { error: 'Tue, Nov 19, 10:00 AM is no longer available.', code: 'BAD_INPUT' }))
    await save()
    expect(q('[data-poll-error]')?.textContent).toBe('Tue, Nov 19, 10:00 AM is no longer available.')
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await save()
    expect(q('[data-poll-error]')?.textContent).toBe("That didn't go through. Try again in a moment.")
    fetchMock.mockResolvedValueOnce(reply(500, { error: 'x' }))
    await save()
    expect(q('[data-poll-error]')?.textContent).toBe("That didn't go through. Try again in a moment.")
    fetchMock.mockResolvedValueOnce(reply(410, { error: 'These times have expired.', code: 'EXPIRED' }))
    await save()
    expect(state()).toBe('expired')
  })

  it('a marked time that passed or was taken meanwhile is never sent again, and a 400 naming the open times drops the gone marks', async () => {
    // Tuesday 9:00 was marked, and has since passed: only the times still open count.
    draw(poll({ slots: SLOTS.slice(1), answer: { works: [SLOTS[0].start, SLOTS[2].start], none: false, note: null, answered_at: '2030-11-15T12:00:00.000Z', from_calendar: false }, waiting: 1 }))
    click(q('[data-poll-change]'))
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(400, { error: 'Wed, Nov 20, 11:00 AM is no longer available.', code: 'BAD_INPUT', details: { slots: [SLOTS[1]] } }))
    await save()
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).works).toEqual([SLOTS[2].start, SLOTS[1].start])
    // The taken time is gone from the page and from the marks; saving again sends only what is open.
    expect(timeButtons()).toHaveLength(1)
    expect(q('[data-poll-error]')?.textContent).toContain("It's unmarked")
    fetchMock.mockResolvedValueOnce(saved([SLOTS[1].start], { slots: [SLOTS[1]] }))
    await save()
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).works).toEqual([SLOTS[1].start])
    expect(state()).toBe('answered')
  })

  it('an answer whose every time has gone says so, instead of an empty list', () => {
    draw(poll({ slots: SLOTS.slice(1), answer: { works: [], none: false, note: null, answered_at: '2030-11-15T12:00:00.000Z', from_calendar: false }, waiting: 1 }))
    expect(q('[data-poll-answer]')?.textContent).toContain('The times you marked have passed or been taken.')
  })

  it('"Keep my answer" drops the edits made since', () => {
    draw(poll({ answer: { works: [SLOTS[1].start], none: false, note: 'Afternoons', answered_at: '2030-11-15T12:00:00.000Z', from_calendar: false }, waiting: 1 }))
    click(q('[data-poll-change]'))
    click(timeButtons()[0])
    type(q('#poll-note'), 'Mornings now')
    click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Keep my answer') ?? null)
    click(q('[data-poll-change]'))
    expect(timeButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    expect((q('#poll-note') as HTMLTextAreaElement).value).toBe('Afternoons')
  })

  it('booked meanwhile: the page reads the poll again for the time and the guest’s own link', async () => {
    draw(poll())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(410, { error: 'It was booked.', code: 'BOOKED' }))
    fetchMock.mockResolvedValueOnce(reply(200, { poll: poll({ state: 'booked', slots: [], booked: { start: SLOTS[1].start, end: SLOTS[1].end, attending: true, video: true, conference_url: null, location: null, manage_url: 'https://app.example/b/ZyXwVuTsRqPoNmLkJiHgFeDc' } }) }))
    await save()
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/public/time-offers/${TOKEN}`)
    expect(state()).toBe('booked')
    expect(q('[data-poll-when]')).not.toBeNull()
    expect(q('[data-poll-manage]')).not.toBeNull()
  })

  it('a 404 or a withdrawal on save; and the final states', async () => {
    draw(poll())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(410, { error: 'Ava Lin withdrew these times.', code: 'WITHDRAWN' }))
    await save()
    expect(state()).toBe('withdrawn')
    act(() => root.unmount())
    root = createRoot(container)
    draw(poll())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(404, { error: 'These times do not exist.', code: 'NOT_FOUND' }))
    await save()
    expect(state()).toBe('missing')
    act(() => root.unmount())
    root = createRoot(container)
    draw(poll({ slots: [] }))
    expect(state()).toBe('empty')
  })
})
