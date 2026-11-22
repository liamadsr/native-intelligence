// @vitest-environment jsdom
/**
 * The header island's layout switcher (../view-layout-switcher.tsx; Liam,
 * 11-21: the layouts "kinda hidden" in the settings popover, moved to the
 * island, one icon each) and the layouts each kind offers (../view-layouts.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { ViewLayoutSwitcher } from '../view-layout-switcher'
import { layoutOptions } from '../view-layouts'

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

describe('layoutOptions', () => {
  it('offers List and Board, the Roadmap where there are dates, the Graph where the page draws one', () => {
    expect(layoutOptions('action').map((o) => o.value)).toEqual(['list', 'board', 'roadmap'])
    expect(layoutOptions('contact').map((o) => o.value)).toEqual(['list', 'board'])
    expect(layoutOptions('claim', true).map((o) => o.value)).toEqual(['graph', 'list', 'board'])
    expect(layoutOptions('data_row').map((o) => o.value)).toEqual(['grid', 'board', 'calendar', 'gallery'])
    // The library keeps its one row layout.
    expect(layoutOptions('agent')).toEqual([])
  })
})

describe('ViewLayoutSwitcher', () => {
  it('draws one icon per layout, named, the one in use lifted, and picks another', async () => {
    const onChange = vi.fn()
    await act(async () => root.render(h(ViewLayoutSwitcher, { options: layoutOptions('action'), value: 'list', onChange })))
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-layout-option]'))
    expect(items.map((b) => b.getAttribute('aria-label'))).toEqual(['List', 'Board', 'Roadmap'])
    // Icons only: no text in the segments.
    expect(items.every((b) => b.textContent === '')).toBe(true)
    expect(items.map((b) => b.getAttribute('data-state'))).toEqual(['on', 'off', 'off'])
    await act(async () => items[2].click())
    expect(onChange).toHaveBeenCalledWith('roadmap')
  })

  it('draws nothing with fewer than two layouts to pick from', async () => {
    await act(async () => root.render(h(ViewLayoutSwitcher, { options: layoutOptions('agent'), value: 'list', onChange: () => {} })))
    expect(container.querySelector('[data-view-layout-switcher]')).toBeNull()
  })
})
