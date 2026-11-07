// @vitest-environment jsdom
/**
 * The "Thinking" line for a `reasoning` UI part.
 *
 * Covers: nothing renders before the first delta lands (no empty shell); while
 * streaming it is ONE collapsed line, a shimmering "Thinking", with the
 * reasoning text NOT in the DOM; the settled state is a static "Thought for a
 * bit" with no shimmer; the disclosure (aria-expanded) reveals the text, live
 * while streaming; a part loaded from persisted history (state undefined)
 * renders exactly like 'done'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ReasoningCard } from '../reasoning-card'

describe('<ReasoningCard /> (jsdom)', () => {
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

  function render(props: Parameters<typeof ReasoningCard>[0]) {
    act(() => {
      root.render(h(ReasoningCard, props))
    })
  }

  it('renders nothing before any delta has landed (state streaming, empty text)', () => {
    render({ text: '', state: 'streaming' })
    expect(container.textContent).toBe('')
    expect(container.children).toHaveLength(0)
  })

  it('renders nothing for an empty settled part either', () => {
    render({ text: '', state: 'done' })
    expect(container.textContent).toBe('')
  })

  it('while streaming: one collapsed, shimmering "Thinking" line, the reasoning text not mounted', () => {
    render({ text: 'Secret chain of thought THE_FRESH_END', state: 'streaming' })
    expect(container.textContent).toContain('Thinking')
    expect(container.textContent).not.toContain('THE_FRESH_END')
    expect(container.querySelector('p')).toBeNull()
    const trigger = container.querySelector('button')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    const shimmer = container.querySelector('[data-shimmer]')!
    expect(shimmer.textContent).toBe('Thinking')
    expect(shimmer.classList.contains('shimmer-text')).toBe(true)
  })

  it('expanding while streaming shows the live text; it follows new tokens, and collapsing hides it again', () => {
    render({ text: 'First thought.', state: 'streaming' })
    const trigger = container.querySelector('button')!
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('First thought.')
    render({ text: 'First thought. Second thought.', state: 'streaming' })
    expect(container.textContent).toContain('Second thought.')
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).not.toContain('First thought.')
  })

  it('once settled (state: "done"): collapses to a plain summary with NO live snippet leaking through', () => {
    render({ text: 'The user wants X, so I should do Y.', state: 'done' })
    expect(container.textContent).toContain('Thought for a bit')
    expect(container.textContent).not.toContain('Thinking')
    // Static once settled: no shimmer at all.
    expect(container.querySelector('.shimmer-text')).toBeNull()
    // Collapsed by default — the full reasoning text is not in the DOM yet.
    expect(container.textContent).not.toContain('The user wants X, so I should do Y.')
  })

  it('a part with state undefined (rehydrated from persisted history) renders exactly like "done"', () => {
    render({ text: 'Reasoned about it earlier.' })
    expect(container.textContent).toContain('Thought for a bit')
    expect(container.textContent).not.toContain('Thinking')
    expect(container.querySelector('.shimmer-text')).toBeNull()
  })

  it('expands to reveal the full text on click, and collapses again on a second click', () => {
    render({ text: 'Full reasoning text goes here.', state: 'done' })
    const trigger = container.querySelector('button')!
    expect(container.textContent).not.toContain('Full reasoning text goes here.')

    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Full reasoning text goes here.')

    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).not.toContain('Full reasoning text goes here.')
  })
})
