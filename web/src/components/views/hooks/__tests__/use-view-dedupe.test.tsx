// @vitest-environment jsdom
/**
 * Request sharing between mounted lists (perf plan 1.4).
 *
 * The windowed dashboard keeps every window of every tab mounted, and several
 * windows often show the same list. Each runs its own useView/useViewResults,
 * so without sharing N windows on one view sent N identical views-list GETs and
 * N identical page-1 queries on mount — and N more for every realtime-driven
 * refetch. These tests pin the sharing AND its limits, because every limit is a
 * way to show a window the wrong data:
 *   - only identical page-1 queries share; other queries and load-more pages
 *     never do;
 *   - a failure reaches every list waiting on the request, exactly as each
 *     list's own request used to fail it;
 *   - a request sent before an entity event is never handed to a list that
 *     asks after it, and an explicit refetch always sends its own;
 *   - one list moving on (or unmounting) never aborts a request another list
 *     is still waiting on.
 *
 * The first block drives the REAL hooks in the order unified-view-layout
 * composes them; the last drives two REAL UnifiedViewLayouts (children and
 * lookup hooks stubbed) to prove the realtime/reconnect refetches coalesce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactElement } from 'react'
import type { ViewConfig } from '../use-view'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'm-1',
}))
// Only has to not drag the supabase client into a jsdom run.
vi.mock('@/hooks/use-realtime-entities', () => ({
  acquireCrossWorkspaceTable: () => () => {},
}))
// UnifiedViewLayout's lookup hooks and children — inert; the refetch wiring
// lives above rendering.
vi.mock('../use-picker-context', () => ({
  usePickerContext: () => ({ workflowStatesByTeam: {} }),
}))
vi.mock('../use-flow-status-ids', () => ({ useFlowStatusIds: () => ({}) }))
vi.mock('../use-bulk-selection', () => ({
  useBulkSelection: () => ({
    selectedIds: new Set<string>(), count: 0, hasSelection: false,
    clear: vi.fn(), toggle: vi.fn(), selectAll: vi.fn(),
  }),
}))
vi.mock('../../bulk-actions/use-bulk-actions', () => ({
  useBulkActions: () => ({ execute: vi.fn() }),
}))
vi.mock('../../view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('../../view-list', () => ({ ViewList: () => null }))
vi.mock('../../view-board', () => ({ ViewBoard: () => null }))

import { useView, useViewResults } from '../use-view'
import { UnifiedViewLayout } from '../../unified-view-layout'

// ── Controllable fetch ───────────────────────────────────────────────────────

interface Call {
  url: string
  body: Record<string, unknown> | null
  signal: AbortSignal | null
  resolve: (body: unknown, status?: number) => void
  reject: (err: Error) => void
}

let calls: Call[] = []

function installFetch() {
  globalThis.fetch = ((input: unknown, init?: RequestInit) =>
    new Promise((res, rej) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        signal: init?.signal ?? null,
        // A minimal Response: the hooks only read `ok` and `json()`.
        resolve: (body, status = 200) =>
          res({ ok: status >= 200 && status < 300, status, json: async () => body } as Response),
        reject: rej,
      })
    })) as typeof fetch
}

const queryCalls = () => calls.filter((c) => c.url === '/api/account/views/query')
const viewsCalls = () => calls.filter((c) => c.url.startsWith('/api/account/views?'))

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function respond(call: Call, body: unknown, status?: number) {
  call.resolve(body, status)
  await flush()
}

async function fail(call: Call, err: Error) {
  call.reject(err)
  await flush()
}

const rows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, title: `${prefix} ${i + 1}` }))
const ids = (data: unknown) => (data as Array<{ id: string }>).map((r) => r.id)

// ── Harness: the REAL composition order ─────────────────────────────────────

const baseConfig = {
  filters: [],
  grouping: null,
  sub_grouping: null,
  ordering: [{ field: 'created_at', direction: 'desc' }],
  display_properties: [],
  layout: 'list',
  board_group_by: null,
  show_completed: true,
  completed_filter: 'all',
  show_sub_items: true,
  nested_sub_items: false,
  show_empty_groups: false,
  action_scope: 'all',
  workspace_scope: 'workspace',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as ViewConfig

type Results = ReturnType<typeof useViewResults>
const lists: Record<string, Results> = {}
const report = (id: string, results: Results) => { lists[id] = results }

// viewResultsCache is module-level and outlives each test, so every test
// queries under its own search term — no test starts from another's cache.
let testTag = 0

function List({ id, search = '' }: { id: string; search?: string }) {
  const { activeViewId } = useView('action')
  report(id, useViewResults(activeViewId, baseConfig, 'action', undefined, undefined, `t${testTag}${search}`))
  return null
}

/** Render these lists side by side (a stable `id` keeps a list mounted across calls). */
const renderLists = (...specs: Array<{ id: string; search?: string }>) =>
  mount(h('div', null, ...specs.map((s) => h(List, { key: s.id, ...s }))))

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

function mount(node: ReactElement) {
  act(() => { root.render(node) })
}

beforeEach(() => {
  testTag += 1
  calls = []
  installFetch()
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
})

// ── Load-more ───────────────────────────────────────────────────────────────

describe('useViewResults — load-more', () => {
  const pageCalls = (page: number) => queryCalls().filter((c) => c.body?.page === page)

  it('a load-more superseded by a page-1 refetch does not leave loading-more stuck', async () => {
    renderLists({ id: 'a' })
    await respond(queryCalls()[0], { data: rows('p1-', 50), total: 150 })

    act(() => { lists.a.loadMore() })
    expect(lists.a.loadingMore).toBe(true)
    // A realtime refetch / filter edit lands before page 2 does.
    act(() => { lists.a.refetch() })
    await respond(pageCalls(1).at(-1)!, { data: rows('p1-', 50), total: 150 })
    await respond(pageCalls(2)[0], { data: rows('stale2-', 50), total: 150 })

    expect(lists.a.loadingMore).toBe(false)
    act(() => { lists.a.loadMore() })
    expect(pageCalls(2)).toHaveLength(2)
  })

  it('a failed load-more asks for the same page again, not the next one', async () => {
    renderLists({ id: 'a' })
    await respond(queryCalls()[0], { data: rows('p1-', 50), total: 150 })

    act(() => { lists.a.loadMore() })
    await respond(pageCalls(2)[0], { error: 'boom' }, 500)
    act(() => { lists.a.loadMore() })

    expect(pageCalls(2)).toHaveLength(2)
    expect(pageCalls(3)).toHaveLength(0)
  })
})

// ── Hooks ───────────────────────────────────────────────────────────────────

describe('useView / useViewResults — requests shared by lists on the same query', () => {
  it('two lists mounted together send ONE views GET and ONE query POST, and both get its rows', async () => {
    renderLists({ id: 'a' }, { id: 'b' })

    expect(viewsCalls()).toHaveLength(1)
    expect(queryCalls()).toHaveLength(1)

    await respond(queryCalls()[0], { data: rows('r', 2), total: 2 })

    for (const list of [lists.a, lists.b]) {
      expect(ids(list.data)).toEqual(['r1', 'r2'])
      expect(list.totalCount).toBe(2)
      expect(list.loading).toBe(false)
    }
  })

  it('lists on different queries each send their own POST', () => {
    renderLists({ id: 'a' }, { id: 'b', search: '-other' })

    expect(queryCalls()).toHaveLength(2)
    expect(queryCalls()[0].body?.search).not.toBe(queryCalls()[1].body?.search)
    // Same entity type and team → the saved-views list is still one request.
    expect(viewsCalls()).toHaveLength(1)
  })

  it('never merges load-more pages', async () => {
    renderLists({ id: 'a' }, { id: 'b' })
    await respond(queryCalls()[0], { data: rows('p1-', 50), total: 150 })

    act(() => {
      lists.a.loadMore()
      lists.b.loadMore()
    })

    const pageTwo = queryCalls().filter((c) => c.body?.page === 2)
    expect(pageTwo).toHaveLength(2)

    await respond(pageTwo[0], { data: rows('a2-', 50), total: 150 })
    await respond(pageTwo[1], { data: rows('b2-', 50), total: 150 })
    // Each list appended its OWN page 2.
    expect(ids(lists.a.data)).toContain('a2-1')
    expect(ids(lists.a.data)).not.toContain('b2-1')
    expect(ids(lists.b.data)).toContain('b2-1')
    expect(ids(lists.b.data)).not.toContain('a2-1')
  })

  it('a failed shared request fails every waiting list the way its own request did', async () => {
    renderLists({ id: 'a' }, { id: 'b' })
    await respond(queryCalls()[0], { data: rows('r', 2), total: 2 })

    // Two automatic refetches of the same query → one request.
    act(() => {
      lists.a.refetch({ coalesce: true })
      lists.b.refetch({ coalesce: true })
    })
    expect(queryCalls()).toHaveLength(2)

    await fail(queryCalls()[1], new TypeError('Failed to fetch'))

    // The per-instance catch: rows cleared, count zeroed, spinner off — for both.
    for (const list of [lists.a, lists.b]) {
      expect(list.data).toEqual([])
      expect(list.totalCount).toBe(0)
      expect(list.loading).toBe(false)
    }
  })

  it('an explicit refetch() always sends its own request', async () => {
    renderLists({ id: 'a' }, { id: 'b' })
    await respond(queryCalls()[0], { data: rows('r', 1), total: 1 })

    act(() => {
      lists.a.refetch()
      lists.b.refetch()
    })

    expect(queryCalls()).toHaveLength(3)
  })

  it('a request sent before an entity event is not handed to a list that asks after it', async () => {
    renderLists({ id: 'a' })
    // A list mounting while the request is in flight joins it…
    renderLists({ id: 'a' }, { id: 'b' })
    expect(queryCalls()).toHaveLength(1)

    // …but once a change has been heard of, that request may predate it.
    act(() => {
      window.dispatchEvent(new CustomEvent('dial8:entity-updated', {
        detail: { entityType: 'action', id: 'x', fields: { title: 'renamed' } },
      }))
    })
    renderLists({ id: 'a' }, { id: 'b' }, { id: 'c' })
    expect(queryCalls()).toHaveLength(2)

    await respond(queryCalls()[0], { data: rows('old', 1), total: 1 })
    await respond(queryCalls()[1], { data: rows('new', 1), total: 1 })
    expect(ids(lists.a.data)).toEqual(['old1'])
    expect(ids(lists.b.data)).toEqual(['old1'])
    expect(ids(lists.c.data)).toEqual(['new1'])
  })

  it('a list moving to another query does not abort the request the other list still waits on', async () => {
    renderLists({ id: 'a' }, { id: 'b' })
    const shared = queryCalls()[0]

    renderLists({ id: 'a', search: '-moved' }, { id: 'b' })
    expect(queryCalls()).toHaveLength(2)
    expect(shared.signal?.aborted).toBe(false)

    await respond(shared, { data: rows('r', 2), total: 2 })
    await respond(queryCalls()[1], { data: rows('m', 1), total: 1 })
    expect(ids(lists.b.data)).toEqual(['r1', 'r2'])
    // A ignored the superseded answer (generation check) and shows its own.
    expect(ids(lists.a.data)).toEqual(['m1'])
  })

  it('the last list out of a superseded request aborts it, as the per-instance fetch did', () => {
    renderLists({ id: 'a' })
    const first = queryCalls()[0]

    renderLists({ id: 'a', search: '-moved' })

    expect(first.signal?.aborted).toBe(true)
    expect(queryCalls()).toHaveLength(2)
  })

  it('an unmounted list leaves its request running (it still fills the cache) but no later mount joins it', async () => {
    renderLists({ id: 'a' })
    const orphan = queryCalls()[0]

    mount(h('div'))
    expect(orphan.signal?.aborted).toBe(false)

    renderLists({ id: 'b' })
    expect(queryCalls()).toHaveLength(2)

    // The orphan still lands in the stale-while-revalidate cache…
    await respond(orphan, { data: rows('cached', 1), total: 1 })
    mount(h('div'))
    renderLists({ id: 'c' })
    // …so the next mount renders it instantly (and revalidates on its own).
    expect(ids(lists.c.data)).toEqual(['cached1'])
    expect(queryCalls()).toHaveLength(3)
  })
})

// ── The realtime / reconnect wiring in UnifiedViewLayout ────────────────────

describe('UnifiedViewLayout — automatic refetches coalesce across lists on one query', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  async function mountTwoLayouts() {
    mount(h('div', null,
      h(UnifiedViewLayout, { key: 'a', entityType: 'action' as const }),
      h(UnifiedViewLayout, { key: 'b', entityType: 'action' as const }),
    ))
    // The mount itself is already shared.
    expect(queryCalls()).toHaveLength(1)
    await respond(queryCalls()[0], { data: rows('r', 2), total: 2 })
  }

  it('a realtime event both lists refetch on (300 ms debounce each) sends ONE request', async () => {
    await mountTwoLayouts()

    act(() => {
      window.dispatchEvent(new CustomEvent('dial8:entity-created', { detail: { entityType: 'action' } }))
    })
    expect(queryCalls()).toHaveLength(1)

    act(() => { vi.advanceTimersByTime(300) })
    expect(queryCalls()).toHaveLength(2)

    act(() => { vi.advanceTimersByTime(1000) })
    expect(queryCalls()).toHaveLength(2)
  })

  it('the reconnect refetch (dial8:realtime-recovered) is shared too', async () => {
    await mountTwoLayouts()

    act(() => { window.dispatchEvent(new CustomEvent('dial8:realtime-recovered')) })

    expect(queryCalls()).toHaveLength(2)
  })
})
