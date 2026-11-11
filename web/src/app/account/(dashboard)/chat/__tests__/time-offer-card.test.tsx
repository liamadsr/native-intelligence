// @vitest-environment jsdom
/**
 * The time-offer cards (../time-offer-card.tsx) and their place in the chat's
 * tool renderers: offer_times' who, times and link to copy; the booked
 * meeting; list_time_offers' states; and the generic chip for a refusal or a
 * call still running.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { DynamicToolUIPart } from 'ai'
import { TimeOfferCard } from '../time-offer-card'
import { rendererFor, type ToolRenderContext } from '../tool-renderers'
import type { TimeOfferCardData } from '@/lib/time-offers/offer-card'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const draw = (node: ReactNode) => act(() => root.render(node as never))
const q = (sel: string) => container.querySelector(sel)

const OFFER: TimeOfferCardData = {
  kind: 'offer',
  recipient: 'Dana Whitfield',
  title: 'Intro call',
  durationMinutes: 30,
  times: ['Tue, Nov 17, 10:00 AM EST', 'Wed, Nov 18, 2:00 PM EST'],
  link: 'https://app.example/t/AbCdEfGhIjKlMnOpQrStUvWx',
  sentVia: 'link',
  to: null,
  expires: 'Tue, Nov 17, 10:00 AM EST',
  pasteText: 'Could we meet for Intro call?',
}

const T = ['2030-11-19T15:00:00.000Z', '2030-11-19T19:00:00.000Z', '2030-11-20T16:00:00.000Z']
const POLL: TimeOfferCardData = {
  kind: 'poll',
  title: 'Planning session',
  durationMinutes: 45,
  state: 'open',
  times: [
    { start: T[0], label: 'Tue, Nov 19, 10:00 AM EST', booked: false },
    { start: T[1], label: 'Tue, Nov 19, 2:00 PM EST', booked: false },
    { start: T[2], label: 'Wed, Nov 20, 11:00 AM EST', booked: false },
  ],
  guests: [
    { id: 'r-1', name: 'Dana Reyes', link: 'https://app.example/t/AAAAAAAAAAAAAAAAAAAAAAAA', answered: true, works: [T[0], T[2]], fromCalendar: false, attending: null },
    { id: 'r-2', name: 'Sam Ortiz', link: 'https://app.example/t/BBBBBBBBBBBBBBBBBBBBBBBB', answered: true, works: [T[2]], fromCalendar: true, attending: null },
    { id: 'r-3', name: 'Lee Park', link: 'https://app.example/t/CCCCCCCCCCCCCCCCCCCCCCCC', answered: false, works: [], fromCalendar: false, attending: null },
  ],
  sentVia: 'link',
  expires: 'Wed, Nov 20, 11:00 AM EST',
  best: null,
  booking: null,
  coHosts: 1,
}
const marks = (guest: string) => [...container.querySelectorAll(`tr[data-guest="${guest}"] td[data-mark]`)].map((td) => td.getAttribute('data-mark'))

describe('TimeOfferCard', () => {
  it('an offer by link: who, the times, the link, both copies, held and not sent', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    draw(h(TimeOfferCard, { data: OFFER }))
    expect(container.textContent).toContain('Times offered to Dana Whitfield · 30 min')
    expect([...container.querySelectorAll('[data-time-offer-times] li')].map((li) => li.textContent)).toEqual(OFFER.times)
    expect(q('[data-time-offer-link]')?.textContent).toBe('app.example/t/AbCdEfGhIjKlMnOpQrStUvWx')
    expect(q('[data-time-offer-status]')?.textContent).toBe('Held until they pick one or Tue, Nov 17, 10:00 AM EST. Nothing was sent: share the link.')
    await act(async () => (q('[data-time-offer-copy="link"]') as HTMLButtonElement).click())
    expect(writeText).toHaveBeenCalledWith(OFFER.link)
    expect(q('[data-time-offer-copy="link"]')?.textContent).toBe('Copied')
    await act(async () => (q('[data-time-offer-copy="message"]') as HTMLButtonElement).click())
    expect(writeText).toHaveBeenLastCalledWith('Could we meet for Intro call?')
  })

  it('an offer by email: where it went, no message to copy', () => {
    draw(h(TimeOfferCard, { data: { ...OFFER, sentVia: 'email', to: 'dana@initech.example', pasteText: null } }))
    expect(q('[data-time-offer-status]')?.textContent).toBe('Sent by email to dana@initech.example. Held until they pick one or Tue, Nov 17, 10:00 AM EST.')
    expect(q('[data-time-offer-copy="message"]')).toBeNull()
  })

  it('a booked meeting', () => {
    draw(h(TimeOfferCard, { data: { kind: 'booked', guest: 'Dana Whitfield', title: 'Intro call', when: 'Tue, Nov 17, 10:00 AM EST', state: 'confirmed', videoLink: 'https://meet.example/abc', already: false } }))
    expect(q('[data-time-offer-card="booked"]')?.textContent).toBe('Booked with Dana WhitfieldIntro callTue, Nov 17, 10:00 AM ESTmeet.example/abc')
  })

  it('the list: each offer with its state, each booking with its time', () => {
    draw(
      h(TimeOfferCard, {
        data: {
          kind: 'list',
          offers: [{ id: 'o-1', recipient: 'Dana Whitfield', title: 'Intro call', state: 'open', times: [{ label: 'Tue, Nov 17, 10:00 AM EST', booked: false }], expires: null }],
          bookings: [
            { id: 'b-1', guest: 'Lee Okafor', title: 'Tour', when: 'Wed, Nov 18, 2:00 PM EST', state: 'cancelled', fromLink: false },
            { id: 'b-2', guest: 'Rae Moss', title: 'Intro call', when: 'Thu, Nov 19, 9:00 AM EST', state: 'requested', fromLink: true },
          ],
        },
      }),
    )
    expect(q('[data-time-offer-offers] li')?.textContent).toBe('Dana Whitfield · Intro call · waiting for a pickTue, Nov 17, 10:00 AM EST')
    expect([...document.querySelectorAll('[data-time-offer-bookings] li')].map((li) => li.textContent)).toEqual([
      'Lee Okafor · Wed, Nov 18, 2:00 PM EST · cancelled',
      'Rae Moss · Thu, Nov 19, 9:00 AM EST · Intro call · waiting on your yes',
    ])
    expect(q('[data-time-offer-card="list"]')?.textContent).toContain('Meetings booked')
    expect(q('[data-time-offer-card="list"]')?.textContent).not.toContain('from offers')
  })
})

describe('a poll', () => {
  it('waiting: the grid of guests by times, the calendar marker, each guest\'s link to copy, how many still to answer', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    draw(h(TimeOfferCard, { data: POLL }))
    expect(q('[data-time-offer-card="poll"]')?.textContent).toContain('Times asked of 3 people · 45 min · with a teammate')
    expect([...container.querySelectorAll('thead th[scope="col"]')].map((th) => th.textContent)).toEqual(['Tue, Nov 1910:00 AM', 'Tue, Nov 192:00 PM', 'Wed, Nov 2011:00 AM'])
    expect(marks('Dana Reyes')).toEqual(['works', 'no', 'works'])
    expect(marks('Sam Ortiz')).toEqual(['no', 'no', 'works'])
    expect(marks('Lee Park')).toEqual(['waiting', 'waiting', 'waiting'])
    expect(q('tr[data-guest="Sam Ortiz"] [data-from-calendar]')).not.toBeNull()
    expect(q('tr[data-guest="Dana Reyes"] [data-from-calendar]')).toBeNull()
    await act(async () => (q('[data-time-offer-copy="guest:r-3"]') as HTMLButtonElement).click())
    expect(writeText).toHaveBeenCalledWith('https://app.example/t/CCCCCCCCCCCCCCCCCCCCCCCC')
    expect(q('[data-time-offer-status]')?.textContent).toBe("1 of 3 still to answer. Held until everyone answers or Wed, Nov 20, 11:00 AM EST. Nothing was sent: share each guest's link.")
  })

  it('booked: the booked time marked, the video link, no links to copy, who is off it struck', () => {
    draw(
      h(TimeOfferCard, {
        data: {
          ...POLL,
          state: 'booked',
          times: POLL.kind === 'poll' ? POLL.times.map((t, i) => ({ ...t, booked: i === 2 })) : [],
          guests: POLL.kind === 'poll' ? POLL.guests.map((g, i) => ({ ...g, answered: true, works: [T[2]], attending: i !== 2 })) : [],
          booking: { when: 'Wed, Nov 20, 11:00 AM EST', videoLink: 'https://meet.example/abc', state: 'confirmed' },
        },
      }),
    )
    expect(q('thead th[data-booked]')?.textContent).toBe('Wed, Nov 2011:00 AM')
    expect(container.querySelector('[data-time-offer-copy]')).toBeNull()
    expect(q('[data-time-offer-status]')?.textContent).toBe('Booked: Wed, Nov 20, 11:00 AM EST.')
    expect(container.textContent).toContain('meet.example/abc')
    expect(q('tr[data-guest="Lee Park"] th')?.className).toContain('line-through')
  })

  it('no common time: the best option', () => {
    draw(h(TimeOfferCard, { data: { ...POLL, best: 'Wed, Nov 20, 11:00 AM EST (Dana Reyes and Sam Ortiz can; Lee Park can\'t)' } }))
    expect(q('[data-time-offer-status]')?.textContent).toBe("No time works for everyone. Most can make Wed, Nov 20, 11:00 AM EST (Dana Reyes and Sam Ortiz can; Lee Park can't).")
  })

  it('a poll in the list carries its grid instead of the times line', () => {
    draw(h(TimeOfferCard, { data: { kind: 'list', offers: [{ id: 'p-1', recipient: '3 people', title: 'Planning session', state: 'open', times: [], expires: null, poll: POLL as Extract<TimeOfferCardData, { kind: 'poll' }> }], bookings: [] } }))
    expect(q('[data-time-offer-offers] li')?.textContent).toContain('3 people · Planning session')
    expect(q('[data-time-offer-offers] [data-time-offer-grid]')).not.toBeNull()
    expect(q('[data-time-offer-offers] li')?.textContent).not.toContain('waiting for a pick')
  })
})

describe('the chat renders it for the time-offer tools', () => {
  const ctx = (toolName: string, state: ToolRenderContext['state'], output?: unknown): ToolRenderContext =>
    ({
      part: (output === undefined
        ? { type: 'dynamic-tool', toolName, toolCallId: 't1', state: 'input-available', input: {} }
        : { type: 'dynamic-tool', toolName, toolCallId: 't1', state: 'output-available', input: {}, output }) as DynamicToolUIPart,
      toolName,
      toolCallId: 't1',
      state,
      textContent: '',
      links: undefined,
      lastEmailDraftToolCallId: null,
      lastPlanToolCallId: null,
      lastAttachmentImageToolCallId: null,
      allAttachmentImages: [],
      attachmentLinks: [],
      onEntityClick: () => {},
    }) as ToolRenderContext

  it('offer_times with a link is the card; running or refused is the chip', () => {
    const entry = rendererFor('offer_times')
    expect(entry).toBeDefined()
    const card = entry!.render(ctx('offer_times', 'result', { success: true, recipient_name: 'Dana Whitfield', link: OFFER.link, sent_via: 'link', times: [{ label: 'Tue, Nov 17, 10:00 AM EST' }] }))
    draw(card)
    expect(q('[data-time-offer-card="offer"]')).not.toBeNull()
    expect(entry!.render(ctx('offer_times', 'call'))).toBeUndefined()
    expect(entry!.render(ctx('offer_times', 'result', { success: false, code: 'APPROVAL_REQUIRED', error: 'Nothing was sent.' }))).toBeUndefined()
  })

  it('accept_time_offer and list_time_offers are cards; withdraw and cancel keep the chip', () => {
    expect(rendererFor('accept_time_offer')).toBeDefined()
    expect(rendererFor('list_time_offers')).toBeDefined()
    expect(rendererFor('list_time_offers')!.render(ctx('list_time_offers', 'result', { success: true, offers: [], bookings: [] }))).toBeUndefined()
    expect(rendererFor('record_time_offer_answer')).toBeDefined()
    expect(rendererFor('book_poll_time')).toBeDefined()
    expect(rendererFor('nudge_time_offer')).toBeUndefined()
    expect(rendererFor('withdraw_time_offer')).toBeUndefined()
    expect(rendererFor('cancel_offered_meeting')).toBeUndefined()
  })
})
