// @vitest-environment jsdom
/**
 * The live capture's notepad docked on the left of the main chat
 * (live-capture-dock.tsx; there is one chat: docs/plans/one-chat.md):
 *
 *  • only while a capture is active;
 *  • it slides in once the capture's card attaches (its page is moved into
 *    the dock's body), pushing the chat right, or over a narrow chat;
 *  • a spot about half the chat's height, centred on the chat's whole
 *    height, with no chrome of its own: the card is what shows (its own header
 *    and Full screen, show-tool-card.tsx), and nothing puts it away;
 *  • when the capture ends it slides away, the card staying docked until it
 *    is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import { createPortal } from 'react-dom'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rec = vi.hoisted(() => ({
  value: null as null | { captureId: string | null; isRecording: boolean; isStarting: boolean; isPaused: boolean },
}))

vi.mock('@/hooks/recording-context', () => ({
  useOptionalRecordingStable: () => rec.value,
}))

import { DOCK_CARD_HEIGHT, LiveCaptureDockLayout, useLiveCaptureDockSlot, type LiveCaptureDockSlot } from '../live-capture-dock'
import {
  DOCK_COMPOSER_CLEARANCE_REM,
  DOCK_SLIDE_MS,
  dockPush,
} from '../live-capture-dock-store'

let container: HTMLDivElement
let root: Root
let width = 1400
let seen: LiveCaptureDockSlot | null = null
const enterFullScreen = vi.fn()

/** Stands in for the docked card: its page moved into the dock, attached with its title. */
function FakeCard({ attach = true, fullScreen = false }: { attach?: boolean; fullScreen?: boolean }) {
  const slot = useLiveCaptureDockSlot()
  seen = slot
  const attachFn = slot?.attach
  useEffect(() => {
    if (!attach || !attachFn) return
    return attachFn({ title: 'Capture Oct 9', fullScreen, enterFullScreen })
  }, [attach, attachFn, fullScreen])
  return h(
    'div',
    { 'data-chat': '' },
    'the chat',
    slot?.body && !fullScreen ? createPortal(h('div', { 'data-capture-page': '' }, 'live notes'), slot.body) : null,
  )
}

function render(props: { attach?: boolean; fullScreen?: boolean } = {}) {
  act(() => {
    root.render(
      h(
        'div',
        { id: 'ni-chat-strip-slot' },
        h(LiveCaptureDockLayout, {
          children: h(FakeCard, { attach: props.attach, fullScreen: props.fullScreen }),
        }),
      ),
    )
  })
}

const row = () => container.querySelector<HTMLElement>('[data-live-capture-dock-row]')!
const chatArea = () => container.querySelector<HTMLElement>('[data-live-capture-chat-area]')!
const dock = () => container.querySelector<HTMLElement>('aside[data-live-capture-dock]')
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

function recording(captureId: string | null, extra: Partial<NonNullable<typeof rec.value>> = {}) {
  rec.value = { captureId, isRecording: !!captureId, isStarting: false, isPaused: false, ...extra }
}

beforeEach(() => {
  width = 1400
  seen = null
  enterFullScreen.mockReset()
  rec.value = null
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return width
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth
})

describe('LiveCaptureDockLayout', () => {
  it('is only the chat, at full width, while no capture is active', () => {
    render()
    expect(dock()).toBeNull()
    expect(chatArea().style.left).toBe('0px')
    expect(row().getAttribute('data-live-capture-dock-row')).toBe('off')
    expect(seen).toBeNull()
    expect(container.textContent).toContain('the chat')
  })

  it('stays out of sight until the capture’s card attaches', () => {
    recording('cap-1')
    render({ attach: false })
    // The panel is there for the card to move its page into, but not out.
    expect(dock()).not.toBeNull()
    expect(dock()!.hasAttribute('inert')).toBe(true)
    expect(dock()!.className).toContain('invisible')
    expect(chatArea().style.left).toBe('0px')
    expect(seen?.captureId).toBe('cap-1')
    expect(seen?.body).toBeInstanceOf(HTMLElement)
  })

  it('slides in with the card’s page and pushes the chat right, only as far as clears the card', () => {
    recording('cap-1')
    render()
    expect(row().getAttribute('data-live-capture-dock-row')).toBe('push')
    expect(dock()!.hasAttribute('inert')).toBe(false)
    expect(dock()!.className).toContain('translate-x-0')
    expect(chatArea().style.left).toBe(`${dockPush(1400)}px`)
    // The card is in the dock's spot.
    expect(dock()!.querySelector('[data-live-capture-dock-body] [data-capture-page]')?.textContent).toBe('live notes')
  })

  it('lies over a narrow chat instead of pushing it', () => {
    width = 900
    recording('cap-1')
    render()
    expect(row().getAttribute('data-live-capture-dock-row')).toBe('overlay')
    expect(dock()!.getAttribute('data-live-capture-dock-mode')).toBe('overlay')
    expect(chatArea().style.left).toBe('0px')
  })

  it('keeps its place while the card is full screen', () => {
    recording('cap-1')
    render({ fullScreen: true })
    expect(chatArea().style.left).toBe(`${dockPush(1400)}px`)
    expect(dock()!.hasAttribute('inert')).toBe(false)
  })

  it('floats a little under two thirds of the chat’s height, centred between the top bar’s insets', () => {
    recording('cap-1')
    render()
    const column = dock()!
    expect(column.className).toContain('justify-center')
    expect(column.className).toContain('inset-y-0')
    expect(column.style.paddingTop).toContain('--chat-top-inset')
    expect(column.style.paddingBottom).toContain('--chat-top-inset')
    const spot = column.querySelector<HTMLElement>('[data-live-capture-dock-body]')!
    expect(spot.style.height).toBe(DOCK_CARD_HEIGHT)
    expect(DOCK_CARD_HEIGHT).toContain('62%')
    // Capped on a short window, clear of the composer at both ends.
    expect(DOCK_CARD_HEIGHT).toContain(`${2 * DOCK_COMPOSER_CLEARANCE_REM}rem`)
    // The column is click-through; only the card's spot takes clicks.
    expect(column.className).toContain('pointer-events-none')
    expect(spot.className).toContain('pointer-events-auto')
  })

  it('draws no chrome of its own and nothing to put it away with: the card is what shows', () => {
    recording('cap-1')
    render()
    expect(dock()!.querySelectorAll('button')).toHaveLength(0)
    expect(dock()!.querySelector('[data-live-capture-dock-header]')).toBeNull()
    expect(button('Hide')).toBeNull()
    expect(button('Show notes')).toBeNull()
    expect(container.querySelector('[data-live-capture-dock-tab]')).toBeNull()
    // Only the card inside the spot.
    expect(dock()!.querySelector('[data-live-capture-dock-body]')!.children).toHaveLength(1)
  })

  it('slides away when the capture ends, the card docked until it is gone', () => {
    vi.useFakeTimers()
    recording('cap-1')
    render()
    recording(null)
    render()
    // Sliding out: the chat has its width back, the card is still in the panel.
    expect(chatArea().style.left).toBe('0px')
    expect(dock()!.hasAttribute('inert')).toBe(true)
    expect(seen?.ending).toBe(true)
    expect(dock()!.querySelector('[data-capture-page]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(DOCK_SLIDE_MS))
    expect(dock()).toBeNull()
    expect(seen).toBeNull()
  })

  it('goes at once when the capture stops before its card attached', () => {
    recording('cap-1')
    render({ attach: false })
    recording('cap-1', { isRecording: false })
    render({ attach: false })
    expect(dock()).toBeNull()
  })
})
