// @vitest-environment jsdom
/**
 * Saved-view selection as a CONTROLLED prop.
 *
 * Switching saved views is a real navigation — it changes filters, grouping and
 * layout wholesale — so the tab records it as a history step and drives the
 * selection back through `historyViewId` on Back/Forward. Two things have to
 * hold for that not to loop:
 *
 *  - a USER pick reports out via onViewSelectionChange (that's what becomes the
 *    history step);
 *  - applying an incoming `historyViewId` does NOT report out, or the parent
 *    would push a step for its own step and the two would ping-pong.
 *
 * And `historyViewId === undefined` must leave the layout fully uncontrolled,
 * which is what arriving from the nav menu does — the layout keeps restoring
 * the user's last selection from localStorage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState, useCallback } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const config = {
  filters: [],
  grouping: null,
  layout: 'list',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

const VIEWS = [
  { id: 'view-a', name: 'View A' },
  { id: 'view-b', name: 'View B' },
]

/** Stateful stand-in for useView — the real one is localStorage-backed state. */
vi.mock('../hooks/use-view', async () => {
  const react = await import('react')
  return {
    // A chat card reads the entity's defaults for what it reports.
    defaultConfig: () => config,
    useView: () => {
      const [activeViewId, setActiveViewId] = react.useState<string | null>(null)
      return {
        views: VIEWS,
        activeViewId,
        activeView: VIEWS.find(v => v.id === activeViewId) ?? null,
        setActiveViewId,
        createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
      }
    },
    useViewConfig: () => ({
      config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false,
      saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
    }),
    useViewResults: () => ({
      data: [], loading: false, loadingMore: false, totalCount: 0, hasMore: false,
      loadMore: vi.fn(), refetch: vi.fn(), updateItem: vi.fn(),
      moveItemBetweenGroups: vi.fn(), removeItem: vi.fn(),
    }),
  }
})

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

// Captures the toolbar's props so the test can drive onViewChange the way a
// click on a view tab would, and read back the activeViewId the layout holds.
type ToolbarCapture = {
  activeViewId: string | null
  onViewChange: (id: string | null, opts?: { silent?: boolean }) => void
}
let toolbarProps: ToolbarCapture | null = null
vi.mock('../view-toolbar', () => ({
  ViewToolbar: (props: ToolbarCapture) => {
    toolbarProps = props
    return null
  },
}))
vi.mock('../view-list', () => ({ ViewList: () => null }))
vi.mock('../view-board', () => ({ ViewBoard: () => null }))

import { UnifiedViewLayout } from '../unified-view-layout'
import { stubAppFetch } from '@/test/app-fetch-stub'

let container: HTMLDivElement
let root: Root
let reported: Array<{ id: string; name: string } | null>

beforeEach(() => {
  // The layout reads /api/account/workspace on mount. Refused at once, as the
  // real fetch refused it only later, it cannot outlive the test
  // (src/test/app-fetch-stub.ts says why).
  stubAppFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  toolbarProps = null
  reported = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Renders the layout with a parent that owns historyViewId, mimicking the tab. */
function renderControlled(initial: string | null | undefined) {
  const control: { set?: (v: string | null | undefined) => void } = {}
  function Parent() {
    const [historyViewId, setHistoryViewId] = useState<string | null | undefined>(initial)
    control.set = useCallback((v: string | null | undefined) => setHistoryViewId(v), [])
    return h(UnifiedViewLayout, {
      entityType: 'action' as const,
      historyViewId,
      onViewSelectionChange: (v: { id: string; name: string } | null) => { reported.push(v) },
    })
  }
  act(() => { root.render(h(Parent)) })
  return control
}

describe('UnifiedViewLayout — saved-view selection as history', () => {
  it('reports a USER pick so the parent can push a history step', () => {
    renderControlled(null)
    expect(toolbarProps!.activeViewId).toBeNull()

    act(() => { toolbarProps!.onViewChange('view-a') })

    expect(reported).toEqual([{ id: 'view-a', name: 'View A' }])
    expect(toolbarProps!.activeViewId).toBe('view-a')
  })

  it('reports null when the user goes back to the built-in default', () => {
    renderControlled(null)
    act(() => { toolbarProps!.onViewChange('view-a') })
    reported = []

    act(() => { toolbarProps!.onViewChange(null) })

    expect(reported).toEqual([null])
  })

  it('applies an incoming historyViewId WITHOUT reporting it back', () => {
    const control = renderControlled(null)

    act(() => { control.set!('view-b') })

    expect(toolbarProps!.activeViewId).toBe('view-b')
    // Silence here is the whole point — reporting would push a duplicate step.
    expect(reported).toEqual([])
  })

  it('a Back that re-selects the previous view does not echo a new step', () => {
    const control = renderControlled(null)
    act(() => { toolbarProps!.onViewChange('view-a') })
    act(() => { control.set!('view-a') })
    reported = []

    // Parent moves the cursor back to the default; layout follows, silently.
    act(() => { control.set!(null) })

    expect(toolbarProps!.activeViewId).toBeNull()
    expect(reported).toEqual([])
  })

  it('applies a historyViewId that is already set at MOUNT (restored tab)', () => {
    renderControlled('view-b')

    expect(toolbarProps!.activeViewId).toBe('view-b')
    expect(reported).toEqual([])
  })

  it('leaves the layout uncontrolled when historyViewId is undefined', () => {
    renderControlled(undefined)

    act(() => { toolbarProps!.onViewChange('view-a') })

    // The layout keeps its own selection — the parent never forces it back.
    expect(toolbarProps!.activeViewId).toBe('view-a')
    expect(reported).toEqual([{ id: 'view-a', name: 'View A' }])
  })

  it('does NOT report a silent clear (scope tabs) — no phantom history step', () => {
    renderControlled(undefined)
    act(() => { toolbarProps!.onViewChange('view-a') })
    reported = []

    // A scope-tab click clears the saved view as plumbing, flagged silent.
    act(() => { toolbarProps!.onViewChange(null, { silent: true }) })

    expect(toolbarProps!.activeViewId).toBeNull()
    expect(reported).toEqual([])
  })

  it('re-applies a saved view after passing through an uncontrolled entry', () => {
    // Back/Forward walk: custom-view(view-b) -> plain view entry (undefined)
    // -> back to custom-view(view-b). The undefined leg must reset the
    // identity anchor, or the return leg would early-return and never restore.
    const control = renderControlled('view-b')
    expect(toolbarProps!.activeViewId).toBe('view-b')

    act(() => { control.set!(undefined) })
    // Uncontrolled leg: the user picks something else meanwhile.
    act(() => { toolbarProps!.onViewChange('view-a') })
    reported = []

    act(() => { control.set!('view-b') })

    expect(toolbarProps!.activeViewId).toBe('view-b')
    // The re-apply is history-driven, so it must not echo a new step.
    expect(reported).toEqual([])
  })
})

describe('UnifiedViewLayout — a chat card keeps its saved view', () => {
  function renderCard(view: string | null | undefined, onViewChange: (id: string | null) => void) {
    act(() => {
      root.render(h(UnifiedViewLayout, { entityType: 'action' as const, card: { baseline: {}, view, onViewChange } }))
    })
  }

  it('lands on the view it kept when it mounts (a page history visit loads it again), without reporting it', () => {
    const kept = vi.fn()
    renderCard('view-b', kept)
    expect(toolbarProps!.activeViewId).toBe('view-b')
    expect(kept).not.toHaveBeenCalled()
  })

  it('keeps the person’s pick, the page itself included', () => {
    const kept = vi.fn()
    renderCard(undefined, kept)
    act(() => { toolbarProps!.onViewChange('view-a') })
    act(() => { toolbarProps!.onViewChange(null) })
    expect(kept.mock.calls).toEqual([['view-a'], [null]])
  })
})
