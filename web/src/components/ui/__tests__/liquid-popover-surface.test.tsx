// @vitest-environment jsdom
import { act, createElement as h, forwardRef, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiquidPopoverSurface } from '../liquid-popover-surface'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('liquid-gooey', () => ({
  Liquid: Object.assign(
    forwardRef<HTMLDivElement, Record<string, unknown>>(function Liquid(props, ref) {
      const { blur: _b, contrast: _c, fill: _f, shadow: _s, filterPadding: _p, children, ...rest } = props
      return h('div', { ...rest, ref }, children as ReactNode)
    }),
    {
      Item: ({ x = 0, y = 0, scale = 1, children }: { x?: number; y?: number; scale?: number; children?: ReactNode }) =>
        h('div', { 'data-x': x, 'data-y': y, 'data-scale': scale }, children),
    },
  ),
}))

let container: HTMLDivElement
let root: Root
let notifyPlacement: () => void
let notifyResize: () => void
let height: number
let frameId: number
let frames: Map<number, FrameRequestCallback>
let originsWhenScheduled: Array<{ x: number; y: number }>

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect

function Fixture({ placed = false }: { placed?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={triggerRef}>Properties</button>
    <div data-radix-popper-content-wrapper="" style={{ transform: placed ? 'translate(308px, 134px)' : 'translate(0px, -200%)' }}>
      <LiquidPopoverSurface triggerRef={triggerRef} triggerIcon="icon"><div>Fields</div></LiquidPopoverSurface>
    </div>
  </>
}

function card() {
  return container.querySelector<HTMLElement>('[data-bot-obstacle]')!.parentElement!
}

function collapsedPoint() {
  // The library scales around the item's centre. At scale zero this is the
  // actual visible starting point, which must land in the header button.
  return { x: 308 + 320 / 2 + Number(card().dataset.x), y: 134 + height / 2 + Number(card().dataset.y) }
}

function flushFrame() {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(16))
}

beforeEach(() => {
  height = 440
  frameId = 0
  frames = new Map()
  originsWhenScheduled = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'BUTTON' ? rect(600, 100, 28, 28) : rect(308, 134, 320, height + 6.5)
  })
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { notifyPlacement = callback }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize = callback }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    originsWhenScheduled.push(collapsedPoint())
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the properties liquid pour', () => {
  it('commits a collapsed card at the icon before scheduling any reveal', () => {
    act(() => root.render(<Fixture placed />))
    expect(originsWhenScheduled).toEqual([{ x: 614, y: 114 }])
    expect(card().dataset.scale).toBe('0')
    act(flushFrame)
    expect(card().dataset).toMatchObject({ x: '0', y: '0', scale: '1' })
  })

  it('waits for portal placement and restored fields, then parks using their actual height', () => {
    height = 0
    act(() => root.render(<Fixture />))
    expect(frames.size).toBe(0)
    act(() => {
      container.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')!.style.transform = 'translate(308px, 134px)'
      notifyPlacement()
    })
    expect(frames.size).toBe(0)
    act(() => { height = 500; notifyResize() })
    expect(originsWhenScheduled).toEqual([{ x: 614, y: 114 }])

    // A size change before paint must re-park the invisible card rather than
    // let its new centre become the start of a centre-out zoom.
    act(() => { height = 600; notifyResize() })
    expect(collapsedPoint()).toEqual({ x: 614, y: 114 })
    expect(frames.size).toBe(1)
    act(flushFrame)
    expect(card().dataset.scale).toBe('1')
  })

  it('cancels the reveal when the panel is dismissed before the first frame', () => {
    act(() => root.render(<Fixture placed />))
    expect(frames.size).toBe(1)
    act(() => root.render(null))
    expect(frames.size).toBe(0)
  })
})
