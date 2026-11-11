// @vitest-environment jsdom
/**
 * A booking link's page (../link-view.tsx): one times read per strip of
 * days, in the guest's zone; days with no times shown empty, not hidden; a
 * time picked opens the form, which asks for what the link's `contact` says
 * and its questions; and each answer of POST …/book: confirmed, requested
 * (ask first), a time taken (that strip read again), the calendar unknown,
 * turned off. Not found and the first read failing. Made-up people.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, createElement as h } from 'react'
import { LinkView } from '../link-view'
import type { PublicLinkData } from '@/lib/booking-links/types'
import type { PageLoad } from '@/lib/time-offers/display'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Monday, November 18 2030, 8:00 AM in Chicago.
const NOW = Date.parse('2030-11-18T14:00:00.000Z')
const LINK: PublicLinkData = {
  profile: 'ava-lin',
  slug: 'intro-call',
  purpose: 'meeting',
  title: 'Intro call',
  description: 'A first chat about the project.',
  duration_minutes: 30,
  window_days: 30,
  host_mode: 'one',
  host_names: ['Ava Lin'],
  questions: [{ id: 'company', label: 'Company', required: true, kind: 'text' }],
  time_zone: 'America/New_York',
  video: true,
  location: null,
  ask_first: false,
  contact: 'email_or_phone',
}
// Tuesday the 19th, 9:00 and 1:00 in Chicago; nothing Monday or Wednesday.
const SLOTS = [
  { start: '2030-11-19T15:00:00.000Z', end: '2030-11-19T15:30:00.000Z' },
  { start: '2030-11-19T19:00:00.000Z', end: '2030-11-19T19:30:00.000Z' },
  { start: '2030-11-21T16:00:00.000Z', end: '2030-11-21T16:30:00.000Z' },
]
const found = (link: Partial<PublicLinkData> = {}): PageLoad<PublicLinkData> => ({ kind: 'found', data: { ...LINK, ...link } })
const BOOKED = { start: SLOTS[1].start, end: SLOTS[1].end, title: 'Intro call', host_name: 'Ava Lin', video: true, conference_url: 'https://meet.example/abc-defg-hij', location: null }

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let book: (body: Record<string, unknown>) => Response
let times: () => Response

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'America/Chicago' } as Intl.ResolvedDateTimeFormatOptions)
  times = () => reply(200, { time_zone: 'America/New_York', from: '', to: '', slots: SLOTS })
  book = () => reply(201, { ok: true, status: 'confirmed', booking: BOOKED, manage_url: 'https://app.example/b/ZyXwVu' })
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => (url.includes('/times?') ? times() : book(JSON.parse(String(init?.body)))))
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const draw = async (load: PageLoad<PublicLinkData>) => {
  act(() => root.render(h(LinkView, { profile: 'ava-lin', slug: 'intro-call', load })))
  await settle()
}
const q = (sel: string) => container.querySelector(sel)
const state = () => q('[data-link-state]')?.getAttribute('data-link-state')
const timesRead = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/times?')).map((c) => String(c[0]))
const bookBodies = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/book')).map((c) => JSON.parse(String((c[1] as RequestInit).body)))
const timeButtons = () => [...container.querySelectorAll('[data-link-times] button')] as HTMLButtonElement[]

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

async function fillAndSubmit({ email = 'dana@initech.example', phone = '', company = 'Initech', pick = true } = {}) {
  if (pick) click(timeButtons()[1])
  type(q('#link-name'), 'Dana Reyes')
  if (email) type(q('#link-email'), email)
  if (phone) type(q('#link-phone'), phone)
  if (company) type(q('#link-q-company'), company)
  const form = q('[data-link-form]') as HTMLFormElement
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}

describe('the page', () => {
  it('the server renders in the host’s zone with no times yet, and reads nothing', () => {
    const html = renderToString(h(LinkView, { profile: 'ava-lin', slug: 'intro-call', load: found() })).replace(/<!-- -->/g, '')
    expect(html).toContain('Intro call')
    expect(html).toContain('Times in EST')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads one strip in the guest’s zone; the first day with times is picked; empty days show empty', async () => {
    await draw(found())
    expect(timesRead()).toEqual(['/api/public/booking-links/ava-lin/intro-call/times?from=2030-11-18&days=7&tz=America%2FChicago'])
    expect(q('[data-link-hosts]')?.textContent).toBe('Ava Lin')
    expect(q('[data-link-description]')?.textContent).toBe('A first chat about the project.')
    expect(q('[data-link-zone]')?.textContent).toBe('Times in CST (Ava Lin is on EST)')
    expect(q('[data-link-month]')?.textContent).toBe('November 2030')
    const days = [...container.querySelectorAll('[data-link-days] button')]
    expect(days).toHaveLength(7)
    expect(q('[data-day="2030-11-18"]')?.hasAttribute('data-empty')).toBe(true)
    expect(q('[data-day="2030-11-19"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(timeButtons().map((b) => b.textContent)).toEqual(['9:00 AM', '1:00 PM'])
    click(q('[data-day="2030-11-20"]'))
    expect(q('[data-link-empty]')?.textContent).toBe('No open times this day. Pick another.')
  })

  it('the next strip is one more read; going back reads nothing', async () => {
    await draw(found())
    click(q('[aria-label="Later days"]'))
    await settle()
    expect(timesRead().at(-1)).toContain('from=2030-11-25&days=7')
    click(q('[aria-label="Earlier days"]'))
    await settle()
    expect(timesRead()).toHaveLength(2)
    expect(q('[aria-label="Earlier days"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('a strip with no times at all says so', async () => {
    times = () => reply(200, { time_zone: 'America/New_York', from: '', to: '', slots: [] })
    await draw(found())
    expect(q('[data-link-empty]')?.textContent).toBe('No open times these days. Try the next ones.')
    expect(container.querySelectorAll('[data-link-days] [data-empty]')).toHaveLength(7)
  })

  it('the calendar unknown: says try again, and Try again reads it again', async () => {
    times = () => reply(503, { error: 'x', code: 'UNAVAILABLE' })
    await draw(found())
    expect(q('[data-link-unavailable]')?.textContent).toContain("We couldn't check Ava Lin's calendar just now. Try again in a minute.")
    times = () => reply(200, { time_zone: 'America/New_York', from: '', to: '', slots: SLOTS })
    click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!)
    await settle()
    expect(timesRead()).toHaveLength(2)
    expect(timeButtons()).toHaveLength(2)
  })

  it('not found, and a first read that failed', async () => {
    await draw({ kind: 'missing' })
    expect(state()).toBe('missing')
    await draw({ kind: 'error' })
    expect(state()).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a team link: every host, and whether they all come', async () => {
    await draw(found({ host_names: ['Ava Lin', 'Ben Ruiz', 'Cara Diaz'], host_mode: 'any' }))
    expect(q('[data-link-hosts]')?.textContent).toBe('Ava Lin, Ben Ruiz or Cara Diaz')
    expect(q('[data-link-together]')?.textContent).toBe('One of them will meet you.')
    expect(q('[data-link-zone]')?.textContent).toBe('Times in CST (the hosts are on EST)')
  })
})

describe('booking', () => {
  it('the form asks for the link’s contact and questions; confirmed shows the time, video, invitation and manage link', async () => {
    await draw(found())
    click(timeButtons()[1])
    const submitButton = () => q('[data-link-form] button[type="submit"]') as HTMLButtonElement
    expect(submitButton().textContent).toBe('Confirm 1:00 PM')
    expect(q('#link-email')).not.toBeNull()
    expect(q('#link-phone')).not.toBeNull()
    type(q('#link-name'), 'Dana Reyes')
    type(q('#link-email'), 'dana@initech.example')
    expect(submitButton().disabled).toBe(true)
    type(q('#link-q-company'), 'Initech')
    expect(submitButton().disabled).toBe(false)
    await act(async () => {
      ;(q('[data-link-form]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle()
    expect(bookBodies()).toEqual([{ start: SLOTS[1].start, name: 'Dana Reyes', email: 'dana@initech.example', answers: { company: 'Initech' }, note: '', time_zone: 'America/Chicago', website: '' }])
    expect(state()).toBe('confirmed')
    expect(q('[data-link-when]')?.textContent).toBe('Tuesday, November 19 · 1:00 PM – 1:30 PM CST')
    expect(q('[data-link-video]')?.textContent).toBe('meet.example/abc-defg-hij')
    expect(q('[data-link-invite]')?.textContent).toBe('An invitation is on its way to dana@initech.example.')
    expect(q('[data-link-manage]')?.getAttribute('href')).toBe('https://app.example/b/ZyXwVu')
  })

  it('an email-only link asks no mobile; a mobile is sent as +1 and formatted as typed', async () => {
    await draw(found({ contact: 'email' }))
    click(timeButtons()[0])
    expect(q('#link-phone')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    await draw(found({ questions: [] }))
    click(timeButtons()[0])
    type(q('#link-phone'), '5550100123')
    expect((q('#link-phone') as HTMLInputElement).value).toBe('(555) 010-0123')
  })

  it('ask first: Request, and the request’s final state says the host confirms', async () => {
    book = () => reply(201, { ok: true, status: 'requested', booking: { ...BOOKED, conference_url: null }, manage_url: 'https://app.example/b/ZyXwVu' })
    await draw(found({ ask_first: true }))
    click(timeButtons()[1])
    expect((q('[data-link-form] button[type="submit"]') as HTMLButtonElement).textContent).toBe('Request 1:00 PM')
    await fillAndSubmit({ pick: false })
    expect(state()).toBe('requested')
    expect(q('[data-link-invite]')?.textContent).toBe("Ava Lin will confirm. Nothing is booked until then: the time is held for you, and the invitation goes to dana@initech.example once it's a yes.")
    expect(q('[data-link-manage]')?.textContent).toBe('Cancel the request')
  })

  it('held while the calendar writes: the invitation follows', async () => {
    book = () => reply(201, { ok: true, status: 'booking', booking: { ...BOOKED, conference_url: null }, manage_url: 'https://app.example/b/ZyXwVu' })
    await draw(found())
    await fillAndSubmit()
    expect(state()).toBe('booking')
    expect(q('[data-link-invite]')?.textContent).toBe('Your time is held. The invitation follows in a minute, to dana@initech.example.')
  })

  it('a time taken: that strip read again, the guest told', async () => {
    book = () => reply(409, { error: 'That time was just taken.', code: 'SLOT_TAKEN' })
    await draw(found())
    await fillAndSubmit()
    times = () => reply(200, { time_zone: 'America/New_York', from: '', to: '', slots: [SLOTS[0], SLOTS[2]] })
    await settle()
    expect(timesRead()).toHaveLength(2)
    expect(q('[data-link-taken]')).not.toBeNull()
    expect(q('[data-link-form]')).toBeNull()
  })

  it('a field to fix is shown on its field; the calendar unknown and turned off', async () => {
    book = () => reply(400, { error: 'Add your email, so the invitation can reach you.', code: 'NEEDS_EMAIL', details: { field: 'email' } })
    await draw(found())
    await fillAndSubmit({ email: '', phone: '5550100123' })
    expect(container.textContent).toContain('Add your email, so the invitation can reach you.')
    book = () => reply(503, { error: 'x', code: 'UNAVAILABLE' })
    type(q('#link-email'), 'dana@initech.example')
    await act(async () => {
      ;(q('[data-link-form]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle()
    expect(q('[data-link-error]')?.textContent).toBe("We couldn't check Ava Lin's calendar just now. Try again in a minute.")
    book = () => reply(410, { error: 'This booking page is turned off.', code: 'CLOSED' })
    await act(async () => {
      ;(q('[data-link-form]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle()
    expect(state()).toBe('closed')
  })
})
