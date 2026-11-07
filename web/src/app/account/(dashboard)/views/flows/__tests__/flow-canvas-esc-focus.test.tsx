// @vitest-environment jsdom
/**
 * One Esc closes one canvas: the one in focus. A flows card full screen (pages
 * in the chat) takes the focus from the Flows window under it, so its canvas
 * closes and the window's stays open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

import { FlowCanvasEditor } from '../flow-canvas-editor'
import { ChatCardLayer, WindowFocusProvider } from '@/components/views/tab-active'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('FlowCanvasEditor Esc', () => {
  it('closes only the canvas in focus', async () => {
    const closeWindow = vi.fn()
    const closeCard = vi.fn()
    await act(async () => {
      root.render(
        h('div', null,
          h(WindowFocusProvider, { isFocused: true, children: h(FlowCanvasEditor, { flowId: null, onClose: closeWindow, onSaved: () => {} }) }),
          h(ChatCardLayer, { children: h(WindowFocusProvider, { isFocused: true, children: h(FlowCanvasEditor, { flowId: null, onClose: closeCard, onSaved: () => {} }) }) }),
        ),
      )
    })
    // A new flow opens with its trigger selected: the first Esc lets go of it,
    // the next closes the canvas.
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(closeCard).toHaveBeenCalledTimes(1)
    expect(closeWindow).not.toHaveBeenCalled()
  })
})
