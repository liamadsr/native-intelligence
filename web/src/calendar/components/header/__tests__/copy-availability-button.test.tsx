// @vitest-environment jsdom
/**
 * Copy availability (../copy-availability-button.tsx): nothing drawn without
 * a calendar connected; the text read from the server's engine for the
 * range picked, in the browser's zone; an unknown answer rejects with its
 * reason so nothing is copied. And the person's booking links to copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

const hoisted = vi.hoisted(() => ({ connected: false }))
vi.mock('@/components/account-filter-dropdown', () => ({ useHasConnectedAccount: () => hoisted.connected }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { CopyAvailabilityButton, fetchAvailabilityText, fetchMyBookingLinks } from '../copy-availability-button'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response)

describe('fetchAvailabilityText', () => {
  it('asks for the range in the browser zone and gives back the text', async () => {
    const load = answer({ known: true, text: 'My availability (EST):\nTue, Nov 10: 9:00 AM – 6:00 PM' })
    await expect(fetchAvailabilityText('this_week', 'America/New_York', load as never)).resolves.toBe('My availability (EST):\nTue, Nov 10: 9:00 AM – 6:00 PM')
    expect(load).toHaveBeenCalledWith('/api/account/availability/copy?range=this_week&tz=America%2FNew_York')
  })

  it('unknown or a failed request: rejects with why, never a text', async () => {
    await expect(fetchAvailabilityText('today', undefined, answer({ known: false, reason: 'A calendar account needs signing in again' }) as never)).rejects.toThrow('A calendar account needs signing in again')
    await expect(fetchAvailabilityText('today', undefined, answer({ error: 'Unauthorized' }, false) as never)).rejects.toThrow('Unauthorized')
  })
})

describe('fetchMyBookingLinks', () => {
  it('the person’s links that are on: ones they own or host, never a business page or a teammate’s', async () => {
    const link = (id: string, extra: Record<string, unknown>) => ({ id, title: id, url: `https://app.example/book/x/${id}`, active: true, hosts: ['me'], owner_user_id: 'me', purpose: 'meeting', ...extra })
    const load = answer({
      user_id: 'me',
      links: [link('intro', {}), link('team', { owner_user_id: 'boss' }), link('off', { active: false }), link('theirs', { owner_user_id: 'boss', hosts: ['boss'] }), link('pickup', { purpose: 'job' })],
    })
    expect((await fetchMyBookingLinks(load as never)).map((l) => l.id)).toEqual(['intro', 'team'])
    // A failed read is not "no links".
    await expect(fetchMyBookingLinks(answer({}, false) as never)).rejects.toThrow()
  })
})

describe('CopyAvailabilityButton', () => {
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

  it('draws nothing without a calendar connected, and the button with one', () => {
    hoisted.connected = false
    act(() => root.render(h(CopyAvailabilityButton)))
    expect(container.innerHTML).toBe('')
    hoisted.connected = true
    act(() => root.render(h(CopyAvailabilityButton, { key: 'again' })))
    expect(container.textContent).toBe('Copy availability')
  })
})
