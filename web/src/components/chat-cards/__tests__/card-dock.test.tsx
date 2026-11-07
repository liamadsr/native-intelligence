// @vitest-environment jsdom
/**
 * The live capture's card, docked beside its chat while it records
 * (card-store.ts setDocked, show-tool-card.tsx, chat/live-capture-dock.tsx):
 *
 *   - docked, it is mounted as itself (beside the 1 + LIVE_CARDS cap, never a
 *     second copy), and is never one of the kept pages;
 *   - in the dock it is the card itself, as it draws in the chat: its frame,
 *     its header (Back and Forward, the page's controls such as Properties in
 *     its slots) and its round Full screen, but no Close; full screen it is
 *     the same page in the overlay, "Back to notes" puts it back in the dock;
 *   - let go (the capture ended), it is the page visited last (kept mounted,
 *     as any), and stays in the dock while the dock slides away;
 *   - a capture card with no dock opens like any page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../card-body', async () => {
  const React = await import('react')
  const { CardHeaderSlot } = await import('../card-header-slot')
  // The page, and a control of its own in the card's header (as Properties is).
  function PageBody(props: { toolCallId: string }) {
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        CardHeaderSlot as React.FC<{ side: 'left' | 'right'; children?: React.ReactNode }>,
        { side: 'right' },
        React.createElement('button', { type: 'button', 'aria-label': 'Properties' }),
      ),
      React.createElement('div', { 'data-page': props.toolCallId }, `page ${props.toolCallId}`),
    )
  }
  return { default: PageBody }
})

import { ShowToolCard } from '../show-tool-card'
import { ChatCardHostProvider } from '../card-host'
import { ChatCardStore, LIVE_CARDS } from '../card-store'
import { LiveCaptureDockSlotProvider, type DockedCard, type LiveCaptureDockSlot } from '../card-dock-slot'
import { KeptCardHost } from '@/app/account/(dashboard)/chat/kept-card-host'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const page = (title: string): CardSpec => ({ kind: 'list', title, entity_type: 'action', filters: [] })
const capture: CardSpec = { kind: 'record', title: 'Capture Oct 9', record: { type: 'capture', id: 'cap-1' } }

let t = 10_000
let store: ChatCardStore

beforeEach(() => {
  t = 10_000
  window.localStorage.clear()
  vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000))
  store = new ChatCardStore()
})
afterEach(() => vi.restoreAllMocks())

/** Opened pages p1..pn, each visited in turn, and the capture's card. */
function withPages(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`)
  store.setCards([...ids.map((id) => ({ id, spec: page(id), opened: true })), { id: 'cap', spec: capture, opened: true }])
  for (const id of ids) {
    store.enterFullScreen(id)
    store.exitFullScreen()
  }
  store.update('cap', { visitedAt: Date.now() })
  return ids
}

describe('the store, with a docked card', () => {
  it('mounts the docked card as itself: the cap of 1 + LIVE_CARDS holds, never a second copy', () => {
    withPages(5)
    store.setDocked('cap')
    expect(store.docked()).toBe('cap')
    // The docked card, and the LIVE_CARDS pages visited last (not the docked one in their place).
    expect(store.keptPages().map((c) => c.id)).toEqual(['p3', 'p4', 'p5'])
    expect(store.hostedIds()).toHaveLength(1 + LIVE_CARDS)
    expect(store.hostedIds()).toContain('cap')
    // Full screen, an old page is one of the kept, the cap the same.
    store.enterFullScreen('p1')
    expect(store.hostedIds()).toHaveLength(1 + LIVE_CARDS)
    store.exitFullScreen()
    // The docked card full screen is still one card.
    store.enterFullScreen('cap')
    expect(store.hostedIds().filter((id) => id === 'cap')).toHaveLength(1)
    expect(store.hostedIds()).toHaveLength(1 + LIVE_CARDS)
  })

  it('never counts the docked card among the kept pages, even back from full screen', () => {
    withPages(2)
    store.setDocked('cap')
    expect(store.keptPages().map((c) => c.id)).not.toContain('cap')
    store.enterFullScreen('cap')
    store.exitFullScreen()
    expect(store.keptPages().map((c) => c.id)).toEqual(['p1', 'p2'])
    expect(store.hostedIds()).toContain('cap')
  })

  it('let go, it is the page visited last: kept mounted, as any', () => {
    withPages(4)
    store.setDocked('cap')
    const before = store.drawKey('cap')
    store.setDocked(null)
    expect(store.docked()).toBeNull()
    expect(store.dockReleased()).toBe('cap')
    expect(store.drawKey('cap')).not.toBe(before)
    expect(store.openedByVisit().at(-1)?.id).toBe('cap')
    expect(store.keptPages().map((c) => c.id)).toEqual(['p3', 'p4', 'cap'])
  })

  it('let go while full screen, stays full screen, and is kept once put away', () => {
    withPages(1)
    store.setDocked('cap')
    store.enterFullScreen('cap')
    store.setDocked(null)
    expect(store.fullScreen()).toBe('cap')
    store.exitFullScreen()
    expect(store.keptPages().map((c) => c.id)).toContain('cap')
    expect(store.hostedIds()).toContain('cap')
  })
})

describe('the docked card', () => {
  let container: HTMLDivElement
  let dockBody: HTMLDivElement
  let root: Root
  let attached: DockedCard | null
  const detach = vi.fn()
  const attach = vi.fn((card: DockedCard) => {
    attached = card
    return () => {
      detach()
      if (attached === card) attached = null
    }
  })

  beforeEach(() => {
    attached = null
    attach.mockClear()
    detach.mockClear()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 1000, height: 625, top: 0, left: 0, right: 1000, bottom: 625, x: 0, y: 0, toJSON() {} }) as DOMRect,
    )
    container = document.createElement('div')
    dockBody = document.createElement('div')
    dockBody.setAttribute('data-test-dock-body', '')
    document.body.append(container, dockBody)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    dockBody.remove()
  })

  async function render(slot: Partial<LiveCaptureDockSlot> | null) {
    const value: LiveCaptureDockSlot | null = slot
      ? { captureId: 'cap-1', body: dockBody, ending: false, attach, ...slot }
      : null
    await act(async () => {
      root.render(
        h(
          Suspense,
          { fallback: null },
          h(LiveCaptureDockSlotProvider, {
            value,
            children: h(ChatCardHostProvider, { value: { wide: true, store, stage: null }, children: h(KeptCardHost, { store }) }),
          }),
        ),
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  const inDock = () => dockBody.querySelector('[data-page="cap"]')
  const parked = () => document.querySelector('[data-card-parked="cap"] [data-page="cap"]')
  const fullScreenPage = () => document.querySelector('[data-chat-card-fullscreen="cap"] [data-page="cap"]')

  it('is the card itself in the dock: its header and controls, Full screen, no Close', async () => {
    withPages(1)
    store.setDocked('cap')
    await render({})
    expect(inDock()).not.toBeNull()
    expect(parked()).toBeNull()
    expect(attach).toHaveBeenCalled()
    expect(attached?.title).toBe('Capture Oct 9')
    expect(attached?.fullScreen).toBe(false)
    // The card as it draws in the chat, in the dock's spot.
    const card = dockBody.querySelector('[data-chat-card="cap"]')!
    expect(card).not.toBeNull()
    expect(card.hasAttribute('data-chat-card-docked')).toBe(true)
    expect(card.querySelector('[data-card-glass]')).not.toBeNull()
    expect(card.querySelector('[data-card-header]')?.textContent).toContain('Capture Oct 9')
    expect(card.querySelector('[data-card-header] button[aria-label="Properties"]')).not.toBeNull()
    expect(card.querySelector('button[aria-label="Full screen"]')).not.toBeNull()
    // Nothing closes it: it leaves when the capture ends.
    expect(card.querySelector('button[aria-label="Close"]')).toBeNull()
  })

  it('goes full screen from the dock and back to it with “Back to notes”', async () => {
    withPages(1)
    store.setDocked('cap')
    await render({})
    const expand = dockBody.querySelector('[data-chat-card="cap"] button[aria-label="Full screen"]') as HTMLButtonElement
    await act(async () => expand.click())
    expect(store.fullScreen()).toBe('cap')
    expect(fullScreenPage()).not.toBeNull()
    expect(inDock()).toBeNull()
    // Still attached (the dock keeps its place), saying it is full screen.
    expect(attached?.fullScreen).toBe(true)
    const back = document.querySelector('[data-chat-card-fullscreen="cap"] button[aria-label="Back to notes"]') as HTMLButtonElement
    expect(back).not.toBeNull()
    await act(async () => back.click())
    expect(store.fullScreen()).toBeNull()
    expect(inDock()).not.toBeNull()
    expect(dockBody.querySelector('[data-chat-card="cap"] [data-card-header]')).not.toBeNull()
    expect(attached?.fullScreen).toBe(false)
    // Still docked, still not one of the kept pages.
    expect(store.docked()).toBe('cap')
    expect(store.keptPages().map((c) => c.id)).not.toContain('cap')
  })

  it('stays in the dock while it slides away, then parks as a page like any other', async () => {
    withPages(1)
    store.setDocked('cap')
    await render({})
    // The capture ended: the store lets it go while the dock slides away.
    await act(async () => store.setDocked(null))
    await render({ ending: true })
    expect(inDock()).not.toBeNull()
    expect(store.keptPages().map((c) => c.id)).toContain('cap')
    // The dock gone: the page waits parked, as any kept page.
    await render(null)
    expect(inDock()).toBeNull()
    expect(parked()).not.toBeNull()
    expect(detach).toHaveBeenCalled()
  })

  it('opens like any page when no capture is docked', async () => {
    withPages(1)
    await render(null)
    await act(async () => store.enterFullScreen('cap'))
    expect(fullScreenPage()).not.toBeNull()
    expect(document.querySelector('[data-chat-card-fullscreen="cap"] button[aria-label="Close"]')).not.toBeNull()
    expect(attach).not.toHaveBeenCalled()
  })
})
