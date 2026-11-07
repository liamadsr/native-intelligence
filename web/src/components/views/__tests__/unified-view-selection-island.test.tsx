// @vitest-environment jsdom
/**
 * WHERE the selection island lives (Liam, 2026-09-06: "centered to the width
 * of the main content view, on the bottom of the page … for everywhere we
 * have these custom views, not just the prospecting page").
 *
 * The layout used to wedge the bar between the toolbar and the rows; now it
 * floats it over the bottom of the list, centred on the layout's own width,
 * and the layout root isolates it so a detail overlay drawn over the layout
 * still covers it. A page's own verbs (`selectionActions`) float in a SECOND
 * island of the same make directly above the primary one (Liam: "a secondary
 * menu, like a second island floating above it instead of all of them being
 * combined in one") — never mixed into the primary, never a strip of the
 * page's own on top.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { selection } = vi.hoisted(() => ({
  /** What the (stubbed) bulk selection holds — a test sets it before rendering. */
  selection: { ids: ['a1', 'a2'] as string[] },
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
      { id: 'a1', title: 'Buy milk' },
      { id: 'a2', title: 'Ship it' },
      { id: 'a3', title: 'Call back' },
    ],
    loading: false, loadingMore: false, totalCount: 3, hasMore: false,
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
  useBulkActions: () => ({ execute: vi.fn() }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws1',
  useCurrentMemberId: () => 'm1',
  useWorkspaces: () => ({ workspaces: [{ id: 'ws1' }] }),
}))
vi.mock('../view-toolbar', () => ({ ViewToolbar: () => h('div', { 'data-testid': 'toolbar' }) }))
vi.mock('../view-list', () => ({ ViewList: () => h('div', { 'data-testid': 'list' }) }))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  selection.ids = ['a1', 'a2']
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(props: { selectionActions?: React.ReactNode } = {}) {
  act(() => {
    root.render(h(UnifiedViewLayout, { entityType: 'action' as const, ...props }))
  })
}

const islandWrapper = () => container.querySelector('[data-selection-island]') as HTMLElement | null
const island = () => container.querySelector('[data-bulk-action-island]') as HTMLElement | null

describe('UnifiedViewLayout — the selection island', () => {
  it('floats over the bottom of the layout, centred, inside an isolated root', () => {
    mount()
    const wrapper = islandWrapper()!
    expect(wrapper).toBeTruthy()
    // Anchored to the bottom of the layout and centred on its width — not a
    // strip in the column flow between the toolbar and the list.
    expect(wrapper.className).toContain('absolute')
    expect(wrapper.className).toContain('bottom-4')
    expect(wrapper.className).toContain('justify-center')
    const rootEl = container.firstElementChild as HTMLElement
    expect(rootEl.contains(wrapper)).toBe(true)
    expect(wrapper.parentElement).toBe(rootEl)
    expect(rootEl.className).toContain('relative')
    expect(rootEl.className).toContain('isolate')

    // The rows keep their place: the list is still the toolbar's next sibling.
    const toolbar = container.querySelector('[data-testid="toolbar"]')!
    const list = container.querySelector('[data-testid="list"]')!
    expect(toolbar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.contains(list)).toBe(false)

    expect(island()!.textContent).toContain('2 selected')
  })

  it('is absent with nothing selected', () => {
    selection.ids = []
    mount()
    expect(islandWrapper()).toBeNull()
  })

  it("floats the page's own verbs in a second island directly above the primary one", () => {
    mount({ selectionActions: h('button', { 'data-testid': 'page-verb' }, 'Save') })
    const verb = container.querySelector('[data-testid="page-verb"]')!
    const secondary = container.querySelector('[data-selection-island-secondary]') as HTMLElement
    const primary = island()!
    expect(secondary).toBeTruthy()
    expect(secondary.contains(verb)).toBe(true)
    expect(primary.contains(verb)).toBe(false)
    // Same make as the primary, stacked above it in the one centred column.
    expect(secondary.className).toBe(primary.className)
    expect(secondary.parentElement).toBe(primary.parentElement)
    expect(secondary.parentElement!.className).toContain('flex-col')
    expect(secondary.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('draws no second island for a page without verbs of its own', () => {
    mount()
    expect(container.querySelector('[data-selection-island-secondary]')).toBeNull()
  })
})
