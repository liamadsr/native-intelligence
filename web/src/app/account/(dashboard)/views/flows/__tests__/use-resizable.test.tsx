// @vitest-environment jsdom
/**
 * useResizable is COMMIT-ON-RELEASE (2026-08 resize sweep): dragging the flow
 * editor's handles used to setState + write localStorage on EVERY pointermove
 * frame, re-rendering the ~1,400-line FlowCanvasEditor per frame. Pins the
 * contract the perf work depends on:
 *  - a drag paints the panel element directly (rAF-coalesced) and renders /
 *    persists NOTHING until pointerup;
 *  - pointerup commits exactly one render and one localStorage write;
 *  - min/max clamping is unchanged, on the live DOM value as well as the commit;
 *  - a re-render mid-drag keeps rendering the DRAGGED size, never snapping back
 *    to the committed one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { useResizable } from '../use-resizable'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STORAGE_KEY = 'ni:test:resizable'

interface Harness {
  /** The element the hook paints (the resize handle's parent). */
  panel: HTMLElement
  handle: HTMLElement
  /** Committed size as React last rendered it. */
  rendered: () => number
  renderCount: () => number
  rerender: () => void
  unmount: () => void
}

/**
 * Mirrors the editor's markup: a sized panel with the handle as a DIRECT child
 * (the hook resolves its paint target through parentElement).
 */
function mount(opts: {
  axis: 'x-left' | 'y-top'
  defaultSize?: number
  min?: number
  max?: number
}): Harness {
  const axis = opts.axis
  const prop = axis === 'x-left' ? 'width' : 'height'
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  let renders = 0
  let lastSize = 0

  function Panel() {
    const r = useResizable({
      storageKey: STORAGE_KEY,
      defaultSize: opts.defaultSize ?? 300,
      min: opts.min ?? 100,
      max: opts.max ?? 500,
      axis,
    })
    renders += 1
    lastSize = r.size
    return h(
      'div',
      { 'data-panel': '', style: { [prop]: `${r.size}px` } },
      h('div', { 'data-handle': '', onPointerDown: r.startResize }),
    )
  }

  act(() => {
    root.render(h(Panel))
  })

  const panel = container.querySelector('[data-panel]') as HTMLElement
  const handle = container.querySelector('[data-handle]') as HTMLElement
  return {
    panel,
    handle,
    rendered: () => lastSize,
    renderCount: () => renders,
    rerender: () => {
      act(() => {
        root.render(h(Panel))
      })
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function pointerDown(el: HTMLElement, coords: { clientX?: number; clientY?: number }) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, ...coords }),
    )
  })
}

function pointerMove(coords: { clientX?: number; clientY?: number }) {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, ...coords }))
  })
}

function pointerUp() {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
}

/** Run the rAF paint the drag scheduled. */
function flushFrame() {
  act(() => {
    vi.advanceTimersByTime(32)
  })
}

let setItem: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  setItem = vi.spyOn(Storage.prototype, 'setItem')
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

afterEach(() => {
  setItem.mockRestore()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('useResizable — commit-on-release', () => {
  it('paints the panel during the drag without rendering or persisting', () => {
    const hk = mount({ axis: 'y-top', defaultSize: 300 })
    const rendersBefore = hk.renderCount()

    pointerDown(hk.handle, { clientY: 500 })
    // Dragging the top handle UP grows the drawer.
    pointerMove({ clientY: 450 })
    flushFrame()

    expect(hk.panel.style.height).toBe('350px')
    expect(hk.renderCount()).toBe(rendersBefore)
    expect(setItem).not.toHaveBeenCalled()

    pointerMove({ clientY: 400 })
    flushFrame()
    expect(hk.panel.style.height).toBe('400px')
    expect(hk.renderCount()).toBe(rendersBefore)
    expect(setItem).not.toHaveBeenCalled()

    hk.unmount()
  })

  it('coalesces many moves in one frame into a single latest-wins paint', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300 })
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')

    pointerDown(hk.handle, { clientX: 800 })
    pointerMove({ clientX: 790 })
    pointerMove({ clientX: 780 })
    pointerMove({ clientX: 770 })
    // Nothing painted yet — the frame has not run.
    expect(hk.panel.style.width).toBe('300px')
    expect(rafSpy).toHaveBeenCalledTimes(1)

    flushFrame()
    expect(hk.panel.style.width).toBe('330px') // the LAST move wins

    rafSpy.mockRestore()
    hk.unmount()
  })

  it('commits state + exactly one localStorage write on release', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300 })
    const rendersBefore = hk.renderCount()

    pointerDown(hk.handle, { clientX: 800 })
    pointerMove({ clientX: 700 })
    flushFrame()
    expect(setItem).not.toHaveBeenCalled()

    pointerUp()

    expect(hk.rendered()).toBe(400)
    expect(hk.panel.style.width).toBe('400px')
    expect(hk.renderCount()).toBeGreaterThan(rendersBefore)
    const writes = setItem.mock.calls.filter((c) => c[0] === STORAGE_KEY)
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toBe('400')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('400')

    hk.unmount()
  })

  it('clamps to max during the drag and on the committed value', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300, min: 100, max: 500 })

    pointerDown(hk.handle, { clientX: 800 })
    pointerMove({ clientX: 200 }) // +600 → clamped to 500
    flushFrame()
    expect(hk.panel.style.width).toBe('500px')

    pointerUp()
    expect(hk.rendered()).toBe(500)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('500')

    hk.unmount()
  })

  it('clamps to min during the drag and on the committed value', () => {
    const hk = mount({ axis: 'y-top', defaultSize: 300, min: 120, max: 600 })

    pointerDown(hk.handle, { clientY: 500 })
    pointerMove({ clientY: 900 }) // -400 → clamped to 120
    flushFrame()
    expect(hk.panel.style.height).toBe('120px')

    pointerUp()
    expect(hk.rendered()).toBe(120)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('120')

    hk.unmount()
  })

  it('renders the LIVE size when the editor re-renders mid-drag', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300 })

    pointerDown(hk.handle, { clientX: 800 })
    pointerMove({ clientX: 720 })
    flushFrame()

    // An unrelated state change in the editor re-renders the tree mid-drag.
    hk.rerender()
    expect(hk.rendered()).toBe(380)
    expect(hk.panel.style.width).toBe('380px')

    pointerUp()
    expect(hk.rendered()).toBe(380)

    hk.unmount()
  })

  it('seeds from the clamped persisted value and drags from it', () => {
    localStorage.setItem(STORAGE_KEY, '9999')
    setItem.mockClear()
    const hk = mount({ axis: 'x-left', defaultSize: 300, min: 100, max: 500 })

    // Mount reads storage but must NOT write it back.
    expect(hk.rendered()).toBe(500)
    expect(setItem.mock.calls.filter((c) => c[0] === STORAGE_KEY)).toHaveLength(0)

    // The drag origin is the seeded size, not the default.
    pointerDown(hk.handle, { clientX: 800 })
    pointerMove({ clientX: 850 })
    flushFrame()
    expect(hk.panel.style.width).toBe('450px')

    pointerUp()
    expect(hk.rendered()).toBe(450)

    hk.unmount()
  })

  it('restores the body cursor/user-select and stops listening after release', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300 })

    pointerDown(hk.handle, { clientX: 800 })
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    pointerUp()
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    // A stray move after release must not repaint the panel.
    pointerMove({ clientX: 100 })
    flushFrame()
    expect(hk.panel.style.width).toBe('300px')

    hk.unmount()
  })

  it('commits on pointercancel the same way as pointerup', () => {
    const hk = mount({ axis: 'y-top', defaultSize: 300 })

    pointerDown(hk.handle, { clientY: 500 })
    pointerMove({ clientY: 460 })
    flushFrame()
    act(() => {
      window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
    })

    expect(hk.rendered()).toBe(340)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('340')

    hk.unmount()
  })

  it('unmounting mid-drag tears the drag down without committing', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300 })

    pointerDown(hk.handle, { clientX: 800 })
    pointerMove({ clientX: 700 })
    flushFrame()
    hk.unmount()

    expect(document.body.style.cursor).toBe('')
    // No setState-after-unmount, and no persisted half-drag.
    expect(setItem.mock.calls.filter((c) => c[0] === STORAGE_KEY)).toHaveLength(0)

    // The window listeners are gone: a stray release writes nothing.
    pointerUp()
    expect(setItem.mock.calls.filter((c) => c[0] === STORAGE_KEY)).toHaveLength(0)
  })

  it('a second pointerdown replaces the in-flight drag instead of stacking it', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300 })

    pointerDown(hk.handle, { clientX: 800 })
    pointerMove({ clientX: 750 })
    flushFrame()
    // A pointerup released outside the window never reaches us; the next grab
    // starts from the size the panel is actually showing.
    pointerDown(hk.handle, { clientX: 700 })
    pointerMove({ clientX: 690 })
    flushFrame()
    expect(hk.panel.style.width).toBe('360px')

    pointerUp()
    expect(hk.rendered()).toBe(360)
    expect(setItem.mock.calls.filter((c) => c[0] === STORAGE_KEY)).toHaveLength(1)

    hk.unmount()
  })

  it('ignores non-primary buttons', () => {
    const hk = mount({ axis: 'x-left', defaultSize: 300 })

    act(() => {
      hk.handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 2, clientX: 800 }),
      )
    })
    pointerMove({ clientX: 700 })
    flushFrame()

    expect(hk.panel.style.width).toBe('300px')
    expect(setItem).not.toHaveBeenCalled()

    hk.unmount()
  })
})
