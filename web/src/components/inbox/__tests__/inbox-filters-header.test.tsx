// @vitest-environment jsdom
/**
 * The inbox's filters (../inbox-view.tsx; Liam, 11-23: "Into the header"): in
 * a card, a capsule of segments in the card's header (its right slot), as
 * Calendar's views are, and the page starts with the list; on their own, the
 * row over the list, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/app/account/(dashboard)/views/team-chat-view', () => ({ TeamChatView: () => null }))

const { InboxView } = await import('../inbox-view')

let container: HTMLDivElement
let right: HTMLDivElement
let root: Root
const realFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [], held: [], mail: [] }), { status: 200 })) as typeof fetch
  container = document.createElement('div')
  right = document.createElement('div')
  document.body.append(right, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  globalThis.fetch = realFetch
})

describe('the inbox’s filters', () => {
  it('in a card: in its header, a capsule of 24px segments, the chosen one lifted; none over the list', async () => {
    await act(async () => root.render(<CardHeaderSlotsProvider value={{ left: null, right }}><InboxView /></CardHeaderSlotsProvider>))
    const capsule = right.querySelector<HTMLElement>('[data-inbox-filters="header"]')!
    expect(capsule).not.toBeNull()
    expect(capsule.getAttribute('role')).toBe('tablist')
    expect(capsule.className).toContain('h-6')
    expect(Array.from(capsule.querySelectorAll('[data-inbox-filter]')).map((b) => b.getAttribute('data-inbox-filter'))).toEqual(['all', 'messages', 'mentions', 'mail', 'held'])
    expect(capsule.querySelector('[data-inbox-filter="all"]')!.getAttribute('aria-selected')).toBe('true')
    // The long one's full name is its tooltip.
    expect(capsule.querySelector('[data-inbox-filter="mentions"]')!.getAttribute('title')).toBe('Mentions & assignments')
    // The page starts with the list.
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    // A press chooses.
    await act(async () => capsule.querySelector<HTMLButtonElement>('[data-inbox-filter="held"]')!.click())
    expect(capsule.querySelector('[data-inbox-filter="held"]')!.getAttribute('aria-selected')).toBe('true')
  })

  it('on their own (no card): the row over the list, as before', async () => {
    await act(async () => root.render(<InboxView />))
    expect(container.querySelector('[role="tablist"] [data-inbox-filter="all"]')).not.toBeNull()
    expect(right.childElementCount).toBe(0)
  })

  it('a key on a header control is that control’s, not the list’s (it is portalled out of the page but bubbles through React): Enter presses it, e and h never touch a row', async () => {
    const item = { key: 'n1', source: 'notification', category: 'other', at: new Date().toISOString(), title: 'A note', body: null, unread: true, count: 1, notificationIds: ['n1'], actor: null, open: { kind: 'none' }, type: 'other' }
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [item], held: [], mail: [] }), { status: 200 })) as typeof fetch
    await act(async () => root.render(<CardHeaderSlotsProvider value={{ left: null, right }}><InboxView /></CardHeaderSlotsProvider>))
    await act(async () => {})
    expect(container.textContent).toContain('A note')
    const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
    const before = calls()
    for (const key of ['Enter', 'e', 'h', 'j']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      await act(async () => void right.querySelector<HTMLButtonElement>('[data-inbox-filter="messages"]')!.dispatchEvent(ev))
      // Not taken by the list: the button's own Enter (its click) still happens.
      expect(ev.defaultPrevented).toBe(false)
    }
    // No Done, no hold: nothing was sent for the row.
    expect(calls()).toBe(before)
  })
})
