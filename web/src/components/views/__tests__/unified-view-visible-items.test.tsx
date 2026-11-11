// @vitest-environment jsdom
/**
 * What UnifiedViewLayout reports as its VISIBLE ITEMS.
 *
 * That array is load-bearing twice over: it's the list context prev/next steps
 * through, and it's what "select all" selects. Two shapes broke it silently —
 * both produced a plausible-looking empty/blank result rather than an error:
 *
 *  1. SUB-GROUPED views. groupResults moves every row down into
 *     `group.subGroups` and EMPTIES `group.items`, so flattening `g.items`
 *     alone reported ZERO visible items on exactly the views where grouping is
 *     most useful — arrows dead, select-all a no-op.
 *  2. CONTACT titles. Contacts carry `full_name`, not `title`/`name`, so every
 *     contact reported an empty title, which is what then got written into tab
 *     history and the detail breadcrumb.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VisibleItem } from '../detail-nav-utils'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const config = {
  filters: [],
  grouping: null,
  layout: 'list',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

// Swapped per test before render — useViewResults reads it lazily.
let resultsData: unknown[] = []

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
    data: resultsData,
    loading: false, loadingMore: false, totalCount: resultsData.length, hasMore: false,
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
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'
import { stubAppFetch } from '@/test/app-fetch-stub'

let container: HTMLDivElement
let root: Root
let reported: VisibleItem[] = []

function renderList(entityType: 'action' | 'contact') {
  act(() => {
    root.render(
      h(UnifiedViewLayout, {
        entityType,
        onVisibleItemsChange: (items: VisibleItem[]) => { reported = items },
      }),
    )
  })
}

beforeEach(() => {
  // The layout reads /api/account/workspace on mount. Refused at once, as the
  // real fetch refused it only later, it cannot outlive the test
  // (src/test/app-fetch-stub.ts says why).
  stubAppFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  reported = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('UnifiedViewLayout visible items', () => {
  it('reports rows that live in SUB-GROUPS — the parent group\'s own items array is empty by design', () => {
    resultsData = [
      {
        key: 'in-progress',
        label: 'In Progress',
        items: [],
        subGroups: [
          { key: 'high', label: 'High', items: [{ id: 'a1', title: 'One' }, { id: 'a2', title: 'Two' }] },
          { key: 'low', label: 'Low', items: [{ id: 'a3', title: 'Three' }] },
        ],
      },
      {
        key: 'done',
        label: 'Done',
        items: [],
        subGroups: [{ key: 'none', label: 'No priority', items: [{ id: 'a4', title: 'Four' }] }],
      },
    ]

    renderList('action')

    expect(reported.map(it => it.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  it('still reports plain single-level groups, in render order', () => {
    resultsData = [
      { key: 'g1', label: 'G1', items: [{ id: 'a1', title: 'One' }] },
      { key: 'g2', label: 'G2', items: [{ id: 'a2', title: 'Two' }] },
    ]

    renderList('action')

    expect(reported.map(it => it.id)).toEqual(['a1', 'a2'])
  })

  it('reports ungrouped (flat) results unchanged', () => {
    resultsData = [{ id: 'a1', title: 'One' }, { id: 'a2', title: 'Two' }]

    renderList('action')

    expect(reported.map(it => it.id)).toEqual(['a1', 'a2'])
  })

  it('titles contacts from full_name instead of writing an empty string into history', () => {
    resultsData = [{ id: 'ct1', full_name: 'Ada Lovelace', email: 'ada@example.com' }]

    renderList('contact')

    expect(reported).toHaveLength(1)
    expect(reported[0].title).toBe('Ada Lovelace')
  })
})
