// @vitest-environment jsdom
/**
 * A list inside a page card (pages in the chat, P3) that was handed no card
 * options takes them from the card surface around it: it restores no saved
 * view (standalone) and its saved views go to the card header's menu, never
 * the toolbar's tab pills; its config comes from the card, and it reports
 * what it shows. Outside a card, nothing changes. A prospect list's entries
 * keep their tab row (the stage tabs live there) and list no saved views.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const calls = vi.hoisted(() => ({ useView: [] as unknown[][], useViewConfig: [] as unknown[][], toolbar: [] as Array<Record<string, unknown>> }))
const config = { filters: [], ordering: [], grouping: null, layout: 'list', display_properties: [], crm_scope: 'contacts', capture_scope: 'all' }

vi.mock('../hooks/use-view', () => ({
  useView: (...args: unknown[]) => {
    calls.useView.push(args)
    return { views: [], activeViewId: null, activeView: null, setActiveViewId: vi.fn(), createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn() }
  },
  useViewConfig: (...args: unknown[]) => {
    calls.useViewConfig.push(args)
    return { config, baseline: config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false, saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {} }
  },
  useViewResults: () => ({
    data: [{ id: 's1', name: 'Q4 outbound' }],
    loading: false, loadingMore: false, totalCount: 1, hasMore: false,
    loadMore: vi.fn(), refetch: vi.fn(), updateItem: vi.fn(), moveItemBetweenGroups: vi.fn(), removeItem: vi.fn(),
  }),
  defaultConfig: () => config,
  spansWorkspaces: () => false,
}))
vi.mock('../hooks/use-picker-context', () => ({ usePickerContext: () => ({ workflowStatesByTeam: {} }) }))
vi.mock('../hooks/use-flow-status-ids', () => ({ useFlowStatusIds: () => ({}) }))
vi.mock('../hooks/use-bulk-selection', () => ({
  useBulkSelection: () => ({ selectedIds: new Set<string>(), count: 0, hasSelection: false, clear: vi.fn(), toggle: vi.fn(), selectAll: vi.fn() }),
}))
vi.mock('../bulk-actions/use-bulk-actions', () => ({ useBulkActions: () => ({ execute: vi.fn() }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws1', useCurrentMemberId: () => 'm1' }))
vi.mock('../view-toolbar', () => ({
  ViewToolbar: (props: Record<string, unknown>) => {
    calls.toolbar.push(props)
    return null
  },
}))
vi.mock('../view-list', () => ({ ViewList: () => null }))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { CardSurfaceContext, UnifiedViewLayout, type CardLayoutOptions } from '../unified-view-layout'
import { stubAppFetch } from '@/test/app-fetch-stub'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  calls.useView.length = 0
  calls.useViewConfig.length = 0
  calls.toolbar.length = 0
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

describe('UnifiedViewLayout inside a page card', () => {
  it('takes its card options from the surface, keyed by entity and scope, and reports what it shows', () => {
    const report = vi.fn()
    const options: CardLayoutOptions = { baseline: { layout: 'list' }, onStateChange: report }
    const listOptions = vi.fn(() => options)
    act(() => {
      root.render(h(CardSurfaceContext.Provider, { value: { listOptions } }, h(UnifiedViewLayout, { entityType: 'sequence' as const })))
    })
    expect(listOptions).toHaveBeenCalledWith('sequence', 'sequence:')
    expect(calls.useView.at(-1)![3]).toEqual({ standalone: true, listViews: true })
    expect(calls.useViewConfig.at(-1)![6]).toBe(options)
    // The card's own list (it reports) has the window's tab row: its saved views.
    expect(calls.toolbar.at(-1)!.hideTabs).toBe(false)
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ total: 1 }))
  })

  it("keeps a prospect list's tab row when the surface asks for it", () => {
    const listOptions = vi.fn((): CardLayoutOptions => ({ baseline: {}, keepTabs: true }))
    act(() => {
      root.render(
        h(CardSurfaceContext.Provider, { value: { listOptions } }, h(UnifiedViewLayout, { entityType: 'prospect_list_entry' as const, viewScope: { type: 'prospect_list', id: 'l1' } as never })),
      )
    })
    expect(listOptions).toHaveBeenCalledWith('prospect_list_entry', 'prospect_list_entry:prospect_list:l1')
    expect(calls.useView.at(-1)![3]).toEqual({ standalone: true, listViews: false })
    expect(calls.toolbar.at(-1)!.hideTabs).toBe(false)
  })

  it('is the page as ever outside a card', () => {
    act(() => {
      root.render(h(UnifiedViewLayout, { entityType: 'sequence' as const }))
    })
    expect(calls.useView.at(-1)![3]).toEqual({ standalone: false, listViews: true })
    expect(calls.useViewConfig.at(-1)![6]).toBeUndefined()
    expect(calls.toolbar.at(-1)!.hideTabs).toBe(false)
  })
})
