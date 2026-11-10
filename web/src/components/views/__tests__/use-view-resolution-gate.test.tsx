// @vitest-environment jsdom
/**
 * Saved-view resolution gate (perf audit 13.3).
 *
 * A persisted activeViewId means the user left this list sitting on a saved
 * view. On mount the views list hasn't loaded, so useViewConfig is still
 * handing useViewResults the DEFAULT config — and the old code fired the
 * expensive query engine with it immediately, then fired the real query the
 * moment the view resolved. Every saved-view mount cost two server-side
 * queries, the first of which nobody ever saw (the captures default is grouped
 * → per_page 500, so the wasted one is the expensive one).
 *
 * The gate holds useViewResults' INITIAL fetch while useView is still
 * resolving the same id. Two properties are load-bearing and both are failure
 * modes that would be invisible in manual testing:
 *   - the hold must release on BOTH outcomes of the views fetch (a failed
 *     fetch that never releases = a permanently empty list with no request in
 *     flight), and
 *   - two lists mounted on the same saved view must hold independent marks, so
 *     one settling early can't un-gate the other.
 *
 * These tests drive the REAL hooks composed in the real order
 * (useView → useViewResults), against a controllable fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewConfig } from '../hooks/use-view'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
}))

import { useView, useViewResults } from '../hooks/use-view'

// ── Controllable fetch ───────────────────────────────────────────────────────

interface Deferred {
  url: string
  resolve: (body: unknown, status?: number) => void
  reject: (err: Error) => void
}

let pending: Deferred[] = []

function installFetch() {
  globalThis.fetch = ((input: unknown) => {
    const url = String(input)
    return new Promise((res, rej) => {
      pending.push({
        url,
        resolve: (body, status = 200) =>
          res(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
        reject: rej,
      })
    })
  }) as typeof fetch
}

const viewsCalls = () => pending.filter((p) => p.url.startsWith('/api/account/views?'))
const queryCalls = () => pending.filter((p) => p.url === '/api/account/views/query')

/** Settle the oldest un-settled views fetch. */
async function settleViews(outcome: 'ok' | 'fail', views: unknown[] = []) {
  const call = viewsCalls()[0]
  expect(call, 'expected a /api/account/views request in flight').toBeDefined()
  pending = pending.filter((p) => p !== call)
  await act(async () => {
    if (outcome === 'ok') call.resolve({ views })
    else call.reject(new Error('offline'))
    await Promise.resolve()
  })
}

// ── Harness component: the REAL composition order ───────────────────────────

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
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as ViewConfig

function List({ entityType = 'capture' as const, teamId }: { entityType?: 'capture'; teamId?: string }) {
  // Exactly the order unified-view-layout composes them in.
  const { activeViewId } = useView(entityType, teamId)
  useViewResults(activeViewId, baseConfig, entityType, teamId)
  return null
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

const STORAGE_KEY_GLOBAL = 'ni:active-view:ws-1:capture:noteam:global'
const storageKeyForTeam = (teamId: string) => `ni:active-view:ws-1:capture:${teamId}:global`

beforeEach(() => {
  pending = []
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

function mount(node: ReturnType<typeof h>) {
  act(() => {
    root.render(node)
  })
}

// ── The hold ────────────────────────────────────────────────────────────────

describe('saved-view resolution gate — holds the initial query', () => {
  it('holds the initial fetch while a persisted saved view is still resolving', () => {
    localStorage.setItem(STORAGE_KEY_GLOBAL, 'view-abc')
    mount(h(List))

    // The views list IS being fetched…
    expect(viewsCalls()).toHaveLength(1)
    // …but the expensive query engine has NOT run with the default config.
    expect(queryCalls()).toHaveLength(0)
  })

  it('does not hold when there is no persisted saved view (the common default-list mount)', () => {
    mount(h(List))
    expect(queryCalls()).toHaveLength(1)
  })

  it('releases on a SUCCESSFUL views fetch and fires exactly one query', async () => {
    localStorage.setItem(STORAGE_KEY_GLOBAL, 'view-abc')
    mount(h(List))
    expect(queryCalls()).toHaveLength(0)

    await settleViews('ok', [
      { id: 'view-abc', entity_type: 'capture', name: 'My view', filters: [], layout: 'list' },
    ])

    expect(queryCalls()).toHaveLength(1)
  })

  it('releases on a FAILED views fetch too — a network error must not strand the list forever', async () => {
    localStorage.setItem(STORAGE_KEY_GLOBAL, 'view-abc')
    mount(h(List))
    expect(queryCalls()).toHaveLength(0)

    await settleViews('fail')

    // The default config is now the right thing to query — and crucially,
    // SOMETHING is in flight. A permanent hold would show an empty list with
    // no request and no spinner, unrecoverable without a reload.
    expect(queryCalls()).toHaveLength(1)
  })

  it('releases when the views fetch returns a non-OK status', async () => {
    localStorage.setItem(STORAGE_KEY_GLOBAL, 'view-abc')
    mount(h(List))

    const call = viewsCalls()[0]
    pending = pending.filter((p) => p !== call)
    await act(async () => {
      call.resolve({ error: 'boom' }, 500)
      await Promise.resolve()
    })

    expect(queryCalls()).toHaveLength(1)
  })

  it('holds only the INITIAL fetch — it never re-gates once a query has gone out', async () => {
    localStorage.setItem(STORAGE_KEY_GLOBAL, 'view-abc')
    mount(h(List))
    await settleViews('ok', [{ id: 'view-abc', entity_type: 'capture', name: 'v', filters: [], layout: 'list' }])
    expect(queryCalls()).toHaveLength(1)

    // Remounting the same list with a fresh mark must not retroactively
    // suppress the already-running list's future queries; and this new
    // instance holds its own initial fetch until its own views fetch settles.
    const before = queryCalls().length
    mount(h('div', null, h(List), h(List, { key: 'second' })))
    expect(queryCalls().length).toBeGreaterThanOrEqual(before)
  })
})

// ── Per-instance tokens ─────────────────────────────────────────────────────

describe('saved-view resolution gate — two lists on the same saved view', () => {
  it('one list settling does NOT release the other list still resolving the same id', async () => {
    // Both lists persist the SAME saved-view id (different storage keys, same
    // id value) — a module-level boolean flag keyed only by id would let the
    // first settle un-gate the second, which is the whole reason the marks are
    // per-instance token sets.
    localStorage.setItem(storageKeyForTeam('team-a'), 'view-shared')
    localStorage.setItem(storageKeyForTeam('team-b'), 'view-shared')

    mount(h('div', null, h(List, { key: 'a', teamId: 'team-a' }), h(List, { key: 'b', teamId: 'team-b' })))

    expect(viewsCalls()).toHaveLength(2)
    expect(queryCalls()).toHaveLength(0)

    // Settle only the FIRST list's views fetch.
    await settleViews('ok', [{ id: 'view-shared', entity_type: 'capture', name: 'v', filters: [], layout: 'list' }])

    // The other list still holds the id → still zero queries. (Both lists
    // build the same queryKey, so a leaked release would show up as a query
    // firing before the second views fetch settled.)
    expect(queryCalls()).toHaveLength(0)

    // Settle the second — now the gate is clear for both.
    await settleViews('ok', [{ id: 'view-shared', entity_type: 'capture', name: 'v', filters: [], layout: 'list' }])
    expect(queryCalls().length).toBeGreaterThan(0)
  })

  it('unmounting mid-resolution releases that instance mark (no stranded hold for the next mount)', async () => {
    localStorage.setItem(STORAGE_KEY_GLOBAL, 'view-abc')
    mount(h(List))
    expect(queryCalls()).toHaveLength(0)

    // Navigate away before the views fetch lands.
    act(() => {
      root.render(h('div'))
    })
    pending = []

    // Come back. If the previous instance's mark had leaked, this mount would
    // hold forever — its own release can only clear its OWN token.
    mount(h(List))
    await settleViews('ok', [{ id: 'view-abc', entity_type: 'capture', name: 'v', filters: [], layout: 'list' }])
    expect(queryCalls()).toHaveLength(1)
  })
})
