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
})
