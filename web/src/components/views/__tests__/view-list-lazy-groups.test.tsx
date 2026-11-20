// @vitest-environment jsdom
/**
 * A grouped action list's finished groups (lib/views/lazy-done-groups.ts):
 * collapsed at the bottom with the server's count, loaded only when expanded,
 * and an open group untouched by it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../list/entity-row', async () => {
  const { createElement: e } = await import('react')
  return {
    EntityRow: ({ item }: { item: Record<string, unknown> }) => e('div', { 'data-row': item.id as string }, item.title as string),
    getTitle: (_e: unknown, item: Record<string, unknown>) => (item.title as string) || 'Untitled',
  }
})

class IOStub {
  constructor(_cb: unknown, _opts?: unknown) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IOStub

import { ViewList } from '../view-list'
import { defaultConfig, type ViewConfig } from '../hooks/use-view'
import type { GroupedResults } from '@/lib/views/types'

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-a' }))

const config: ViewConfig = { ...defaultConfig('action'), grouping: { field: 'status_id', direction: 'asc' } }

const todo: GroupedResults = { key: 'unstarted', label: 'Todo', items: [{ id: 't-1', title: 'Open one' }] }
const done = (items: Array<Record<string, unknown>> = []): GroupedResults => ({
  key: 'completed', label: 'Done', items, metadata: { lazy: true, count: 312, status_ids: ['s-done'] },
})

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

function render(data: GroupedResults[], props: Record<string, unknown> = {}) {
  act(() => {
    root.render(h(ViewList, { entityType: 'action', data, loading: false, config, selectedItemId: null, onItemSelect: () => {}, ...props }))
  })
}
const header = () => container.querySelector<HTMLButtonElement>('[data-lazy-group="completed"]')!

describe('a finished group in a grouped list', () => {
  it('starts collapsed with the server count, and loads nothing until expanded', () => {
    const onLoadGroup = vi.fn()
    render([todo, done()], { onLoadGroup, groupLoadState: {} })
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().textContent).toContain('Done')
    expect(header().textContent).toContain('312')
    expect(onLoadGroup).not.toHaveBeenCalled()
    // The open group is shown as always.
    expect(container.querySelector('[data-row="t-1"]')).not.toBeNull()
  })

  it('expanding loads its first page, once', () => {
    const onLoadGroup = vi.fn()
    render([todo, done()], { onLoadGroup, groupLoadState: {} })
    act(() => header().click())
    expect(onLoadGroup).toHaveBeenCalledTimes(1)
    expect(onLoadGroup).toHaveBeenCalledWith('completed')
    expect(container.querySelector('[data-lazy-group-loading]')).not.toBeNull()
    // Loading: not asked again.
    render([todo, done()], { onLoadGroup, groupLoadState: { completed: { loading: true, hasMore: true, loaded: false } } })
    expect(onLoadGroup).toHaveBeenCalledTimes(1)
  })

  it('shows its loaded rows, the count still the server\'s, and the open rows kept', () => {
    const onLoadGroup = vi.fn()
    render([todo, done()], { onLoadGroup, groupLoadState: {} })
    act(() => header().click())
    render([todo, done([{ id: 'd-1', title: 'Finished one' }])], {
      onLoadGroup, groupLoadState: { completed: { loading: false, hasMore: true, loaded: true } },
    })
    expect(container.querySelector('[data-row="d-1"]')).not.toBeNull()
    expect(container.querySelector('[data-row="t-1"]')).not.toBeNull()
    expect(header().textContent).toContain('312')
    expect(container.textContent).toContain('Show more (311)')
  })

  it('without a loader (any other caller), a group is drawn as before', () => {
    render([todo, done()])
    expect(container.querySelector('[data-lazy-group]')).toBeNull()
  })
})
