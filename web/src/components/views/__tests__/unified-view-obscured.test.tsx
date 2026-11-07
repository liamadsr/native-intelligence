// @vitest-environment jsdom
/**
 * `obscured` containment for UnifiedViewLayout.
 *
 * A detail panel is now an OVERLAY layered over the list rather than a sibling
 * branch that unmounts it — that's what preserves scroll offset, pagination,
 * scope tabs, board draft resolution, realtime subscriptions and the reported
 * visible-item order across a detail open/close.
 *
 * The whole point is that the list keeps LIVING while covered, so these tests
 * pin the two halves of that contract, which pull in opposite directions:
 *  1. Data listeners keep firing while obscured (a covered list must not go
 *     stale — otherwise closing the detail would show a snapshot from before).
 *  2. Interaction does NOT: the covered subtree is marked inert, so nothing
 *     behind an opaque overlay stays tab-reachable or clickable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const updateItem = vi.fn()
const refetch = vi.fn()
const removeItem = vi.fn()
const moveItemBetweenGroups = vi.fn()

const config = {
  filters: [],
  grouping: null,
  layout: 'list',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

vi.mock('../hooks/use-view', () => ({
  useView: () => ({
    views: [], activeViewId: 'v1', activeView: null, setActiveViewId: vi.fn(),
    createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
  }),
  useViewConfig: () => ({
    config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false,
    saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
  }),
  useViewResults: () => ({
    data: [{ id: 'a1', title: 'One' }],
    loading: false, loadingMore: false, totalCount: 1, hasMore: false,
    loadMore: vi.fn(), refetch, updateItem, moveItemBetweenGroups, removeItem,
  }),
}))

vi.mock('../hooks/use-picker-context', () => ({
  usePickerContext: () => ({ workflowStatesByTeam: {} }),
}))
vi.mock('../hooks/use-flow-status-ids', () => ({ useFlowStatusIds: () => ({}) }))
vi.mock('../hooks/use-bulk-selection', () => ({
  useBulkSelection: () => ({
    selectedIds: new Set<string>(), count: 0, hasSelection: false,
    clear: vi.fn(), toggle: vi.fn(), selectAll: vi.fn(),
  }),
}))
vi.mock('../bulk-actions/use-bulk-actions', () => ({
  useBulkActions: () => ({ execute: vi.fn() }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws1',
  useCurrentMemberId: () => 'm1',
}))

// A focusable stand-in for the real list/toolbar, so the inert assertion is
// about something a user could actually tab into.
vi.mock('../view-toolbar', () => ({
  ViewToolbar: () => h('button', { type: 'button', 'data-testid': 'toolbar-button' }, 'Filter'),
}))
vi.mock('../view-list', () => ({
  ViewList: () => h('button', { type: 'button', 'data-testid': 'row-button' }, 'Row'),
}))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'

let container: HTMLDivElement
let root: Root

function render(node: React.ReactElement) {
  act(() => { root.render(node) })
}

beforeEach(() => {
  vi.useFakeTimers()
  updateItem.mockClear(); refetch.mockClear(); removeItem.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const layout = (obscured: boolean) =>
  h(UnifiedViewLayout, { entityType: 'action' as const, obscured })

describe('UnifiedViewLayout obscured containment', () => {
  it('marks the whole subtree inert + aria-hidden while a detail overlay covers it', () => {
    render(layout(true))

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.hasAttribute('inert')).toBe(true)
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
  })

  it('leaves the subtree fully interactive when nothing covers it', () => {
    render(layout(false))

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.hasAttribute('inert')).toBe(false)
    expect(wrapper.hasAttribute('aria-hidden')).toBe(false)
  })

  it('keeps the list MOUNTED while obscured — covering is not unmounting', () => {
    render(layout(false))
    render(layout(true))

    // The rows and toolbar are still in the DOM; only reachability changed. If
    // this ever regresses to a mount-exclusive branch, scroll/pagination/board
    // state dies on every detail open and this assertion is the tripwire.
    expect(container.querySelector('[data-testid="row-button"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="toolbar-button"]')).not.toBeNull()
  })

  it('keeps applying realtime entity updates while obscured — a covered list must not go stale', () => {
    render(layout(true))

    act(() => {
      window.dispatchEvent(
        new CustomEvent('dial8:entity-updated', {
          detail: { entityType: 'action', id: 'a1', fields: { title: 'Renamed' } },
        }),
      )
    })
    act(() => vi.advanceTimersByTime(350))

    expect(updateItem).toHaveBeenCalled()
  })

  it('still refetches on realtime reconnect while obscured', () => {
    render(layout(true))

    act(() => { window.dispatchEvent(new CustomEvent('dial8:realtime-recovered')) })

    expect(refetch).toHaveBeenCalled()
  })
})
