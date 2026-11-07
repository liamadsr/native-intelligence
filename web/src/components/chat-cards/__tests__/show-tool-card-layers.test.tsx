// @vitest-environment jsdom
/**
 * Esc and a page's own inner layer (the flow canvas in a flows card): the
 * layer's Esc closes it, and the same keypress must not also put the card
 * back. Only the next Esc does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense, useEffect, useState } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../card-body', () => ({
  // A page with a layer of its own that closes on Esc, as the flow canvas does.
  default: function Body() {
    const [open, setOpen] = useState(true)
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false)
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [])
    return open ? h('div', { 'data-chat-card-layer': '' }, 'canvas') : h('div', null, 'list')
  },
}))

import { ShowToolCard } from '../show-tool-card'
import { ChatCardHostProvider } from '../card-host'
import { ChatCardStore } from '../card-store'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const spec: CardSpec = { kind: 'flows', title: 'Flows' }
let container: HTMLDivElement
let stage: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  stage = document.createElement('div')
  document.body.append(container, stage)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  stage.remove()
})

describe('a full-screen page card with an inner layer', () => {
  it('lets Esc close the layer first, and only the next Esc puts the card back', async () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec }])
    store.enterFullScreen('c1')
    await act(async () => {
      root.render(h(Suspense, { fallback: null }, h(ChatCardHostProvider, { value: { wide: true, store, stage }, children: [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec, count: null })] })))
    })
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(document.querySelector('[data-chat-card-layer]')).not.toBeNull()

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[data-chat-card-layer]')).toBeNull()
    expect(store.fullScreen()).toBe('c1')

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(store.fullScreen()).toBeNull()
  })
})
