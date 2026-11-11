// @vitest-environment jsdom
/**
 * The prospect list's stage tabs, THROUGH the real toolbar.
 *
 * The page owns the tab; the layout owns the saved-view selection. Four seams
 * hold the two together, and each is the kind of thing that fails silently:
 *
 *  - a stage tab click must clear the open custom view (silently — no history
 *    step) AND report the tab, or a tab and a view read as selected together;
 *  - the layout reports the active view on mount — the restored one included,
 *    which `onViewSelectionChange` deliberately never does — and lends the
 *    page its selector, so a tab picked from the save story clears the view
 *    the way a toolbar click does;
 *  - "+" pressed on Saved seeds the new view with a VISIBLE "Stage is saved"
 *    chip, because the tab's own narrowing is an invisible scope filter a
 *    saved view would silently drop;
 *  - the page's toolbar actions render in the toolbar's right cluster.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { setActiveViewIdSpy, updateConfigSpy } = vi.hoisted(() => ({
  setActiveViewIdSpy: vi.fn(),
  updateConfigSpy: vi.fn(),
}))

const config = {
  filters: [],
  grouping: null,
  sub_grouping: null,
  ordering: [],
  display_properties: [],
  layout: 'list',
  board_group_by: null,
  show_completed: true,
  completed_filter: 'all',
  show_sub_items: true,
  nested_sub_items: false,
  show_empty_groups: false,
  action_scope: 'all',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

const VIEWS = [{ id: 'view-a', name: 'Hot ones', filters: [], entity_type: 'prospect_list_entry' }]

/** What the layout would restore from localStorage — set per test. */
let initialActive: string | null = null

/** Stateful stand-in for useView — the real one is localStorage-backed state. */
vi.mock('../hooks/use-view', async () => {
  const react = await import('react')
  return {
    useView: () => {
      const [activeViewId, setState] = react.useState<string | null>(initialActive)
      const setActiveViewId = react.useCallback((id: string | null) => {
        setActiveViewIdSpy(id)
        setState(id)
      }, [])
      return {
        views: VIEWS,
        activeViewId,
        activeView: VIEWS.find((v) => v.id === activeViewId) ?? null,
        setActiveViewId,
        createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
      }
    },
    useViewConfig: () => ({
      config, updateConfig: updateConfigSpy, resetConfig: vi.fn(), isDirty: false,
      saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
    }),
    useViewResults: () => ({
      data: [], loading: false, loadingMore: false, totalCount: 0, hasMore: false,
      loadMore: vi.fn(), refetch: vi.fn(), updateItem: vi.fn(),
      moveItemBetweenGroups: vi.fn(), removeItem: vi.fn(),
    }),
  }
})

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
vi.mock('../view-list', () => ({ ViewList: () => null }))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'
import { stubAppFetch } from '@/test/app-fetch-stub'
import type { ProspectStageTab } from '@/lib/views/prospect-stage-tabs'

let container: HTMLDivElement
let root: Root

const COUNTS = { all: 12, saved: 3, needs_review: 0, dismissed: 2 }

type Selector = (viewId: string | null, opts?: { silent?: boolean }) => void

function mount(props: {
  stage?: ProspectStageTab | null
  onPick?: (tab: ProspectStageTab) => void
  onActive?: (id: string | null) => void
  onSelector?: (select: Selector) => void
  onSelection?: (v: { id: string; name: string } | null) => void
  actions?: React.ReactNode
}) {
  act(() => {
    root.render(
      h(UnifiedViewLayout, {
        entityType: 'prospect_list_entry' as const,
        scopeFilters: [{ id: '__scope_prospect_list', field: 'list_id', operator: 'is' as const, value: 'list-1' }],
        prospectStage: props.stage === undefined ? 'all' : props.stage,
        prospectStageCounts: COUNTS,
        onProspectStageChange: props.onPick ?? (() => {}),
        onActiveViewChange: props.onActive,
        onViewSelectorReady: props.onSelector,
        onViewSelectionChange: props.onSelection,
        toolbarActions: props.actions,
      }),
    )
  })
}

function tabs(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[role="tab"]'))
}
function tab(label: string): HTMLButtonElement | undefined {
  return tabs().find((b) => (b.textContent ?? '').startsWith(label))
}
function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  initialActive = null
  setActiveViewIdSpy.mockReset()
  updateConfigSpy.mockReset()
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

describe('UnifiedViewLayout — the prospect stage tabs through the real toolbar', () => {
  it('draws the stage tabs with their counts in the views tab row, beside the custom views', () => {
    mount({})
    // Label and count are sibling spans (the gap is CSS), so textContent
    // runs them together; Needs review is hidden at zero.
    expect(tabs().map((t) => t.textContent)).toEqual(['All12', 'Saved3', 'Dismissed2'])
    expect(container.textContent).not.toContain('All candidates')
    // The custom view is a tab in the same row.
    expect(container.textContent).toContain('Hot ones')
    expect(tab('All')!.getAttribute('aria-selected')).toBe('true')
  })

  it('a stage tab click clears the open custom view SILENTLY and reports the tab', () => {
    initialActive = 'view-a'
    const onPick = vi.fn()
    const onActive = vi.fn()
    const onSelection = vi.fn()
    mount({ stage: null, onPick, onActive, onSelection })
    // While the view is open, no stage tab is selected.
    expect(tabs().every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true)

    click(tab('Saved')!)

    expect(setActiveViewIdSpy).toHaveBeenCalledWith(null)
    expect(onPick).toHaveBeenCalledWith('saved')
    expect(onActive).toHaveBeenLastCalledWith(null)
    // Silent: the clear is plumbing for the tab switch, not a view pick, so
    // it must not become a history step.
    expect(onSelection).not.toHaveBeenCalled()
  })

  it('reports the active view on mount — the restored one included — and hands the page a selector', () => {
    initialActive = 'view-a'
    const onActive = vi.fn()
    let selector: Selector | null = null
    mount({ stage: null, onActive, onSelector: (s) => { selector = s } })

    expect(onActive).toHaveBeenCalledWith('view-a')
    expect(selector).toBeTypeOf('function')

    act(() => {
      selector!(null, { silent: true })
    })
    expect(setActiveViewIdSpy).toHaveBeenCalledWith(null)
    expect(onActive).toHaveBeenLastCalledWith(null)
  })

  it('"+" pressed on the Saved tab seeds the new view with a visible "Stage is saved" chip', () => {
    mount({ stage: 'saved' })
    const plus = container.querySelector('button.border-dashed') as HTMLButtonElement | null
    expect(plus).toBeTruthy()
    click(plus!)

    expect(updateConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ field: 'stage', operator: 'is', value: 'saved' })],
      }),
    )
  })

  it('"+" pressed on All seeds nothing — the server already scopes to what is still on the list', () => {
    mount({ stage: 'all' })
    click(container.querySelector('button.border-dashed')!)
    expect(updateConfigSpy).toHaveBeenCalledWith(expect.objectContaining({ filters: [] }))
  })

  it("renders the page's toolbar actions in the toolbar's right cluster", () => {
    mount({ actions: h('button', { 'data-testid': 'enrich' }, 'Enrich · 3') })
    const enrich = container.querySelector('[data-testid="enrich"]')
    expect(enrich).toBeTruthy()
    // In the toolbar row, beside the tabs — not somewhere below the list.
    const row = enrich!.closest('.h-10')
    expect(row).toBeTruthy()
    expect(row!.contains(tab('All')!)).toBe(true)
  })
})
