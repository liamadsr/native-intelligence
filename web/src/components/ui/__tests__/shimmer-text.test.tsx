// @vitest-environment jsdom
/**
 * ShimmerText's performance contract: the animation class is present only
 * while the state is active, the chat tab is on screen and motion is allowed.
 * Inactive, a hidden tab (mounted under visibility:hidden, where WebKit keeps
 * CSS animations running) or reduced motion: plain muted text, no class.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ShimmerText } from '../shimmer-text'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const originalMatchMedia = window.matchMedia

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.matchMedia = originalMatchMedia
})

function stubReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

function render(active: boolean) {
  const text = h(ShimmerText, { active, className: 'text-sm', children: 'Thinking' })
  act(() => {
    root.render(text)
  })
  return container.querySelector('span')!
}

describe('<ShimmerText />', () => {
  it('active: carries the animation class, muted base colour and the passed classes', () => {
    const el = render(true)
    expect(el.textContent).toBe('Thinking')
    expect(el.classList.contains('shimmer-text')).toBe(true)
    expect(el.classList.contains('text-muted-foreground')).toBe(true)
    expect(el.classList.contains('text-sm')).toBe(true)
    expect(el.dataset.shimmer).toBe('on')
  })

  it('inactive: plain muted text, no animation class', () => {
    const el = render(false)
    expect(el.classList.contains('shimmer-text')).toBe(false)
    expect(el.classList.contains('text-muted-foreground')).toBe(true)
    expect(el.dataset.shimmer).toBe('off')
  })

  it('stops the moment the state ends', () => {
    expect(render(true).classList.contains('shimmer-text')).toBe(true)
    expect(render(false).classList.contains('shimmer-text')).toBe(false)
  })

  it('does not animate under prefers-reduced-motion: reduce', () => {
    stubReducedMotion(true)
    const el = render(true)
    expect(el.classList.contains('shimmer-text')).toBe(false)
    expect(el.textContent).toBe('Thinking')
  })

  it('animates when the person has not asked for reduced motion', () => {
    stubReducedMotion(false)
    expect(render(true).classList.contains('shimmer-text')).toBe(true)
  })
})
