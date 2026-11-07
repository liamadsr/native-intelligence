// @vitest-environment jsdom
/**
 * A chat card full screen takes the focus from the windows under it: the
 * window it covers reads unfocused, so a shortcut (Shift+H on an action) is
 * handled once, in the card, not twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { ChatCardLayer, WindowFocusProvider, useIsWindowFocused } from '../tab-active'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const seen: Record<string, boolean> = {}

function Probe({ name }: { name: string }) {
  seen[name] = useIsWindowFocused()
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(cardOpen: boolean) {
  act(() => {
    root.render(
      h('div', null,
        h(WindowFocusProvider, { isFocused: true, children: h(Probe, { name: 'window' }) }),
        cardOpen ? h(ChatCardLayer, { children: h(WindowFocusProvider, { isFocused: true, children: h(Probe, { name: 'card' }) }) }) : null,
      ),
    )
  })
}

describe('ChatCardLayer', () => {
  it('unfocuses the window under a full-screen card, keeps the card focused, and gives the focus back', () => {
    render(false)
    expect(seen.window).toBe(true)
    render(true)
    expect(seen.window).toBe(false)
    expect(seen.card).toBe(true)
    render(false)
    expect(seen.window).toBe(true)
  })
})
