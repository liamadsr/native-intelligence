// @vitest-environment jsdom
/**
 * A typed optional property (a contact's job title, a company's website): a
 * chip in the add strip while empty, the input row once it has a value or the
 * focus. Pinned: the chip opens the input FOCUSED (one click, then type, as
 * the bare input was), the row commits on blur as TextPropertyRow does, and an
 * input left empty goes back to a chip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OptionalTextProperty } from '../optional-text-property'

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

function Field({ initial, onCommit }: { initial: string | null; onCommit: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <OptionalTextProperty
      icon={<svg data-icon="" />}
      value={value}
      onChange={setValue}
      onCommit={onCommit}
      placeholder="Job title"
    />
  )
}

const slot = () => container.querySelector('[data-optional-property]') as HTMLElement
const input = () => container.querySelector('input') as HTMLInputElement | null

function type(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  return act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('OptionalTextProperty', () => {
  it('is a chip named for the field while empty', async () => {
    await act(async () => root.render(<Field initial={null} onCommit={vi.fn()} />))
    expect(slot().getAttribute('data-optional-property')).toBe('empty')
    expect(input()).toBeNull()
    expect(container.querySelector('[data-add-text-property]')?.textContent).toBe('Job title')
  })

  it('is the input row when it has a value', async () => {
    await act(async () => root.render(<Field initial="Head of Operations" onCommit={vi.fn()} />))
    expect(slot().getAttribute('data-optional-property')).toBe('set')
    expect(input()?.value).toBe('Head of Operations')
    expect(container.querySelector('[data-add-text-property]')).toBeNull()
  })

  it('opens focused from the chip, commits on blur, and stays a row', async () => {
    const onCommit = vi.fn()
    await act(async () => root.render(<Field initial={null} onCommit={onCommit} />))
    await act(async () => (container.querySelector('[data-add-text-property]') as HTMLButtonElement).click())
    expect(slot().getAttribute('data-optional-property')).toBe('set')
    expect(document.activeElement).toBe(input())
    await type(input()!, 'Buyer')
    await act(async () => input()!.blur())
    expect(onCommit).toHaveBeenCalledWith('Buyer')
    expect(slot().getAttribute('data-optional-property')).toBe('set')
    expect(input()?.value).toBe('Buyer')
  })

  it('goes back to a chip when left empty', async () => {
    const onCommit = vi.fn()
    await act(async () => root.render(<Field initial={null} onCommit={onCommit} />))
    await act(async () => (container.querySelector('[data-add-text-property]') as HTMLButtonElement).click())
    await act(async () => input()!.blur())
    expect(onCommit).toHaveBeenCalledWith('')
    expect(slot().getAttribute('data-optional-property')).toBe('empty')
    expect(input()).toBeNull()
  })
})
