// @vitest-environment jsdom
/**
 * WRITING TO A ROW THAT LIVES IN ANOTHER WORKSPACE.
 *
 * Reading across workspaces was the easy half. Every write the views layer
 * issues — an inline property edit, a board drag, a bulk action — goes to a
 * route that resolves its ids against ONE workspace, chosen by the request's
 * `x-workspace-id` header (which the fetch interceptor fills from the ACTIVE
 * workspace when the caller hasn't set it). So in "All workspaces" scope every
 * write about a foreign row would look up that id in the wrong workspace, 404,
 * and roll the optimistic update back — a list you can read but not touch, with
 * a bare "HTTP 404" as the only explanation.
 *
 * The fix is the override the attention rail already uses: name the ROW's
 * workspace. The server re-verifies membership on the header, so this says
 * WHICH of the user's workspaces to act in, never widens what they may touch.
 *
 * The other half of the contract, pinned just as hard: a same-workspace row's
 * request must be UNCHANGED — no header at all. That is every row on every
 * other surface in the app, and this is the busiest write path there is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewConfig } from '../hooks/use-view'
import type { GroupedResults } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOME_WS = { id: 'ws-1', name: 'Native Intelligence' }
const OTHER_WS = { id: 'ws-2', name: 'Acme Sales' }

const HOME_ROW = { id: 'act-1', title: 'Ship it', priority: 'low', workspace: HOME_WS }
const FOREIGN_ROW = { id: 'act-9', title: 'Renew contract', priority: 'low', workspace: OTHER_WS }

// What the mocked view hooks hand the layout. Set per test before mounting.
const view = vi.hoisted(() => ({
  config: {} as ViewConfig,
  data: [] as unknown,
}))

vi.mock('../hooks/use-view', () => ({
  useView: () => ({
    views: [],
    activeViewId: null,
    activeView: null,
    setActiveViewId: vi.fn(),
    createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
  }),
  useViewConfig: () => ({
    config: view.config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false,
    saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
  }),
  useViewResults: () => ({
    data: view.data, loading: false, loadingMore: false, totalCount: 0, hasMore: false,
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
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'm1',
}))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({ useCanOpenCards: () => true }))

const toasts = vi.hoisted(() => ({ errors: [] as string[] }))
vi.mock('sonner', () => ({
  toast: Object.assign(
    (msg: string) => { void msg },
    {
      error: (msg: string) => { toasts.errors.push(msg) },
      success: () => {},
      message: () => {},
    },
  ),
}))

// Capture the write callbacks the two surfaces are handed.
type PatchFn = (id: string, fields: Record<string, unknown>) => void
type MoveFn = (ids: string[], from: string, to: string) => void
type CanEditFn = (item: Record<string, unknown>, property: string) => boolean
let onPatch: PatchFn | null = null
let canEdit: CanEditFn | null = null
let onMoveItem: MoveFn | null = null
vi.mock('../view-list', () => ({
  ViewList: (props: { onPatch?: PatchFn; canEdit?: CanEditFn }) => {
    onPatch = props.onPatch ?? null
    canEdit = props.canEdit ?? null
    return null
  },
}))
vi.mock('../view-board', () => ({
  ViewBoard: (props: { onMoveItem?: MoveFn }) => {
    onMoveItem = props.onMoveItem ?? null
    return null
  },
}))
vi.mock('../view-toolbar', () => ({ ViewToolbar: () => null }))

// The REAL bulk hook — its per-workspace partitioning is part of what's pinned.
import { UnifiedViewLayout } from '../unified-view-layout'

// ── Recording fetch ─────────────────────────────────────────────────────────

interface Call {
  url: string
  method: string
  workspaceHeader: string | null
  body: Record<string, unknown> | null
}
let calls: Call[] = []

function installFetch(ok = true) {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      workspaceHeader: headers.get('x-workspace-id'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    return Promise.resolve(
      new Response(JSON.stringify({ success: 1, failed: 0, actions: [] }), {
        status: ok ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

function baseConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return {
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
    action_scope: 'assigned',
    workspace_scope: 'all',
    crm_scope: 'contacts',
    capture_scope: 'all',
    ...over,
  } as ViewConfig
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  onPatch = null
  canEdit = null
  onMoveItem = null
  toasts.errors = []
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
})

async function mountLayout() {
  // Async so the layout's mount effects settle inside act — otherwise the
  // synchronous assertions below race them and React warns.
  await act(async () => {
    root.render(h(UnifiedViewLayout, { entityType: 'action' as const }))
    await Promise.resolve()
  })
}

/** The PATCHes that went to the actions route, in order. */
const patches = () => calls.filter((c) => c.method === 'PATCH' && c.url.includes('/api/account/actions/'))

// ── Inline property edits ───────────────────────────────────────────────────

describe('inline edit', () => {
  beforeEach(() => {
    view.config = baseConfig()
    view.data = [HOME_ROW, FOREIGN_ROW]
  })

  it('names the row\'s workspace when editing a foreign row', async () => {
    await mountLayout()
    await act(async () => {
      onPatch!('act-9', { priority: 'high' })
      await Promise.resolve()
    })

    expect(patches()).toHaveLength(1)
    expect(patches()[0].url).toContain('act-9')
    expect(patches()[0].workspaceHeader).toBe('ws-2')
    expect(patches()[0].body).toEqual({ priority: 'high' })
  })

  it('sends NO x-workspace-id for a row in the active workspace', async () => {
    await mountLayout()
    await act(async () => {
      onPatch!('act-1', { priority: 'high' })
      await Promise.resolve()
    })

    expect(patches()).toHaveLength(1)
    // Absent, so the interceptor fills in the active workspace exactly as it
    // always has — the default path is untouched.
    expect(patches()[0].workspaceHeader).toBeNull()
  })

  // Reaching the right workspace is only half of being correct. The inline
  // pickers are fed by this workspace's lookups, so on a foreign row the
  // lookup-valued cells must not be editable at all — otherwise the PATCH now
  // lands in the row's workspace carrying an id from another one.
  it('leaves lookup-valued cells read-only on a foreign row', async () => {
    await mountLayout()
    expect(canEdit!(FOREIGN_ROW, 'status')).toBe(false)
    expect(canEdit!(FOREIGN_ROW, 'assignee')).toBe(false)
    expect(canEdit!(FOREIGN_ROW, 'project')).toBe(false)
    expect(canEdit!(FOREIGN_ROW, 'labels')).toBe(false)
  })

  it('keeps plain values editable on a foreign row', async () => {
    // A priority and a date mean the same thing in any workspace, and they are
    // most of what anyone edits from a list.
    await mountLayout()
    expect(canEdit!(FOREIGN_ROW, 'priority')).toBe(true)
    expect(canEdit!(FOREIGN_ROW, 'due_at')).toBe(true)
  })

  it('leaves every cell editable on a row in the active workspace', async () => {
    await mountLayout()
    expect(canEdit!(HOME_ROW, 'status')).toBe(true)
    expect(canEdit!(HOME_ROW, 'project')).toBe(true)
    expect(canEdit!(HOME_ROW, 'priority')).toBe(true)
  })
})

// ── Board drag-and-drop ─────────────────────────────────────────────────────

describe('board drag-and-drop', () => {
  beforeEach(() => {
    view.config = baseConfig({ layout: 'board', grouping: { field: 'priority', direction: 'asc' } })
    view.data = [
      { key: 'low', label: 'Low', items: [HOME_ROW, FOREIGN_ROW] },
      { key: 'high', label: 'High', items: [] },
    ] as GroupedResults[]
  })

  it('names each dragged card\'s own workspace', async () => {
    await mountLayout()
    await act(async () => {
      onMoveItem!(['act-9'], 'low', 'high')
      await Promise.resolve()
    })

    expect(patches()).toHaveLength(1)
    expect(patches()[0].url).toContain('act-9')
    expect(patches()[0].workspaceHeader).toBe('ws-2')
    expect(patches()[0].body).toEqual({ priority: 'high' })
  })

  it('a same-workspace card still drags with no header', async () => {
    await mountLayout()
    await act(async () => {
      onMoveItem!(['act-1'], 'low', 'high')
      await Promise.resolve()
    })

    expect(patches()[0].workspaceHeader).toBeNull()
  })

  it('refuses to drop a foreign card into a column keyed by a workspace-scoped id', async () => {
    // Grouped by project here: the column key IS a project UUID belonging to
    // one workspace. Before the header fix this PATCH 404'd harmlessly; now it
    // would reach the card's own workspace carrying a project id from another.
    view.config = baseConfig({ layout: 'board', grouping: { field: 'project_id', direction: 'asc' } })
    view.data = [
      { key: 'proj-a', label: 'Apollo', items: [HOME_ROW, FOREIGN_ROW] },
      { key: 'proj-b', label: 'Borealis', items: [] },
    ] as GroupedResults[]
    await mountLayout()

    await act(async () => {
      onMoveItem!(['act-9'], 'proj-a', 'proj-b')
      await Promise.resolve()
    })

    expect(patches()).toHaveLength(0)
    // Refused with the reason, naming where the card actually lives, rather
    // than optimistically moving and springing back on a 400.
    expect(toasts.errors.join(' ')).toContain('Acme Sales')
  })

  it('still lets a same-workspace card move on that same board', async () => {
    view.config = baseConfig({ layout: 'board', grouping: { field: 'project_id', direction: 'asc' } })
    view.data = [
      { key: 'proj-a', label: 'Apollo', items: [HOME_ROW, FOREIGN_ROW] },
      { key: 'proj-b', label: 'Borealis', items: [] },
    ] as GroupedResults[]
    await mountLayout()

    await act(async () => {
      onMoveItem!(['act-1'], 'proj-a', 'proj-b')
      await Promise.resolve()
    })

    expect(patches()).toHaveLength(1)
    expect(patches()[0].body).toEqual({ project_id: 'proj-b' })
    expect(toasts.errors).toEqual([])
  })

  it('a MULTI-card drag headers each card independently', async () => {
    // Multi-select drag carries every checked id in one gesture, and in this
    // scope those ids can belong to different workspaces. One shared header
    // would send half the batch to the wrong place.
    await mountLayout()
    await act(async () => {
      onMoveItem!(['act-1', 'act-9'], 'low', 'high')
      await Promise.resolve()
      await Promise.resolve()
    })

    const byId = new Map(patches().map((c) => [c.url.split('/').pop(), c.workspaceHeader]))
    expect(byId.get('act-1')).toBeNull()
    expect(byId.get('act-9')).toBe('ws-2')
  })
})
