// @vitest-environment jsdom
/**
 * The booking link cards (../booking-link-card.tsx): the link made with its
 * address to copy, length and hosts; turned off with no address; the list.
 * And the chat draws them for the booking link tools, the chip otherwise.
 * Made-up people.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { DynamicToolUIPart } from 'ai'
import { BookingLinkCard } from '../booking-link-card'
import { rendererFor, type ToolRenderContext } from '../tool-renderers'

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
})

const draw = (node: ReactNode) => act(() => root.render(node as never))
const q = (sel: string) => container.querySelector(sel)
const ITEM = { id: 'l-1', title: 'Intro call', url: 'https://app.example/book/ava-lin/intro-call', durationMinutes: 30, hostNames: ['Ava Lin', 'Ben Ruiz'], hostMode: 'all' as const, active: true, askFirst: true }

describe('BookingLinkCard', () => {
  it('a link made: title, on, length and hosts, the address to copy', () => {
    draw(h(BookingLinkCard, { data: { kind: 'link', verb: 'made', link: ITEM } }))
    expect(q('[data-booking-link-card="link"]')?.textContent).toContain('Booking link made')
    expect(q('[data-booking-link-state]')?.textContent).toBe('On')
    expect(container.textContent).toContain('30 min · Ava Lin and Ben Ruiz, all attend · asks you first')
    expect(q('[data-booking-link-url]')?.textContent).toBe('app.example/book/ava-lin/intro-call')
    expect(q('[data-booking-link-copy]')).not.toBeNull()
  })

  it('turned off: no address, and its bookings stay', () => {
    draw(h(BookingLinkCard, { data: { kind: 'link', verb: 'off', link: { ...ITEM, active: false } } }))
    expect(container.textContent).toContain('Booking link turned off')
    expect(q('[data-booking-link-state]')?.textContent).toBe('Off')
    expect(q('[data-booking-link-url]')).toBeNull()
    expect(container.textContent).toContain('the meetings it booked stay')
  })

  it('the list: each link with its state', () => {
    draw(h(BookingLinkCard, { data: { kind: 'links', links: [ITEM, { ...ITEM, id: 'l-2', title: 'Office hours', active: false, hostNames: ['Ava Lin'], hostMode: 'one' }] } }))
    expect([...container.querySelectorAll('[data-booking-links] li')].map((li) => li.textContent)).toEqual([
      'Intro callOn30 min · Ava Lin and Ben Ruiz, all attendapp.example/book/ava-lin/intro-callCopy link',
      'Office hoursOff30 min · Ava Lin',
    ])
  })
})

describe('the chat renders it for the booking link tools', () => {
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
  const LINK = { id: 'l-1', title: 'Intro call', url: ITEM.url, duration_minutes: 30, host_names: ['Ava Lin'], host_mode: 'one', active: true, ask_first: false }

  it('create, update, delete and list are cards; running, refused or empty is the chip', () => {
    for (const name of ['create_booking_link', 'update_booking_link', 'delete_booking_link', 'list_booking_links']) expect(rendererFor(name), name).toBeDefined()
    draw(rendererFor('create_booking_link')!.render(ctx('create_booking_link', 'result', { success: true, link: LINK })))
    expect(q('[data-booking-link-card="link"]')).not.toBeNull()
    expect(rendererFor('create_booking_link')!.render(ctx('create_booking_link', 'call'))).toBeUndefined()
    expect(rendererFor('update_booking_link')!.render(ctx('update_booking_link', 'result', { success: false, code: 'NOT_ALLOWED', error: 'No.' }))).toBeUndefined()
    expect(rendererFor('list_booking_links')!.render(ctx('list_booking_links', 'result', { success: true, links: [] }))).toBeUndefined()
  })
})
