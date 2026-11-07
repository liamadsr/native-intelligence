// @vitest-environment jsdom
/**
 * Two ways view state used to get destroyed behind the user's back.
 *
 *  1. SCOPE TABS WIPED THE DRAFT. Clicking "All issues" / "Assigned to me" ran
 *     resetConfig, which blanked the whole default-baseline draft — including a
 *     `layout: 'board'` the user had deliberately set. One click on a scope tab
 *     and the board was gone. Only the `filters` override actually conflicts
 *     with a scope change (the scope's implied @me filter lives in the
 *     baseline, and a stale filters override shadows it), so that is the only
 *     key that may be dropped.
 *
 *  2. A FAILED FETCH ERASED THE SAVED-VIEW SELECTION. fetchViews swallows
 *     errors, so a 500 or an offline blip left `views` empty — which the
 *     phantom-view sweep read as "the view you were on no longer exists" and
 *     permanently cleared the persisted id. The sweep must only fire after a
 *     fetch that is known to have succeeded.
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

const DEFAULT_BASELINE_KEY = 'dial8:view-draft:default:ws-1:action:global'

let container: HTMLDivElement
let root: Root

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(node) })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  if (root) act(() => { root.unmount() })
  container?.remove()
})

// ── resetConfig: scope tabs must not destroy layout ──────────────────────────

describe('useViewConfig.resetConfig', () => {
  /** Harness that exposes the hook's surface to the test body. */
  function makeHarness() {
    const api: {
      config?: ViewConfig
      resetConfig?: (o: Partial<ViewConfig>) => void
      updateConfig?: (o: Partial<ViewConfig>) => void
    } = {}
    function Harness() {
      const v = useViewConfig(null, 'action', undefined, false)
      api.config = v.config
      api.resetConfig = v.resetConfig
      api.updateConfig = v.updateConfig
      return null
    }
    return { api, Harness }
  }

  it('preserves a board-layout draft across a scope-tab switch', () => {
    window.localStorage.setItem(
      DEFAULT_BASELINE_KEY,
      JSON.stringify({ overrides: { layout: 'board', board_group_by: 'status_id' }, savedAt: Date.now() }),
    )

    const { api, Harness } = makeHarness()
    mount(h(Harness))
    expect(api.config?.layout).toBe('board')

    act(() => { api.resetConfig!({ action_scope: 'assigned' }) })

    // Layout survives the scope switch — in memory and on disk.
    expect(api.config?.layout).toBe('board')
    expect(api.config?.board_group_by).toBe('status_id')
    expect(api.config?.action_scope).toBe('assigned')
    const persisted = JSON.parse(window.localStorage.getItem(DEFAULT_BASELINE_KEY)!)
    expect(persisted.overrides.layout).toBe('board')
  })

  it('drops the filters override so the new scope\'s implied @me filter applies', () => {
    window.localStorage.setItem(
      DEFAULT_BASELINE_KEY,
      JSON.stringify({
        overrides: {
          layout: 'board',
          filters: [{ id: 'stale', field: 'priority', operator: 'is', value: 'high' }],
        },
        savedAt: Date.now(),
      }),
    )

    const { api, Harness } = makeHarness()
    mount(h(Harness))
    expect(api.config?.filters).toHaveLength(1)

    act(() => { api.resetConfig!({ action_scope: 'created' }) })

    // The stale override is gone; what's left is the baseline's scope filter.
    expect(api.config?.filters).toEqual([
      { id: '__scope_assignee', field: 'user_id', operator: 'is', value: '@me' },
    ])
    expect(api.config?.layout).toBe('board')
    const persisted = JSON.parse(window.localStorage.getItem(DEFAULT_BASELINE_KEY)!)
    expect(persisted.overrides.filters).toBeUndefined()
    expect(persisted.overrides.layout).toBe('board')
  })

  it('"All issues" leaves no scope filter, so unassigned rows stay visible', () => {
    const { api, Harness } = makeHarness()
    mount(h(Harness))

    act(() => { api.resetConfig!({ action_scope: 'assigned' }) })
    expect(api.config?.filters).toHaveLength(1)

    act(() => { api.resetConfig!({ action_scope: 'all' }) })
    expect(api.config?.filters).toEqual([])
  })

  it('leaves the baseline slot empty when there was no draft to preserve', () => {
    const { api, Harness } = makeHarness()
    mount(h(Harness))

    act(() => { api.resetConfig!({ action_scope: 'assigned' }) })

    expect(window.localStorage.getItem(DEFAULT_BASELINE_KEY)).toBeNull()
  })

  // ── Workspace span ────────────────────────────────────────────────────────
  //
  // The span is the app's "Show all workspaces" switch, handed in as
  // useViewConfig's `workspaceScope` — the list holds no state of its own for
  // it. What is worth pinning is the @me filter the "Assigned to me" tab puts
  // in the baseline: across workspaces it has to go (`@me` resolves to the
  // active workspace's member id only, and the query route drops `action_scope`
  // the moment such a filter is present), and it has to come back — without
  // taking the user's own filters or layout with it.

  /** The same harness, with the switch as a prop the test can flip. */
  function makeSpanHarness() {
    const api: {
      config?: ViewConfig
      isDirty?: boolean
      resetConfig?: (o: Partial<ViewConfig>) => void
      updateConfig?: (o: Partial<ViewConfig>) => void
    } = {}
    function Harness({ scope }: { scope: 'workspace' | 'all' }) {
      const v = useViewConfig(null, 'action', undefined, false, undefined, scope)
      api.config = v.config
      api.isDirty = v.isDirty
      api.resetConfig = v.resetConfig
      api.updateConfig = v.updateConfig
      return null
    }
    return { api, Harness }
  }

  it('defaults to the active workspace alone', () => {
    const { api, Harness } = makeHarness()
    mount(h(Harness))
    expect(api.config?.workspace_scope).toBe('workspace')
  })

  it('takes the span it is handed, and drops the @me filter across workspaces', () => {
    const { api, Harness } = makeSpanHarness()
    mount(h(Harness, { scope: 'workspace' }))

    act(() => { api.resetConfig!({ action_scope: 'assigned' }) })
    expect(api.config?.filters).toEqual([
      { id: '__scope_assignee', field: 'assignee_id', operator: 'is', value: '@me' },
    ])

    act(() => { root.render(h(Harness, { scope: 'all' })) })

    expect(api.config?.workspace_scope).toBe('all')
    // The tab selection is untouched — it is what the request body sends as
    // action_scope — but the filter that would have shadowed it is gone.
    expect(api.config?.action_scope).toBe('assigned')
    expect(api.config?.filters).toEqual([])
  })

  it('coming back to this workspace restores the tab\'s @me filter', () => {
    const { api, Harness } = makeSpanHarness()
    mount(h(Harness, { scope: 'workspace' }))

    act(() => { api.resetConfig!({ action_scope: 'created' }) })
    act(() => { root.render(h(Harness, { scope: 'all' })) })
    expect(api.config?.filters).toEqual([])

    act(() => { root.render(h(Harness, { scope: 'workspace' })) })

    expect(api.config?.workspace_scope).toBe('workspace')
    expect(api.config?.filters).toEqual([
      { id: '__scope_assignee', field: 'user_id', operator: 'is', value: '@me' },
    ])
  })

  it('a flip keeps the user\'s own filters, refitting only the tab\'s', () => {
    const own = { id: 'mine', field: 'priority', operator: 'is' as const, value: 'high' }
    const { api, Harness } = makeSpanHarness()
    mount(h(Harness, { scope: 'workspace' }))

    act(() => { api.resetConfig!({ action_scope: 'assigned' }) })
    act(() => { api.updateConfig!({ filters: [...api.config!.filters, own] }) })
    expect(api.config?.filters).toEqual([
      { id: '__scope_assignee', field: 'assignee_id', operator: 'is', value: '@me' },
      own,
    ])

    act(() => { root.render(h(Harness, { scope: 'all' })) })
    expect(api.config?.filters).toEqual([own])

    // A filter added while spanning every workspace survives the way back,
    // and the tab's filter returns in front of it.
    act(() => { root.render(h(Harness, { scope: 'workspace' })) })
    expect(api.config?.filters).toEqual([
      { id: '__scope_assignee', field: 'assignee_id', operator: 'is', value: '@me' },
      own,
    ])
  })

  it('a draft holding the tab\'s @me filter never narrows a list that spans every workspace', () => {
    // Written while this list was in one workspace (or by an older build);
    // restored with the switch on.
    window.localStorage.setItem(
      DEFAULT_BASELINE_KEY,
      JSON.stringify({
        overrides: {
          filters: [
            { id: '__scope_assignee', field: 'assignee_id', operator: 'is', value: '@me' },
            { id: 'mine', field: 'priority', operator: 'is', value: 'high' },
          ],
        },
        savedAt: Date.now(),
      }),
    )
    const { api, Harness } = makeSpanHarness()
    mount(h(Harness, { scope: 'all' }))
    expect(api.config?.filters).toEqual([{ id: 'mine', field: 'priority', operator: 'is', value: 'high' }])
  })

  it('preserves a board-layout draft across a flip of the switch', () => {
    window.localStorage.setItem(
      DEFAULT_BASELINE_KEY,
      JSON.stringify({ overrides: { layout: 'board' }, savedAt: Date.now() }),
    )

    const { api, Harness } = makeSpanHarness()
    mount(h(Harness, { scope: 'workspace' }))

    act(() => { root.render(h(Harness, { scope: 'all' })) })

    expect(api.config?.layout).toBe('board')
    expect(api.config?.workspace_scope).toBe('all')
    act(() => { root.render(h(Harness, { scope: 'workspace' })) })
    expect(api.config?.layout).toBe('board')
  })
})

// ── useView: a failed fetch must not erase the selection ─────────────────────

describe('useView phantom-view sweep', () => {
  function makeHarness() {
    const api: { activeViewId?: string | null } = {}
    function Harness() {
      const v = useView('action')
      api.activeViewId = v.activeViewId
      return null
    }
    return { api, Harness }
  }

  const STORAGE_KEY = 'dial8:active-view:ws-1:action:noteam:global'

  /** Let the fetch promise + its state updates flush. */
  async function settle() {
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  }

  it('keeps the persisted selection when the views fetch FAILS', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'view-a')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const { api, Harness } = makeHarness()
    mount(h(Harness))
    await settle()

    expect(api.activeViewId).toBe('view-a')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('view-a')
  })

  it('keeps the persisted selection on a non-ok response', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'view-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const { api, Harness } = makeHarness()
    mount(h(Harness))
    await settle()

    expect(api.activeViewId).toBe('view-a')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('view-a')
  })

  it('drops the selection when a SUCCESSFUL fetch no longer lists it', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'view-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ views: [{ id: 'view-b', name: 'B' }] }),
    }))

    const { api, Harness } = makeHarness()
    mount(h(Harness))
    await settle()

    expect(api.activeViewId).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('keeps the selection when a successful fetch DOES list it', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'view-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ views: [{ id: 'view-a', name: 'A' }] }),
    }))

    const { api, Harness } = makeHarness()
    mount(h(Harness))
    await settle()

    expect(api.activeViewId).toBe('view-a')
  })
})
