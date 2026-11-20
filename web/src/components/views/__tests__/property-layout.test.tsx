// @vitest-environment jsdom
/**
 * The properties panel's frame (docs/plans/properties-panels.md): core rows,
 * the optional properties that are set as rows, the ones that aren't as chips
 * in one strip. What is worth pinning:
 *
 *  - an optional property is ALWAYS rendered, set or not: the strip hides
 *    nothing, a chip is the field's own trigger;
 *  - it is the same element in the same place when its value arrives, so a
 *    picker open at that moment (and anything typed into it) survives;
 *  - set and empty are told apart on the element, for the CSS that places them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OptionalProperty, PropertyRow, PropertyRows } from '../property-layout'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** A field with a draft of its own: an input that would lose its text on a remount. */
function Estimate({ value, onPick }: { value: number | null; onPick: () => void }) {
  return (
    <div>
      <button onClick={onPick}>{value != null ? `${value} pts` : 'Estimate'}</button>
      <input aria-label="draft" defaultValue="" />
    </div>
  )
}

function Panel() {
  const [estimate, setEstimate] = useState<number | null>(null)
  return (
    <PropertyRows>
      <PropertyRow>
        <button>Todo</button>
      </PropertyRow>
      <OptionalProperty set={estimate != null}>
        <Estimate value={estimate} onPick={() => setEstimate(3)} />
      </OptionalProperty>
      <OptionalProperty set={false}>
        <button>Add label</button>
      </OptionalProperty>
    </PropertyRows>
  )
}

const states = () => [...container.querySelectorAll('[data-optional-property]')].map((el) => el.getAttribute('data-optional-property'))

describe('PropertyRows / OptionalProperty', () => {
  it('renders every optional property, set or not', async () => {
    await act(async () => root.render(<Panel />))
    expect(container.querySelector('[data-property-rows]')).not.toBeNull()
    expect(states()).toEqual(['empty', 'empty'])
    // Nothing is hidden: the empty ones are there to click.
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Todo', 'Estimate', 'Add label'])
  })

  it('keeps the field mounted when its value arrives (an open picker and its draft survive)', async () => {
    await act(async () => root.render(<Panel />))
    const draft = container.querySelector('input[aria-label="draft"]') as HTMLInputElement
    draft.value = 'half typed'
    const slot = container.querySelector('[data-optional-property]') as HTMLElement
    await act(async () => (slot.querySelector('button') as HTMLButtonElement).click())
    expect(states()).toEqual(['set', 'empty'])
    // The same DOM nodes, moved by CSS order only.
    expect(container.querySelector('[data-optional-property]')).toBe(slot)
    expect(container.querySelector('input[aria-label="draft"]')).toBe(draft)
    expect(draft.value).toBe('half typed')
    expect(slot.textContent).toContain('3 pts')
  })

  it('orders core rows, then set rows, then the add strip', async () => {
    await act(async () => root.render(<Panel />))
    const [estimate, label] = [...container.querySelectorAll<HTMLElement>('[data-optional-property]')]
    const core = container.querySelector('[data-property-rows] > div') as HTMLElement
    expect(core.className).toContain('order-1')
    expect(estimate.className).toContain('order-3')
    await act(async () => (estimate.querySelector('button') as HTMLButtonElement).click())
    expect(estimate.className).toContain('order-2')
    expect(estimate.className).toContain('w-full')
    expect(label.className).toContain('order-3')
  })

  it("says which inset the panel's rows use, for the chips to match", async () => {
    await act(async () => root.render(<PropertyRows inset="px-3"><PropertyRow>x</PropertyRow></PropertyRows>))
    expect(container.querySelector('[data-property-rows]')?.getAttribute('data-inset')).toBe('px-3')
  })
})
