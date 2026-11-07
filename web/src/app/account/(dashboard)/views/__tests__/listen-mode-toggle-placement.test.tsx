// @vitest-environment jsdom
/**
 * The team actions board (../team-actions-view) carries no Listen mode toggle:
 * not in its header row, where it sat after the Cycles control, nor in the
 * view toolbar under it, where it sat before that. It lives once, in the top
 * bar beside the workspace pill (top-bar/top-bar.tsx, pinned by
 * top-bar/__tests__/listen-mode-toggle-top-bar.test.ts). The real TeamActionsView
 * and UnifiedViewLayout are mounted, with read-aloud supported (as in the
 * desktop app), so a toggle mounted anywhere here would show; the list's data
 * hooks are stubbed, and the toolbar is a stand-in that shows the controls the
 * layout hands it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => {},
    ttsCancel: async () => {},
    ttsPrepare: async () => {},
    onTtsState: (_cb: (p: TtsStatePayload) => void) => () => {},
  },
}))

// ── TeamActionsView's own data ───────────────────────────────────────────────
vi.mock('@/app/account/teams-context', () => ({
  useTeams: () => ({ teams: [] }),
}))
vi.mock('@/hooks/use-entity-sync', () => ({
  useEntityListSync: () => {},
}))

// ── UnifiedViewLayout's data (as in unified-view-obscured.test.tsx) ──────────
const config = {
  filters: [],
  grouping: null,
  layout: 'list',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('@/components/views/hooks/use-view').ViewConfig

vi.mock('@/components/views/hooks/use-view', () => ({
  useView: () => ({
    views: [], activeViewId: 'v1', activeView: null, setActiveViewId: vi.fn(),
    createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
  }),
  useViewConfig: () => ({
    config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false,
    saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
  }),
  useViewResults: () => ({
    data: [{ id: 'a1', title: 'One' }],
    loading: false, loadingMore: false, totalCount: 1, hasMore: false,
    loadMore: vi.fn(), refetch: vi.fn(), updateItem: vi.fn(), moveItemBetweenGroups: vi.fn(), removeItem: vi.fn(),
  }),
}))
vi.mock('@/components/views/hooks/use-picker-context', () => ({
  usePickerContext: () => ({ workflowStatesByTeam: {} }),
}))
vi.mock('@/components/views/hooks/use-flow-status-ids', () => ({ useFlowStatusIds: () => ({}) }))
vi.mock('@/components/views/hooks/use-bulk-selection', () => ({
  useBulkSelection: () => ({
    selectedIds: new Set<string>(), count: 0, hasSelection: false,
    clear: vi.fn(), toggle: vi.fn(), selectAll: vi.fn(),
  }),
}))
vi.mock('@/components/views/bulk-actions/use-bulk-actions', () => ({
  useBulkActions: () => ({ execute: vi.fn() }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws1',
  useCurrentMemberId: () => 'm1',
}))
// The toolbar stand-in renders what the layout puts in it.
vi.mock('@/components/views/view-toolbar', () => ({
  ViewToolbar: ({ actions }: { actions?: ReactNode }) =>
    h('div', { 'data-testid': 'view-toolbar' }, h('button', { type: 'button' }, 'Filter'), actions),
}))
vi.mock('@/components/views/view-list', () => ({ ViewList: () => null }))
vi.mock('@/components/views/view-board', () => ({ ViewBoard: () => null }))

import { TeamActionsView } from '../team-actions-view'
import { __resetSectionPlayerForTests, setSectionPlayerSupported } from '@/lib/read-aloud/section-player'
import { __resetListenModeForTests } from '@/lib/read-aloud/listen-mode'

let container: HTMLDivElement
let root: Root

const toggles = () => container.querySelectorAll<HTMLButtonElement>('button[aria-label="Interactive"]')
const cycles = () => container.querySelector<HTMLButtonElement>('button[title="Cycles"]')
const toolbar = () => container.querySelector('[data-testid="view-toolbar"]')

async function render() {
  await act(async () => root.render(h(TeamActionsView, { teamId: 't1', teamName: 'Engineering' })))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetListenModeForTests()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ cycles: [] }) }) as unknown as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  __resetSectionPlayerForTests()
  __resetListenModeForTests()
})

describe('the team actions board: no Listen mode toggle of its own', () => {
  it('none in its header row, which keeps the Cycles control last', async () => {
    setSectionPlayerSupported(true)
    await render()
    expect(cycles()).not.toBeNull()
    expect(toggles()).toHaveLength(0)
    expect(cycles()!.nextElementSibling).toBeNull()
  })

  it('none in the view toolbar', async () => {
    setSectionPlayerSupported(true)
    await render()
    expect(toolbar()).not.toBeNull()
    expect(toolbar()!.querySelector('button[aria-label="Interactive"]')).toBeNull()
  })
})
