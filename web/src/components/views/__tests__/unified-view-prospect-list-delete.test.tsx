// @vitest-environment jsdom
/**
 * Bulk-deleting prospect lists from the index (Liam, 2026-09-06: "from the
 * main lists page with the bulk actions there should be a delete option").
 *
 * The bar offers Delete for `prospect_list` now, and the layout intercepts it
 * the way it intercepts the company cascade: the shared
 * ProspectListDeleteDialog owns the confirmation and the per-list DELETE
 * calls, and the generic /api/account/bulk endpoint is never reached — it
 * could not refuse a list with a run in flight, nor say what stays in the
 * CRM. The bar's own "N item(s)" confirm is skipped for the same reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { executeSpy, barProps, dialogProps, selection } = vi.hoisted(() => ({
  executeSpy: vi.fn(),
  barProps: { current: null as null | { onAction: (id: string) => void; skipConfirmActionIds?: string[] } },
  dialogProps: { current: null as null | { listIds: string[]; open: boolean; listName?: string } },
  /** What the (stubbed) bulk selection holds — a test sets it before rendering. */
  selection: { ids: ['l1', 'l2'] as string[] },
}))

const config = {
  filters: [],
  grouping: null,
  layout: 'list',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

vi.mock('../hooks/use-view', () => ({
  useView: () => ({
    views: [], activeViewId: null, activeView: null, setActiveViewId: vi.fn(),
    createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
  }),
  useViewConfig: () => ({
    config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false,
    saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
  }),
  useViewResults: () => ({
    data: [
      { id: 'l1', name: 'Throwaway A' },
      { id: 'l2', name: 'Throwaway B' },
    ],
    loading: false, loadingMore: false, totalCount: 2, hasMore: false,
    loadMore: vi.fn(), refetch: vi.fn(), updateItem: vi.fn(),
    moveItemBetweenGroups: vi.fn(), removeItem: vi.fn(),
  }),
}))
vi.mock('../hooks/use-picker-context', () => ({
  usePickerContext: () => ({ workflowStatesByTeam: {} }),
}))
vi.mock('../hooks/use-flow-status-ids', () => ({ useFlowStatusIds: () => ({}) }))
vi.mock('../hooks/use-bulk-selection', () => ({
  useBulkSelection: () => ({
    selectedIds: new Set<string>(selection.ids),
    count: selection.ids.length,
    hasSelection: selection.ids.length > 0,
    clear: vi.fn(), toggle: vi.fn(), selectAll: vi.fn(),
  }),
}))
vi.mock('../bulk-actions/use-bulk-actions', () => ({
  useBulkActions: () => ({ execute: executeSpy }),
}))
vi.mock('../bulk-actions/bulk-action-bar', () => ({
  BulkActionBar: (props: { onAction: (id: string) => void; skipConfirmActionIds?: string[] }) => {
    barProps.current = props
    return null
  },
}))
vi.mock('../bulk-actions/prospect-list-delete-dialog', () => ({
  ProspectListDeleteDialog: (props: { listIds: string[]; open: boolean; listName?: string }) => {
    dialogProps.current = props
    return h('div', { 'data-testid': 'list-delete-dialog' }, props.listIds.join(','))
  },
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws1',
  useCurrentMemberId: () => 'm1',
}))
vi.mock('../view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('../view-list', () => ({ ViewList: () => null }))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'
import { stubAppFetch } from '@/test/app-fetch-stub'
import { BULK_ACTIONS } from '../bulk-actions/types'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  executeSpy.mockReset()
  barProps.current = null
  dialogProps.current = null
  selection.ids = ['l1', 'l2']
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

describe('UnifiedViewLayout — deleting prospect lists in bulk', () => {
  it('the index offers Delete, and only Delete, for lists', () => {
    expect(BULK_ACTIONS.prospect_list).toEqual([
      { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
    ])
  })

  it('hands the selection to the shared dialog instead of the generic bulk endpoint', () => {
    act(() => {
      root.render(h(UnifiedViewLayout, { entityType: 'prospect_list' as const }))
    })
    // The bar's generic "N item(s)" confirm steps aside for the dialog.
    expect(barProps.current?.skipConfirmActionIds).toEqual(['delete'])
    expect(dialogProps.current).toBeNull()

    act(() => {
      barProps.current!.onAction('delete')
    })

    expect(dialogProps.current).toMatchObject({ listIds: ['l1', 'l2'], open: true })
    // A batch is counted, not named.
    expect(dialogProps.current?.listName).toBeUndefined()
    expect(container.querySelector('[data-testid="list-delete-dialog"]')?.textContent).toBe('l1,l2')
    expect(executeSpy).not.toHaveBeenCalled()
  })
})

describe('UnifiedViewLayout — deleting ONE prospect list from the index', () => {
  it('names the list in the dialog from the row on screen', () => {
    selection.ids = ['l2']
    act(() => {
      root.render(h(UnifiedViewLayout, { entityType: 'prospect_list' as const }))
    })
    act(() => {
      barProps.current!.onAction('delete')
    })
    expect(dialogProps.current).toMatchObject({ listIds: ['l2'], listName: 'Throwaway B', open: true })
  })
})
