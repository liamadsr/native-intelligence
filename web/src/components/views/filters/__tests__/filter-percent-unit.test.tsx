// @vitest-environment jsdom
/**
 * CONFIDENCE IS A PERCENTAGE EVERYWHERE EXCEPT IN THE COLUMN.
 *
 * `claim.confidence` is a REAL in 0..1; every surface that shows it — the row
 * chip, the command palette, the attention card — renders it as "95%". The
 * generic number chip knew neither fact, so it offered a bare box defaulting to
 * `is`, and a user who typed the number the row had just shown them got
 * `confidence is 70` against a column that never exceeds 1: an empty list, from
 * two independent mistakes.
 *
 * The bugs this file guards are both "the units were lost in one direction
 * only": a chip that accepts percents but stores them unchanged, a chip that
 * stores fractions but shows them raw when a saved view re-opens, and a default
 * operator that makes a continuous field ask for exact equality.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { FILTERABLE_FIELDS, OPERATORS_BY_TYPE, type ViewFilter } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import { FilterChip, FILTER_COMMIT_DEBOUNCE_MS } from '../filter-chip'
import { defaultOperatorFor, percentToStored, storedToPercent } from '../field-traits'

const claimField = (name: string) => {
  const def = FILTERABLE_FIELDS.claim.find(f => f.field === name)
  if (!def) throw new Error(`claim has no ${name} field`)
  return def
}

describe('the operator a new chip starts on', () => {
  it('starts confidence on a THRESHOLD, not on exact equality', () => {
    expect(defaultOperatorFor(claimField('confidence'))).toBe('gte')
  })

  it('leaves every other field on its type default', () => {
    // The mechanism is opt-in per field: nothing else may shift under it.
    for (const def of FILTERABLE_FIELDS.claim) {
      if (def.field === 'confidence') continue
      expect(defaultOperatorFor(def)).toBe(OPERATORS_BY_TYPE[def.type][0])
    }
  })

  it('is an operator the chip can actually show for that field', () => {
    // A preference the type does not offer would put the chip in a state its
    // own dropdown cannot render and hand the query engine an unknown pair.
    const def = claimField('confidence')
    expect(OPERATORS_BY_TYPE[def.type]).toContain(defaultOperatorFor(def))
  })
})

describe('percent ↔ fraction round trip', () => {
  it('returns the number the user typed, for every whole percent', () => {
    for (let percent = 0; percent <= 100; percent++) {
      expect(storedToPercent(percentToStored(percent))).toBe(percent)
    }
  })

  it('survives the float error that makes 0.29 × 100 not 29', () => {
    expect(storedToPercent(0.29)).toBe(29)
    expect(storedToPercent(0.07)).toBe(7)
  })

  it('clamps past the 0..100 the input advertises rather than storing 7.0', () => {
    // `max` on a number input is advice a browser does not enforce, and an
    // unclamped 700 lands outside the column's range: a filter that matches
    // nothing and explains nothing.
    expect(percentToStored(700)).toBe(1)
    expect(percentToStored(-5)).toBe(0)
  })
})

describe('the chip, end to end', () => {
  let container: HTMLDivElement
  let root: Root
  let onUpdate: ReturnType<typeof vi.fn>

  const setInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!

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

  function render(filter: ViewFilter) {
    act(() => {
      root.render(h(FilterChip, { filter, entityType: 'claim', onUpdate, onRemove: vi.fn() }))
    })
  }

  const confidence = (value: ViewFilter['value']): ViewFilter =>
    ({ id: 'f1', field: 'confidence', operator: 'gte', value })

  it('stores the 0..1 value the column holds for the percent that was typed', () => {
    render(confidence(''))
    const el = container.querySelector('input')!

    act(() => {
      setInputValue.call(el, '70')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { vi.advanceTimersByTime(FILTER_COMMIT_DEBOUNCE_MS) })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0].value).toBe(0.7)
  })

  it('re-opens a saved view showing the same number the user typed', () => {
    render(confidence(0.7))
    expect(container.querySelector('input')!.value).toBe('70')
  })

  it('says which of the two scales the box is on', () => {
    render(confidence(0.7))
    expect(container.textContent).toContain('%')
  })

  it('leaves a plain number field unitless', () => {
    // `interaction_count` is a count, not a fraction: 12 must stay 12 and the
    // box must not sprout a percent sign.
    act(() => {
      root.render(h(FilterChip, {
        filter: { id: 'f1', field: 'interaction_count', operator: 'gte', value: 12 },
        entityType: 'contact',
        onUpdate,
        onRemove: vi.fn(),
      }))
    })
    expect(container.querySelector('input')!.value).toBe('12')
    expect(container.textContent).not.toContain('%')
  })
})
