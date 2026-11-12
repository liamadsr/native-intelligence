// @vitest-environment jsdom
/**
 * A board grouped by a custom select field (`custom_fields.<key>`): a drop
 * sets that field through the values route, which checks the person's edit
 * right on each record (a PATCH of the record would not know the path), moves
 * the card at once with its `custom_fields` updated, and puts it back with the
 * route's reason when the write is refused.
 *
 * Harness: the shape of unified-view-prospect-list-drag.test.tsx, the REAL
 * layout with the data hooks stubbed and a ViewBoard stub that captures
 * `onMoveItem`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refetch = vi.fn()
const updateItem = vi.fn()
const removeItem = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}))

const config = {
  filters: [],
  grouping: { field: 'custom_fields.project_type', direction: 'asc' },
  layout: 'board',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

const KILN = { id: 'd1', name: 'Kiln Coffee rebrand', workspace_id: 'ws1', custom_fields: { project_type: 'Brand', retainer_months: 6 } }
const DATA = [
  { key: 'Brand', label: 'Brand', items: [KILN] },
  { key: 'Website', label: 'Website', items: [] },
  { key: '__none__', label: 'No value', items: [] },
]

const moveItemBetweenGroups = vi.fn((id: string) => (id === KILN.id ? KILN : undefined))

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

let response: { ok: boolean; body: unknown } = { ok: true, body: {} }
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: response.ok,
  status: response.ok ? 200 : 403,
  json: async () => response.body,
}) as Response)

const valueWrites = () =>
  fetchMock.mock.calls
    .filter(([u]) => u === '/api/account/custom-fields/values')
    .map(([, init]) => ({ method: init?.method, body: JSON.parse(String(init?.body)) }))

describe('board grouped by a custom select field', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    response = { ok: true, body: {} }
    fetchMock.mockClear()
    toastError.mockClear()
    moveItemBetweenGroups.mockClear()
    refetch.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(h(UnifiedViewLayout, { entityType: 'company' as const }))
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('sets the field through the values route and moves the card with it', async () => {
    expect(onMoveItem).toBeTruthy()
    await act(async () => { onMoveItem!(['d1'], 'Brand', 'Website') })
    expect(valueWrites()).toEqual([
      { method: 'POST', body: { entity_type: 'company', id: 'd1', values: { project_type: 'Website' } } },
    ])
    expect(moveItemBetweenGroups).toHaveBeenCalledWith('d1', 'Brand', 'Website', {
      custom_fields: { project_type: 'Website', retainer_months: 6 },
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('tells the other surfaces the values the server stored, not the card’s old copy', async () => {
    // A teammate set renewal_date meanwhile: the server's row has it.
    response = { ok: true, body: { custom_fields: { project_type: 'Website', retainer_months: 6, renewal_date: '2026-12-01' } } }
    const updates: unknown[] = []
    const listen = (e: Event) => updates.push((e as CustomEvent).detail)
    window.addEventListener('ni:entity-updated', listen)
    try {
      await act(async () => { onMoveItem!(['d1'], 'Brand', 'Website') })
    } finally {
      window.removeEventListener('ni:entity-updated', listen)
    }
    expect(updates).toEqual([
      { entityType: 'company', id: 'd1', fields: { custom_fields: { project_type: 'Website', retainer_months: 6, renewal_date: '2026-12-01' } } },
    ])
  })

  it('clears the field when dropped on "No value"', async () => {
    await act(async () => { onMoveItem!(['d1'], 'Brand', '__none__') })
    expect(valueWrites()).toEqual([
      { method: 'POST', body: { entity_type: 'company', id: 'd1', values: { project_type: null } } },
    ])
    expect(moveItemBetweenGroups).toHaveBeenCalledWith('d1', 'Brand', '__none__', {
      custom_fields: { retainer_months: 6 },
    })
  })

  it('puts the card back with the route’s reason when the write is refused', async () => {
    response = { ok: false, body: { error: "You can't edit this deal" } }
    await act(async () => { onMoveItem!(['d1'], 'Brand', 'Website') })
    expect(moveItemBetweenGroups).toHaveBeenLastCalledWith('d1', 'Website', 'Brand', {
      custom_fields: { project_type: 'Brand', retainer_months: 6 },
    })
    expect(toastError).toHaveBeenCalledWith("You can't edit this deal")
    expect(refetch).toHaveBeenCalled()
  })

  it('moves a card when its field changes elsewhere (a teammate, the panel)', () => {
    act(() => {
      window.dispatchEvent(new CustomEvent('ni:entity-updated', {
        detail: { entityType: 'company', id: 'd1', fields: { custom_fields: { project_type: 'Website', retainer_months: 6 } } },
      }))
    })
    expect(moveItemBetweenGroups).toHaveBeenCalledWith('d1', 'Brand', 'Website', {
      custom_fields: { project_type: 'Website', retainer_months: 6 },
    })
  })

  it('never PATCHes the record with the path as a column', async () => {
    await act(async () => { onMoveItem!(['d1'], 'Brand', 'Website') })
    const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')
    expect(patches).toEqual([])
  })
})
