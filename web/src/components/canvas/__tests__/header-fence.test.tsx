// @vitest-environment jsdom
/**
 * The canvas's controls in its card's header are portals whose React parent
 * is the surface: without the fence a press on the title or the menu bubbles
 * to the surface, which draws, selects or types there (../canvas-editor.tsx
 * HeaderFence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../surface', () => ({ CanvasSurface: () => null, isTyping: () => false }))

import { HeaderFence } from '../canvas-editor'
import { CardHeaderSlot, CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'

let container: HTMLDivElement
let header: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  header = document.createElement('div')
  document.body.append(header, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  header.remove()
})

function press(target: Element) {
  for (const type of ['pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
}

function render(fenced: boolean, surface: Record<string, () => void>) {
  const control: ReactNode = h('button', { type: 'button', 'data-control': '' }, 'Canvas menu')
  act(() => {
    root.render(
      h(CardHeaderSlotsProvider, { value: { left: null, right: header } },
        h('div', { 'data-surface': '', ...surface },
          h(CardHeaderSlot, { side: 'right' }, fenced ? h(HeaderFence, null, control) : control),
        ),
      ),
    )
  })
}

describe('the canvas header in a card', () => {
  it('keeps a press on its controls from the surface', () => {
    const surface = { onPointerDown: vi.fn(), onPointerUp: vi.fn(), onDoubleClick: vi.fn(), onContextMenu: vi.fn() }
    // Unfenced, the portal's press reaches the surface (why the fence is there).
    render(false, surface)
    press(header.querySelector('[data-control]')!)
    expect(surface.onPointerDown).toHaveBeenCalled()
    for (const spy of Object.values(surface)) spy.mockClear()
    render(true, surface)
    press(header.querySelector('[data-control]')!)
    for (const spy of Object.values(surface)) expect(spy).not.toHaveBeenCalled()
  })
})
