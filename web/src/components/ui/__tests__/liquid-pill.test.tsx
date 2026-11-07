// @vitest-environment jsdom
/**
 * A liquid pill pours its card out on hover and puts it back when the pointer
 * leaves. Closed, the card is collapsed onto the centre of the pill's right cap
 * — worked out from the card's height when it's content-sized; open, it hangs
 * right-aligned under the pill.
 *
 * Hover: opens as the pointer enters the pill (never for touch), holds while
 * the pointer is over the pill or the card, closes a moment after it leaves
 * both, and stays shut while disabled. Only one pill is out at a time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, useRef, useState, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

import { LiquidPill, LiquidPillCard, LiquidPillFace, useLiquidPillHover } from '../liquid-pill'

let container: HTMLDivElement
let root: Root

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} } as DOMRect
}

/** A pill with a card, opened by hover. `name` tells two apart. */
function HoverPill({ name, enabled = true, height }: { name: string; enabled?: boolean; height?: number }) {
  const [open, setOpen] = useState(false)
  const faceRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const { onPointerEnter } = useLiquidPillHover({ open, setOpen, enabled, faceRef, cardRef })
  return (
    <LiquidPill open={open} data-pill={name}>
      <LiquidPillFace ref={faceRef} onPointerEnter={onPointerEnter} data-face={name}>
        {name}
      </LiquidPillFace>
      <LiquidPillCard ref={cardRef} width={288} height={height} data-card={name} className="rounded-xl">
        menu
      </LiquidPillCard>
    </LiquidPill>
  )
}

const pillRoot = (name: string) => container.querySelector<HTMLElement>(`[data-pill="${name}"]`)!
const face = (name: string) => container.querySelector<HTMLElement>(`[data-face="${name}"]`)!
const card = (name: string) => container.querySelector<HTMLElement>(`[data-card="${name}"]`)!
const isOpen = (name: string) => pillRoot(name).hasAttribute('data-open')

const hover = (el: Element, pointerType = 'mouse') =>
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }))
  })
const moveTo = (x: number, y: number) =>
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }))
  })
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

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

describe('a liquid pill’s card', () => {
  it('parks on the pill’s right cap when closed and hangs right-aligned below it when open', () => {
    act(() => root.render(h(HoverPill, { name: 'a', height: 320 })))
    // Centre on the cap: half the 288px card in, less half the 36px pill; and
    // half the pill down, less half the 320px card.
    expect(card('a').parentElement!.dataset).toMatchObject({ x: '126', y: '-142', scale: '0' })
    expect(card('a').hasAttribute('inert')).toBe(true)

    hover(face('a'))
    expect(card('a').parentElement!.dataset).toMatchObject({ x: '0', y: '42', scale: '1' })
    expect(card('a').hasAttribute('inert')).toBe(false)
  })

  it('parks by its measured height when it is as tall as its content', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(411)
    act(() => root.render(h(HoverPill, { name: 'a' })))
    expect(card('a').parentElement!.dataset.y).toBe('-187.5')
  })
})

describe('useLiquidPillHover', () => {
  function layOut(name: string) {
    vi.spyOn(face(name), 'getBoundingClientRect').mockReturnValue(box(1000, 6, 90, 36))
    vi.spyOn(card(name), 'getBoundingClientRect').mockReturnValue(box(802, 48, 288, 400))
  }

  it('opens on hover, holds across the gap and over the card, and closes a moment after leaving both', () => {
    act(() => root.render(h(HoverPill, { name: 'a' })))
    layOut('a')
    hover(face('a'))
    expect(isOpen('a')).toBe(true)

    moveTo(1040, 45) // the gap under the pill
    moveTo(850, 300) // inside the card, well left of the pill
    wait(1000)
    expect(isOpen('a')).toBe(true)

    moveTo(400, 600)
    wait(200)
    expect(isOpen('a')).toBe(true)
    wait(40)
    expect(isOpen('a')).toBe(false)
  })

  it('never opens for touch, and stays shut while disabled', () => {
    act(() => root.render(h('div', null, h(HoverPill, { name: 'a' }), h(HoverPill, { name: 'off', enabled: false }))))
    hover(face('a'), 'touch')
    hover(face('off'))
    expect(isOpen('a')).toBe(false)
    expect(isOpen('off')).toBe(false)
  })

  it('closes after the grace period when the pointer leaves the page with no further move', () => {
    act(() => root.render(h(HoverPill, { name: 'a' })))
    layOut('a')
    hover(face('a'))
    expect(isOpen('a')).toBe(true)

    // Off the window's top edge: the browser reports a mouseout to nowhere and
    // then nothing more — no pointermove ever lands outside the pill.
    act(() => {
      face('a').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    })
    wait(200)
    expect(isOpen('a')).toBe(true)
    wait(40)
    expect(isOpen('a')).toBe(false)
  })

  it('stays out when the pointer leaves the page and comes straight back over the card', () => {
    act(() => root.render(h(HoverPill, { name: 'a' })))
    layOut('a')
    hover(face('a'))
    act(() => {
      face('a').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    })
    moveTo(850, 300) // back inside the card before the grace period ends
    wait(1000)
    expect(isOpen('a')).toBe(true)
  })

  it('closes when the window loses focus', () => {
    act(() => root.render(h(HoverPill, { name: 'a' })))
    layOut('a')
    hover(face('a'))
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    wait(240)
    expect(isOpen('a')).toBe(false)
  })

  it('takes turns: opening one pill puts the other away', () => {
    act(() => root.render(h('div', null, h(HoverPill, { name: 'a' }), h(HoverPill, { name: 'b' }))))
    hover(face('a'))
    expect(isOpen('a')).toBe(true)

    hover(face('b'))
    expect(isOpen('b')).toBe(true)
    expect(isOpen('a')).toBe(false)
  })
})

describe('a liquid pill’s colour', () => {
  /** The local override that paints the liquid the header pills' pure
   *  white / black (the goo's fill is `hsl(var(--background))`). */
  const OVERRIDE = /\[--background:0_0%_100%\].*dark:\[--background:0_0%_0%\]/

  it('is the header pills’ pure white / black by default', () => {
    act(() => root.render(<LiquidPill open={false} data-pill="header" />))
    expect(pillRoot('header').className).toMatch(OVERRIDE)
  })

  it('is the app’s own background with appBackground — the override is left off', () => {
    act(() => root.render(<LiquidPill open={false} appBackground data-pill="composer" />))
    expect(pillRoot('composer').className).not.toMatch(/--background:/)
  })
})
