// @vitest-environment jsdom
/**
 * "Add to sequence" from a contact row reaches only the FOCUSED contact list:
 * a chat card and the real CRM page can both be mounted, and the event is
 * window-wide, so an unfocused copy answering too would open a second dialog.
 * (Harness borrowed from unified-view-obscured.test.tsx.)
 *
 * Was: `obscured` containment for UnifiedViewLayout.
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

vi.mock('@/components/sequences/add-to-sequence-dialog', () => ({
  ADD_TO_SEQUENCE_EVENT: 'ni:add-to-sequence',
  AddToSequenceDialog: (props: { contactIds: string[] }) => h('div', { 'data-sequence-dialog': props.contactIds.join(',') }),
}))

import { UnifiedViewLayout } from '../unified-view-layout'
import { stubAppFetch } from '@/test/app-fetch-stub'
import { WindowFocusProvider } from '../tab-active'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // The layout reads /api/account/workspace on mount. Refused at once, as the
  // real fetch refused it only later, it cannot outlive the test
  // (src/test/app-fetch-stub.ts says why).
  stubAppFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('UnifiedViewLayout add to sequence', () => {
  it('opens one dialog, in the focused contact list only', () => {
    act(() => {
      root.render(
        h('div', null,
          h(WindowFocusProvider, { isFocused: true, children: h('div', { 'data-list': 'page' }, h(UnifiedViewLayout, { entityType: 'contact' as const })) }),
          h(WindowFocusProvider, { isFocused: false, children: h('div', { 'data-list': 'card' }, h(UnifiedViewLayout, { entityType: 'contact' as const })) }),
        ),
      )
    })
    act(() => {
      window.dispatchEvent(new CustomEvent('ni:add-to-sequence', { detail: { contactIds: ['c1'] } }))
    })
    expect(container.querySelectorAll('[data-sequence-dialog="c1"]')).toHaveLength(1)
    expect(container.querySelector('[data-list="page"] [data-sequence-dialog]')).not.toBeNull()
    expect(container.querySelector('[data-list="card"] [data-sequence-dialog]')).toBeNull()
  })
})
