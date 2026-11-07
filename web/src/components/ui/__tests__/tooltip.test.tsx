// @vitest-environment jsdom
/**
 * Tooltips close when the pointer moves off their trigger — including when it
 * leaves the page altogether, where no later pointermove ever arrives (the
 * desktop app's "tooltip stays up until I click" bug). Runs against the real
 * installed Radix, so an upgrade that changes its close behaviour or renames
 * its `tooltip.open` event fails here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Radix's popper measures with ResizeObserver, which jsdom lacks.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Radix opens through a timer even at delayDuration 0.
  vi.useFakeTimers()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= NoopResizeObserver
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function renderTooltip(providerProps: { disableHoverableContent?: boolean } = {}) {
  act(() =>
    root.render(
      <TooltipProvider delayDuration={0} {...providerProps}>
        <Tooltip>
          <TooltipTrigger data-trigger="">Search</TooltipTrigger>
          <TooltipContent>Search · /</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    ),
  )
  return container.querySelector<HTMLElement>('[data-trigger]')!
}

const pointer = (type: string, init: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, pointerType: 'mouse', ...init })

function open(trigger: HTMLElement) {
  act(() => {
    trigger.dispatchEvent(pointer('pointermove'))
  })
  act(() => {
    vi.advanceTimersByTime(1)
  })
  expect(trigger.getAttribute('data-state')).toMatch(/open/)
}

const isOpen = (trigger: HTMLElement) => /open/.test(trigger.getAttribute('data-state') ?? '')

describe('Tooltip', () => {
  /** What a browser sends as the pointer crosses off the trigger: React reads
   *  `pointerout`, Radix's hoverable mode the native `pointerleave`. */
  function leave(trigger: HTMLElement) {
    act(() => {
      trigger.dispatchEvent(pointer('pointerout', { relatedTarget: document.body }))
      trigger.dispatchEvent(pointer('pointerleave', { bubbles: false, relatedTarget: document.body }))
    })
  }

  it('closes on leaving the trigger, with no later move needed', () => {
    const trigger = renderTooltip()
    open(trigger)
    leave(trigger)
    expect(isOpen(trigger)).toBe(false)
  })

  it('(why the default changed) Radix’s hoverable mode stays open when no later move arrives', () => {
    const trigger = renderTooltip({ disableHoverableContent: false })
    open(trigger)
    leave(trigger)
    expect(isOpen(trigger)).toBe(true)
  })

  it('closes when the pointer leaves the page, even if the trigger never saw a leave', () => {
    const trigger = renderTooltip({ disableHoverableContent: false })
    open(trigger)
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    })
    expect(isOpen(trigger)).toBe(false)
  })

  it('closes when the window loses focus', () => {
    const trigger = renderTooltip()
    open(trigger)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(isOpen(trigger)).toBe(false)
  })

  it('stays open while the pointer moves between elements inside the page', () => {
    const trigger = renderTooltip()
    open(trigger)
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(isOpen(trigger)).toBe(true)
  })
})
