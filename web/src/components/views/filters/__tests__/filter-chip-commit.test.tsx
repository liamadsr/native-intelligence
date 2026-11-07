// @vitest-environment jsdom
/**
 * WHEN A FILTER CHIP TURNS TYPING INTO A QUERY.
 *
 * The class of bug guarded here is "every keystroke is a round trip". A
 * committed filter is a query; on the knowledge map it is a new server-side
 * cache key and therefore a re-tile of the whole map, so an unbuffered chip
 * turns typing one word into roughly one whole-map pass per character. The
 * cure has its own failure modes, and each of them is a test below:
 *
 *   - buffering a SELECTION (a checkbox, an entity row, a calendar day) puts
 *     300 ms of lag on a click that was already deliberate;
 *   - buffering the callback but not the VALUE breaks the range editors, which
 *     merge into the value they were handed — the second field would spread a
 *     range the first field's edit never reached;
 *   - a buffer that survives a view switch lands the previous view's half-typed
 *     word on the new one 300 ms later;
 *   - a timer that survives unmount commits a filter after its chip is gone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewFilter } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// cmdk (the enum picker's Command list) needs both of these; jsdom has neither.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}
}

import { FilterChip, FILTER_COMMIT_DEBOUNCE_MS } from '../filter-chip'

let container: HTMLDivElement
let root: Root
let onUpdate: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  onUpdate = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function makeFilter(over: Partial<ViewFilter> = {}): ViewFilter {
  return { id: 'f1', field: 'text', operator: 'contains', value: '', ...over }
}

function render(filter: ViewFilter) {
  act(() => {
    root.render(h(FilterChip, { filter, entityType: 'claim', onUpdate, onRemove: vi.fn() }))
  })
}

function input(): HTMLInputElement {
  const el = container.querySelector('input')
  if (!el) throw new Error('chip rendered no input')
  return el
}

// Assigning `el.value` directly goes through the value tracker React installs
// on the instance, so React concludes nothing changed and never fires onChange.
// The prototype setter is the way past it.
const setInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!

/** One keystroke, the way React hears it: the DOM value is already the new
 *  text by the time the event fires. */
function type(el: HTMLInputElement, text: string) {
  act(() => {
    setInputValue.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('a typed value is committed once, at rest', () => {
  it('commits ONE filter for a word typed a character at a time', () => {
    render(makeFilter())
    const el = input()

    for (const text of ['r', 're', 'rev', 'reve', 'reven', 'revenu', 'revenue']) type(el, text)

    // Still nothing upstream — seven keystrokes, seven cancelled timers.
    expect(onUpdate).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(FILTER_COMMIT_DEBOUNCE_MS) })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ field: 'text', value: 'revenue' })
  })

  it('shows what was typed while the commit is still pending', () => {
    render(makeFilter())
    type(input(), 'rev')

    // The buffer is fed back INTO the picker, so the box never lags the typing
    // even though the query does.
    expect(input().value).toBe('rev')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('commits immediately on blur rather than making the user wait out the timer', () => {
    render(makeFilter())
    const el = input()
    type(el, 'rev')

    act(() => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ value: 'rev' })

    // And the flush cancelled the timer — it must not fire a second time.
    act(() => { vi.advanceTimersByTime(FILTER_COMMIT_DEBOUNCE_MS) })
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('commits immediately on Enter', () => {
    render(makeFilter())
    const el = input()
    type(el, 'rev')

    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ value: 'rev' })
  })
})

describe('a selection is committed the moment it is made', () => {
  it('does not delay a boolean toggle — a click is already a deliberate commit', () => {
    render(makeFilter({ field: 'auto_accepted', operator: 'is', value: true }))

    const toggle = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yes')
    expect(toggle).toBeTruthy()
    act(() => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // No timer advanced.
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ field: 'auto_accepted', value: false })
  })
})

describe('a buffered value never outlives what it was typed into', () => {
  it('drops the draft when the value changes from outside (switching saved views)', () => {
    const first = makeFilter({ value: '' })
    render(first)
    type(input(), 'rev')

    // Another saved view is picked: same chip position, different filter value.
    render(makeFilter({ id: 'f2', value: 'pricing' }))

    expect(input().value).toBe('pricing')

    act(() => { vi.advanceTimersByTime(FILTER_COMMIT_DEBOUNCE_MS * 2) })

    // The stale draft must not land on the view the user just switched TO.
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('keeps the draft when the re-render carries the same value in a new object', () => {
    render(makeFilter())
    type(input(), 'rev')

    // Consumers rebuild the filter array on every change, so a chip is
    // routinely handed a COPY of the filter it already has. That is not an
    // external change and must not wipe what is being typed.
    render(makeFilter())

    expect(input().value).toBe('rev')
    act(() => { vi.advanceTimersByTime(FILTER_COMMIT_DEBOUNCE_MS) })
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending commit on unmount', () => {
    render(makeFilter())
    type(input(), 'rev')

    act(() => { root.unmount() })
    act(() => { vi.advanceTimersByTime(FILTER_COMMIT_DEBOUNCE_MS * 2) })

    expect(onUpdate).not.toHaveBeenCalled()

    // The afterEach unmount would otherwise run against a dead root.
    root = createRoot(container)
  })
})

describe('the range editor sees its own uncommitted half', () => {
  it('keeps `from` when `to` is typed before the first commit lands', () => {
    render(makeFilter({ field: 'confidence', operator: 'between', value: '' }))
    const [from, to] = Array.from(container.querySelectorAll('input'))

    type(from, '50')
    type(to, '90')

    act(() => { vi.advanceTimersByTime(FILTER_COMMIT_DEBOUNCE_MS) })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    // Percent in, fraction out — see filter-percent-unit.test.ts.
    expect(onUpdate.mock.calls[0][0].value).toEqual({ from: 0.5, to: 0.9 })
  })
})
