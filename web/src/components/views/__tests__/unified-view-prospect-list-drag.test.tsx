// @vitest-environment jsdom
/**
 * The prospect LIST board (grouped by purpose) refuses drags.
 *
 * A list's purpose is not a status column: it seeds the ICP draft and picks
 * the angle templates the next run searches with. A drag between purpose
 * columns would change what the list looks for next time — silently, because
 * nothing bumps icp_version on a purpose change. The row cell is read-only for
 * the same reason; the list's ICP editor is where that change belongs.
 *
 * Harness: the same shape as unified-view-prospect-drag.test.tsx — the REAL
 * layout with the data/picker hooks stubbed and a ViewBoard stub that captures
 * `onMoveItem` so a drop can be invoked directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refetch = vi.fn()
const updateItem = vi.fn()
const removeItem = vi.fn()
const moveItemBetweenGroups = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}))

const config = {
  filters: [],
  grouping: { field: 'purpose', direction: 'asc' },
  layout: 'board',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

const DATA = [
  { id: 'l1', name: 'Customers like us', purpose: 'buyers', status: 'active', entry_counts: { total: 3, saved: 1, saved_people: 0 }, prospecting_run: [] },
  { id: 'l2', name: 'Seed funds', purpose: 'investors', status: 'active', entry_counts: { total: 0, saved: 0, saved_people: 0 }, prospecting_run: [] },
]

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
    data: DATA,
    loading: false, loadingMore: false, totalCount: 2, hasMore: false,
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
vi.mock('../view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('../view-list', () => ({ ViewList: () => null }))

let onMoveItem: ((ids: string[], from: string, to: string) => void) | null = null
vi.mock('../view-board', () => ({
  ViewBoard: (props: { onMoveItem?: (ids: string[], from: string, to: string) => void }) => {
    onMoveItem = props.onMoveItem ?? null
    return null
  },
}))

import { UnifiedViewLayout } from '../unified-view-layout'

describe('prospect_list board drag guard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    toastError.mockClear()
    moveItemBetweenGroups.mockClear()
    updateItem.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(h(UnifiedViewLayout, { entityType: 'prospect_list' as const }))
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('refuses a drag between purpose columns and says where the change belongs', () => {
    expect(onMoveItem).toBeTruthy()
    act(() => onMoveItem!(['l1'], 'buyers', 'investors'))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(String(toastError.mock.calls[0][0])).toMatch(/ICP editor/)
    // Refused BEFORE any optimistic move, so there is nothing to roll back.
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
    expect(updateItem).not.toHaveBeenCalled()
  })
})
