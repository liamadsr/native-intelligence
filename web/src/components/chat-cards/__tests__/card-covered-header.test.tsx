// @vitest-environment jsdom
/**
 * A page covered by what opens over it (../card-covered.tsx) puts nothing in
 * its card's header: its controls and its breadcrumb step aside for the
 * overlay's own, and come back when it is uncovered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { CardCovered } from '../card-covered'
import { CardHeaderSlot, CardHeaderSlotsProvider, CardHeaderTrail } from '../card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let right: HTMLDivElement
let trail: HTMLDivElement
let root: Root
const setBack = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  right = document.createElement('div')
  trail = document.createElement('div')
  document.body.append(right, trail, container)
  root = createRoot(container)
  setBack.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  trail.remove()
})

function render(covered: boolean) {
  act(() => {
    root.render(
      h(
        CardHeaderSlotsProvider,
        { value: { left: null, right, trail, setBack } },
        h(
          CardCovered,
          { covered },
          h(CardHeaderSlot, { side: 'right' }, h('button', { type: 'button' }, 'New table')),
          h(CardHeaderTrail, { onBack: () => {}, backLabel: 'Back to tables' }, h('span', null, 'Sales')),
        ),
      ),
    )
  })
}

describe('a covered page and its card’s header', () => {
  it('draws its controls and breadcrumb while uncovered, nothing while covered', () => {
    render(false)
    expect(right.textContent).toBe('New table')
    expect(trail.textContent).toBe('Sales')
    expect(setBack).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Back to tables' }))

    render(true)
    expect(right.textContent).toBe('')
    expect(trail.textContent).toBe('')
    // Its way back is taken off the title too.
    expect(setBack).toHaveBeenLastCalledWith(null)

    render(false)
    expect(right.textContent).toBe('New table')
    expect(trail.textContent).toBe('Sales')
  })
})
