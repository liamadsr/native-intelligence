// @vitest-environment jsdom
/**
 * ComposerLiquidPill — the capture page's Transcripts and Tools in the chat
 * composer's top row: pills like Capture whose cards RISE out of them.
 *
 * Hover opens the card and leaving both pill and card closes it; a click PINS
 * it open (pressed) so a live transcript can be read hands-free, and a second
 * click, Escape or a press outside puts it away. Pills take turns — one
 * opening puts the others away, pinned or not. While a card is out (or still
 * shrinking home) it lifts itself over the chat and the windows, and the lift
 * holds until the LAST card is home. The card fits the room above the pill
 * and to its left.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The liquid is a silhouette painted behind the content; what matters here is
// where each item is sent, so the stand-in records x / y / scale.
vi.mock('liquid-gooey', () => {
  const Liquid = Object.assign(
    forwardRef<HTMLDivElement, Record<string, unknown>>(function Liquid(props, ref) {
      const { blur: _b, contrast: _c, fill: _f, shadow: _s, filterPadding: _p, children, ...rest } = props
      return h('div', { ...rest, ref }, children as ReactNode)
    }),
    {
      Item: ({ x, y, scale, className, children }: { x?: number; y?: number; scale?: number; className?: string; children?: ReactNode }) =>
        h('div', { className, 'data-item': '', 'data-x': x, 'data-y': y, 'data-scale': scale ?? 1 }, children),
    },
  )
  return { Liquid }
})

import { CAPTURE_CARD_UP_ATTR, ComposerLiquidPill } from '../composer-liquid-pill'

let container: HTMLDivElement
let root: Root

function Pills({ count = 3, both = false }: { count?: number; both?: boolean }) {
  return h(
    'div',
    null,
    h(ComposerLiquidPill, {
      name: 'transcripts',
      label: 'Transcripts',
      icon: h('svg'),
      count,
      cardLabel: 'Transcript',
      cardMaxWidth: 380,
      cardMaxHeight: 360,
      children: h('div', { 'data-content': 'transcripts' }, 'live words'),
    }),
    both &&
      h(ComposerLiquidPill, {
        name: 'tools',
        label: 'Tools',
        icon: h('svg'),
        count: 0,
        cardLabel: 'Live agent tool calls',
        cardMaxWidth: 320,
        cardMaxHeight: 280,
        children: h('div', { 'data-content': 'tools' }, 'calls'),
      }),
  )
}

function render(props: { count?: number; both?: boolean } = {}) {
  act(() => {
    root.render(h(Pills, props))
  })
}

const liquid = (name = 'transcripts') => container.querySelector<HTMLElement>(`[data-composer-pill="${name}"]`)!
const button = (name = 'transcripts') => liquid(name).querySelector('button')!
const face = (name = 'transcripts') => button(name).parentElement!
const card = (name = 'transcripts') => liquid(name).querySelector<HTMLElement>('[role="dialog"]')!
const cardItem = (name = 'transcripts') => card(name).parentElement!
const isOpen = (name = 'transcripts') => liquid(name).hasAttribute('data-open')
const isPinned = (name = 'transcripts') => button(name).getAttribute('aria-pressed') === 'true'
const contentMounted = (name = 'transcripts') => !!container.querySelector(`[data-content="${name}"]`)
const lifted = () => document.documentElement.hasAttribute(CAPTURE_CARD_UP_ATTR)
const wrapper = (name = 'transcripts') => liquid(name).parentElement!

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} } as DOMRect
}

/** The pill low in the composer at 700,700 and its open card above it. */
function layOut(name = 'transcripts') {
  vi.spyOn(face(name), 'getBoundingClientRect').mockReturnValue(box(700, 700, 110, 36))
  vi.spyOn(card(name), 'getBoundingClientRect').mockReturnValue(box(430, 334, 380, 360))
}

const hover = (el: Element) =>
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
const moveTo = (x: number, y: number) =>
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }))
  })
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const click = (el: HTMLElement) => act(() => el.click())

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('a composer pill', () => {
  it('looks like Capture: the label (hidden on a narrow window), its tally, nothing for none', () => {
    render({ both: true })
    const label = [...button().querySelectorAll('span')].find((el) => el.textContent === 'Transcripts')!
    expect(label.className).toMatch(/(^|\s)max-md:hidden(\s|$)/)
    expect(button().textContent).toBe('Transcripts3')
    expect(button().getAttribute('aria-label')).toBe('Transcripts (3)')
    expect(button().className).toMatch(/(^|\s)text-\[12px\](\s|$)/)
    expect(button('tools').textContent).toBe('Tools')
    // The face is the liquid pill's own 36px face.
    expect(face().className).toMatch(/(^|\s)h-9(\s|$)/)
    // The liquid is the app's own background, like every composer pill — not
    // the header pills' pure white / black override.
    expect(liquid().className).not.toMatch(/--background:/)
  })

  it('rises out of the pill on hover, and goes home once the pointer leaves both', () => {
    render()
    layOut()
    expect(isOpen()).toBe(false)
    expect(contentMounted()).toBe(false)

    hover(face())
    expect(isOpen()).toBe(true)
    expect(contentMounted()).toBe(true)
    // Risen: right-aligned, lifted its own height (360) plus the gap.
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '-366', scale: '1' })

    moveTo(500, 500) // inside the card
    wait(1000)
    expect(isOpen()).toBe(true)

    moveTo(100, 100)
    wait(240)
    expect(isOpen()).toBe(false)
    // Its content stays while it shrinks home, then goes.
    expect(contentMounted()).toBe(true)
    wait(600)
    expect(contentMounted()).toBe(false)
  })

  it('stays open, pinned, after a click — whatever the pointer does — until clicked again', () => {
    render()
    layOut()
    hover(face())
    click(button())
    expect(isPinned()).toBe(true)
    expect(button().className).toMatch(/(^|\s)bg-muted(\s|$)/)

    moveTo(100, 100)
    wait(2000)
    expect(isOpen()).toBe(true)

    click(button())
    expect(isOpen()).toBe(false)
    expect(isPinned()).toBe(false)
  })

  it('opens pinned from a click alone (touch, keyboard)', () => {
    render()
    click(button())
    expect(isOpen()).toBe(true)
    expect(isPinned()).toBe(true)
  })

  it('puts a pinned card away on Escape, and on a press outside — not one inside it', () => {
    render()
    click(button())
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(isOpen()).toBe(false)
    expect(isPinned()).toBe(false)

    click(button())
    act(() => {
      card().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(isOpen()).toBe(true)
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(isOpen()).toBe(false)
    expect(isPinned()).toBe(false)
  })

  it('opens on keyboard focus, and a plain (unpinned) card closes once focus leaves', () => {
    render()
    act(() => button().focus())
    expect(isOpen()).toBe(true)
    act(() => button().blur())
    wait(240)
    expect(isOpen()).toBe(false)
  })

  it('takes turns: another pill opening puts it away, pinned or not', () => {
    render({ both: true })
    click(button())
    expect(isPinned()).toBe(true)

    hover(face('tools'))
    expect(isOpen('tools')).toBe(true)
    expect(isOpen()).toBe(false)
    expect(isPinned()).toBe(false)
  })

  it('lifts itself over the chat while out, and the lift holds until the LAST card is home', () => {
    render({ both: true })
    expect(lifted()).toBe(false)
    expect(wrapper().className).toMatch(/(^|\s)z-10(\s|$)/)

    hover(face())
    expect(lifted()).toBe(true)
    expect(wrapper().className).toMatch(/(^|\s)z-\[46\](\s|$)/)

    // Tools takes its turn while Transcripts shrinks home…
    wait(100)
    hover(face('tools'))
    // …Transcripts gets home first: Tools' card is still out, so the lift stays.
    wait(600)
    expect(wrapper().className).toMatch(/(^|\s)z-10(\s|$)/)
    expect(lifted()).toBe(true)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    wait(600)
    expect(lifted()).toBe(false)
  })

  it('fits its card into the room above the pill and to its left', () => {
    render()
    // The chat strip clips from (100, 480); the pill sits at 300,700.
    container.style.overflowY = 'hidden'
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(box(100, 480, 1000, 400))
    vi.spyOn(face(), 'getBoundingClientRect').mockReturnValue(box(300, 700, 110, 36))
    hover(face())
    // Up: 700 - 6 (gap) - 480 - 8 clear = 206. Left: 410 - 100 - 8 clear = 302.
    expect(card().style.height).toBe('206px')
    expect(card().style.width).toBe('302px')
    expect(cardItem().dataset).toMatchObject({ y: '-212' })
  })

  it('lets go of the lift when it unmounts mid-pour', () => {
    render()
    hover(face())
    expect(lifted()).toBe(true)
    act(() => root.render(null))
    expect(lifted()).toBe(false)
  })
})
