// @vitest-environment jsdom
/**
 * usePageColumns: two columns or two tabs, by the page's own laid-out width.
 *
 *   • the first measure is the box's `clientWidth`, taken as the page mounts;
 *   • every later one is the ResizeObserver entry's `contentRect`, never the
 *     on-screen width (getBoundingClientRect), which a glide scales from the
 *     old size to the new one, and the stack scales down for good: a window
 *     snapped narrow mid-glide still reads narrow, and a recessed wide window
 *     still reads wide;
 *   • a zero width (not laid out) changes nothing;
 *   • back to columns takes a little more room than staying in them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { BOT_PAGE_COLUMNS_MIN_PX, usePageColumns } from '../use-page-columns'

/** The page's laid-out width (clientWidth, contentRect) and its width on screen (getBoundingClientRect). */
let boxWidth = 1200
let screenWidth = 1200
let observed: { cb: (entries: Array<{ target: Element; contentRect: { width: number } }>) => void; el: Element | null } | null = null

class StubResizeObserver {
  constructor(cb: (entries: Array<{ target: Element; contentRect: { width: number } }>) => void) {
    observed = { cb, el: null }
  }
  observe(el: Element) {
    if (observed) observed.el = el
  }
  disconnect() {
    observed = null
  }
}

const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const realRect = HTMLElement.prototype.getBoundingClientRect

let container: HTMLDivElement
let root: Root
let seen: boolean[] = []

function Probe() {
  const ref = useRef<HTMLDivElement>(null)
  const columns = usePageColumns(ref)
  seen.push(columns)
  return h('div', { ref, 'data-page': '', 'data-columns': String(columns) })
}

const columns = () => container.querySelector('[data-page]')!.getAttribute('data-columns')
/** The box changes size: the observer reports its content box, the screen whatever the transform draws. */
async function resizeTo(box: number, screen = box) {
  boxWidth = box
  screenWidth = screen
  await act(async () => observed?.cb([{ target: observed.el!, contentRect: { width: box } }]))
}

beforeEach(() => {
  boxWidth = 1200
  screenWidth = 1200
  seen = []
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-page') ? boxWidth : 0
    },
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const width = this.hasAttribute('data-page') ? screenWidth : 0
    return { width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (realClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth)
  HTMLElement.prototype.getBoundingClientRect = realRect
  vi.unstubAllGlobals()
})

describe('usePageColumns', () => {
  it('measures the box as it mounts: a narrow card is tabs from its first commit after the measure', async () => {
    boxWidth = 600
    // Drawn mid-glide at the old, wider size: the screen width is not the page's width.
    screenWidth = 1100
    await act(async () => root.render(h(Probe)))
    expect(columns()).toBe('false')
    // The first render's default, then the measured answer, in the same act (before any paint).
    expect(seen.at(-1)).toBe(false)
  })

  it('a window snapped narrow mid-glide reads narrow: the content box, not the scaled width on screen', async () => {
    await act(async () => root.render(h(Probe)))
    expect(columns()).toBe('true')
    // The box is written at its final 600 px; the glide still draws it 1200 px wide.
    await resizeTo(600, 1200)
    expect(columns()).toBe('false')
  })

  it('a wide window receding in the stack (drawn scaled down) keeps its columns', async () => {
    await act(async () => root.render(h(Probe)))
    // Its box is 1000 px; the stack draws it at 70%.
    await resizeTo(1000, 700)
    expect(columns()).toBe('true')
  })

  it('a zero width (not laid out) changes nothing', async () => {
    await act(async () => root.render(h(Probe)))
    await resizeTo(0)
    expect(columns()).toBe('true')
    await resizeTo(600)
    await resizeTo(0)
    expect(columns()).toBe('false')
  })

  it('back to columns takes a little more room than staying in them', async () => {
    await act(async () => root.render(h(Probe)))
    await resizeTo(BOT_PAGE_COLUMNS_MIN_PX)
    expect(columns()).toBe('true')
    await resizeTo(BOT_PAGE_COLUMNS_MIN_PX - 1)
    expect(columns()).toBe('false')
    await resizeTo(BOT_PAGE_COLUMNS_MIN_PX + 10)
    expect(columns()).toBe('false')
    await resizeTo(BOT_PAGE_COLUMNS_MIN_PX + 40)
    expect(columns()).toBe('true')
  })
})
