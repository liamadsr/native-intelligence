// @vitest-environment jsdom
/**
 * The time offer's page (../offer-view.tsx): the times in the guest's own
 * zone (the host's on the server's render, so hydration matches), the pick
 * and its form, the confirmed state, and every answer of POST /accept:
 * slot taken, closed, missing, needs an email, the calendar unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, createElement as h } from 'react'
import { OfferView } from '../offer-view'
import type { PageLoad, PublicOfferData } from '@/lib/time-offers/display'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx'
const SLOTS = [
  { start: '2030-11-19T15:00:00.000Z', end: '2030-11-19T15:30:00.000Z' },
  { start: '2030-11-19T19:00:00.000Z', end: '2030-11-19T19:30:00.000Z' },
  { start: '2030-11-20T16:00:00.000Z', end: '2030-11-20T16:30:00.000Z' },
]
const OFFER: PublicOfferData = {
  state: 'open',
  host_name: 'Ava Lin',
  title: 'Intro call',
  duration_minutes: 30,
  video: true,
  location: null,
  message: 'Looking forward to it.',
  time_zone: 'America/New_York',
  expires_at: SLOTS[0].start,
  recipient_name: 'Dana Reyes',
  needs_email: false,
  slots: SLOTS,
  booked_start: null,
}
const found = (offer: Partial<PublicOfferData> = {}): PageLoad<PublicOfferData> => ({ kind: 'found', data: { ...OFFER, ...offer } })

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

const draw = (load: PageLoad<PublicOfferData>) => act(() => root.render(h(OfferView, { token: TOKEN, load })))
const q = (sel: string) => container.querySelector(sel)
const state = () => q('[data-offer-state]')?.getAttribute('data-offer-state')
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  act(() => (el as HTMLElement).click())
}

function type(el: Element | null, value: string) {
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const timeButtons = () => [...container.querySelectorAll('[data-offer-slots] button')] as HTMLButtonElement[]
async function submit() {
  await act(async () => {
    ;(q('[data-offer-form]') as HTMLFormElement).requestSubmit()
  })
}

describe('OfferView', () => {
  it("the server renders the host's zone; the browser shows the guest's", () => {
    const html = renderToString(h(OfferView, { token: TOKEN, load: found() })).replace(/<!-- -->/g, '')
    expect(html).toContain('Times in EST</p>')
    expect(html).toContain('10:00 AM')
    draw(found())
    expect(q('[data-offer-zone]')?.textContent).toBe('Times in CST (Ava Lin is on EST)')
    expect(timeButtons().map((b) => b.textContent)).toEqual(['9:00 AM', '1:00 PM', '10:00 AM'])
    expect([...container.querySelectorAll('[data-offer-slots] > div > p')].map((p) => p.textContent)).toEqual(['Tuesday, November 19', 'Wednesday, November 20'])
    expect(container.textContent).toContain('Intro call')
    expect(container.textContent).toContain('30 min')
    expect(container.textContent).toContain('Video call')
    expect(q('[data-offer-message]')?.textContent).toBe('Looking forward to it.')
  })

  it('pick a time: the form with the name filled; confirm books it and shows the time, the video link and the manage link', async () => {
    draw(found())
    expect(q('[data-offer-form]')).toBeNull()
    click(timeButtons()[1])
    expect(timeButtons()[1].getAttribute('aria-pressed')).toBe('true')
    expect((q('#offer-name') as HTMLInputElement).value).toBe('Dana Reyes')
    expect(q('#offer-email')).toBeNull()
    expect((q('input[name="website"]') as HTMLInputElement).className).toContain('hidden')
    type(q('#offer-note'), 'Bring the floor plan')
    fetchMock.mockResolvedValueOnce(
      reply(201, {
        ok: true,
        already: false,
        status: 'confirmed',
        booking: { start: SLOTS[1].start, end: SLOTS[1].end, title: 'Intro call', host_name: 'Ava Lin', video: true, conference_url: 'https://meet.example/abc-defg-hij', location: null },
        manage_url: 'https://app.example/b/ZyXwVuTsRqPoNmLkJiHgFeDc',
      }),
    )
    await submit()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/public/time-offers/${TOKEN}/accept`)
    expect(JSON.parse(String(init.body))).toEqual({ start: SLOTS[1].start, name: 'Dana Reyes', note: 'Bring the floor plan', time_zone: 'America/Chicago', website: '' })
    expect(state()).toBe('confirmed')
    expect(q('[data-offer-when]')?.textContent).toBe('Tuesday, November 19 · 1:00 PM – 1:30 PM CST')
    expect(q('[data-offer-video]')?.getAttribute('href')).toBe('https://meet.example/abc-defg-hij')
    expect(q('[data-offer-invite]')?.textContent).toBe('An invitation is on its way to your inbox.')
    expect(q('[data-offer-manage]')?.getAttribute('href')).toBe('https://app.example/b/ZyXwVuTsRqPoNmLkJiHgFeDc')
  })

  it('no email on file: asks for one, and the confirmation names it', async () => {
    draw(found({ needs_email: true, recipient_name: '' }))
    click(timeButtons()[0])
    const confirm = () => q('[data-offer-form] button[type="submit"]') as HTMLButtonElement
    expect(confirm().disabled).toBe(true)
    type(q('#offer-name'), 'Dana Reyes')
    expect(confirm().disabled).toBe(true)
    type(q('#offer-email'), 'dana@initech.example')
    expect(confirm().disabled).toBe(false)
    fetchMock.mockResolvedValueOnce(reply(201, { ok: true, already: false, status: 'confirmed', booking: { start: SLOTS[0].start, end: SLOTS[0].end, title: 'Intro call', host_name: 'Ava Lin', video: true, conference_url: null, location: null }, manage_url: 'https://app.example/b/x' }))
    await submit()
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).email).toBe('dana@initech.example')
    expect(q('[data-offer-invite]')?.textContent).toBe('An invitation is on its way to dana@initech.example.')
    expect(container.textContent).toContain('The video link will be in the invitation.')
  })

  it('the time was just taken: the times still open, and says so', async () => {
    draw(found())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(409, { error: 'That time is no longer available.', code: 'SLOT_TAKEN', details: { slots: [SLOTS[2]] } }))
    await submit()
    expect(q('[data-offer-taken]')?.textContent).toBe('That time was just taken. These are still open.')
    expect(timeButtons().map((b) => b.textContent)).toEqual(['10:00 AM'])
    expect(q('[data-offer-form]')).toBeNull()
  })

  it('the last time taken: nothing left to pick', async () => {
    draw(found())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(409, { error: 'That time is no longer available.', code: 'SLOT_TAKEN', details: { slots: [] } }))
    await submit()
    expect(state()).toBe('empty')
    expect(container.textContent).toContain('The last time was just taken.')
  })

  it('booked meanwhile (410): re-reads the offer and shows the booked time', async () => {
    draw(found())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(410, { error: 'These times were just booked.', code: 'BOOKED' }))
    fetchMock.mockResolvedValueOnce(reply(200, { offer: { ...OFFER, state: 'booked', slots: [], booked_start: SLOTS[2].start } }))
    await submit()
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/public/time-offers/${TOKEN}`)
    expect(state()).toBe('booked')
    expect(q('[data-offer-when]')?.textContent).toBe('Wednesday, November 20 · 10:00 AM – 10:30 AM CST')
  })

  it("the calendar can't be checked (503), too many tries (429), or the network fails: says so and keeps the pick", async () => {
    draw(found())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(503, { error: 'x', code: 'UNAVAILABLE' }))
    await submit()
    expect(q('[data-offer-error]')?.textContent).toBe("We couldn't check Ava Lin's calendar just now. Try again in a minute.")
    fetchMock.mockResolvedValueOnce(reply(429, { error: 'Too many tries on this offer today. Ask for new times.', code: 'RATE_LIMITED' }))
    await submit()
    expect(q('[data-offer-error]')?.textContent).toBe('Too many tries on this offer today. Ask for new times.')
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await submit()
    expect(q('[data-offer-error]')?.textContent).toBe("That didn't go through. Try again in a moment.")
    expect(q('[data-offer-form]')).not.toBeNull()
  })

  it('a 400 NEEDS_EMAIL shows the email field', async () => {
    draw(found())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(400, { error: 'Add your email so the invitation can reach you.', code: 'NEEDS_EMAIL' }))
    await submit()
    expect(q('#offer-email')).not.toBeNull()
    expect(q('[data-offer-error]')?.textContent).toBe('Add your email so the invitation can reach you.')
  })

  it('a 404 on the pick is the missing page', async () => {
    draw(found())
    click(timeButtons()[0])
    fetchMock.mockResolvedValueOnce(reply(404, { error: 'This offer does not exist.', code: 'NOT_FOUND' }))
    await submit()
    expect(state()).toBe('missing')
  })

  it('final states: booked, expired, withdrawn, missing, unavailable', () => {
    const fresh = (load: PageLoad<PublicOfferData>) => {
      act(() => root.unmount())
      root = createRoot(container)
      draw(load)
    }
    draw(found({ state: 'booked', slots: [], booked_start: SLOTS[0].start }))
    expect(state()).toBe('booked')
    expect(q('[data-offer-when]')?.textContent).toBe('Tuesday, November 19 · 9:00 AM – 9:30 AM CST')
    fresh(found({ state: 'expired', slots: [] }))
    expect(state()).toBe('expired')
    expect(container.textContent).toContain('Ask Ava Lin for new times.')
    fresh(found({ state: 'withdrawn', slots: [] }))
    expect(state()).toBe('withdrawn')
    fresh({ kind: 'missing' })
    expect(state()).toBe('missing')
    fresh({ kind: 'error' })
    expect(state()).toBe('error')
  })
})
