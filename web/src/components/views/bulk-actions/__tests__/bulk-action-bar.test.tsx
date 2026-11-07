// @vitest-environment jsdom
/**
 * The selection island's face (Liam, 2026-09-06: "make it a floating
 * component, just like how Linear does this … following the same standard we
 * follow with our pill shaped buttons").
 *
 * What is pinned: the count sits in the FILLED pill with the clear × inside
 * it; Select all appears only while some visible rows are unchecked and
 * selects exactly the visible ids; and the whole thing is one rounded-full
 * slab, not a strip. A host page's own verbs are NOT this component's — the
 * layout floats them in a second island above it (see the layout's island
 * test). The command dialog behind Actions is closed here and left to the
 * layout tests that exercise `skipConfirmActionIds`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaces: () => ({ workspaces: [{ id: 'ws1' }] }),
}))

import { BulkActionBar } from '../bulk-action-bar'

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

const island = () => container.querySelector('[data-bulk-action-island]') as HTMLElement | null
const buttons = () => Array.from(container.querySelectorAll('button'))
const button = (label: string) => buttons().find((b) => (b.textContent ?? '').trim().startsWith(label))

function render(props: Partial<Parameters<typeof BulkActionBar>[0]> = {}) {
  const onClear = vi.fn()
  const onAction = vi.fn()
  const onSelectAll = vi.fn()
  act(() => {
    root.render(
      h(BulkActionBar, {
        entityType: 'action',
        selectedCount: 3,
        onClear,
        onAction,
        allVisibleIds: ['a', 'b', 'c', 'd', 'e'],
        onSelectAll,
        ...props,
      }),
    )
  })
  return { onClear, onAction, onSelectAll }
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('BulkActionBar — the selection island', () => {
  it('draws nothing with nothing selected', () => {
    render({ selectedCount: 0 })
    expect(island()).toBeNull()
  })

  it('is one rounded-full slab holding the count in the filled pill, with the clear × inside it', () => {
    const { onClear } = render()
    const slab = island()!
    expect(slab.getAttribute('role')).toBe('toolbar')
    expect(slab.className).toContain('rounded-full')
    expect(slab.className).toContain('backdrop-blur')

    const count = slab.querySelector('.bg-foreground') as HTMLElement
    expect(count.textContent).toContain('3 selected')
    const clear = count.querySelector('button[aria-label="Clear selection"]')!
    expect(clear).toBeTruthy()
    click(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('offers Select all only while some visible rows are unchecked, and selects exactly those', () => {
    const { onSelectAll } = render()
    click(button('Select all (5)')!)
    expect(onSelectAll).toHaveBeenCalledWith(['a', 'b', 'c', 'd', 'e'])

    render({ selectedCount: 5 })
    expect(button('Select all')).toBeUndefined()
  })

  it('offers Actions for an entity with bulk actions — as a pill, in the island', () => {
    render()
    const actions = button('Actions')!
    expect(actions.className).toContain('rounded-full')
    expect(island()!.contains(actions)).toBe(true)
  })
})
