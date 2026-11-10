// @vitest-environment jsdom
/**
 * The workspace badge, on the two surfaces that draw rows.
 *
 * In "All workspaces" scope a My Actions list mixes rows from every workspace
 * the user belongs to, and nothing else on the row says which one it came
 * from: identifiers are per-workspace (two workspaces both have an ENG-1),
 * statuses are merged by category, and the assignee is the same person
 * everywhere. The badge is the only distinguishing mark, so what is pinned here
 * is when it appears — and, just as load-bearing, when it does NOT: the
 * ordinary single-workspace list is every user's default view, and a badge on
 * every row there would be noise on the app's busiest surface.
 *
 * `activeWorkspaceId === null` (cache still loading) counts as "not foreign" —
 * an unknown active workspace makes every row look foreign, and a list that
 * badges all of its own rows for a beat reads as a bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The active workspace, swapped per test through this hoisted box.
const active = vi.hoisted(() => ({ id: 'ws-1' as string | null }))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => active.id,
  useCurrentMemberId: () => 'member-1',
}))

// The push menu has its own suites; here it would only add fetches.
vi.mock('@/components/tasks/action-platform-cell', () => ({
  ActionPlatformCell: () => null,
}))

const noopRef = () => {}
vi.mock('react-dnd', () => ({
  DndProvider: ({ children }: { children: ReactNode }) => children,
  useDrag: () => [{ isDragging: false, isColumnDragging: false }, noopRef, noopRef],
  useDrop: () => [{ isOver: false, canDrop: false, isColumnOver: false }, noopRef],
}))
vi.mock('react-dnd-html5-backend', () => ({ HTML5Backend: {} }))

class IOStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IOStub

import { EntityRow } from '../list/entity-row'
import { ViewBoard } from '../view-board'
import { isForeignWorkspace, rowWorkspace, rowWorkspaceHeaders } from '../row-workspace'
import type { ViewConfig } from '../hooks/use-view'
import type { GroupedResults } from '@/lib/views/types'

const HOME = { id: 'ws-1', name: 'Native Intelligence', slug: 'dial8', logo_url: null }
const OTHER = { id: 'ws-2', name: 'Acme Sales', slug: 'acme', logo_url: null }

function action(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'act-1', identifier: 'ENG-42', title: 'Ship it', workspace: HOME, ...over }
}

let container: HTMLDivElement
let root: Root

function badges(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-workspace-badge]'))
}

beforeEach(() => {
  active.id = 'ws-1'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderRow(item: Record<string, unknown>, entityType: 'action' | 'capture' = 'action') {
  await act(async () => {
    root.render(
      h(EntityRow, {
        item,
        entityType,
        displayProperties: [],
        isSelected: false,
        onItemSelect: vi.fn(),
      }),
    )
  })
}

function boardConfig(): ViewConfig {
  return {
    filters: [],
    grouping: { field: 'status_id', direction: 'asc' },
    sub_grouping: null,
    ordering: [],
    display_properties: [],
    layout: 'board',
    board_group_by: null,
    show_completed: true,
    completed_filter: 'all',
    show_sub_items: false,
    nested_sub_items: false,
    show_empty_groups: false,
    action_scope: 'all',
    workspace_scope: 'all',
    crm_scope: 'contacts',
    capture_scope: 'all',
  } as ViewConfig
}

async function renderBoard(items: Array<Record<string, unknown>>) {
  const data: GroupedResults[] = [{ key: 'unstarted::Todo', label: 'Todo', items }]
  await act(async () => {
    root.render(
      h(ViewBoard, {
        entityType: 'action' as const,
        data,
        loading: false,
        config: boardConfig(),
        selectedItemId: null,
        onItemSelect: vi.fn(),
      }),
    )
  })
}

describe('list row', () => {
  it('badges a row from another workspace, with that workspace\'s name', async () => {
    await renderRow(action({ workspace: OTHER }))
    expect(badges()).toHaveLength(1)
    expect(badges()[0].getAttribute('data-workspace-badge')).toBe('ws-2')
    expect(badges()[0].textContent).toContain('Acme Sales')
  })

  it('draws NOTHING for a row in the active workspace', async () => {
    await renderRow(action())
    expect(badges()).toHaveLength(0)
  })

  it('draws nothing for a row with no workspace embed (every non-action entity)', async () => {
    await renderRow({ id: 'cap-1', title: 'Standup' }, 'capture')
    expect(badges()).toHaveLength(0)
  })

  it('draws nothing while the active workspace is still unknown', async () => {
    active.id = null
    await renderRow(action({ workspace: OTHER }))
    expect(badges()).toHaveLength(0)
  })
})

describe('board card', () => {
  it('badges only the foreign cards in a merged column', async () => {
    // A category column in personal scope holds cards from several workspaces
    // at once — this is exactly the mix the badge exists for.
    await renderBoard([
      action({ id: 'act-1', workspace: HOME }),
      action({ id: 'act-2', workspace: OTHER }),
    ])
    expect(badges().map((b) => b.getAttribute('data-workspace-badge'))).toEqual(['ws-2'])
  })

  it('a single-workspace board carries no badges at all', async () => {
    await renderBoard([action({ id: 'act-1' }), action({ id: 'act-2' })])
    expect(badges()).toHaveLength(0)
  })
})

// ── The rule itself ─────────────────────────────────────────────────────────
// Both surfaces defer to these two functions, so the edge cases are pinned
// once here rather than twice through the DOM.

describe('rowWorkspace / isForeignWorkspace', () => {
  it('reads the embed off a row', () => {
    expect(rowWorkspace(action({ workspace: OTHER }))).toMatchObject({ id: 'ws-2', name: 'Acme Sales' })
  })

  it('returns null for a row with no embed, a null embed, or a malformed one', () => {
    expect(rowWorkspace({ id: 'a' })).toBeNull()
    expect(rowWorkspace({ id: 'a', workspace: null })).toBeNull()
    expect(rowWorkspace({ id: 'a', workspace: { name: 'No id' } })).toBeNull()
    expect(rowWorkspace(undefined)).toBeNull()
  })

  it('falls back to a generic name rather than rendering an empty badge', () => {
    expect(rowWorkspace({ id: 'a', workspace: { id: 'ws-9' } })?.name).toBe('Workspace')
  })

  it('is foreign only when both ids are known and differ', () => {
    expect(isForeignWorkspace(OTHER, 'ws-1')).toBe(true)
    expect(isForeignWorkspace(HOME, 'ws-1')).toBe(false)
    expect(isForeignWorkspace(OTHER, null)).toBe(false)
    expect(isForeignWorkspace(null, 'ws-1')).toBe(false)
  })

  // The same rule, as the request paths consume it. Empty for anything that
  // isn't foreign — spreading `{}` into a headers object leaves the request
  // byte-identical, which is what keeps the default path untouched.
  it('names the row\'s workspace in a header, and only for a foreign row', () => {
    expect(rowWorkspaceHeaders(action({ workspace: OTHER }), 'ws-1')).toEqual({ 'x-workspace-id': 'ws-2' })
    expect(rowWorkspaceHeaders(action(), 'ws-1')).toEqual({})
    expect(rowWorkspaceHeaders({ id: 'a' }, 'ws-1')).toEqual({})
    expect(rowWorkspaceHeaders(undefined, 'ws-1')).toEqual({})
    expect(rowWorkspaceHeaders(action({ workspace: OTHER }), null)).toEqual({})
  })
})
