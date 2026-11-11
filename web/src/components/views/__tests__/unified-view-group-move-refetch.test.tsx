// @vitest-environment jsdom
/**
 * Group-move fallback coalescing in UnifiedViewLayout's entity-updated listener.
 *
 * Diffed realtime payloads made the board's group-move branch reachable for
 * REMOTE events (pre-diff, every realtime UPDATE carried all FK keys and always
 * took the debounced changedJoinedFk refetch). When a remote group-field change
 * can't be resolved locally — the destination column isn't in this view (e.g. a
 * board that hides Done) or the item is filtered out — the failure fallback must
 * go through the DEBOUNCED scheduleRefetch: a teammate/AI bulk update fans out
 * one UPDATE per row, and N un-coalesced immediate refetches would fire N full
 * view queries back-to-back (a request storm that defeats the refetch-avoidance
 * the diffing exists to deliver).
 *
 * Same harness pattern as unified-view-hidden-tab-sync.test.tsx: the REAL
 * component against the real window event bus, data/picker hooks and view
 * children stubbed, assertions on the mocked useViewResults spies.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Spies shared with the useViewResults mock ────────────────────────────────
const updateItem = vi.fn()
const refetch = vi.fn()
const removeItem = vi.fn()
const moveItemBetweenGroups = vi.fn()

// Board grouped by status — the config shape the group-move branch requires.
const config = {
  filters: [],
  grouping: { field: 'status_id', direction: 'asc' },
  layout: 'board',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

// Mutable holder so each test shapes the grouped data before render.
const state: { data: unknown } = { data: [] }

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
    data: state.data,
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

// Inert view children — the listener lives above rendering; no DOM needed.
vi.mock('../view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('../view-list', () => ({ ViewList: () => null }))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'
import { stubAppFetch } from '@/test/app-fetch-stub'

function dispatch(name: string, detail: unknown) {
  act(() => { window.dispatchEvent(new CustomEvent(name, { detail })) })
}

let container: HTMLDivElement
let root: Root

function render() {
  act(() => { root.render(h(UnifiedViewLayout, { entityType: 'action' as const })) })
}

beforeEach(() => {
  vi.useFakeTimers()
  updateItem.mockClear(); refetch.mockClear(); removeItem.mockClear()
  moveItemBetweenGroups.mockClear()
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
  vi.useRealTimers()
})

describe('UnifiedViewLayout group-move fallback coalescing', () => {
  it('coalesces a burst of unresolvable remote group moves into ONE debounced refetch', () => {
    // Status-grouped board with the Done column NOT in the view — the exact
    // shape a bulk "mark done" burst hits: every event resolves no toKey.
    state.data = [
      {
        key: 'started::In Progress',
        metadata: { status_id: 's-progress' },
        items: [
          { id: 'a1', title: 'One', workflow_state: { id: 's-progress' } },
          { id: 'a2', title: 'Two', workflow_state: { id: 's-progress' } },
          { id: 'a3', title: 'Three', workflow_state: { id: 's-progress' } },
        ],
      },
    ]
    render()

    // A teammate bulk-completes three actions → three realtime UPDATEs whose
    // destination column is absent from this view.
    for (const id of ['a1', 'a2', 'a3']) {
      dispatch('ni:entity-updated', {
        entityType: 'action', id, fields: { status_id: 's-done' },
      })
    }

    // No immediate (un-coalesced) refetch, and no bogus local move.
    expect(refetch).not.toHaveBeenCalled()
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()

    // The trailing 300ms debounce fires ONE refetch for the whole burst.
    act(() => { vi.advanceTimersByTime(350) })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('still resolves a remote move locally (no refetch) when the destination column is present', () => {
    state.data = [
      {
        key: 'started::In Progress',
        metadata: { status_id: 's-progress' },
        items: [{ id: 'a1', title: 'One', workflow_state: { id: 's-progress' } }],
      },
      { key: 'completed::Done', metadata: { status_id: 's-done' }, items: [] },
    ]
    render()

    dispatch('ni:entity-updated', {
      entityType: 'action', id: 'a1', fields: { status_id: 's-done' },
    })

    // Fast path intact: local column move, and the debounce window stays empty.
    expect(moveItemBetweenGroups).toHaveBeenCalledWith(
      'a1', 'started::In Progress', 'completed::Done', { status_id: 's-done' },
    )
    act(() => { vi.advanceTimersByTime(350) })
    expect(refetch).not.toHaveBeenCalled()
  })
})
