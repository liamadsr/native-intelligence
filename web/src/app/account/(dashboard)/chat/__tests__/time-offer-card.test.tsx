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
          bookings: [{ id: 'b-1', guest: 'Lee Okafor', title: 'Tour', when: 'Wed, Nov 18, 2:00 PM EST', state: 'cancelled' }],
        },
      }),
    )
    expect(q('[data-time-offer-offers] li')?.textContent).toBe('Dana Whitfield · Intro call · waiting for a pickTue, Nov 17, 10:00 AM EST')
    expect(q('[data-time-offer-bookings] li')?.textContent).toBe('Lee Okafor · Wed, Nov 18, 2:00 PM EST · cancelled')
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
    expect(rendererFor('withdraw_time_offer')).toBeUndefined()
    expect(rendererFor('cancel_offered_meeting')).toBeUndefined()
  })
})
