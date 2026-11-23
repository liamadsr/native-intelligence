// @vitest-environment jsdom
/**
 * A full-screen page's header up on the sky (../sky-header-row.tsx; Liam,
 * 11-23: "Lets try G"): level with the rail's header, its title's pill past
 * the rail's header when the card starts under it, and measured again when the
 * card moves without resizing (the side panel comes or goes: the stage
 * resizes, the card may not).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { SkyHeaderRow } from '../sky-header-row'
import { FULL_SCREEN_CONTROL_ATTR } from '../outside-card-press'
import { TILE_FLIGHT_RIDER_ATTR } from '@/lib/chat/tile-flight'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Box = { left: number; top: number; width: number; height: number }
const realRect = HTMLElement.prototype.getBoundingClientRect
const boxes = new WeakMap<Element, Box>()
function place(el: Element, b: Box) {
  boxes.set(el, b)
}

/** A ResizeObserver the test drives: `resize(el)` tells whoever observes `el`. */
const observed = new Map<Element, Array<() => void>>()
class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe(el: Element) {
    observed.set(el, [...(observed.get(el) ?? []), this.cb])
  }
  disconnect() {
    for (const [el, cbs] of observed) observed.set(el, cbs.filter((cb) => cb !== this.cb))
  }
  unobserve() {}
}
const resize = (el: Element) => act(() => observed.get(el)?.forEach((cb) => cb()))

let root: Root
let stage: HTMLElement
let column: HTMLElement
let rail: HTMLElement

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const b = boxes.get(this)
    if (!b) return realRect.call(this)
    return { ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON: () => ({}) } as DOMRect
  }
  rail = document.createElement('div')
  rail.setAttribute('data-app-rail-header', '')
  place(rail, { left: 8, top: 3, width: 258, height: 42 })
  stage = document.createElement('div')
  column = document.createElement('div')
  stage.append(column)
  document.body.append(rail, stage)
  // The side panel open: the card starts well past the rail's header.
  place(column, { left: 400, top: 50, width: 900, height: 700 })
  root = createRoot(column)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  observed.clear()
  HTMLElement.prototype.getBoundingClientRect = realRect
})

/** The header as show-tool-card.tsx draws it (its pills elided). */
const header = () => (
  <SkyHeaderRow data-card-header="">
    <div>My actions</div>
  </SkyHeaderRow>
)
const row = () => column.querySelector<HTMLElement>('[data-card-header]')!

describe('the header up on the sky', () => {
  it('level with the rail’s header, a press on it the card’s, riding the card’s flight', () => {
    act(() => root.render(header()))
    // The rail's header's top (3) in the column's coordinates (its top at 50).
    expect(row().style.top).toBe('-47px')
    expect(row().style.height).toBe('42px')
    expect(row().style.paddingLeft).toBe('0px')
    expect(row().hasAttribute(FULL_SCREEN_CONTROL_ATTR)).toBe(true)
    expect(row().hasAttribute(TILE_FLIGHT_RIDER_ATTR)).toBe(true)
  })

  it('the card moved under the rail’s header without resizing (the side panel closed): measured again off the stage, past the rail’s header', () => {
    act(() => root.render(header()))
    place(column, { left: 70, top: 50, width: 900, height: 700 })
    resize(stage)
    // The rail's header ends at 266; 8px after it, from the card's left at 70.
    expect(row().style.paddingLeft).toBe('204px')
  })

  it('Interactive in the controls’ pill: its width (and its margin and the pill’s gap) kept out of the page controls’ room, as it comes, grows and goes', async () => {
    const withToggle = (shown: boolean) => (
      <SkyHeaderRow data-card-header="">
        <div>My actions</div>
        <div data-card-header-pill="controls">{shown && <span data-listen-header="">Interactive</span>}</div>
      </SkyHeaderRow>
    )
    await act(async () => root.render(withToggle(false)))
    expect(row().style.getPropertyValue('--sky-reserve')).toBe('0px')
    await act(async () => root.render(withToggle(true)))
    const toggle = column.querySelector('[data-listen-header]')!
    place(toggle, { left: 1100, top: 12, width: 92, height: 24 })
    resize(toggle)
    expect(row().style.getPropertyValue('--sky-reserve')).toBe('98px')
    // Next and the mic come: wider.
    place(toggle, { left: 1050, top: 12, width: 144, height: 24 })
    resize(toggle)
    expect(row().style.getPropertyValue('--sky-reserve')).toBe('150px')
    // Nothing to read here: it goes, and the room comes back.
    await act(async () => root.render(withToggle(false)))
    expect(row().style.getPropertyValue('--sky-reserve')).toBe('0px')
    // The pills stay put: the row's right padding, the controls' pill's negative margin.
    expect(row().className).toContain('pr-[var(--sky-reserve,0px)]')
  })
})
