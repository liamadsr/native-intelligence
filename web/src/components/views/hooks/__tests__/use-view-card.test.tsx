// @vitest-environment jsdom
/**
 * A card in the chat never touches the real page's saved views, selection or
 * drafts: its baseline is the agent's page (or a saved view picked in the card
 * alone), its changes go to the card, and it lists the saved views without
 * restoring or writing a selection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'member-1',
}))

import { useView, useViewConfig, type ViewConfig } from '../use-view'
import { announceViewsChanged } from '@/lib/views/views-changed'
import type { View } from '@/lib/views/types'

let container: HTMLDivElement
let root: Root

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(node)
  })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})
afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

const BASELINE: Partial<ViewConfig> = {
  filters: [{ id: 'card-0', field: 'title', operator: 'contains', value: 'pricing' }],
  layout: 'board',
}

describe('useViewConfig in card mode', () => {
  it("starts from the agent's page and the card's kept changes, and hands every change to the card, never to the page's drafts", async () => {
    const changes: Array<Partial<ViewConfig>> = []
    const api: { config?: ViewConfig; update?: (u: Partial<ViewConfig>) => void; discard?: () => void } = {}
    // The page's own draft for actions, which a card must not read or write.
    window.localStorage.setItem('dial8:view-draft:default:ws-1:action:global', JSON.stringify({ overrides: { layout: 'list' }, savedAt: Date.now() }))
    const card = { baseline: BASELINE, overrides: { ordering: [{ field: 'due_at', direction: 'asc' as const }] }, onOverridesChange: (o: Partial<ViewConfig>) => changes.push(o) }
    function Harness() {
      const v = useViewConfig(null, 'action', undefined, false, undefined, 'workspace', card)
      api.config = v.config
      api.update = v.updateConfig
      api.discard = v.discardOverrides
      return null
    }
    mount(h(Harness))
    expect(api.config).toMatchObject({ layout: 'board', ordering: [{ field: 'due_at', direction: 'asc' }] })
    expect(api.config?.filters).toEqual(BASELINE.filters)

    await act(async () => {
      api.update!({ filters: [{ id: 'x', field: 'assignee_id', operator: 'is', value: '@me' }] })
      await Promise.resolve()
    })
    expect(changes.at(-1)).toMatchObject({ filters: [{ field: 'assignee_id' }], ordering: [{ field: 'due_at' }] })
    act(() => api.discard!())
    expect(changes.at(-1)).toEqual({})
    expect(api.config?.filters).toEqual(BASELINE.filters)

    const draftKeys = Object.keys(window.localStorage).filter((k) => k.startsWith('dial8:view-draft:'))
    expect(draftKeys).toEqual(['dial8:view-draft:default:ws-1:action:global'])
    expect(JSON.parse(window.localStorage.getItem(draftKeys[0])!).overrides).toEqual({ layout: 'list' })
  })
})

describe('useViewConfig in card mode on a scope tab', () => {
  it("leaves the agent's page for another scope's defaults and comes back on the page's own, never touching the page's drafts", async () => {
    const changes: Array<Partial<ViewConfig>> = []
    const api: { config?: ViewConfig; reset?: (o: Partial<ViewConfig>) => void; update?: (u: Partial<ViewConfig>) => void } = {}
    window.localStorage.setItem('dial8:view-draft:default:ws-1:capture:global', JSON.stringify({ overrides: { layout: 'board' }, savedAt: Date.now() }))
    const card = { baseline: BASELINE, onOverridesChange: (o: Partial<ViewConfig>) => changes.push(o) }
    function Harness() {
      const v = useViewConfig(null, 'capture', undefined, false, undefined, 'workspace', card)
      api.config = v.config
      api.reset = v.resetConfig
      api.update = v.updateConfig
      return null
    }
    mount(h(Harness))
    expect(api.config).toMatchObject({ capture_scope: 'all', layout: 'board' })
    expect(api.config?.filters).toEqual(BASELINE.filters)

    // Mine: that scope's own defaults, not the page; the page's draft never read.
    act(() => api.reset!({ capture_scope: 'mine' }))
    expect(api.config?.capture_scope).toBe('mine')
    expect(api.config?.filters).not.toEqual(BASELINE.filters)
    expect(api.config?.layout).not.toBe('board')

    // A change on the scope tab stays in memory: the card keeps only the page's.
    await act(async () => {
      api.update!({ layout: 'board' })
      await Promise.resolve()
    })
    expect(api.config?.layout).toBe('board')
    expect(changes.some((c) => c.layout === 'board')).toBe(false)

    // All captures, the page's own scope: back on the agent's page.
    act(() => api.reset!({ capture_scope: 'all' }))
    expect(api.config?.capture_scope).toBe('all')
    expect(api.config?.filters).toEqual(BASELINE.filters)
    expect(JSON.parse(window.localStorage.getItem('dial8:view-draft:default:ws-1:capture:global')!).overrides).toEqual({ layout: 'board' })
  })
})

describe('useViewConfig in card mode on a saved view', () => {
  const VIEW = {
    id: 'view-1', name: 'Mine', entity_type: 'action', layout: 'list', icon: null,
    filters: [{ id: 'v-0', field: 'assignee_id', operator: 'is', value: '@me' }],
    grouping: null, sub_grouping: null, ordering: [], display_properties: [],
  } as unknown as View

  it("takes the view as its baseline, starts the card's changes over on a switch, and keeps only changes to the agent's page", async () => {
    const changes: Array<Partial<ViewConfig>> = []
    const api: { v?: ReturnType<typeof useViewConfig> } = {}
    const card = { baseline: BASELINE, overrides: { ordering: [{ field: 'due_at', direction: 'asc' as const }] }, onOverridesChange: (o: Partial<ViewConfig>) => changes.push(o) }
    function Harness({ view }: { view: View | null }) {
      api.v = useViewConfig(view, 'action', undefined, false, undefined, 'workspace', card)
      return null
    }
    mount(h(Harness, { view: null }))
    expect(api.v!.config.ordering).toEqual([{ field: 'due_at', direction: 'asc' }])

    act(() => root.render(h(Harness, { view: VIEW })))
    expect(api.v!.config.filters).toEqual(VIEW.filters)
    expect(api.v!.config.layout).toBe('list')
    // The kept ordering was made against the agent's page: it goes.
    expect(api.v!.overrides).toEqual({})
    expect(changes.at(-1)).toEqual({})
    // The agent's page stays what the card reports against.
    expect(api.v!.cardPageBaseline?.filters).toEqual(BASELINE.filters)

    const kept = changes.length
    await act(async () => {
      api.v!.updateConfig({ layout: 'board' })
      await Promise.resolve()
    })
    expect(api.v!.config.layout).toBe('board')
    expect(changes.length).toBe(kept)

    act(() => root.render(h(Harness, { view: null })))
    expect(api.v!.config.filters).toEqual(BASELINE.filters)
    expect(api.v!.overrides).toEqual({})
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('dial8:view-draft:'))).toEqual([])
  })
})

describe('useView standalone (a card)', () => {
  it('lists the saved views but restores no selection and writes none', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ views: [{ id: 'view-9', name: 'Mine' }] })))
    window.localStorage.setItem('dial8:active-view:ws-1:action:noteam:global', 'view-9')
    const api: { v?: ReturnType<typeof useView> } = {}
    function Harness() {
      api.v = useView('action', undefined, undefined, { standalone: true })
      return null
    }
    mount(h(Harness))
    expect(api.v!.activeViewId).toBeNull()
    expect(api.v!.loading).toBe(true)
    await act(async () => {})
    expect(String(fetchSpy.mock.calls[0][0])).toBe('/api/account/views?entity_type=action')
    expect(api.v!.views.map((v) => v.id)).toEqual(['view-9'])
    expect(api.v!.loading).toBe(false)

    act(() => api.v!.setActiveViewId('view-9'))
    expect(api.v!.activeViewId).toBe('view-9')
    expect(api.v!.activeView?.name).toBe('Mine')
    act(() => api.v!.setActiveViewId(null))
    expect(window.localStorage.getItem('dial8:active-view:ws-1:action:noteam:global')).toBe('view-9')
  })

  it('reloads the list when a view is saved elsewhere (the card header)', async () => {
    let listed = [{ id: 'view-1', name: 'One' }]
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ views: listed })))
    const api: { views?: View[] } = {}
    function Harness() {
      api.views = useView('action', undefined, undefined, { standalone: true }).views
      return null
    }
    mount(h(Harness))
    await act(async () => {})
    listed = [{ id: 'view-2', name: 'Two' }, ...listed]
    await act(async () => {
      announceViewsChanged()
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(api.views?.map((v) => v.id)).toEqual(['view-2', 'view-1'])
  })

  it('skips the list when asked to (the mail card)', () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ views: [] })))
    const api: { loading?: boolean } = {}
    function Harness() {
      api.loading = useView('email_thread', undefined, undefined, { standalone: true, listViews: false }).loading
      return null
    }
    mount(h(Harness))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(api.loading).toBe(false)
  })
})
