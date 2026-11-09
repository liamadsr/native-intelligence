// @vitest-environment jsdom
/**
 * OPENING A ROW THAT LIVES IN ANOTHER WORKSPACE.
 *
 * With "Show all workspaces" on, My Actions and Projects show rows the active
 * workspace does not
 * contain. Every detail fetch behind the panel resolves its id against the
 * ACTIVE workspace — server-side from the cookie, client-side from the
 * workspace header — so handing a foreign id to the ordinary open path yields a
 * panel that can only say "not found". That failure is invisible in a unit test
 * of the panel and obvious to a user, which is why the fork is pinned here:
 *
 *  - foreign row  → its record card, carrying the row's workspace (P5: every
 *    way in opens a card), so the tabs switch first and put the card in the
 *    incoming workspace's chat; the local open is NOT also fired — two
 *    openings would race a switch;
 *  - same-workspace row → completely unchanged, because that is every row in
 *    the default scope and this code sits on the app's busiest interaction;
 *  - middle-click takes the same fork, and the browser default is swallowed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const config = {
  filters: [],
  grouping: null,
  layout: 'list',
  action_scope: 'assigned',
  workspace_scope: 'all',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

vi.mock('../hooks/use-view', () => ({
  useView: () => ({
    views: [],
    activeViewId: null,
    activeView: null,
    setActiveViewId: vi.fn(),
    createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
  }),
  useViewConfig: () => ({
    config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false,
    saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
  }),
  useViewResults: () => ({
    data: [], loading: false, loadingMore: false, totalCount: 0, hasMore: false,
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
vi.mock('../bulk-actions/use-bulk-actions', () => ({
  useBulkActions: () => ({ execute: vi.fn() }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'm1',
}))

// The tabs provider is there (cards can open); the card requests are the result.
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({ useCanOpenCards: () => true }))
const tabs = vi.hoisted(() => ({ opened: [] as Array<Record<string, unknown>> }))
const onOpenCard = (e: Event) => tabs.opened.push((e as CustomEvent).detail)

// Capture the row-activation callback the list is handed.
let listOnItemSelect:
  | ((id: string, title: string, event?: unknown, item?: Record<string, unknown>) => void)
  | null = null
vi.mock('../view-list', () => ({
  ViewList: (props: { onItemSelect: typeof listOnItemSelect }) => {
    listOnItemSelect = props.onItemSelect
    return null
  },
}))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))
vi.mock('../view-toolbar', () => ({ ViewToolbar: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'

const HOME_ROW = { id: 'act-1', title: 'Ship it', workspace: { id: 'ws-1', name: 'Native Intelligence' } }
const FOREIGN_ROW = { id: 'act-9', title: 'Renew contract', workspace: { id: 'ws-2', name: 'Acme Sales' } }

let container: HTMLDivElement
let root: Root
let onItemSelect: ReturnType<typeof vi.fn>

beforeEach(() => {
  tabs.opened = []
  window.addEventListener('dial8:open-card', onOpenCard)
  listOnItemSelect = null
  onItemSelect = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(h(UnifiedViewLayout, { entityType: 'action' as const, onItemSelect }))
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener('dial8:open-card', onOpenCard)
})

describe('UnifiedViewLayout — activating a cross-workspace row', () => {
  it('opens a foreign row as its record card, carrying ITS workspace', () => {
    act(() => {
      listOnItemSelect!(FOREIGN_ROW.id, FOREIGN_ROW.title, undefined, FOREIGN_ROW)
    })

    expect(tabs.opened).toHaveLength(1)
    expect(tabs.opened[0]).toMatchObject({
      workspaceId: 'ws-2',
      spec: { kind: 'record', title: 'Renew contract', record: { type: 'action', id: 'act-9' } },
    })
  })

  it('does NOT also open the row locally — the two would race the switch', () => {
    act(() => {
      listOnItemSelect!(FOREIGN_ROW.id, FOREIGN_ROW.title, undefined, FOREIGN_ROW)
    })
    expect(onItemSelect).not.toHaveBeenCalled()
  })

  it('leaves a same-workspace row on the ordinary path', () => {
    act(() => {
      listOnItemSelect!(HOME_ROW.id, HOME_ROW.title, undefined, HOME_ROW)
    })

    expect(tabs.opened).toHaveLength(0)
    expect(onItemSelect).toHaveBeenCalledWith(
      'act-1', 'Ship it', undefined, HOME_ROW, 'action',
    )
  })

  it('a row with no workspace embed is never treated as foreign', () => {
    // Rows cached before the embed shipped, and every non-action entity.
    const bare = { id: 'act-0', title: 'Legacy row' }
    act(() => {
      listOnItemSelect!(bare.id, bare.title, undefined, bare)
    })
    expect(tabs.opened).toHaveLength(0)
    expect(onItemSelect).toHaveBeenCalled()
  })

  it('takes the same fork for a middle-click, and swallows the browser default', () => {
    // Middle-click arrives as a MouseEvent the host would read as "open in a
    // background tab". That path is workspace-bound, so the foreign row still
    // has to go through the switch — and the event's default has to be
    // prevented or the browser opens its own tab on top of it.
    const preventDefault = vi.fn()
    act(() => {
      listOnItemSelect!(
        FOREIGN_ROW.id,
        FOREIGN_ROW.title,
        { button: 1, preventDefault } as unknown as React.MouseEvent,
        FOREIGN_ROW,
      )
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(tabs.opened).toHaveLength(1)
    expect(onItemSelect).not.toHaveBeenCalled()
  })

  it('opens a foreign PROJECT as its record card, in its own workspace', () => {
    act(() => {
      root.render(h(UnifiedViewLayout, { entityType: 'project' as const, onItemSelect }))
    })
    const project = { id: 'proj-9', name: 'Spring launch', workspace: { id: 'ws-2', name: 'Acme Sales' } }
    act(() => {
      listOnItemSelect!(project.id, project.name, undefined, project)
    })
    expect(tabs.opened[0]).toMatchObject({ workspaceId: 'ws-2', spec: { kind: 'record', record: { type: 'project', id: 'proj-9' } } })
    expect(onItemSelect).not.toHaveBeenCalled()
  })
})
