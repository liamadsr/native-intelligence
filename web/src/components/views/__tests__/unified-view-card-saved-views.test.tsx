// @vitest-environment jsdom
/**
 * A list card is laid out as a window was: its saved views are the toolbar's
 * tab row, beside the filters and the layout switch, and its search sits in
 * the card's header. Picking a view makes it what the card shows (and reports,
 * against the agent's page), the default tab goes back, and nothing is written
 * for the real page's selection. A quiet list inside a card keeps its search
 * in its toolbar and lists no views.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shown = vi.hoisted(() => ({ calls: [] as Array<{ activeViewId: string | null; config: { filters: unknown[]; layout: string } }> }))
const toolbar = vi.hoisted(() => ({ props: null as null | { hideTabs?: boolean; views: unknown[]; onViewChange: (id: string | null) => void } }))

vi.mock('../hooks/use-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-view')>()
  return {
    ...actual,
    useViewResults: (activeViewId: string | null, config: { filters: unknown[]; layout: string }) => {
      shown.calls.push({ activeViewId, config })
      return {
        data: [], loading: false, loadingMore: false, totalCount: 0, hasMore: false,
        loadMore: vi.fn(), refetch: vi.fn(), updateItem: vi.fn(), moveItemBetweenGroups: vi.fn(), removeItem: vi.fn(),
      }
    },
  }
})
vi.mock('../hooks/use-picker-context', () => ({ usePickerContext: () => ({ workflowStatesByTeam: {} }) }))
vi.mock('../hooks/use-flow-status-ids', () => ({ useFlowStatusIds: () => ({}) }))
vi.mock('../hooks/use-bulk-selection', () => ({
  useBulkSelection: () => ({ selectedIds: new Set<string>(), count: 0, hasSelection: false, clear: vi.fn(), toggle: vi.fn(), selectAll: vi.fn() }),
}))
vi.mock('../bulk-actions/use-bulk-actions', () => ({ useBulkActions: () => ({ execute: vi.fn() }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws1', useCurrentMemberId: () => 'm1' }))
vi.mock('../view-toolbar', async () => {
  const { createElement: e } = await import('react')
  return {
    ViewToolbar: (props: { hideTabs?: boolean; views: unknown[]; onViewChange: (id: string | null) => void; actions?: React.ReactNode }) => {
      toolbar.props = props
      return e('div', { 'data-toolbar': '' }, props.actions)
    },
  }
})
vi.mock('../view-list', () => ({ ViewList: () => null }))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout, type CardLayoutOptions, type CardLayoutState } from '../unified-view-layout'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
import type { ViewFilter } from '@/lib/views/types'

const VIEWS = [
  {
    id: 'view-1', name: 'Board of mine', entity_type: 'action', layout: 'board', icon: '🎯',
    filters: [{ id: 'v-0', field: 'assignee_id', operator: 'is', value: '@me' }],
    grouping: null, sub_grouping: null, ordering: [], display_properties: ['title'],
  },
]
const CARD_FILTERS: ViewFilter[] = [{ id: 'card-0', field: 'title', operator: 'contains', value: 'pricing' }]

let container: HTMLDivElement
let right: HTMLDivElement
let root: Root
let fetchSpy: MockInstance<typeof fetch>

beforeEach(() => {
  window.localStorage.clear()
  shown.calls.length = 0
  toolbar.props = null
  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ views: VIEWS })))
  container = document.createElement('div')
  right = document.createElement('div')
  document.body.append(right, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  vi.restoreAllMocks()
})

function render(card: CardLayoutOptions, obscured = false) {
  act(() => {
    root.render(h(CardHeaderSlotsProvider, { value: { left: null, right } }, h(UnifiedViewLayout, { entityType: 'action' as const, card, obscured })))
  })
}

const searchIn = (el: ParentNode) => el.querySelector('[aria-label="Search issues"]')

describe('a list card laid out as a window', () => {
  it('has its saved views as the tab row, picks one for the card alone, goes back, and searches from the header', async () => {
    const reports: CardLayoutState[] = []
    const changes: unknown[] = []
    render({
      baseline: { filters: CARD_FILTERS, layout: 'list' },
      onStateChange: (s) => reports.push(s),
      onOverridesChange: (o) => changes.push(o),
    })
    await act(async () => {})
    expect(String(fetchSpy.mock.calls[0][0])).toBe('/api/account/views?entity_type=action')
    expect(toolbar.props!.hideTabs).toBe(false)
    expect(toolbar.props!.views).toEqual(VIEWS)

    // The search is the header's, not the toolbar's.
    expect(searchIn(right)).not.toBeNull()
    expect(searchIn(container.querySelector('[data-toolbar]')!)).toBeNull()

    act(() => toolbar.props!.onViewChange('view-1'))
    expect(shown.calls.at(-1)).toMatchObject({ activeViewId: 'view-1', config: { filters: VIEWS[0].filters, layout: 'board' } })
    expect(reports.at(-1)!.config.filters).toEqual(VIEWS[0].filters)
    expect(reports.at(-1)!.baseline.filters).toEqual(CARD_FILTERS)
    expect(changes.at(-1)).toEqual({})

    act(() => toolbar.props!.onViewChange(null))
    expect(shown.calls.at(-1)).toMatchObject({ activeViewId: null, config: { filters: CARD_FILTERS, layout: 'list' } })
    expect(reports.at(-1)!.config.filters).toEqual(CARD_FILTERS)

    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('dial8:active-view:') || k.startsWith('dial8:view-draft:'))).toEqual([])
  })

  it('gives the header up while a record is open over the list', async () => {
    render({ baseline: {}, onStateChange: () => {} }, true)
    await act(async () => {})
    expect(searchIn(right)).toBeNull()
  })

  it('keeps a quiet list’s search in its toolbar, with no tabs and no views fetched', async () => {
    render({ baseline: {} })
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(toolbar.props!.hideTabs).toBe(true)
    expect(searchIn(right)).toBeNull()
    expect(searchIn(container.querySelector('[data-toolbar]')!)).not.toBeNull()
  })
})
